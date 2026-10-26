'use strict';

const $ = (sel) => document.querySelector(sel);
const out = $('#out');
const input = $('#q');
const btn = $('#go');

const DIMS = [
  ['wr', '胜率'], ['dmg', '伤害'], ['frags', '击杀'], ['scout', '侦察'],
  ['cap', '占点'], ['pot', '抗伤'], ['surv', '存活'],
];
const CLASSES = [
  ['Battleship', '战列舰'], ['Cruiser', '巡洋舰'], ['Destroyer', '驱逐舰'],
  ['AirCarrier', '航母'], ['Submarine', '潜艇'],
];
const CLASS_NAME = Object.fromEntries(CLASSES);

const BANDS = [
  [2500, '顶尖', '#e0457b'],
  [2000, '优秀', '#5c7cfa'],
  [1500, '良好', '#3ddc97'],
  [1000, '平均', '#e8b455'],
  [500, '偏低', '#ff8f5c'],
  [-999, '待提升', '#a35b5b'],
];
const bandOf = (t) => BANDS.find((b) => t >= b[0]);
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

let DEFAULT_WEIGHTS = null;
let CURRENT_Q = '';
let APPLIED_WEIGHTS = null;

/* ---------- 启动 ---------- */
(async function init() {
  try {
    const m = await (await fetch('/api/meta')).json();
    DEFAULT_WEIGHTS = m.weights;
    $('#m-sample').textContent = `参数化校准 · 基准 wowsdb`;
    $('#m-time').textContent = `v${m.calibration.version} · ${new Date(m.calibration.generatedAt).toLocaleDateString('zh-CN')}`;
  } catch (e) {
    $('#m-sample').textContent = '服务未就绪';
  }
  const q = new URLSearchParams(location.search).get('q');
  if (q) { input.value = q; search(q); }
})();

btn.addEventListener('click', () => search(input.value));
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(input.value); });
document.querySelectorAll('.examples button').forEach((b) => {
  b.addEventListener('click', () => { input.value = b.dataset.q; search(b.dataset.q); });
});

let BUSY = false;

