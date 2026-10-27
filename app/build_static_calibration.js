'use strict';
/**
 * 生成校准表（不依赖任何自采人群样本）。
 * 输入：配置里的 σ（各维度对数离散度）+ wowsdb 公开的 6 个百分位档位
 * 输出：data/calibration.json
 *   - sortedZ：分位 → 综合比值 的查表（cdf(sortedZ, C) 即百分位）
 *   - dist：   分数轴上的人群密度曲线，供前端画"实况分布"图
 *
 * 分布形状不是假设成正态，而是用 wowsdb 公布的 6 个档位做单调三次插值（PCHIP），
 * 两端用端点斜率线性外推。这样中段比正态更陡（人群更挤）、右尾更薄更长（高手稀少）。
 */
const fs = require('fs');
const path = require('path');
const { probit } = require('./scorer');

const DATA = path.join(__dirname, 'data');

// 维度离散度：按经验设定的常数，可随时调整
const SIGMA = {
  dmg: 0.40,
  frags: 0.55,
  scout: 0.45,
  pot: 0.30,
  cap: 1.00,
  surv: 0.55,
  wr: 0.25,
};

const SCORE_MEAN = 1500;
const SCORE_SD = 500;
// 账号综合分的经验分布参数（Phase 0：由 wowsdb 公开档位反推）
// 线性拟合：C(ratio) = 0.9156 + 0.2443·z，R² = 0.9944
const CAL_SD = 0.2443;          // 综合比值的真实标准差
const CAL_OFFSET = 1 - 0.9156;  // 中位玩家低于基准的幅度

// wowsdb 公开档位（第 5 版，2026-10-22 采样 / 2026-10-01 基准）
// 他们的分 S = 1000 + (C_wowsdb − 1) × 2000，故我们的 C = (S − 1000) / 2000
const WOWSDB_BANDS = [
  [0.99, 2022],
  [0.95, 1608],
  [0.82, 1235],
  [0.65, 990],
  [0.45, 770],
  [0.25, 547],
];

// (z, C) 锚点，按 z 升序
const ANCHORS = WOWSDB_BANDS
  .map(([p, S]) => [probit(p), (S - 1000) / 2000])
  .sort((a, b) => a[0] - b[0]);

/** Fritsch–Carlson 单调三次插值：保证分位函数处处单调递增 */
function pchip(xs, ys) {
  const n = xs.length;
  const h = [];
  const d = [];
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  return (x) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);          // 左尾线性外推
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]); // 右尾线性外推
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]
      + (t3 - 2 * t2 + t) * h[i] * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1]
      + (t3 - t2) * h[i] * m[i + 1];
  };
}

const Q = pchip(ANCHORS.map((a) => a[0]), ANCHORS.map((a) => a[1]));
const dQ = (z) => (Q(z + 5e-5) - Q(z - 5e-5)) / 1e-4;

// 1) 分位表：p = i/(N-1) → C
const N = 1001;
const sortedZ = [];
for (let i = 0; i < N; i++) sortedZ.push(Q(probit(i / (N - 1))));

// 2) 密度曲线：在 z 上等距取样，换算到分数轴
//    T = 1500 + 500·(C + CAL_OFFSET)/CAL_SD，dT/dz = 500·Q'(z)/CAL_SD
//    f_T(t) = φ(z) / |dT/dz|
const b = SCORE_SD / CAL_SD;
const distT = [];
const distF = [];
for (let i = 0; i <= 240; i++) {
  const z = -3.0 + (6.0 * i) / 240;
  const c = Q(z);
  const t = SCORE_MEAN + b * (c + CAL_OFFSET);
  if (t < 0 || t > 3000) continue;
  const slope = b * Math.max(1e-6, dQ(z));
  const dens = Math.exp(-0.5 * z * z) / slope;
  distT.push(Math.round(t * 10) / 10);
  distF.push(dens);
}
const maxF = Math.max(...distF);
const dist = {
  t: distT,
  f: distF.map((v) => Math.round((v / maxF) * 10000) / 10000),
};

const calibration = {
  version: 4,
  mode: 'empirical-fit-spline',
  generatedAt: new Date().toISOString(),
  source: 'wowsdb 公开基准表 + wowsdb 公开百分位档位（6 点 PCHIP 插值）',
  sampleSize: 0,
  sigma: SIGMA,
  scaleZ: CAL_SD,
  offset: CAL_OFFSET,
  calOffset: CAL_OFFSET, // 兼容旧字段名
  anchors: WOWSDB_BANDS,
  stats: {
    mean: sortedZ[500],
    sd: CAL_SD,
    offset: CAL_OFFSET,
    min: sortedZ[0],
    max: sortedZ[N - 1],
  },
  sortedZ,
  dist,
};

fs.writeFileSync(path.join(DATA, 'calibration.json'), JSON.stringify(calibration, null, 1), 'utf8');

// 自检：打印几个关键分位，确认插值没有走形
const at = (p) => Q(probit(p)).toFixed(3);
console.log('calibration written:', {
  anchors: ANCHORS.map((a) => [Number(a[0].toFixed(2)), Number(a[1].toFixed(3))]),
  q50: at(0.5),
  q95: at(0.95),
  q99: at(0.99),
  distPoints: dist.t.length,
  tRange: [dist.t[0], dist.t[dist.t.length - 1]],
});
