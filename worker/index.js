/**
 * Cloudflare Worker 版本
 * - 静态资源由 Workers Assets 提供（app/public）
 * - /api/player、/api/meta 由本脚本处理
 * - 三层缓存：账号解析 1h / 原始战绩 10min / 最终结果 5min
 */
import baselines from '../app/data/baselines.json';
import calibration from '../app/data/calibration.json';
import bundledShipMeta from '../app/data/shipmeta.json';
import namesZh from '../app/data/names_zh_sg.json';
import scorer from '../app/scorer.js';

const { scoreAccount, DIMS, WEIGHTS } = scorer;
const BASE = 'https://api.worldofwarships.asia/wows';

const shipMeta = { ...bundledShipMeta };
const mem = new Map();

const RATE_LIMIT = 60;
const TTL_ACCOUNT = 3600;
const TTL_RAW = 600;
const TTL_PAYLOAD = 300;

const DIA = { 'ü': 'u', 'ä': 'a', 'ö': 'o', 'é': 'e', 'è': 'e', 'ê': 'e', 'á': 'a', 'à': 'a', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ñ': 'n', 'ç': 'c', 'å': 'a', 'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'ō': 'o', 'ū': 'u' };
const slugify = (s) => String(s || '').toLowerCase()
  .replace(/[üäöéèêáàíóúñçåøæßōū]/g, (c) => DIA[c] || c)
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ---------- 缓存 ---------- */
async function cacheGet(origin, key) {
  if (mem.has(key)) return mem.get(key);
  try {
    const res = await caches.default.match(new Request(`${origin}/__cache/${encodeURIComponent(key)}`));
    if (res) {
      const data = await res.json();
      mem.set(key, data);
      if (mem.size > 300) mem.clear();
      return data;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function cachePut(origin, key, data, ttl) {
  mem.set(key, data);
  if (mem.size > 300) mem.clear();
  try {
    await caches.default.put(
      new Request(`${origin}/__cache/${encodeURIComponent(key)}`),
      new Response(JSON.stringify(data), { headers: { 'Cache-Control': `max-age=${ttl}`, 'Content-Type': 'application/json' } }),
    );
  } catch (e) { /* ignore */ }
}

/* ---------- WG API ---------- */
async function api(pathName, params, env, retries = 2) {
  const qs = new URLSearchParams({ application_id: env.WG_APP_ID, ...params });
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${BASE}/${pathName}/?${qs}`, { signal: AbortSignal.timeout(9000) });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 800)); continue; }
      const j = await res.json();
      if (j.status !== 'ok') throw new Error(`${pathName}: ${j.error && j.error.message}`);
      return j.data;
    } catch (e) {
      if (i === retries) throw new Error(`${pathName} 超时或失败`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error('rate limited by WG API');
}

async function ensureMeta(ids, env) {
  const missing = ids.filter((id) => !shipMeta[id]);
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    const part = await api('encyclopedia/ships', { ship_id: chunk.join(','), language: 'en' }, env);
    for (const [sid, e] of Object.entries(part)) {
      if (!e) continue;
      shipMeta[sid] = {
        name: e.name, zh: namesZh[e.ship_id_str] || e.name, type: e.type,
        tier: e.tier, nation: e.nation, slug: slugify(e.name), idStr: e.ship_id_str,
      };
    }
  }
}

/** 按昵称解析（exact 优先，其次 startswith） */
async function resolveName(q, env, origin) {
  const key = `name:${q.toLowerCase()}`;
  const cached = await cacheGet(origin, key);
  if (cached !== null) return cached === false ? null : cached;

  let found = null;
  for (const type of ['exact', 'startswith']) {
    const list = await api('account/list', { search: q, type, limit: 20 }, env);
    if (list && list.length) {
      const exact = list.find((x) => x.nickname.toLowerCase() === q.toLowerCase());
      const pick = exact || list[0];
      found = { id: pick.account_id, candidates: list.length > 1 ? list.map((x) => x.nickname) : undefined };
      break;
    }
  }
  await cachePut(origin, key, found || false, TTL_ACCOUNT);
  return found;
}

/** 纯数字先当 account_id；否则按昵称 */
async function resolveAccount(q, env, origin) {
  if (/^\d{5,}$/.test(q)) return { id: Number(q), numeric: true };
  return resolveName(q, env, origin);
}

/** 拉取原始战绩（与权重无关，可长期缓存） */
async function fetchRaw(id, env, origin) {
  const key = `raw:${id}`;
  const cached = await cacheGet(origin, key);
  if (cached) return cached;

  const [info, st] = await Promise.all([
    api('account/info', { account_id: id }, env),
    api('ships/stats', { account_id: id }, env),
  ]);

  const account = info[id];
  if (!account) return null;

  const rows = (st[id] || []).map((s) => {
    const p = s.pvp || {};
    return {
      sid: s.ship_id, b: p.battles || 0, dmg: p.damage_dealt || 0, frags: p.frags || 0,
      scout: p.damage_scouting || 0, pot: (p.art_agro || 0) + (p.torpedo_agro || 0),
      cap: p.capture_points || 0, surv: p.survived_battles || 0, wins: p.wins || 0,
    };
  }).filter((s) => s.b > 0);

  const raw = { info: account, rows };
  await cachePut(origin, key, raw, TTL_RAW);
  return raw;
}

/* ---------- 参数校验 ---------- */
function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

function parseWeights(raw) {
  if (!raw) return null;
  let w;
  try { w = JSON.parse(raw); } catch (e) { throw badRequest('权重格式错误'); }
  const classes = ['Battleship', 'Cruiser', 'Destroyer', 'AirCarrier', 'Submarine'];
  const dims = ['dmg', 'frags', 'scout', 'pot', 'cap', 'surv', 'wr'];
  const out = {};
  for (const c of classes) {
    const row = w[c];
    if (!row) throw badRequest(`缺少舰种 ${c}`);
    let sum = 0;
    out[c] = {};
    for (const d of dims) {
      const v = Number(row[d]);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw badRequest(`${c}.${d} 权重非法`);
      out[c][d] = v;
      sum += v;
    }
    if (Math.abs(sum - 100) > 0.51) throw badRequest(`${c} 权重合计应为 100（当前 ${sum}）`);
  }
  return out;
}

/* ---------- 限流（每 isolate 近似） ---------- */
const hits = new Map();
function rateInfo(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= RATE_LIMIT) {
    const wait = Math.ceil((60000 - (now - arr[0])) / 1000);
    hits.set(ip, arr);
    const e = new Error(`查询太频繁，请 ${wait} 秒后再试`);
    e.status = 429;
    throw e;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 3000) hits.clear();
}

/* ---------- 主逻辑 ---------- */
async function queryPlayer(q, weights, env, ip, origin) {
  const pKey = `pl:${q.toLowerCase()}|${weights ? JSON.stringify(weights) : 'default'}`;
  const hitPayload = await cacheGet(origin, pKey);
  if (hitPayload) return hitPayload;

  rateInfo(ip);

  let found = await resolveAccount(q, env, origin);
  let raw = found ? await fetchRaw(found.id, env, origin) : null;

  // 纯数字但 ID 查不到时，回退成昵称搜索（有些玩家的昵称就是纯数字）
  if (!raw && /^\d+$/.test(q)) {
    const byName = await resolveName(q, env, origin);
    if (byName) {
      found = byName;
      raw = await fetchRaw(byName.id, env, origin);
    }
  }

  if (!found) return { ok: false, error: '找不到这个玩家（昵称需与游戏内完全一致）' };
  if (!raw) return { ok: false, error: '账号不存在或不可见' };

  await ensureMeta(raw.rows.map((s) => s.sid), env);

  const score = scoreAccount(
    { ships: raw.rows, meta: shipMeta },
    { baseline: baselines, sigma: calibration.sigma, calibration, weights: weights || undefined },
  );

  const info = raw.info;
  const pvp = info.statistics.pvp || {};
  const payload = {
    ok: true,
    player: {
      id: info.account_id, name: info.nickname, hidden: !!info.hidden_profile,
      battles: info.statistics.battles, created: info.created_at, lastBattle: info.last_battle_time,
      pvp: {
        battles: pvp.battles || 0, winrate: pvp.battles ? (pvp.wins / pvp.battles) * 100 : 0,
        avgDamage: pvp.battles ? pvp.damage_dealt / pvp.battles : 0,
        avgFrags: pvp.battles ? pvp.frags / pvp.battles : 0,
      },
    },
    score: {
      T: score.T, percentile: score.percentile, ci: score.ci,
      battles: score.battles, shipsCount: score.shipsCount,
      zAcc: score.zAcc, dims: score.dims, classes: score.classes,
      ships: score.ships, weights: weights || null,
    },
    params: {
      sigma: calibration.sigma, sampleSize: calibration.sampleSize,
      generatedAt: calibration.generatedAt, version: calibration.version,
    },
    candidates: found.candidates,
  };

  await cachePut(origin, pKey, payload, TTL_PAYLOAD);
  return payload;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;

    if (url.pathname === '/api/meta') {
      return json({
        ok: true, dims: DIMS, weights: WEIGHTS, sigma: calibration.sigma,
        calibration: {
          n: calibration.sampleSize, mode: calibration.mode || 'parametric',
          scaleZ: calibration.scaleZ || null, generatedAt: calibration.generatedAt,
          stats: calibration.stats, version: calibration.version,
        },
      });
    }

    if (url.pathname === '/api/player') {
      if (!env.WG_APP_ID) return json({ ok: false, error: '服务端未配置 WG_APP_ID' }, 500);
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ ok: false, error: '缺少 q 参数' }, 400);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      try {
        const weights = parseWeights(url.searchParams.get('w'));
        const payload = await queryPlayer(q, weights, env, ip, origin);
        return json(payload);
      } catch (e) {
        return json({ ok: false, error: e.message }, e.status || 500);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