function search(q, weights) {
  q = (q || '').trim();
  if (!q || BUSY) return;
  BUSY = true;
  CURRENT_Q = q;
  APPLIED_WEIGHTS = weights || null;
  btn.disabled = true;
  out.innerHTML = `<div class="card"><div class="loading"><span class="spinner"></span>正在查询 ${escapeHtml(q)}…</div></div>`;
  let url = `/api/player?q=${encodeURIComponent(q)}`;
  if (weights) url += `&w=${encodeURIComponent(JSON.stringify(weights))}`;
  fetch(url)
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) throw new Error(data.error || '查询失败');
      render(data);
    })
    .catch((e) => {
      out.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`;
    })
    .finally(() => { btn.disabled = false; BUSY = false; });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 权重工具 ---------- */
function normalizeWeights(src) {
  const res = {};
  for (const [c] of CLASSES) {
    const row = (src && src[c]) || {};
    const r = {};
    let sum = 0;
    for (const [d] of DIMS) { r[d] = Number(row[d]) || 0; sum += r[d]; }
    if (Math.abs(sum - 100) > 0.51) {
      const def = (DEFAULT_WEIGHTS && DEFAULT_WEIGHTS[c]) || {};
      for (const [d] of DIMS) r[d] = Number(def[d]) || 0;
    }
    res[c] = r;
  }
  return res;
}

/* ---------- 渲染 ---------- */
function render(d) {
  const p = d.player, s = d.score;
  const band = bandOf(s.T);
  const W = normalizeWeights(s.weights || APPLIED_WEIGHTS || DEFAULT_WEIGHTS);

  const dims = DIMS.map(([k, label]) => {
    const z = s.dims[k] || 0;
    const w = Math.min(50, (Math.abs(z) / 3) * 50);
    const left = z >= 0 ? 50 : 50 - w;
    const col = z >= 0 ? `linear-gradient(90deg,#4cc9f0,#3ddc97)` : `linear-gradient(90deg,#ff8f5c,#ff6b6b)`;
    return `<div class="dimrow">
      <span class="name">${label}</span>
      <div class="track"><span class="mid"></span><i style="left:${left}%;width:${w}%;background:${col}"></i></div>
      <span class="val" style="color:${z >= 0 ? '#3ddc97' : '#ff8f5c'}">${z >= 0 ? '+' : ''}${z.toFixed(2)}</span>
    </div>`;
  }).join('');

  const classes = (s.classes || []).map((c) => {
    const z = c.zs || 0;
    const w = Math.min(50, (Math.abs(z) / 3) * 50);
    const left = z >= 0 ? 50 : 50 - w;
    const col = z >= 0 ? 'linear-gradient(90deg,#4cc9f0,#3ddc97)' : 'linear-gradient(90deg,#ff8f5c,#ff6b6b)';
    return `<div class="dimrow">
      <span class="name">${CLASS_NAME[c.type] || c.type}</span>
      <div class="track"><span class="mid"></span><i style="left:${left}%;width:${w}%;background:${col}"></i></div>
      <span class="val" style="color:${z >= 0 ? '#3ddc97' : '#ff8f5c'}">${z >= 0 ? '+' : ''}${z.toFixed(2)}</span>
    </div>`;
  }).join('');


  const hidden = p.hidden ? `<span class="chip warn">该玩家隐藏了战绩，数据可能不完整</span>` : '';
  const cand = d.candidates && d.candidates.length > 1
    ? `<div class="note" style="margin-top:8px">多个同名匹配：${d.candidates.slice(0, 6).map((n) => `<a href="#" data-q="${escapeHtml(n)}">${escapeHtml(n)}</a>`).join(' · ')}</div>`
    : '';
  const custom = s.weights ? `<span class="chip" style="color:#9fd8ea;border-color:rgba(76,201,240,.4)">自定义权重已应用</span>` : '';

  out.innerHTML = `
  <div class="card">
    <div class="score-main">
      <div class="gauge">
        <div class="T" style="color:${band[2]}">${fmt(s.T)}</div>
        <div class="band" style="color:${band[2]};background:${band[2]}1f">${band[1]}</div>
        <div class="sub">超过 ${s.percentile}% 的玩家 · ±${s.ci}</div>
      </div>
      <div class="who">
        <h2>${escapeHtml(p.name)}</h2>
        <div class="chips">
          <span class="chip">ASIA</span>
          <span class="chip">ID ${p.id}</span>
          <span class="chip">随机战 ${fmt(p.pvp.battles)} 场</span>
          <span class="chip">胜率 ${p.pvp.winrate.toFixed(2)}%</span>
          ${custom}
          ${hidden}
        </div>
        <div class="kpis">
          <div class="kpi"><div class="k">计入船只</div><div class="v">${s.shipsCount}</div></div>
          <div class="kpi"><div class="k">计入场次</div><div class="v">${fmt(s.battles)}</div></div>
          <div class="kpi"><div class="k">场均伤害</div><div class="v">${fmt(p.pvp.avgDamage)}</div></div>
          <div class="kpi"><div class="k">场均击杀</div><div class="v">${p.pvp.avgFrags.toFixed(2)}</div></div>
        </div>
        ${cand}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="sec-title">分数分布（模型：正态 1500 ± 500，截断于 0–3000）</div>
    ${distChart(s.T, s.percentile)}
  </div>

  <div class="card">
    <div class="sec-title">七维表现（相对同船全服基准，单位：标准差）</div>
    <div class="dims">${dims}</div>
  </div>

  <div class="card">
    <div class="sec-title">按舰种</div>
    <div class="dims">${classes || '<div class="empty">无足够数据</div>'}</div>
  </div>

  <div class="card" id="wcard">
    <div class="sec-title">自定义权重 · 每个舰种 100 点（剩余全部归零后可应用）</div>
    ${weightTableHtml(W)}
    <div class="wfoot">
      <button id="wreset" class="wsecondary">重置默认</button>
      <button id="wapply" class="wprimary" disabled>按此权重计算</button>
    </div>
  </div>

  <div class="card" id="shipcard">
    <div class="shipbar">
      <div class="sec-title" style="margin:0">全部舰船（含低场次，按 n/(n+30) 收缩加权）</div>
      <div class="sorts">
        <select id="tierFilter" class="tiersel" title="按等级筛选"></select>
        <button data-sort="battles" class="active">场次</button>
        <button data-sort="tier">等级</button>
        <button data-sort="score">单船评分</button>
      </div>
    </div>
    <table>
      <thead><tr><th>舰船</th><th>场次</th><th>收缩权重</th><th>综合比值 C</th><th>单船分</th></tr></thead>
      <tbody id="shipBody"></tbody>
    </table>
    <div class="pager" id="shipPager"></div>
  </div>

  <div class="card">
    <details>
      <summary>分数怎么算的？</summary>
      <div class="inner">
        1. 每艘船、每个维度算 <code>z = clip(ln(实际/基准) / σ, −3, 3)</code>；σ 为设定的经验常数：
        ${DIMS.map(([k]) => `<code>${k}=${d.params.sigma[k].toFixed(3)}</code>`).join(' ')}<br>
        2. 按舰种权重加权成综合比值 <code>C</code>（权重可在上方自定义）；<br>
        3. 小样本收缩 <code>C' = C × n/(n+30)</code>，1 场的新船只按 3.2% 权重计入；<br>
        4. 按场次加权成账号原始分 <code>Z</code>；<br>
        5. 用参数化正态分布做映射（均值 1500、标准差 500，分位夹紧 0.135%–99.865%）：<code>T = 1500 + 500·(Z / 0.35)</code>，正好覆盖 0–3000。<br>
        <span style="color:#65748c">基准取自 wowsdb 公开表（三区合并），与亚服单服基准存在 4–9% 差异；分布为参数化设定，非人群实测。置信区间按场次估算。</span>
      </div>
    </details>
  </div>`;

  out.querySelectorAll('a[data-q]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); input.value = a.dataset.q; search(a.dataset.q); });
  });
  bindWeightEditor(W);
  bindShips(s.ships || []);
}

