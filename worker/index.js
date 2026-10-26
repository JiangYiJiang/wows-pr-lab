/**
 * Cloudflare Worker 版本
 * - 静态资源由 Workers Assets 提供（app/public）
 * - /api/player、/api/meta 由本脚本处理
 * - 评分逻辑复用 app/scorer.js
 */
import baselines from '../app/data/baselines.json';
import calibration from '../app/data/calibration.json';
import bundledShipMeta from '../app/data/shipmeta.json';
import namesZh from '../app/data/names_zh_sg.json';
import scorer from '../app/scorer.js';

const { scoreAccount, DIMS, WEIGHTS } = scorer;
const BASE = 'https://api.worldofwarships.asia/wows';

const shipMeta = { ...bundledShipMeta };
const cache = new Map();
const hits = new Map();
const RATE_LIMIT = 60;
const CACHE_TTL = 5 * 60 * 1000;

const DIA = { 'ü': 'u', 'ä': 'a', 'ö': 'o', 'é': 'e', 'è': 'e', 'ê': 'e', 'á': 'a', 'à': 'a', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ñ': 'n', 'ç': 'c', 'å': 'a', 'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'ō': 'o', 'ū': 'u' };
const slugify = (s) => String(s || '').toLowerCase()
  .replace(/[üäöéèêáàíóúñçåøæßōū]/g, (c) => DIA[c] || c)
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function api(pathName, params, env, retries = 2) {
  const qs = new URLSearchParams({ application_id: env.WG_APP_ID, ...params });
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(`${BASE}/${pathName}/?${qs}`);
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const j = await res.json();
    if (j.status !== 'ok') throw new Error(`${pathName}: ${j.error && j.error.message}`);
    return j.data;
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

async function lookup(q, env) {
  if (/^\d{5,}$/.test(q)) return { id: Number(q) };
  for (const type of ['exact', 'startswith']) {
    const list = await api('account/list', { search: q, type, limit: 20 }, env);
    if (list && list.length) {
      const exact = list.find((x) => x.nickname.toLowerCase() === q.toLowerCase());
      const pick = exact || list[0];
      return { id: pick.account_id, candidates: list.length > 1 ? list.map((x) => x.nickname) : undefined };
    }
  }
  return null;
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

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

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

async function queryPlayer(q, weights, env, ip) {
  const cacheKey = q.toLowerCase() + '|' + (weights ? JSON.stringify(weights) : 'default');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.payload;

  rateInfo(ip);

  const found = await lookup(q, env);
  if (!found) return { ok: false, error: '找不到这个玩家（昵称需与游戏内完全一致）' };

  const info = (await api('account/info', { account_id: found.id }, env))[found.id];
  if (!info) return { ok: false, error: '账号不存在或不可见' };

  const st = await api('ships/stats', { account_id: found.id }, env);
  const rows = (st[found.id] || []).map((s) => {
    const p = s.pvp || {};
    return {
      sid: s.ship_id, b: p.battles || 0, dmg: p.damage_dealt || 0, frags: p.frags || 0,
      scout: p.damage_scouting || 0, pot: (p.art_agro || 0) + (p.torpedo_agro || 0),
      cap: p.capture_points || 0, surv: p.survived_battles || 0, wins: p.wins || 0,
    };
  }).filter((s) => s.b > 0);

  await ensureMeta(rows.map((s) => s.sid), env);

  const score = scoreAccount({ ships: rows, meta: shipMeta }, { baseline: baselines, sigma: calibration.sigma, calibration, weights: weights || undefined });
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
  cache.set(cacheKey, { t: Date.now(), payload });
  if (cache.size > 500) cache.clear();
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
        const payload = await queryPlayer(q, weights, env, ip);
        return json(payload);
      } catch (e) {
        return json({ ok: false, error: e.message }, e.status || 500);
      }
    }

    // 其余交给静态资源
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
