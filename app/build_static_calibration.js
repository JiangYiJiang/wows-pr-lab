'use strict';
/**
 * 生成参数化校准表（不依赖任何自采人群样本）。
 * 输入：配置里的 σ（各维度对数离散度）+ scaleZ（账号综合分的总体标准差）
 * 输出：data/calibration.json —— sortedZ 为正态分位的映射表，供 scorer 的 CDF 使用
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

// 账号综合分 Z 的总体标准差（决定 T 分的展开幅度）
const SCALE_Z = 0.35;

const N = 1001;
const sortedZ = [];
for (let i = 0; i < N; i++) {
  const p = i / (N - 1);
  sortedZ.push(probit(p) * SCALE_Z);
}

const calibration = {
  version: 2,
  mode: 'parametric',
  generatedAt: new Date().toISOString(),
  source: 'wowsdb 公开基准表 + 参数化分布',
  sampleSize: 0,
  sigma: SIGMA,
  scaleZ: SCALE_Z,
  stats: { mean: 0, sd: SCALE_Z, skew: 0, kurt: 0, min: sortedZ[0], max: sortedZ[N - 1] },
  sortedZ,
};

fs.writeFileSync(path.join(DATA, 'calibration.json'), JSON.stringify(calibration, null, 1), 'utf8');
console.log('parametric calibration written:', { sigma: SIGMA, scaleZ: SCALE_Z, n: N });