/* ---------- 权重表 ---------- */
function weightTableHtml(W) {
  const head = `<tr><th>舰种</th>${DIMS.map(([, l]) => `<th>${l}</th>`).join('')}<th>剩余</th></tr>`;
  const rows = CLASSES.map(([c, label]) => {
    const cells = DIMS.map(([dim]) => `
      <td class="wcell" data-d="${dim}">
        <button class="wbtn" data-act="minus" type="button">−</button>
        <input class="winput" type="number" min="0" max="100" value="${W[c][dim]}">
        <button class="wbtn" data-act="plus" type="button">+</button>
      </td>`).join('');
    return `<tr data-c="${c}"><td class="wname">${label}</td>${cells}<td class="wremain">0</td></tr>`;
  }).join('');
  return `<div class="wscroll"><table class="wtable"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function bindWeightEditor(W) {
  const card = document.getElementById('wcard');
  if (!card) return;
  const applyBtn = card.querySelector('#wapply');
  const resetBtn = card.querySelector('#wreset');
  const rows = [...card.querySelectorAll('tbody tr')];

  const readRow = (tr) => {
    const vals = {};
    tr.querySelectorAll('.wcell').forEach((td) => {
      vals[td.dataset.d] = Math.max(0, Math.min(100, Number(td.querySelector('.winput').value) || 0));
    });
    return vals;
  };

  const refresh = () => {
    let allZero = true;
    rows.forEach((tr) => {
      const vals = readRow(tr);
      let sum = 0;
      DIMS.forEach(([d]) => { sum += vals[d]; });
      const remain = Math.max(0, 100 - sum);
      const remCell = tr.querySelector('.wremain');
      remCell.textContent = remain;
      remCell.className = 'wremain' + (remain === 0 ? ' done' : '');
      if (remain !== 0) allZero = false;
      tr.querySelectorAll('.wcell').forEach((td) => {
        const inp = td.querySelector('.winput');
        const v = vals[td.dataset.d];
        if (Number(inp.value) !== v) inp.value = v;
        td.querySelector('[data-act="plus"]').disabled = remain <= 0;
        td.querySelector('[data-act="minus"]').disabled = v <= 0;
        inp.max = String(v + remain);
      });
    });
    applyBtn.disabled = !allZero;
    applyBtn.classList.toggle('ready', allZero);
  };

  card.addEventListener('click', (e) => {
    const b = e.target.closest('.wbtn');
    if (!b) return;
    const td = b.closest('.wcell');
    const tr = b.closest('tr');
    const inp = td.querySelector('.winput');
    const vals = readRow(tr);
    const sum = DIMS.reduce((a, [d]) => a + vals[d], 0);
    const remain = 100 - sum;
    let v = Number(inp.value) || 0;
    if (b.dataset.act === 'plus') { if (remain <= 0) return; v += 1; }
    else { if (v <= 0) return; v -= 1; }
    inp.value = Math.max(0, Math.min(100, v));
    refresh();
  });

  card.addEventListener('input', (e) => {
    if (!e.target.classList.contains('winput')) return;
    const tr = e.target.closest('tr');
    const vals = readRow(tr);
    const sum = DIMS.reduce((a, [d]) => a + vals[d], 0);
    if (sum > 100) {
      const others = sum - vals[e.target.closest('.wcell').dataset.d];
      e.target.value = String(Math.max(0, 100 - others));
    }
    refresh();
  });

  applyBtn.addEventListener('click', () => {
    const payload = {};
    rows.forEach((tr) => { payload[tr.dataset.c] = readRow(tr); });
    search(CURRENT_Q, payload);
  });

  resetBtn.addEventListener('click', () => {
    const def = normalizeWeights(DEFAULT_WEIGHTS);
    rows.forEach((tr) => {
      const c = tr.dataset.c;
      tr.querySelectorAll('.wcell').forEach((td) => {
        td.querySelector('.winput').value = def[c][td.dataset.d];
      });
    });
    refresh();
  });

  refresh();
}

/* ---------- 分布曲线 ---------- */
function distChart(T, percentile) {
  const W = 1000, H = 260, PADL = 46, PADR = 16, PADT = 34, PADB = 34;
  const mean = 1500, sd = 500, lo = 0, hi = 3000;
  const x = (v) => PADL + ((v - lo) / (hi - lo)) * (W - PADL - PADR);
  const pdf = (v) => Math.exp(-0.5 * Math.pow((v - mean) / sd, 2));
  const y = (d) => PADT + (1 - d / 1.0) * (H - PADT - PADB);

  const pts = [];
  for (let v = lo; v <= hi; v += 10) pts.push([x(v), y(pdf(v))]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

  const clampT = Math.max(lo, Math.min(hi, T));
  const fillPts = pts.filter((p, i) => i * 10 >= clampT);
  const fill = fillPts.length
    ? `M${x(clampT).toFixed(1)},${y(0).toFixed(1)} ` + fillPts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') +
      ` L${pts[pts.length - 1][0].toFixed(1)},${y(0).toFixed(1)} Z`
    : '';

  const ticks = [0, 500, 1000, 1500, 2000, 2500, 3000].map((v) => {
    const px = x(v);
    const label = v === 1500 ? '1500 平均' : String(v);
    return `<line x1="${px.toFixed(1)}" y1="${H - PADB}" x2="${px.toFixed(1)}" y2="${H - PADB + 5}" stroke="rgba(255,255,255,.25)" />
      <text x="${px.toFixed(1)}" y="${H - PADB + 20}" fill="#65748c" font-size="11" text-anchor="middle">${label}</text>`;
  }).join('');

  const guide = Math.abs(T - mean) > 1
    ? `<line x1="${x(mean)}" y1="${PADT}" x2="${x(mean)}" y2="${H - PADB}" stroke="rgba(255,255,255,.18)" stroke-dasharray="4 4" />`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" class="dist" preserveAspectRatio="none">
    <defs><linearGradient id="dg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#4cc9f0" stop-opacity=".55"/>
      <stop offset="1" stop-color="#e8b455" stop-opacity=".35"/>
    </linearGradient></defs>
    <path d="${fill}" fill="url(#dg)" />
    <path d="${line}" fill="none" stroke="#4cc9f0" stroke-width="2.4" />
    ${guide}
    <line x1="${x(clampT).toFixed(1)}" y1="${PADT}" x2="${x(clampT).toFixed(1)}" y2="${H - PADB}" stroke="#e8b455" stroke-width="2" />
    <circle cx="${x(clampT).toFixed(1)}" cy="${y(pdf(clampT)).toFixed(1)}" r="4.5" fill="#e8b455" />
    <text x="${x(clampT).toFixed(1)}" y="14" fill="#e8b455" font-size="13" font-weight="700" text-anchor="middle">你 ${Math.round(T)}</text>
    <text x="8" y="14" fill="#65748c" font-size="11">玩家占比</text>
    ${ticks}
  </svg>
  <div class="distnote">所在位置右侧为更强玩家：约 ${percentile}% 的人低于你</div>`;
}
/* ---------- 舰船列表：排序 + 分页 ---------- */
const PAGE_SIZE = 20;
let SHIP_STATE = { list: [], sort: 'battles', dir: -1, page: 1 };

