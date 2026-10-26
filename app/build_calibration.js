'use strict';
// 由 population.json 生成：baselines.json / shipmeta.json / calibration.json
const fs = require('fs');
const path = require('path');
const { scoreAccount } = require('./scorer');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PIPE = path.join(ROOT, '..', 'pipeline', 'dumps');

/* ---- 1. 基准表 ---- */
const rows = JSON.parse(fs.readFileSync(path.join(PIPE, 'wowsdb_baseline_full.json'), 'utf8'));
const num = (s) => Number(String(s).replace(/[,%\s]/g, '')) || 0;
const baseline = {};
for (const r of rows) {
  const c = r.cells;
  baseline[r.slug.replace(/-[0-9a-f]{10}$/, '')] = {
    dmg: num(c[4]), frags: num(c[5]), scout: num(c[6]), pot: num(c[7]),
    cap: num(c[8]), wr: num(c[9]), surv: num(c[10]),
  };
}
fs.writeFileSync(path.join(DATA, 'baselines.json'), JSON.stringify(baseline), 'utf8');
console.log('baselines:', Object.keys(baseline).length);

/* ---- 2. 人口样本 ---- */
const pop = JSON.parse(fs.readFileSync(path.join(DATA, 'population.json'), 'utf8'));
const zhNames = JSON.parse(fs.readFileSync(path.join(DATA, 'names_zh_sg.json'), 'utf8'));

const DIA = { 'ü': 'u', 'ä': 'a', 'ö': 'o', 'é': 'e', 'è': 'e', 'ê': 'e', 'á': 'a', 'à': 'a', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ñ': 'n', 'ç': 'c', 'å': 'a', 'ø': 'o', 'æ': 'ae', 'ß': 'ss', 'ō': 'o', 'ū': 'u' };
const slugify = (s) => String(s || '').toLowerCase()
  .replace(/[üäöéèêáàíóúñçåøæßōū]/g, (c) => DIA[c] || c)
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const meta = {};
for (const [sid, e] of Object.entries(pop.shipMeta || {})) {
  if (!e) continue;
  meta[sid] = {
    name: e.name, zh: zhNames[e.ship_id_str] || e.name,
    type: e.type, tier: e.tier, nation: e.nation, slug: slugify(e.name), idStr: e.ship_id_str,
  };
}
fs.writeFileSync(path.join(DATA, 'shipmeta.json'), JSON.stringify(meta), 'utf8');
console.log('ship meta:', Object.keys(meta).length);

/* ---- 3. 用同一套评分算样本人群的 Z_acc，生成校准表 ---- */
// σ 只用 ≥10 场的船重新估计，避免小样本把离散度拉大
const sigma = (() => {
  const DIMS = ['dmg', 'frags', 'scout', 'pot', 'cap', 'surv', 'wr'];
  const out = {};
  const solid = (pop.pairs || []).filter((p) => p.b >= 10);
  for (const k of DIMS) {
    const vals = solid.map((p) => p.lr[k]).filter((v) => Number.isFinite(v));
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length;
    out[k] = Math.sqrt(v);
  }
  console.log('sigma (b>=10, n=' + solid.length + '):', Object.entries(out).map(([a, b]) => a + '=' + b.toFixed(3)).join(' '));
  return out;
})();
const zs = [];
for (const a of pop.accounts) {
  const r = scoreAccount({ ships: a.ships, meta }, { baseline, sigma, calibration: null });
  if (r.shipsCount >= 3 && r.battles >= 30) zs.push({ id: a.id, name: a.name, battles: r.battles, z: r.zAcc });
}
zs.sort((a, b) => a.z - b.z);
const arr = zs.map((x) => x.z);
const n = arr.length;
const mean = arr.reduce((a, b) => a + b, 0) / n;
const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
const skew = arr.reduce((a, b) => a + (b - mean) ** 3, 0) / n / sd ** 3;
const kurt = arr.reduce((a, b) => a + (b - mean) ** 4, 0) / n / sd ** 4 - 3;

// 按总场次分桶校准（消除「场次少 → 方差大」的假差异）
const BUCKETS = [[30, 100], [100, 300], [300, 1000], [1000, 1e9]];
const buckets = BUCKETS.map(([min, max]) => {
  const zz = zs.filter((x) => x.battles >= min && x.battles < max).map((x) => x.z).sort((a, b) => a - b);
  return { min, max, n: zz.length, sortedZ: zz };
});

const calibration = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: pop.source,
  sampleSize: n,
  sigma,
  stats: { mean, sd, skew, kurt, min: arr[0], max: arr[n - 1] },
  sortedZ: arr,
  buckets: buckets.map((b) => ({ min: b.min, max: b.max, n: b.n, sortedZ: b.n >= 20 ? b.sortedZ : null })),
};
console.log('buckets:', buckets.map((b) => `${b.min}-${b.max === 1e9 ? '∞' : b.max}:n=${b.n}`).join(' | '));
fs.writeFileSync(path.join(DATA, 'calibration.json'), JSON.stringify(calibration, null, 1), 'utf8');

console.log(`calibration: n=${n}, mean=${mean.toFixed(3)}, sd=${sd.toFixed(3)}, skew=${skew.toFixed(2)}, kurt=${kurt.toFixed(2)}`);
console.log('sigma:', Object.entries(sigma).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' '));
