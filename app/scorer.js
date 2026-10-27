'use strict';
/**
 * 评分核心（设计稿实现）
 * z = clip(ln(实际/基准) / σ, -3, 3)  →  舰种加权  →  小样本收缩  →  账号聚合  →  CDF 校准
 */

const DIMS = ['wr', 'dmg', 'frags', 'scout', 'cap', 'pot', 'surv'];

const DIM_LABEL = {
  dmg: '伤害', frags: '击杀', scout: '侦察', pot: '抗伤', cap: '占点', surv: '存活', wr: '胜率',
};

// 单位：百分比。按舰种区分（设计稿第三节）
const WEIGHTS = {
  Battleship: { wr: 25, dmg: 30, frags: 25, scout: 5,  cap: 0,  pot: 15, surv: 0 },
  Cruiser:    { wr: 25, dmg: 25, frags: 20, scout: 10, cap: 10, pot: 10, surv: 0 },
  Destroyer:  { wr: 25, dmg: 20, frags: 15, scout: 20, cap: 15, pot: 5,  surv: 0 },
  AirCarrier: { wr: 25, dmg: 30, frags: 25, scout: 15, cap: 0,  pot: 0,  surv: 5 },
  Submarine:  { wr: 25, dmg: 25, frags: 20, scout: 15, cap: 10, pot: 0,  surv: 5 },
};

const SHRINK_K = 30;      // 经验贝叶斯收缩强度
const SCORE_MEAN = 1500;  // 全服中位（1500 分 = 中位玩家）
const SCORE_SD = 500;     // 一个标准差（±3σ 正好覆盖 0–3000）

// ── 经验分布校准（Phase 0）────────────────────────────────────────────
// 综合比值 C 的真实分布不是"中位 1.0、SD 0.35"，而是由 wowsdb 公开的 6 个
// 百分位档位反推出来的经验曲线：  C(ratio) = 0.9156 + 0.2443·z   (R² = 0.9944)
// 其中 C(ratio) = 1 + 我们的 C（我们的 C 是"相对基准的偏离"）。
// 含义：① 中位账号的综合比值低于 1（基准按场次加权，被高活跃玩家抬高）；
//       ② 真实离散度只有 0.244，旧假设 0.35 过宽，会低估中上水平玩家。
const CAL_OFFSET = 1 - 0.9156;  // 0.0844：中位玩家低于基准的幅度
const CAL_SD = 0.2443;          // 综合比值的真实标准差

/** 把"综合比值偏离 C"映射成 0–3000 的账号分（1500 = 中位账号，500 = 1σ）
 *  注意：单船分不走这里，单船分仍是 1500 + 500·C（1500 = 该船全服基准水平）——
 *  两个总体的分布宽度不同，账号分的离散度经多船平均后被压缩，不能共用一把尺子。 */
function scoreOf(C) {
  return SCORE_MEAN + SCORE_SD * ((C + CAL_OFFSET) / CAL_SD);
}
const MIN_SHIP_BATTLES = 1;   // 所有有战绩的船都计入，小样本交给收缩处理
const Z_CLIP = 3;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** Acklam 逆正态近似 */
function probit(p) {
  if (p <= 0) return -6;
  if (p >= 1) return 6;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** 单船综合比值 C（未收缩） */
function shipComposite(ship, base, type, sigma, weights) {
  const table = weights || WEIGHTS;
  const w = table[type] || table.Cruiser || WEIGHTS.Cruiser;
  const dims = {
    dmg: ship.dmg / ship.b,
    frags: ship.frags / ship.b,
    scout: ship.scout / ship.b,
    pot: ship.pot / ship.b,
    cap: ship.cap / ship.b,
    surv: ship.surv / ship.b,
    wr: ship.wins / ship.b,
  };
  const z = {};
  let C = 0, wsum = 0;
  for (const k of DIMS) {
    const weight = (w[k] || 0) / 100;
    const mu = (k === 'surv' || k === 'wr') ? base[k] / 100 : base[k];
    // z 始终计算（详情页/七维图要展示），权重为 0 只是不参与 C
    let zz = 0;
    if (mu > 0) {
      const val = dims[k];
      const lr = val > 0 ? Math.log(val / mu) : -4;      // 0 值视为最低
      const s = sigma[k] || 0.5;
      zz = clamp(lr / s, -Z_CLIP, Z_CLIP);
    }
    z[k] = zz;
    C += zz * weight;
    wsum += weight;
  }
  if (wsum > 0 && Math.abs(wsum - 1) > 1e-6) C = C / wsum; // 缺失维度时归一
  return { C, z };
}

/** 从标定表取分位 */
function cdf(sorted, x) {
  if (!sorted.length) return 0.5;
  // 夹紧在 0.135% ~ 99.865%（±3σ）：均值 1500 时正好 0 ~ 3000
  if (x <= sorted[0]) return 0.00135;
  if (x >= sorted[sorted.length - 1]) return 0.99865;
  let lo = 0, hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid; else hi = mid;
  }
  const span = sorted[hi] - sorted[lo] || 1e-9;
  return (lo + (x - sorted[lo]) / span) / (sorted.length - 1);
}

