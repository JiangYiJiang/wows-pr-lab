'use strict';
/**
 * 单船详情（Worker 与本地 server 共用）
 * 输入：该玩家这艘船的原始 pvp 数据 + 全服同船基准
 * 输出：单船评分、七维对比（含全服百分位）、详细数据
 */
const { shipComposite, DIMS, SHRINK_K, SCORE_MEAN, SCORE_SD, WEIGHTS } = require('./scorer');

const DIM_META = {
  wr: { label: '胜率', digits: 2, suffix: '%', ratio: 100 },
  dmg: { label: '伤害', digits: 0, suffix: '', ratio: 1 },
  frags: { label: '击杀', digits: 2, suffix: '', ratio: 1 },
  scout: { label: '侦察', digits: 0, suffix: '', ratio: 1 },
  cap: { label: '占点', digits: 2, suffix: '', ratio: 1 },
  pot: { label: '抗伤', digits: 0, suffix: '', ratio: 1 },
  surv: { label: '存活', digits: 1, suffix: '%', ratio: 100 },
};

const CLASS_NAME = {
  Battleship: '战列舰', Cruiser: '巡洋舰', Destroyer: '驱逐舰',
  AirCarrier: '航母', Submarine: '潜艇',
};

/** 标准正态 CDF（Abramowitz-Stegun 7.1.26，误差 < 1.5e-7） */
function phi(z) {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** 该维度的「实际值」（与基准同单位） */
function actualOf(row, key) {
  const b = row.b || 0;
  if (!b) return 0;
  switch (key) {
    case 'wr': return (row.wins / b) * 100;
    case 'surv': return (row.surv / b) * 100;
    case 'cap': return row.cap / b;
    default: return row[key] / b;
  }
}

/**
 * @param {object} opts
 *  row       当前船的瘦身战绩 {sid,b,dmg,frags,scout,pot,cap,surv,wins,pvp}
 *  rows      该玩家全部船（用于排名）
 *  meta      shipMeta[sid]
 *  base      全服基准
 *  allMeta   shipMeta 全表
 *  baselines 基准全表
 *  sigma, weights
 */
function buildShipDetail({ row, rows = [], meta, base, allMeta = {}, baselines = {}, sigma, weights }) {
  const { C, z } = shipComposite(row, base, meta.type, sigma, weights);
  const shrunk = C * (row.b / (row.b + SHRINK_K));

  // 在玩家自己船队里的排名（按单船分，只统计有基准的船）
  let higher = 0, total = 0;
  for (const r of rows) {
    const m = allMeta[r.sid];
    const b0 = m && baselines[m.slug];
    if (!b0) continue;
    total++;
    const { C: c } = shipComposite(r, b0, m.type, sigma, weights);
    if (c > C + 1e-9) higher++;
  }
  const rank = higher + 1;

  const wTable = weights || WEIGHTS;
  const wRow = wTable[meta.type] || wTable.Cruiser || {};

  const dims = DIMS.map((k) => {
    const m = DIM_META[k];
    const wt = wRow[k] || 0;
    const actual = actualOf(row, k);
    const bv = base[k];
    const ratio = bv > 0 ? actual / bv : 1;
    return {
      key: k, label: m.label, digits: m.digits, suffix: m.suffix,
      actual, base: bv, ratio, weight: wt, z: z[k] || 0,
      pct: Math.round(phi(z[k] || 0) * 1000) / 10,
    };
  });

  const p = row.pvp || {};
  const b = row.b || 0;
  const num = (v) => Number(v) || 0;
  const main = p.main_battery || {};
  const torp = p.torpedoes || {};

  const stats = {
    battles: b,
    wins: num(p.wins), losses: num(p.losses), draws: num(p.draws),
    winrate: b ? (num(p.wins) / b) * 100 : 0,
    survived: num(p.survived_battles),
    survRate: b ? (num(p.survived_battles) / b) * 100 : 0,
    damage: { total: num(p.damage_dealt), avg: b ? num(p.damage_dealt) / b : 0, max: num(p.max_damage_dealt) },
    frags: { total: num(p.frags), avg: b ? num(p.frags) / b : 0, max: num(p.max_frags_battle) },
    scout: { total: num(p.damage_scouting), avg: b ? num(p.damage_scouting) / b : 0, max: num(p.max_damage_scouting) },
    pot: {
      total: num(p.art_agro) + num(p.torpedo_agro),
      avg: b ? (num(p.art_agro) + num(p.torpedo_agro)) / b : 0,
      max: num(p.max_total_agro),
    },
    cap: { total: num(p.capture_points), avg: b ? num(p.capture_points) / b : 0 },
    dropped: { total: num(p.dropped_capture_points), avg: b ? num(p.dropped_capture_points) / b : 0 },
    xp: { total: num(p.xp), avg: b ? num(p.xp) / b : 0, max: num(p.max_xp) },
    planes: { total: num(p.planes_killed), max: num(p.max_planes_killed) },
    spotted: { total: num(p.ships_spotted), max: num(p.max_ships_spotted) },
    main: { shots: num(main.shots), hits: num(main.hits), frags: num(main.frags) },
    torp: { shots: num(torp.shots), hits: num(torp.hits), frags: num(torp.frags) },
    distance: num(p.distance),
    lastBattle: num(row.lastBattle),
  };
  stats.main.rate = stats.main.shots ? (stats.main.hits / stats.main.shots) * 100 : null;
  stats.torp.rate = stats.torp.shots ? (stats.torp.hits / stats.torp.shots) * 100 : null;

  return {
    ship: {
      sid: meta.sid || row.sid, name: meta.name, zh: meta.zh || meta.name,
      type: meta.type, typeZh: CLASS_NAME[meta.type] || meta.type,
      tier: meta.tier, nation: meta.nation, slug: meta.slug,
    },
    fleet: { rank, total },
    score: {
      C, tShip: Math.round(SCORE_MEAN + SCORE_SD * C),
      shrink: b / (b + SHRINK_K), battles: b,
    },
    dims,
    stats,
  };
}

module.exports = { buildShipDetail, phi, actualOf, DIM_META, CLASS_NAME };
