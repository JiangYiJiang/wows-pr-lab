'use strict';
/**
 * PR 查询站点 · 本地服务
 *   GET /                 前端页面
 *   GET /api/player?q=... 查询（昵称或 account_id）
 *   GET /api/meta         评分体系信息
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { scoreAccount, DIMS } = require('./scorer');
const { buildShipDetail } = require('./shipdetail');
const { buildPk } = require('./pkcompare');

const PORT = Number(process.env.PORT || 5173);
const HOST = '127.0.0.1';
const APP_ID = process.env.WG_APP_ID;
const BASE = 'https://api.worldofwarships.asia/wows';

const DATA = path.join(__dirname, 'data');
const PUBLIC = path.join(__dirname, 'public');

const baseline = JSON.parse(fs.readFileSync(path.join(DATA, 'baselines.json'), 'utf8'));
const calibration = JSON.parse(fs.readFileSync(path.join(DATA, 'calibration.json'), 'utf8'));
const sigma = calibration.sigma;
const shipMetaPath = path.join(DATA, 'shipmeta.json');
const shipMeta = fs.existsSync(shipMetaPath) ? JSON.parse(fs.readFileSync(shipMetaPath, 'utf8')) : {};

const DIA = { 'ü': 'u', 'ä': 'a', 'ö': 'o', 'é': 'e', 'è': 'e', 'ê': 'e', 'á': 'a', 'à': 'a', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ñ': 'n', 'ç': 'c', 'å': 'a', 'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'ō': 'o', 'ū': 'u' };
const slugify = (s) => String(s || '').toLowerCase()
  .replace(/[üäöéèêáàíóúñçåøæßōū]/g, (c) => DIA[c] || c)
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const zhNames = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'names_zh_sg.json'), 'utf8')); } catch (e) { return {}; }
})();

const cache = new Map(); // q -> {t, payload}
const rawCache = new Map(); // account_id -> {t, info, rows}

/* 轻量限流：只统计真正调用 WG API 的请求（缓存命中不计） */
const RATE_LIMIT = 60;               // 每 IP 每分钟最多 60 次真实查询
const hits = new Map();
function rateInfo(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= RATE_LIMIT) {
    const wait = Math.ceil((60000 - (now - arr[0])) / 1000);
    hits.set(ip, arr);
    return { blocked: true, wait };
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return { blocked: false, wait: 0 };
}

async function api(pathName, params, retries = 2) {
  const qs = new URLSearchParams({ application_id: APP_ID, ...params });
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(`${BASE}/${pathName}/?${qs}`);
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1200)); continue; }
    const j = await res.json();
    if (j.status !== 'ok') throw new Error(`${pathName}: ${j.error && j.error.message}`);
    return j.data;
  }
  throw new Error('rate limited');
}

async function ensureMeta(ids) {
  const missing = ids.filter((id) => !shipMeta[id]);
  for (let i = 0; i < missing.length; i += 80) {
    const chunk = missing.slice(i, i + 80);
    const part = await api('encyclopedia/ships', { ship_id: chunk.join(','), language: 'en' });
    for (const [sid, e] of Object.entries(part)) {
      if (!e) continue;
      shipMeta[sid] = {
        name: e.name, zh: zhNames[e.ship_id_str] || e.name, type: e.type,
        tier: e.tier, nation: e.nation, slug: slugify(e.name), idStr: e.ship_id_str,
      };
    }
  }
  if (missing.length) fs.writeFile(shipMetaPath, JSON.stringify(shipMeta), () => {});
}

async function lookup(q) {
  // 昵称优先：WoWS 昵称全局唯一，玩家通常也只知道昵称
  for (const type of ['exact', 'startswith']) {
    const list = await api('account/list', { search: q, type, limit: 20 });
    if (list && list.length) {
      const exact = list.find((x) => x.nickname.toLowerCase() === q.toLowerCase());
      return { id: (exact || list[0]).account_id, name: (exact || list[0]).nickname, candidates: list.length > 1 ? list.map((x) => x.nickname) : undefined };
    }
  }
  // 昵称查不到时，纯数字再当 account_id 兜底
  if (/^\d{5,}$/.test(q)) return { id: Number(q), name: null };
  return null;
}