/**
 * 账号评分
 * @param {object} input { ships:[{sid,b,dmg,frags,scout,pot,cap,surv,wins}], meta:{sid:{name,type,tier,nation,idStr}}, }
 * @param {object} refs { baseline, sigma, calibration:{sortedZ,n} }
 */
function scoreAccount(input, refs) {
  const { baseline, sigma, calibration } = refs;
  const weightTable = refs.weights || WEIGHTS;
  const meta = input.meta || {};
  const ships = [];
  const dimAgg = {}; DIMS.forEach((k) => { dimAgg[k] = { sum: 0, w: 0 }; });
  const classAgg = {};

  let num = 0, den = 0;
  for (const s of input.ships) {
    if (!s.b || s.b < MIN_SHIP_BATTLES) continue;
    const m = meta[s.sid];
    if (!m) continue;
    const base = baseline[m.slug];
    if (!base) continue;
    const { C, z } = shipComposite(s, base, m.type, sigma, weightTable);
    const shrink = s.b / (s.b + SHRINK_K);
    const zs = C * shrink;
    num += s.b * zs; den += s.b;

    ships.push({
      sid: s.sid, name: m.zh || m.name, nameEn: m.name, type: m.type, tier: m.tier,
      battles: s.b, C, zs, tShip: SCORE_MEAN + SCORE_SD * C,
    });

    for (const k of DIMS) {
      const w = s.b * shrink;
      dimAgg[k].sum += z[k] * w; dimAgg[k].w += w;
    }
    const cls = m.type || 'Cruiser';
    classAgg[cls] = classAgg[cls] || { num: 0, den: 0 };
    classAgg[cls].num += s.b * zs; classAgg[cls].den += s.b;
  }

  const zAcc = den > 0 ? num / den : 0;
  // 先按总场次选校准桶，缺失则回退到全局
  let sorted = calibration && calibration.sortedZ ? calibration.sortedZ : [-1, 0, 1];
  if (calibration && Array.isArray(calibration.buckets)) {
    const b = calibration.buckets.find((x) => den >= x.min && den < x.max && Array.isArray(x.sortedZ) && x.sortedZ.length >= 20);
    if (b) sorted = b.sortedZ;
  }
  const p = cdf(sorted, zAcc);
  const T = SCORE_MEAN + SCORE_SD * probit(p);

  // 置信区间：以「船」为单位估计有效样本量
  let varSum = 0, w2 = 0;
  for (const sh of ships) {
    varSum += sh.battles * Math.pow(sh.zs - zAcc, 2);
    w2 += sh.battles * sh.battles;
  }
  const wsd = den > 0 ? Math.sqrt(varSum / den) : 0.5;
  const nEff = w2 > 0 ? (den * den) / w2 : 1;
  const seZ = wsd / Math.sqrt(Math.max(1, nEff));
  // 换算到账号分刻度：1 个 C 单位 = SCORE_SD / CAL_SD 分
  const ci = 1.96 * SCORE_SD * seZ / CAL_SD;

  const dims = {};
  for (const k of DIMS) dims[k] = dimAgg[k].w > 0 ? dimAgg[k].sum / dimAgg[k].w : 0;

  const classes = Object.entries(classAgg)
    .map(([k, v]) => ({ type: k, zs: v.num / v.den, battles: v.den }))
    .sort((a, b) => b.battles - a.battles);

  return {
    zAcc, T: Math.round(T), percentile: Math.round(p * 10000) / 100,
    ci: Math.round(ci), battles: den, shipsCount: ships.length,
    dims, classes,
    ships: ships.sort((a, b) => b.battles - a.battles),
  };
}

module.exports = { DIMS, DIM_LABEL, WEIGHTS, SHRINK_K, MIN_SHIP_BATTLES, SCORE_MEAN, SCORE_SD, CAL_OFFSET, CAL_SD, probit, shipComposite, scoreAccount, scoreOf, cdf };
