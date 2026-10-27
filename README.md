# WoWS PR 研究 · 工作区

《战舰世界》个人评级（PR）的数据抓取、原理拆解与评分体系设计。
本项目从 2026-10-23 开始，迁移自 `C:\Users\m1381\Documents\deepseek-harness\default-workspace`。

---

## 一、目录结构

```
wows-pr\
├── README.md                  ← 本文件
├── start.ps1                  ← 站点启动脚本
├── *.html / *.pdf             ← 交付物（8 个）
├── app\                       ← PR 查询站点
│   ├── server.js              ← HTTP 服务（前端 + /api/player + /api/ship）
│   ├── scorer.js              ← 评分核心
│   ├── shipdetail.js          ← 单船详情聚合（Worker 与本地共用）
│   ├── build_static_calibration.js
│   ├── data\                  ← baselines / calibration / shipmeta
│   └── public\                ← index.html / app.js / style.css / ship.html / ship.js
├── previews\                  ← 预览图
├── pipeline\                  ← 采集 / 解析 / 生成脚本
│   └── dumps\                 ← 中间数据与原始响应
└── session\
    ├── 会话记录.md             ← 可读版对话记录（24 轮）
    └── session_raw.jsonl      ← 原始事件日志（8.8 MB，4008 条）
```

> `pipeline` 下的脚本仍按原相对路径工作：**在 `pipeline` 目录内执行**，输出会写到 `../`（即本目录根）。

---

## 一点五、PR 查询站点（app）

```powershell
cd C:\Users\m1381\Desktop\wows-pr
.\start.ps1 -AppId "你的32位WG应用ID"
# 打开 http://127.0.0.1:5173
```

**数据政策（重要）**：站点只使用 **wowsdb 公开基准表** 作为参考数据，不再自行采样人群。
- 基准：`pipeline\dumps\wowsdb_baseline_full.json`（937 艘，按场次加权的七维均值）
- 分布：参数化校准（σ 为设定常数，scaleZ=0.35；分数刻度 1500 ± 500，夹紧分位 0.135%–99.865%，严格覆盖 0–3000），非人群实测
- 玩家数据：查询时实时调用 Wargaming 官方 API（仅取被查询者本人）

评分链路：

```
每船 7 维 z = clip(ln(实际/基准) / σ, −3, +3)
→ 舰种加权 C → 收缩 C·n/(n+30)（全部船只，无场次门槛） → 按场次汇总 Z
→ T = 1500 + 500·(Z / 0.35)
```

`pipeline\sample_pop.js` 是早期的人群采样脚本，**已停用**，仅供参考。

**自定义权重**：结果页内置「100 点制」加点表（5 舰种 × 7 维），支持 +/− 与手动输入，
超出 100 会自动夹回；每个舰种的「剩余」归零后才可点「按此权重计算」。
权重通过 `&w=<JSON>` 传给服务端，服务端会校验每组合计为 100。

**单船详情页**：结果页「全部舰船」表格里点船名（或整行）会在新窗口打开
`/ship.html?q=<昵称>&sid=<shipId>`，数据来自 `GET /api/ship?q=&sid=`。内容包括：
单船分 + 该玩家队列内排名、七维「本船 / 同船全服基准」对比（含超过全服多少百分比）、
详细数据（场均与单场最高、胜平负、存活率、主炮/鱼雷命中率、最近战斗）。
精度：命中率取 `main_battery` / `torpedoes` 的 shots/hits；**航母不显示命中率**（无主炮/鱼雷命中数据）。
权重为 0 的维度只展示并标注「不计分」。

**玩家 PK**：`/pk?a=<昵称A>&b=<昵称B>`，数据来自 `GET /api/pk?a=&b=[&w=]`，
计算在 `app\pkcompare.js`（Worker 与本地 server 共用）。分两层：

- **L1 总账**：各自总分 / 百分位 / 七维 z（z 与权重无关，可直接比）。
- **L2 同船对决**（主判据）：只取两人都打过的船，同船 = 同一基准、同一分母。
  逐船 `ΔC = C_A − C_B`，权重 `w = n·n/(n+30)`、`n = min(场次A, 场次B)`；
  `edge = Σw·ΔC / Σw`，再除以单船 C 的离散度 `SHIP_SD = 0.72` 得标准差分 `sdEdge`。
- 判词按 `|sdEdge|`：<0.15 势均力敌、<0.40 略占上风、<0.80 明显更强、其余压倒性优势；
  置信度用 `se = SHIP_SD/√n_eff`（`n_eff=(Σw)²/Σw²`）算 z 值，|z|<2 记「置信度低」。
- 护栏：共同船 <5 艘或共同场次 <100 时只给 L1，逐船表标注「样本少」（<10 场，按 0.55 透明度弱化）。