function parseWeights(raw) {
  if (!raw) return null;
  let w;
  try { w = JSON.parse(raw); } catch (e) { throw new Error('权重格式错误'); }
  const classes = ['Battleship', 'Cruiser', 'Destroyer', 'AirCarrier', 'Submarine'];
  const dims = ['dmg', 'frags', 'scout', 'pot', 'cap', 'surv', 'wr'];
  const out = {};
  for (const c of classes) {
    const row = w[c];
    if (!row) throw new Error(`缺少舰种 ${c}`);
    let sum = 0;
    out[c] = {};
    for (const d of dims) {
      const v = Number(row[d]);
      if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${c}.${d} 权重非法`);
      out[c][d] = v;
      sum += v;
    }
    if (Math.abs(sum - 100) > 0.51) throw new Error(`${c} 权重合计应为 100（当前 ${sum}）`);
  }
  return out;
}

/** 原始战绩（与权重无关，缓存 10 分钟），单船详情页复用 */
async function fetchRaw(id) {
  const hit = rawCache.get(id);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit;

  const info = (await api('account/info', { account_id: id }))[id];
  if (!info) return null;

  const st = await api('ships/stats', { account_id: id });
  const rows = (st[id] || []).map((s) => {
    const p = s.pvp || {};
    return {
      sid: s.ship_id, b: p.battles || 0, dmg: p.damage_dealt || 0, frags: p.frags || 0,
      scout: p.damage_scouting || 0, pot: (p.art_agro || 0) + (p.torpedo_agro || 0),
      cap: p.capture_points || 0, surv: p.survived_battles || 0, wins: p.wins || 0,
      lastBattle: s.last_battle_time || 0,
      pvp: p,
    };
  }).filter((s) => s.b > 0);

  const raw = { t: Date.now(), info, rows };
  rawCache.set(id, raw);
  if (rawCache.size > 50) rawCache.clear();
  return raw;
}

async function queryPlayer(q, weights, ip) {
  const cacheKey = 'v2|' + q.toLowerCase() + '|' + (weights ? JSON.stringify(weights) : 'default');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.payload;

  const rl = rateInfo(ip);
  if (rl.blocked) {
    const err = new Error("查询太频繁，请 " + rl.wait + " 秒后再试");
    err.status = 429;
    throw err;
  }

  const found = await lookup(q);
  if (!found) return { ok: false, error: `找不到昵称「${q}」的玩家，请检查拼写（需与游戏内完全一致）` };

  const raw = await fetchRaw(found.id);
  if (!raw) return { ok: false, error: '账号不存在或不可见' };
  const info = raw.info;
  const rows = raw.rows;

  await ensureMeta(rows.map((s) => s.sid));

  const score = scoreAccount({ ships: rows, meta: shipMeta }, { baseline, sigma, calibration, weights: weights || undefined });
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
      ships: score.ships,
      weights: weights || null,
    },
    params: {
      sigma, sampleSize: calibration.sampleSize, generatedAt: calibration.generatedAt,
      calibrationStats: calibration.stats, version: calibration.version,
    },
    candidates: found.candidates,
  };
  cache.set(cacheKey, { t: Date.now(), payload });
  return payload;
}

async function queryShip(q, sid, weights, ip) {
  const key = 'ship|v3|' + q.toLowerCase() + '|' + sid + '|' + (weights ? JSON.stringify(weights) : 'default');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.payload;

  const rl = rateInfo(ip);
  if (rl.blocked) {
    const err = new Error('查询太频繁，请 ' + rl.wait + ' 秒后再试');
    err.status = 429;
    throw err;
  }

  const found = await lookup(q);
  if (!found) return { ok: false, error: `找不到昵称「${q}」的玩家` };

  const raw = await fetchRaw(found.id);
  if (!raw) return { ok: false, error: '账号不存在或不可见' };

  await ensureMeta([sid]);

  const row = raw.rows.find((r) => r.sid === sid);
  if (!row) return { ok: false, error: '该玩家没有这艘船的战绩记录' };

  const meta = shipMeta[sid];
  if (!meta) return { ok: false, error: '未找到该舰船的版本数据' };

  const base = baseline[meta.slug];
  if (!base) return { ok: false, error: `该舰船暂无全服基准数据（${meta.zh || meta.name}），无法计算评分` };

  const detail = buildShipDetail({
    row, rows: raw.rows, meta, base,
    allMeta: shipMeta, baselines: baseline, sigma, weights: weights || undefined,
  });

  const payload = {
    ok: true,
    player: { id: raw.info.account_id, name: raw.info.nickname },
    ...detail,
    params: { sigma, version: calibration.version },
  };
  cache.set(key, { t: Date.now(), payload });
  return payload;
}

async function queryPk(qa, qb, weights, ip) {
  const key = 'pk|' + qa.toLowerCase() + '|' + qb.toLowerCase() + '|' + (weights ? JSON.stringify(weights) : 'default');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.payload;

  const [pa, pb] = await Promise.all([
    queryPlayer(qa, weights, ip),
    queryPlayer(qb, weights, ip),
  ]);
  if (!pa.ok) return pa;
  if (!pb.ok) return pb;

  const payload = buildPk(pa, pb);
  if (payload.ok) {
    payload.params = {
      ...payload.params,
      sampleSize: calibration.sampleSize,
      version: calibration.version,
    };
    cache.set(key, { t: Date.now(), payload });
  }
  return payload;
}

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  // 与 Cloudflare Assets 的 html_handling 对齐：/pk → /pk.html
  if (!path.extname(p)) p += '.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    const ext = path.extname(file);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/player') {
      if (!APP_ID) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '服务端未配置 WG_APP_ID' })); return; }
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) { res.writeHead(400).end(JSON.stringify({ ok: false, error: '缺少 q 参数' })); return; }
      const weights = parseWeights(url.searchParams.get('w'));
      const payload = await queryPlayer(q, weights, ip);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === '/api/ship') {
      if (!APP_ID) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '服务端未配置 WG_APP_ID' })); return; }
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      const q = (url.searchParams.get('q') || '').trim();
      const sid = Number(url.searchParams.get('sid'));
      if (!q) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '缺少 q 参数' })); return; }
      if (!Number.isFinite(sid) || sid <= 0) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '缺少或非法的 sid 参数' })); return; }
      const weights = parseWeights(url.searchParams.get('w'));
      const payload = await queryShip(q, sid, weights, ip);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname === '/api/pk') {
      if (!APP_ID) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '服务端未配置 WG_APP_ID' })); return; }
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
      const qa = (url.searchParams.get('a') || '').trim();
      const qb = (url.searchParams.get('b') || '').trim();
      if (!qa || !qb) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '缺少 a / b 参数' })); return; }
      try {
        const weights = parseWeights(url.searchParams.get('w'));
        const payload = await queryPk(qa, qb, weights, ip);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(e.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    if (url.pathname === '/api/meta') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        dims: DIMS,
        weights: require('./scorer').WEIGHTS,
        sigma,
        calibration: { n: calibration.sampleSize, mode: calibration.mode || 'empirical', scaleZ: calibration.scaleZ || null, generatedAt: calibration.generatedAt, stats: calibration.stats, version: calibration.version, anchors: calibration.anchors || null },
        dist: calibration.dist || null,
      }));
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    const code = e.status || 500;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PR site running at http://${HOST}:${PORT}`);
  console.log(`calibration sample: ${calibration.sampleSize} accounts`);
});