function bindShips(list) {
  SHIP_STATE = { list, sort: 'battles', dir: -1, page: 1, tier: 'all' };
  const card = document.getElementById('shipcard');
  if (!card) return;

  const sel = card.querySelector('#tierFilter');
  if (sel) {
    const tiers = [...new Set(list.map((s) => s.tier))].sort((a, b) => a - b);
    sel.innerHTML = '<option value="all">全部等级</option>' + tiers.map((t) => {
      const n = list.filter((s) => s.tier === t).length;
      return '<option value="' + t + '">' + t + ' 级 (' + n + ')</option>';
    }).join('');
    sel.addEventListener('change', () => {
      SHIP_STATE.tier = sel.value;
      SHIP_STATE.page = 1;
      drawShips();
    });
  }

  card.querySelectorAll('.sorts button').forEach((b) => {
    b.addEventListener('click', () => {
      const s = b.dataset.sort;
      if (SHIP_STATE.sort === s) SHIP_STATE.dir *= -1;
      else { SHIP_STATE.sort = s; SHIP_STATE.dir = -1; }
      SHIP_STATE.page = 1;
      drawShips();
    });
  });

  const pager = document.getElementById('shipPager');
  pager.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.p === 'prev') SHIP_STATE.page--;
    if (b.dataset.p === 'next') SHIP_STATE.page++;
    drawShips();
  });

  drawShips();
}

