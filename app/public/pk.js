'use strict';

const $ = (sel) => document.querySelector(sel);
const out = $('#out');
const inputA = $('#qa');
const inputB = $('#qb');
const btn = $('#fight');

const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BANDS = [
  [2500, '顶尖', '#e0457b'], [2000, '优秀', '#5c7cfa'], [1500, '良好', '#3ddc97'],
  [1000, '平均', '#e8b455'], [500, '偏低', '#ff8f5c'], [-999, '待提升', '#a35b5b'],
];
const bandOf = (t) => BANDS.find((b) => t >= b[0]);

const VERDICT_COLOR = {
  crush: '#e0457b', clear: '#e8b455', slight: '#4cc9f0', even: '#93a3ba',
};

const PAGE_SIZE = 20;
let STATE = { data: null, page: 1, filter: 'all' };
let WEIGHTS = null;
let BUSY = false;

/* ---------- 启动 ---------- */
(function init() {
  const sp = new URLSearchParams(location.search);
  const a = sp.get('a') || '';
  const b = sp.get('b') || '';
  try {
    const w = sp.get('w');
    if (w) WEIGHTS = JSON.parse(w);
  } catch (e) { WEIGHTS = null; }
  inputA.value = a;
  inputB.value = b;
  if (a && b) fight();
  else if (a) inputB.focus();
})();

btn.addEventListener('click', fight);
inputA.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (!inputB.value) inputB.focus(); else fight(); } });
inputB.addEventListener('keydown', (e) => { if (e.key === 'Enter') fight(); });
$('#swap').addEventListener('click', () => {
  const a = inputA.value;
  inputA.value = inputB.value;
  inputB.value = a;
  if (inputA.value && inputB.value) fight();
});
document.querySelectorAll('.examples button').forEach((b) => {
  b.addEventListener('click', () => {
    inputA.value = b.dataset.a;
    inputB.value = b.dataset.b;
    fight();
  });
});