---
## 二、交付物

| 文件 | 内容 |
|---|---|
| `JiangYi_HuaiXi_战绩报告.html` | 站点数据版报告（wows-numbers 抓取，含 PR/近 180 天趋势） |
| `Reloading_Kawakaze_FOX_战绩报告.html` | 同上，第二位玩家 |
| `JiangYi_HuaiXi_官方API版.html` | 官方 API 版报告（无 PR，含七维自算汇总） |
| `Reloading_Kawakaze_FOX_官方API版.html` | 同上 |
| `PR评级计算原理.html` / `.pdf` | wows-numbers PR 公式拆解 + 算例 + 交互计算器 |
| `wowsdb-PR计算原理.html` / `.pdf` | wowsdb 七维 PR 拆解 + 七维总表 + 全量分布 |

四份报告均已统一为**亚服中文舰名**（取自客户端 `zh_sg` 语言包）。

---

## 三、关键数据资产（`pipeline\dumps\`）

| 文件 | 大小 | 说明 |
|---|---:|---|
| `iwarship_asia_442.json` | 7.4 MB | 浩舰数据库全量（12 张表：舰船/主炮/穿深/防空…） |
| `ships_stats_raw.json` | 489 KB | 官方 API 逐船战绩（JiangYi_HuaiXi，460 艘） |
| `wowsdb_baseline_full.json` | 181 KB | wowsdb PR 基准全量（937 艘，翻页抓取） |
| `wowsdb_account.json` | 150 KB | 该账号 176 艘船的 wowsdb 复算结果 |
| `expected.json` | 116 KB | wows-numbers 期望值表（1050 条） |
| `api_a.json` / `api_b.json` | 107 / 7 KB | 两位玩家的官方 API 汇总数据 |
| `data.json` / `data_b.json` | 81 / 6 KB | 站点抓取版本（已转亚服译名：`data_reloc_*`） |
| `names_zh_sg.json` | — | 亚服舰名映射（1324 条，来自客户端语言包） |
| `wowsdb_rating.html` | 513 KB | wowsdb PR 说明页原始 HTML |
| `pr_page.html` | 29 KB | wows-numbers PR 说明页原始 HTML |

---

## 四、脚本索引（`pipeline\`）

**官方 API 采集**
- `wows_api.js` — 主采集器：昵称 → 逐船七维 → 汇总 JSON（需 `WG_APP_ID`）
- `api_fields.js` — 枚举 API 全部字段（排查用）
- `ship7.js` / `ship_detail.js` — 单船 / 单船详情探查

**站点抓取（Cloudflare 路线）**
- `probe.js` `grab.js` `read.js` `read2.js` — 浏览器通道与页面读取
- `extract.js` `extract2.js` `parse.js` `parse2.js` — 表格解析
- `search.js` `fetchjs.js` `catch.js` — 站内搜索 / 资源抓取
- `switch.js` `conn.js` `mihomo-ctl.js` — 代理节点控制（Mihomo Party 管道）

**浩舰 / wowsdb**
- `wdb_net.js` `wdb_page.js` `wdb_scrape_all.js` — wowsdb 基准翻页抓取（937 艘）
- `parse_baseline*.js` — 基准表解析
- `wowsdb_calc.js` `wowsdb_full.js` `wowsdb_summary.js` — wowsdb 口径复算

**PR 计算与文档**
- `pr_calc.js` — wows-numbers PR 复算（3 维）
- `pr_work.js` — 算例数值生成
- `build_names.js` `relocalize.js` — 亚服舰名映射与替换
- `build.js` `template.html` — 报告生成
- `pdf_gen.js` `shot.js` `crop.js` — 渲染、截图、PDF
- `session_md.js` `unzstd.js` — 会话日志解码

---

## 五、复现方法

```powershell
cd C:\Users\m1381\Desktop\wows-pr\pipeline

# 需要 Wargaming 的 application_id（不要写进文件）
$env:WG_APP_ID = "你的32位key"

# 抓一位玩家
node wows_api.js "JiangYi_HuaiXi" dumps/api_new.json

# 生成报告（输出到上一级目录）
node build.js dumps/api_new.json "..\新报告.html"

# 导出 PDF + 预览图
node pdf_gen.js "..\新报告.html" "..\新报告.pdf" "..\previews\新报告.png"
```

抓取 wows-numbers / wowsdb 的脚本需要代理 + 真实浏览器（Cloudflare 挑战），
依赖 `puppeteer-core` 与 Edge：`npm install puppeteer-core`。

---

## 六、核心结论速查

**数据源**
- 官方 API：`api.worldofwarships.asia/wows`，账号级 `account/info`（pvp 47 字段 + 5 模式 extra）、逐船 `ships/stats`（36 字段）
- 拿不到：逐场记录、队友/对手、时间序列、排位分

