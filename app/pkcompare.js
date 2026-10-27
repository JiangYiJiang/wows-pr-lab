'use strict';
/**
 * 玩家 PK 对比（Worker 与本地 server 共用）
 *
 * L1 总账：总分 / 百分位 / 七维。七维 z 值本身与权重无关（权重只影响 C 的合成），
 *          所以两人的 z 可以直接比；但总分会受船池结构影响，只作参考。
 * L2 同船：只比两人都打过的船。同一艘船 = 同一基准、同一分母，是真正的技术对比。
 *          逐船 ΔC 按「有效场次」加权，再除以单船 C 的离散度换成标准差分。
 */
const { DIMS, SHRINK_K, SCORE_SD } = require('./scorer');

// 单船 C 的实测离散度：300 账号探针，n≥30 的 150 艘船，IQR/1.349 口径的中位数 0.722
const SHIP_SD = 0.72;

const DIM_ORDER = ['wr', 'dmg', 'frags', 'scout', 'pot', 'cap', 'surv'];
const DIM_LABEL = {
  wr: '胜率', dmg: '伤害', frags: '击杀', scout: '侦察', pot: '抗伤', cap: '占点', surv: '存活',
};
const CLASS_NAME = {
  Battleship: '战列舰', Cruiser: '巡洋舰', Destroyer: '驱逐舰',
  AirCarrier: '航母', Submarine: '潜艇',
};

const MIN_COMMON_SHIPS = 5;
const MIN_COMMON_BATTLES = 100;
const WEAK_PAIR_BATTLES = 10;

/** 有效场次：取两人中较少的那一侧，再套同一条收缩曲线 */
function effWeight(ba, bb) {
  const n = Math.min(ba, bb);
  if (!(n > 0)) return 0;
  return n * (n / (n + SHRINK_K));
}

function verdictOf(sdEdge) {
  const v = Math.abs(sdEdge);
  if (v < 0.15) return { key: 'even', label: '势均力敌' };
  if (v < 0.40) return { key: 'slight', label: '略占上风' };
  if (v < 0.80) return { key: 'clear', label: '明显更强' };
  return { key: 'crush', label: '压倒性优势' };
}

function confidenceOf(z) {
  const a = Math.abs(z);
  if (a >= 3) return { key: 'high', label: '置信度高' };
  if (a >= 2) return { key: 'mid', label: '置信度中' };
  return { key: 'low', label: '置信度低' };
}

/** 单个玩家的对外摘要 */
function sideOf(payload) {
  const p = payload.player;
  const s = payload.score;
  return {
    id: p.id, name: p.name, hidden: !!p.hidden,
    T: s.T, percentile: s.percentile, ci: s.ci,
    battles: s.battles, shipsCount: s.shipsCount, zAcc: s.zAcc,
    pvp: p.pvp,
    classes: (s.classes || []).map((c) => ({
      type: c.type, label: CLASS_NAME[c.type] || c.type, zs: c.zs, battles: c.battles,
    })),
    // 单维 z（与权重无关）
    dims: DIM_ORDER.map((k) => ({ key: k, label: DIM_LABEL[k], z: s.dims[k] || 0 })),
  };
}

/**
 * @param {object} pa 玩家 A 的 /api/player 结果
 * @param {object} pb 玩家 B 的 /api/player 结果
 */
