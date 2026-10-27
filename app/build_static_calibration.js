'use strict';
/**
 * 生成校准表（不依赖任何自采人群样本）。
 * 输入：配置里的 σ（各维度对数离散度）+ 经验分布参数（中位偏移 CAL_OFFSET / 标准差 CAL_SD）
 * 输出：data/calibration.json —— sortedZ 为"分位 → 综合比值"的查表，供 scorer 的 CDF 使用
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

// 账号综合分的经验分布参数（Phase 0：由 wowsdb 公开档位反推）
// 拟合：C(ratio) = 0.9156 + 0.2443·z，R² = 0.9944
const CAL_SD = 0.2443;          // 综合比值的真实标准差
const CAL_OFFSET = 1 - 0.9156;  // 中位玩家低于基准的幅度

const N = 1001;
const sortedZ = [];
for (let i = 0; i < N; i++) {
  const p = i / (N - 1);
  // sortedZ 是"分位点 → 综合比值偏离"的查表：cdf(sortedZ, C) 即得到百分位
  sortedZ.push(probit(p) * CAL_SD - CAL_OFFSET);
}

const calibration = {
  version: 3,
  mode: 'empirical-fit',
  generatedAt: new Date().toISOString(),
  source: 'wowsdb 公开基准表 + wowsdb 公开百分位档位反推的经验分布',
  sampleSize: 0,
  sigma: SIGMA,
  scaleZ: CAL_SD,
  calOffset: CAL_OFFSET,
  stats: { mean: 0, sd: CAL_SD, offset: CAL_OFFSET, skew: 0, kurt: 0, min: sortedZ[0], max: sortedZ[N - 1] },
  sortedZ,
};

fs.writeFileSync(path.join(DATA, 'calibration.json'), JSON.stringify(calibration, null, 1), 'utf8');
console.log('calibration written:', { sigma: SIGMA, calSD: CAL_SD, calOffset: CAL_OFFSET, n: N });
