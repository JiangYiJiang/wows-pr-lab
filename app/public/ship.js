'use strict';
/* 单船详情页 */
const qs = new URLSearchParams(location.search);
const Q = (qs.get('q') || '').trim();
const SID = Number(qs.get('sid'));
const WRAW = qs.get('w');
const out = document.getElementById('out');
const back = document.getElementById('back');

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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

if (Q) {
  back.href = '/?q=' + encodeURIComponent(Q) + (WRAW ? '&w=' + encodeURIComponent(WRAW) : '');
  document.title = `${Q} · 舰船详情 · PR Lab`;
}

function fail(msg) {
  out.innerHTML = `<div class="card"><div class="error">${esc(msg)}</div>
    <div style="margin-top:16px"><a class="backlink" href="${esc(back.href)}">← 返回计算器</a></div></div>`;
}

(async function load() {
  if (!Q || !Number.isFinite(SID) || SID <= 0) { fail('链接参数不完整（缺少 q 或 sid）'); return; }
  let url = `/api/ship?q=${encodeURIComponent(Q)}&sid=${SID}`;
  if (WRAW) url += '&w=' + encodeURIComponent(WRAW);
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!d.ok) { fail(d.error || '加载失败'); return; }
    render(d);
  } catch (e) {
    fail('网络错误：' + e.message);
  }
})();

/* 条形：以 100% 为中线，对数刻度，×2 正好占满半条 */
function barHtml(ratio) {
  const off = Math.max(-50, Math.min(50, (Math.log(ratio) / Math.LN2) * 50));
  const w = Math.abs(off);
  const left = off >= 0 ? 50 : 50 - w;
  const col = off >= 0 ? 'linear-gradient(90deg,#4cc9f0,#3ddc97)' : 'linear-gradient(90deg,#ff8f5c,#ff6b6b)';
  return `<div class="cmptrack"><span class="cmpmid"></span><i style="left:${left}%;width:${w}%;background:${col}"></i></div>`;
}

function cmpRow(d) {
  const up = d.ratio >= 1;
  const isPt = d.suffix === '%';
  const gap = isPt
    ? `${Math.abs(d.actual - d.base).toFixed(2)}pt`
    : `${(Math.round(Math.abs(d.ratio - 1) * 1000) / 10)}%`;
  const col = up ? '#3ddc97' : '#ff8f5c';
  const zero = d.weight === 0 ? '<span class="w0" title="该维度权重为 0，只展示不参与评分">不计分</span>' : '';
  return `<div class="cmprow${d.weight === 0 ? ' zero' : ''}">
    <span class="cmpname">${d.label}${zero}</span>
    ${barHtml(d.ratio)}
    <span class="cmpval">${fmt(d.actual, d.digits)}${d.suffix}<em> / ${fmt(d.base, d.digits)}${d.suffix}</em></span>
    <span class="cmpratio" style="color:${col}">${up ? '↑ +' : '↓ −'}${gap}</span>
    <span class="cmppct">超过 <b style="color:${col}">${d.pct}%</b></span>
  </div>`;
}