function sortShips() {
  const keyOf = (x) => (SHIP_STATE.sort === 'battles' ? x.battles : SHIP_STATE.sort === 'tier' ? x.tier : x.tShip);
  const pool = SHIP_STATE.tier && SHIP_STATE.tier !== 'all'
    ? SHIP_STATE.list.filter((s) => String(s.tier) === SHIP_STATE.tier)
    : SHIP_STATE.list;
  return [...pool].sort((a, b) => {
    let d = (keyOf(a) - keyOf(b)) * SHIP_STATE.dir;
    if (d !== 0) return d;
    d = b.battles - a.battles;
    if (d !== 0) return d;
    return String(a.name).localeCompare(String(b.name), 'zh');
  });
}

function drawShips() {
  const card = document.getElementById('shipcard');
  if (!card) return;
  const sorted = sortShips();
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  SHIP_STATE.page = Math.min(Math.max(1, SHIP_STATE.page), pages);
  const start = (SHIP_STATE.page - 1) * PAGE_SIZE;
  const slice = sorted.slice(start, start + PAGE_SIZE);

  const rows = slice.map((sh) => {
    const b = bandOf(sh.tShip);
    const shrink = (sh.battles / (sh.battles + 30) * 100).toFixed(0);
    return `<tr>
      <td><span class="tier">${sh.tier}</span>${escapeHtml(sh.name)}</td>
      <td>${fmt(sh.battles)}</td>
      <td style="color:#65748c">${shrink}%</td>
      <td>${sh.C.toFixed(2)}</td>
      <td><span class="tpill" style="color:${b[2]};background:${b[2]}1f">${Math.round(sh.tShip)}</span></td>
    </tr>`;
  }).join('');

  document.getElementById('shipBody').innerHTML = rows ||
    '<tr><td colspan="5" class="empty">没有满足条件的舰船</td></tr>';

  card.querySelectorAll('.sorts button').forEach((b) => {
    const active = b.dataset.sort === SHIP_STATE.sort;
    b.classList.toggle('active', active);
    const arrow = active ? (SHIP_STATE.dir === -1 ? ' ↓' : ' ↑') : '';
    const label = { battles: '场次', tier: '等级', score: '单船评分' }[b.dataset.sort];
    b.textContent = label + arrow;
  });

  document.getElementById('shipPager').innerHTML = `
    <button data-p="prev" ${SHIP_STATE.page <= 1 ? 'disabled' : ''}>上一页</button>
    <span>第 ${SHIP_STATE.page} / ${pages} 页 · 共 ${fmt(total)} 艘${SHIP_STATE.tier && SHIP_STATE.tier !== 'all' ? '（' + SHIP_STATE.tier + ' 级）' : ''}</span>
    <button data-p="next" ${SHIP_STATE.page >= pages ? 'disabled' : ''}>下一页</button>`;
}