function fight() {
  const a = inputA.value.trim();
  const b = inputB.value.trim();
  if (!a || !b || BUSY) return;
  BUSY = true;
  btn.disabled = true;
  STATE.page = 1;
  STATE.filter = 'all';
  out.innerHTML = `<div class="card"><div class="loading"><span class="spinner"></span>正在对比 ${esc(a)} 与 ${esc(b)}…</div></div>`;

  let url = `/api/pk?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  if (WEIGHTS) url += `&w=${encodeURIComponent(JSON.stringify(WEIGHTS))}`;
  fetch(url)
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok) throw new Error(d.error || '对比失败');
      STATE.data = d;
      render(d);
      history.replaceState(null, '', `/pk?a=${encodeURIComponent(d.a.name)}&b=${encodeURIComponent(d.b.name)}`);
    })
    .catch((e) => {
      out.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    })
    .finally(() => { btn.disabled = false; BUSY = false; });
}

/* ---------- 渲染 ---------- */
function render(d) {
  const { a, b, l1, l2 } = d;
  out.innerHTML = [
    duelCard(a, b, l1, l2),
    l2.available ? tugCard(a, b, l2) : '',
    dimsCard(l1, a, b),
    l2.available ? shipsCard(a, b, l2) : '',
    howCard(d),
  ].join('');
  bindShips();
}

function sideHead(p, side) {
  const band = bandOf(p.T);
  const cls = p.classes && p.classes[0];
  return `<div class="duelside ${side}">
    <div class="dname">${esc(p.name)}</div>
    <div class="dscore" style="color:${band[2]}">${fmt(p.T)}</div>
    <div class="dband" style="color:${band[2]};background:${band[2]}1f">${band[1]}</div>
    <div class="dsub">超过 ${p.percentile}% · 计入 ${fmt(p.battles)} 场 / ${p.shipsCount} 艘</div>
    ${cls ? `<div class="dsub">主力 ${esc(cls.label)} ${fmt(cls.battles)} 场</div>` : ''}
  </div>`;
}

function duelCard(a, b, l1, l2) {
  const v = l2.available ? l2.verdict : null;
  const vc = v ? VERDICT_COLOR[v.key] : '#93a3ba';
  const edgeTxt = l2.available
    ? `${l2.sdEdge >= 0 ? '+' : ''}${l2.sdEdge.toFixed(2)} 个标准差`
    : l2.reason || '';
  const winnerName = l2.available ? (l2.winner === 'a' ? a.name : l2.winner === 'b' ? b.name : null) : null;

  return `<div class="card">
    <div class="duel">
      ${sideHead(a, 'left')}
      <div class="duelmid">
        <div class="vsbadge">VS</div>
        <div class="verdict" style="color:${vc}">${v ? v.label : '仅总账'}</div>
        <div class="vsub" style="color:${vc}">${esc(edgeTxt)}</div>
        ${winnerName ? `<div class="vsub">${l2.confidence.label}</div>` : ''}
        ${!l2.available ? `<div class="vsub">共同船 ${l2.commonCount} 艘 · ${fmt(Math.min(l2.battlesA, l2.battlesB))} 场</div>` : ''}
      </div>
      ${sideHead(b, 'right')}
    </div>
    ${l2.available ? `<div class="duelfoot">
      ${esc(winnerName || '两人')} 在 ${l2.commonCount} 艘共同舰船上赢下 ${l2.winner === 'b' ? l2.shipsWonB : l2.shipsWonA} 艘，
      加权胜率 ${((l2.winner === 'b' ? l2.winRateB : l2.winRateA) * 100).toFixed(1)}%
      · 共同场次 ${fmt(l2.battlesA)} / ${fmt(l2.battlesB)}
    </div>` : `<div class="duelfoot warnline">${esc(l2.reason || '')}</div>`}
  </div>`;
}

function tugCard(a, b, l2) {
  const w = Math.min(50, (Math.abs(l2.sdEdge) / 1) * 50);
  const left = l2.sdEdge >= 0 ? 50 : 50 - w;
  const color = l2.sdEdge >= 0 ? 'linear-gradient(90deg,#4cc9f0,#3ddc97)' : 'linear-gradient(90deg,#ff8f5c,#ff6b6b)';
  const shareA = (l2.shareA * 100).toFixed(1);
  return `<div class="card">
    <div class="sec-title">同船对决 · 天平</div>
    <div class="tug">
      <div class="tugbar">
        <span class="tugmid"></span>
        <i style="left:${left}%;width:${w}%;background:${color}"></i>
      </div>
      <div class="tugscale"><span>${esc(a.name)}</span><span>0</span><span>${esc(b.name)}</span></div>
    </div>
    <div class="duelgrid">
      <div class="dg"><div class="k">加权优势</div><div class="v">${l2.edge >= 0 ? '+' : ''}${l2.edge.toFixed(3)}</div><div class="s">C 单位</div></div>
      <div class="dg"><div class="k">折算</div><div class="v">${l2.sdEdge >= 0 ? '+' : ''}${l2.sdEdge.toFixed(2)}</div><div class="s">标准差分</div></div>
      <div class="dg"><div class="k">逐船战绩</div><div class="v">${l2.shipsWonA} : ${l2.shipsWonB}</div><div class="s">平 ${l2.shipsTie} 艘</div></div>
      <div class="dg"><div class="k">胜场占比</div><div class="v">${shareA}%</div><div class="s">${esc(a.name)}</div></div>
    </div>
  </div>`;
}

function dimsCard(l1, a, b) {
  const rows = l1.dims.map((d) => {
    const w = Math.min(50, (Math.abs(d.d) / 3) * 50);
    const left = d.d >= 0 ? 50 : 50 - w;
    const col = d.d >= 0 ? 'linear-gradient(90deg,#4cc9f0,#3ddc97)' : 'linear-gradient(90deg,#ff8f5c,#ff6b6b)';
    return `<div class="dimduel">
      <span class="dz" style="color:${d.a >= 0 ? '#3ddc97' : '#ff8f5c'}">${d.a >= 0 ? '+' : ''}${d.a.toFixed(2)}</span>
      <div class="track"><span class="mid"></span><i style="left:${left}%;width:${w}%;background:${col}"></i></div>
      <span class="dz right" style="color:${d.b >= 0 ? '#3ddc97' : '#ff8f5c'}">${d.b >= 0 ? '+' : ''}${d.b.toFixed(2)}</span>
      <span class="dlabel">${esc(d.label)}</span>
    </div>`;
  }).join('');

  return `<div class="card">
    <div class="sec-title">七维对比 · 相对各自同船基准（单位：标准差）</div>
    <div class="dimhead"><span>${esc(a.name)}</span><span>中间线 = 持平</span><span>${esc(b.name)}</span></div>
    <div class="dimduels">${rows}</div>
  </div>`;
}

function shipsCard(a, b, l2) {
  const all = l2.ships;
  const list = STATE.filter === 'all' ? all : all.filter((r) => r.winner === STATE.filter);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  STATE.page = Math.min(Math.max(1, STATE.page), pages);
  const slice = list.slice((STATE.page - 1) * PAGE_SIZE, STATE.page * PAGE_SIZE);

  const rows = slice.map((r) => {
    const col = r.winner === 'a' ? '#3ddc97' : r.winner === 'b' ? '#ff8f5c' : '#65748c';
    const sign = r.delta > 0 ? '+' : '';
    return `<tr class="${r.weak ? 'weak' : ''}">
      <td><span class="tier">${r.tier}</span>${esc(r.name)}${r.weak ? '<span class="w0">样本少</span>' : ''}</td>
      <td class="sidea">${fmt(r.battlesA)}</td>
      <td class="sideb">${fmt(r.battlesB)}</td>
      <td>${r.Ca.toFixed(2)}</td>
      <td>${r.Cb.toFixed(2)}</td>
      <td style="color:${col};font-weight:700">${sign}${r.delta.toFixed(2)}</td>
      <td style="color:#65748c">${Math.round(r.weight)}</td>
    </tr>`;
  }).join('');

  const tabs = [
    ['all', `全部 ${all.length}`],
    ['a', `${esc(a.name)} 胜 ${l2.shipsWonA}`],
    ['b', `${esc(b.name)} 胜 ${l2.shipsWonB}`],
    ['tie', `平 ${l2.shipsTie}`],
  ].map(([k, label]) => `<button data-f="${k}" class="${STATE.filter === k ? 'active' : ''}">${label}</button>`).join('');

  return `<div class="card" id="shipsCard">
    <div class="shipbar">
      <div class="sec-title" style="margin:0">共同舰船（按权重排序）</div>
      <div class="sorts">${tabs}</div>
    </div>
    <div class="wscroll">
      <table class="pktable">
        <thead><tr>
          <th>舰船</th>
          <th class="sidea">${esc(a.name)} 场次</th>
          <th class="sideb">${esc(b.name)} 场次</th>
          <th>${esc(a.name)} C</th>
          <th>${esc(b.name)} C</th>
          <th>优势</th>
          <th>权重</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">没有符合条件的舰船</td></tr>'}</tbody>
      </table>
    </div>
    <div class="pager" id="pkPager">
      <button data-p="prev" ${STATE.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span>第 ${STATE.page} / ${pages} 页 · 共 ${fmt(list.length)} 艘</span>
      <button data-p="next" ${STATE.page >= pages ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`;
}

function howCard(d) {
  const l2 = d.l2;
  return `<div class="card">
    <details>
      <summary>这个胜负是怎么算的？</summary>
      <div class="inner">
        1. 只取两人都打过、且都有全服基准的舰船，共 <code>${l2.commonCount}</code> 艘；<br>
        2. 每艘船算 <code>ΔC = C_A − C_B</code>（C 是该船七维 z 的舰种加权和，同船同基准）；<br>
        3. 权重 <code>w = n·n/(n+30)</code>，<code>n = min(场次_A, 场次_B)</code>，场次悬殊时按少的一方算；<br>
        4. 加权优势 <code>Σ(w·ΔC)/Σw</code>，再除以单船 C 的离散度 <code>σ=${l2 ? d.params.shipSd : 0.72}</code> 得到标准差分；<br>
        5. 逐船判胜，加权得到胜场比；标准差分 &lt;0.15 记势均力敌，&gt;0.8 记压倒性优势。<br>
        <span style="color:#65748c">置信度按有效样本量 <code>n_eff=(Σw)²/Σw²</code> 估算；共同船少于 5 艘或有效场次少于 100 场时只给总账对比。</span>
      </div>
    </details>
  </div>`;
}

/* ---------- 表格分页 ---------- */
function bindShips() {
  const card = document.getElementById('shipsCard');
  const pager = document.getElementById('pkPager');
  if (!card || !pager) return;
  card.querySelectorAll('.sorts button').forEach((b) => {
    b.addEventListener('click', () => {
      STATE.filter = b.dataset.f;
      STATE.page = 1;
      card.outerHTML = shipsCard(STATE.data.a, STATE.data.b, STATE.data.l2);
      bindShips();
    });
  });
  pager.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.p === 'prev') STATE.page--;
    if (b.dataset.p === 'next') STATE.page++;
    card.outerHTML = shipsCard(STATE.data.a, STATE.data.b, STATE.data.l2);
    bindShips();
  });
}