function buildPk(pa, pb) {
  if (pa.player.id === pb.player.id) {
    return { ok: false, error: '不能和自己 PK，换个对手吧' };
  }

  const A = sideOf(pa);
  const B = sideOf(pb);

  /* ---------- L1：总账 ---------- */
  const dims = DIM_ORDER.map((k) => {
    const a = (pa.score.dims[k] || 0);
    const b = (pb.score.dims[k] || 0);
    return { key: k, label: DIM_LABEL[k], a, b, d: a - b };
  });
  const gap = A.T - B.T;
  const l1 = {
    gap,
    sdGap: gap / SCORE_SD,
    dimWinsA: dims.filter((d) => d.d > 0.02).length,
    dimWinsB: dims.filter((d) => d.d < -0.02).length,
    dims,
  };

  /* ---------- L2：同船对决 ---------- */
  const bMap = new Map(pb.score.ships.map((s) => [s.sid, s]));
  const rows = [];
  for (const sa of pa.score.ships) {
    const sb = bMap.get(sa.sid);
    if (!sb) continue;
    const w = effWeight(sa.battles, sb.battles);
    const delta = sa.C - sb.C;
    rows.push({
      sid: sa.sid,
      name: sa.name,
      nameEn: sa.nameEn,
      tier: sa.tier,
      type: sa.type,
      typeLabel: CLASS_NAME[sa.type] || sa.type,
      battlesA: sa.battles,
      battlesB: sb.battles,
      Ca: sa.C,
      Cb: sb.C,
      tShipA: sa.tShip,
      tShipB: sb.tShip,
      delta,
      weight: w,
      weak: Math.min(sa.battles, sb.battles) < WEAK_PAIR_BATTLES,
      winner: delta > 1e-9 ? 'a' : delta < -1e-9 ? 'b' : 'tie',
    });
  }
  rows.sort((x, y) => y.weight - x.weight || Math.abs(y.delta) - Math.abs(x.delta));

  let sw = 0, swd = 0, sw2 = 0, wa = 0, wb = 0, wtie = 0, bA = 0, bB = 0;
  for (const r of rows) {
    sw += r.weight;
    swd += r.weight * r.delta;
    sw2 += r.weight * r.weight;
    if (r.winner === 'a') wa += r.weight;
    else if (r.winner === 'b') wb += r.weight;
    else wtie += r.weight;
    bA += r.battlesA;
    bB += r.battlesB;
  }

  const edge = sw > 0 ? swd / sw : 0;
  const nEff = sw2 > 0 ? (sw * sw) / sw2 : 0;
  const se = nEff > 0 ? SHIP_SD / Math.sqrt(nEff) : 1;
  const z = edge / se;
  const sdEdge = edge / SHIP_SD;

  const available = rows.length >= MIN_COMMON_SHIPS && Math.min(bA, bB) >= MIN_COMMON_BATTLES;
  const winRateA = sw > 0 ? wa / sw : 0;
  const winRateB = sw > 0 ? wb / sw : 0;
  const tieRate = sw > 0 ? wtie / sw : 0;
  // 平局按各得半分计算「胜场比」
  const shareA = sw > 0 ? (wa + wtie / 2) / sw : 0.5;

  const l2 = {
    available,
    reason: available ? null
      : `共同舰船 ${rows.length} 艘、有效场次 ${Math.min(bA, bB)}，少于 ${MIN_COMMON_SHIPS} 艘 / ${MIN_COMMON_BATTLES} 场，只能参考总分`,
    commonCount: rows.length,
    battlesA: bA,
    battlesB: bB,
    totalWeight: sw,
    nEff,
    edge,
    sdEdge,
    z,
    se,
    shipsWonA: rows.filter((r) => r.winner === 'a').length,
    shipsWonB: rows.filter((r) => r.winner === 'b').length,
    shipsTie: rows.filter((r) => r.winner === 'tie').length,
    winRateA,
    winRateB,
    tieRate,
    shareA,
    verdict: verdictOf(sdEdge),
    confidence: available ? confidenceOf(z) : { key: 'na', label: '样本不足' },
    winner: Math.abs(sdEdge) < 0.15 ? 'even' : sdEdge > 0 ? 'a' : 'b',
    ships: rows,
  };

  return {
    ok: true,
    a: A,
    b: B,
    l1,
    l2,
    params: { shipSd: SHIP_SD, shrinkK: SHRINK_K, dims: DIMS },
  };
}

module.exports = {
  buildPk, effWeight, verdictOf, confidenceOf, sideOf,
  SHIP_SD, DIM_ORDER, DIM_LABEL, CLASS_NAME, MIN_COMMON_SHIPS, MIN_COMMON_BATTLES,
};