function stat(label, value, sub) {
  return `<div class="stat"><div class="k">${label}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
}

function render(d) {
  const s = d.ship, sc = d.score, st = d.stats;
  const band = bandOf(sc.tShip);
  const isCV = s.type === 'AirCarrier';
  const cmps = d.dims.map(cmpRow).join('');

  const acc = (!isCV && st.main.shots > 0)
    ? stat('主炮命中率', st.main.rate.toFixed(1) + '%', `${fmt(st.main.hits)} / ${fmt(st.main.shots)} 发`)
    : '';
  const torp = (st.torp.shots > 0)
    ? stat('鱼雷命中率', st.torp.rate.toFixed(1) + '%', `${fmt(st.torp.hits)} / ${fmt(st.torp.shots)} 发`)
    : '';

  out.innerHTML = `
  <div class="card shiphead-card">
    <div class="shiphead">
      <span class="tierbig">${s.tier === 11 ? '★' : s.tier}</span>
      <div class="shipnames">
        <h1>${esc(s.zh)}</h1>
        <div class="shipen">${esc(s.name)} · ${esc(s.typeZh)} · ${nationName(s.nation)}</div>
      </div>
      <a class="owner" href="${esc(back.href)}">${esc(d.player.name)}</a>
    </div>
  </div>

  <div class="card">
    <div class="score-main">
      <div class="gauge">
        <div class="T" style="color:${band[2]}">${fmt(sc.tShip)}</div>
        <div class="band" style="color:${band[2]};background:${band[2]}1f">${band[1]}</div>
        <div class="sub">全服同船平均 1,500</div>
      </div>
      <div class="who">
        <div class="kpis">
          <div class="kpi"><div class="k">场次</div><div class="v">${fmt(sc.battles)}</div></div>
          <div class="kpi"><div class="k">胜率</div><div class="v">${st.winrate.toFixed(2)}%</div></div>
          <div class="kpi"><div class="k">队内排名</div><div class="v">${d.fleet.rank} <span style="font-size:13px;color:var(--dim2)">/ ${d.fleet.total}</span></div></div>
          <div class="kpi"><div class="k">收缩权重</div><div class="v">${Math.round(sc.shrink * 100)}%</div></div>
        </div>
        <div class="note" style="margin-top:12px">
          综合比值 C = <b>${sc.C.toFixed(3)}</b> · 单船分 = 1500 + 500 × C（未收缩）· 队内排名按单船分在该玩家全部 ${d.fleet.total} 艘船中的位置
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="sec-title">与全服对比（同船全部玩家平均 = 中线）</div>
    <div class="cmphead">
      <span>维度</span><span>相对全服</span><span>本船 / 全服</span><span>差距</span><span>百分位</span>
    </div>
    <div class="cmps">${cmps}</div>
    <div class="note" style="margin-top:14px">
      百分位按各维度标准差换算（<b>模型估算</b>，非逐人实测）：超过 69% 表示优于约 69% 的同船玩家。
      伤害/击杀/侦察/抗伤/占点为场均，胜率与存活为百分比。
    </div>
  </div>

  <div class="card">
    <div class="sec-title">详细数据</div>
    <div class="statgrid">
      ${stat('场均伤害', fmt(st.damage.avg), '总计 ' + fmt(st.damage.total) + ' · 最高 ' + fmt(st.damage.max))}
      ${stat('场均击杀', st.frags.avg.toFixed(2), '总计 ' + fmt(st.frags.total) + ' · 单场最高 ' + st.frags.max)}
      ${stat('场均侦察', fmt(st.scout.avg), '总计 ' + fmt(st.scout.total) + ' · 最高 ' + fmt(st.scout.max))}
      ${stat('场均抗伤', fmt(st.pot.avg), '总计 ' + fmt(st.pot.total) + ' · 最高 ' + fmt(st.pot.max))}
      ${stat('场均占点', st.cap.avg.toFixed(2), '总计 ' + fmt(st.cap.total) + ' · 防守 ' + fmt(st.dropped.total))}
      ${stat('存活率', st.survRate.toFixed(1) + '%', `${fmt(st.survived)} / ${fmt(st.battles)} 场存活`)}
      ${stat('胜 / 负 / 平', `${st.wins} / ${st.losses} / ${st.draws}`, '胜率 ' + st.winrate.toFixed(2) + '%')}
      ${acc}
      ${torp}
      ${stat('场均经验', fmt(st.xp.avg), '总计 ' + fmt(st.xp.total) + ' · 最高 ' + fmt(st.xp.max))}
      ${stat('击落飞机', fmt(st.planes.total), '单场最高 ' + st.planes.max)}
      ${stat('最近战斗', st.lastBattle ? new Date(st.lastBattle * 1000).toLocaleDateString('zh-CN') : '—', '')}
    </div>
  </div>

  <div class="card">
    <details>
      <summary>这页的数字怎么来的？</summary>
      <div class="inner">
        1. 数据来自 Wargaming 官方 API 的 <code>ships/stats</code>（随机战），即该玩家这艘船的全部历史累计。<br>
        2. 基准是该船在全服（三区合并）的全部玩家平均值，来自第三方公开基准表。<br>
        3. 每个维度算 <code>z = ln(本船/全服) / σ</code>，再按舰种权重加权成 C；百分位由 z 换算成标准正态分布的分位。<br>
        4. 单船分 = <code>1500 + 500 × C</code>，与列表页同一把尺子；队内排名按 C 排序。<br>
        <span style="color:#65748c">注意：单船分未做小样本收缩，场次很少的船分数波动大（列表页的「收缩权重」列即为此）。</span>
      </div>
    </details>
  </div>`;

  document.getElementById('m-time').textContent = d.params ? `v${d.params.version}` : '';
}

const NATIONS = {
  usa: '美国', japan: '日本', germany: '德国', ussr: '苏联', uk: '英国',
  france: '法国', italy: '意大利', pan_asia: '泛亚', europe: '欧洲',
  pan_america: '泛美', netherlands: '荷兰', spain: '西班牙', commonwealth: '英联邦',
};
function nationName(n) { return NATIONS[n] || n || ''; }