**wows-numbers PR**
```
r = 实际/期望 ；n = max(0,(r−零点)/斜率)
PR = 700·nDmg + 300·nFrags + 150·nWins   （零点 0.4 / 0.1 / 0.7）
```
期望值表：`api.wows-numbers.com/personal/rating/expected/json/`

**wowsdb PR**
```
逐船 7 维比值(0~3) × 舰种权重 → C ；单船 = 1000+(C−1)×2000
账号 = Σ(单船×场次)/Σ场次 （全部船只，无场次门槛）
```

**计算得到的数值**

| 项目 | 结果 |
|---|---:|
| JiangYi_HuaiXi wows-numbers PR | 1631（站点 1632） |
| JiangYi_HuaiXi wowsdb PR | 1382（176 艘 / 5674 场） |
| 该账号七维总表 | 伤害 1.246 / 击杀 1.227 / 侦察 1.257 / 抗伤 1.174 / 占点 0.618 / 存活 1.007 / 胜率 1.064 |

---

## 七、会话记录

`session\会话记录.md` 为 24 轮对话的可读整理（自动提取用户与助手消息）；
`session\session_raw.jsonl` 是完整事件流，含工具调用与结果，可另行分析。

---

## 八、下一步（待办）

1. **评分体系设计落地**：对数化 + 小样本收缩 + 经验 CDF 校准（目标正态）
2. **人群采样**：1,000–100,000 账号，建立每船 μ/σ 基准与校准表
3. **权重敏感性实验**：等权 / 现行 / 集中三套方案对比偏度、峰度、撞线率

---

## 九、注意事项

- `WG_APP_ID` 未写入任何文件，仅存在于运行时环境变量
- 抓取 wows-numbers 需要住宅节点（`🇭🇰香港T04 家宽`）+ 真实 Edge 通过人机验证
- 浩舰 / wowsdb 均为第三方站点，数据仅作个人研究，批量抓取与再分发需谨慎

---

## 十、部署到互联网（Render / Railway）

站点已做成**自包含**：运行时只依赖 `app/` + `package.json`，不需要 `pipeline/dumps` 里的大文件。

### Render（推荐，免费额度）

1. 把代码推到 GitHub（只提交 `app/`、`package.json`、`render.yaml`）：
   ```powershell
   cd C:\Users\m1381\Desktop\wows-pr
   git init; git add app package.json render.yaml; git commit -m "wows pr lab"
   git remote add origin https://github.com/<你的账号>/wows-pr-lab.git
   git branch -M main; git push -u origin main
   ```
2. Render 控制台 → **New +** → **Blueprint** → 选择仓库（自动读 `render.yaml`）
   或 **New +** → **Web Service** → 选仓库，Build `npm install`，Start `npm start`
3. 环境变量里填 `WG_APP_ID`（只存在 Render，不进仓库）
4. 部署完成后得到 `https://<名字>.onrender.com`

### Railway（备选）

```powershell
npm i -g @railway/cli
railway login
cd C:\Users\m1381\Desktop\wows-pr
railway init
railway variables set WG_APP_ID=你的key
railway up
```

### 注意事项

- 免费实例闲置 15 分钟会休眠，首次访问约 30 秒冷启动；可用 cron-job.org 每 10 分钟请求 `/api/meta` 保活
- 区域选 **Singapore**，国内访问相对快
- 服务端已内置限流：每 IP 每分钟 20 次查询（实测 19 次 200 + 4 次 429）
- `HOST` 默认 `0.0.0.0`、`PORT` 读取平台注入值，本地与云端通用

---

## 十一、已部署（Cloudflare Workers）

**线上地址：** https://pr.wows-tool.top

| 项 | 说明 |
|---|---|
| 运行环境 | Cloudflare Workers（免费计划，无需绑卡） |
| 入口脚本 | `worker/index.js` |
| 静态资源 | `app/public`，通过 Workers Assets 提供 |
| 数据 | `app/data/*.json` 打包进 Worker（约 305 KiB，gzip 80 KiB） |
| 密钥 | `WG_APP_ID` 存为 Worker Secret，不进仓库 |
| 自定义域 | `pr.wows-tool.top`（Cloudflare 托管，自动 SSL） |

### 重新部署

```powershell
# 首次或换机器：登录
npx wrangler login

# 部署
npm run deploy

# 设置密钥（只需一次）
npx wrangler secret put WG_APP_ID
```

### 本地调试 Worker

```powershell
npx wrangler dev --var WG_APP_ID:你的key
# http://127.0.0.1:8787
```

> 注意：`*.workers.dev` 域名在国内被 DNS 污染，直连超时，所以必须绑自定义域名。
