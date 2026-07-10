---
id: F041
title: 投研跟踪台（invest-tracker）：watchlist 实体层 + 公告/研报/评级动作 source-of-record + 双管线简报 + 档案投影
status: spec
owner: 黄仁勋
created: 2026-07-10
---

# F041 — 投研跟踪台（invest-tracker）

## Why

小孙 2026-07-10 原话：「长期跟踪多个公司的研报和多个板块的最新新闻动态，但是我不知道消息源从哪里找，也没想好怎么样的形式跟用户交互」。他自己怀疑「扔进 F027 wiki 再提问」不方便——怀疑正确：wiki 是知识沉淀面，不是订阅面，无 watchlist 概念、无「不漏」保证、无时间线。

现状缺口：

1. **F037 日报没有实体概念**：股票/篮球/电竞板块已被小孙 07-03 拍板删除，剩 ai/hot/community/github 四类泛科技流；「新易盛今天发了什么公告」这类 per-entity 问题它回答不了。
2. **全系统没有投研信息的 source-of-record**：公告、研报、评级动作没有任何一处「担保不漏」的落库；看不到=不知道发生过。
3. **F027 wiki 消费端归零**（07-10 愿景审计）：F041 是审计给出的 B 路线——做一个真实的 wiki-pattern 消费者（档案页=派生投影），但与 F027 存量管线**完全隔离**。

**北极星**：小孙 1 分钟内知道 watchlist 今天发生了什么、证据在哪、一周怎么演变。（兑现对账——冻结研报预测到期对账公告——降级为远期愿景，MVP 只留数据兼容，见 D12。）

## What

小孙可感知的交付：

- **盘前 08:00 投研简报**（独立邮件，与 F037 日报分离）：watchlist 昨日以来新增的公告 / 研报 / 评级动作，按实体分组，来源+日期+链接，纯规则渲染无 LLM；源故障显式渲染（「东财 12h 无新收录」而非假装无事）。
- **实体档案页**：每公司/板块一页只读时间线（现有 webapp 一个入口）+ Markdown 可再生投影（Obsidian 直接读）。
- **证据可溯**：每条事件回指原始来源快照（公告 PDF 链接 / 研报元数据 / 评级动作原始 JSON）。

### Watchlist（小孙 2026-07-10 拍板，A股五家已全部实测反查验证）

| 实体 | 市场 | 代码 | 巨潮 orgId / 外部 ID | 备注 |
|------|------|------|---------------------|------|
| 新易盛 | 深市 szse | 300502 | 9900026455 | 光模块 |
| 中际旭创 | 深市 szse | 300308 | 9900022016 | 光模块 |
| 天孚通信 | 深市 szse | 300394 | 9900023911 | 光器件 |
| 亨通光电 | **沪市 sse** | 600487 | **gssh0600487**（沪市 orgId 格式与深市不同，column 用 sse） | 光纤光缆 |
| 东山精密 | 深市 szse | 002384 | 9900011647 | PCB/精密制造 |
| 康宁 Corning | 美股 | GLW | CIK onboarding 时解析 | 光纤玻璃 |
| 英伟达 NVIDIA | 美股 | NVDA | CIK onboarding 时解析 | AI 硬件 |
| 美光 Micron | 美股 | MU | CIK onboarding 时解析 | 存储 |
| 板块：光模块 / CPO / 光纤 | — | — | 东财 indvInduName + 概念映射实现期定 | AI 硬件链 |

### 信源（MVP = C+ 档，德彪 r2 裁决；三级担保模型）

| 级别 | 语义 | MVP 源 |
|------|------|--------|
| **record** | 源头担保完整性，漏=事故级报警 | 巨潮公告（沪深）、SEC EDGAR（美股申报，Atom per-CIK，申报 UA=产品名+邮箱，≤10 req/s——SEC 明文允许程序化访问） |
| **aggregator** | 二手聚合，只验「已收录的不漏」，收录滞后单独监控 | 东财研报元数据（接口原生给结构化字段：infoCode/券商/分析师/评级及前次/目标价/三年盈利预测/行业，大半不用抠 PDF） |
| **supplemental** | 尽力而为，故障显式渲染，不担全量 | Yahoo upgradeDowngradeHistory（外资投行评级/目标价变动，具名 firm；**小孙拍个人用途启用**，见 D4） |

接入 spike 已在本机全部活体实测通过（真数据）：巨潮 `POST /new/hisAnnouncement/query`（stock=代码,orgId + seDate 窗口；orgId 用 topSearch 一次性解析后缓存）；东财 `GET reportapi.eastmoney.com/report/list`（qType=0，**必带 beginTime/endTime 否则 400**；`stockCode` 不是过滤参数；宁德时代窄窗 0 篇=收录滞后活证据）；EDGAR Atom；Yahoo quoteSummary（crumb 两步握手：fc.yahoo.com 取 cookie → query1/v1/test/getcrumb 取 crumb）。外资研报全文=机构付费产品，无合法免费渠道；**红线：禁止系统化收集群传/网盘泄漏 PDF**；小孙合法持有的 PDF 手动投喂入档属切片 2。

## Acceptance Criteria（MVP · 切片 1）

**实体与数据合同**

- [ ] **AC1 · 实体三层模型**：`invest_entities`（issuer/sector）+ `invest_listings`（market/exchange/symbol/currency/有效期——多地上市、改名换码可表达）+ 外部 ID 带 namespace（cninfo_orgid / sec_cik / yahoo_symbol…）；watchlist 全量 onboarding（上表 seed；CIK 解析入库）；多市场代码归一规则集（A股裸 6 位/美股裸 ticker，参考 DSA normalize_stock_code）。验收：三层查询能答「亨通光电的巨潮 orgId 和东财代码」；改名/换码场景单测。
- [ ] **AC2 · 数据合同**：`fetch_attempts`/`fetch_artifacts`（一次分页响应，CAS 快照+hash，可离线 replay）与 `source_documents`（一份公告/报告，不可变+内容 hash 去重）分离；`invest_events` + `item_attributions`（多对多外挂，method+confidence+rule_version）；`checkpoints`（orgId 缓存/水位/分页断点落库）；`forecast_observations`（东财目标价/盈利预测结构化落地，只存不算——兑现对账数据兼容）；rating_actions = invest_events 的 typed extension（event_id PK/FK），`evidence_class=primary|aggregator|secondhand` 与 source_id 分字段；publishedAt / discoveredAt / 修订撤回分开存。drizzle 现实=INIT_SQL+MIGRATIONS[] 同步三处 + 升级测试。
- [ ] **AC3 · 巨潮源（record）**：窗口拉取全 watchlist A股公告；沪深 column/orgId 格式差异正确处理；**公告错过一个盘前窗口即报警**（不等 3 天）；200-but-schema-drift 算失败；lastSuccessfulFetchAt 与 lastNewItemAt 分开监控。
- [ ] **AC4 · 东财源（aggregator）**：全市场窄窗分页拉取（**必遍历分页并验 total**）+ watchlist 逐码日核对比集，union 入库、差异记 canary；回填走 per-code；结构化字段（评级/前次评级/目标价/三年 EPS+PE/行业）直取入 forecast_observations。
- [ ] **AC5 · EDGAR 源（record）**：per-CIK Atom 拉取美股三家申报（8-K/10-K/10-Q 等）；申报 UA（产品名+联系邮箱）+ ≤10 req/s 硬编码合规。
- [ ] **AC6 · Yahoo 评级源（supplemental，已启用）**：upgradeDowngradeHistory 结构化入 rating_actions（firm/from-to grade/目标价前后值/action/epochGradeDate）；crumb 语义=401/403 原子清 cookie+crumb、**仅一次重握手+一次重放**；429 遵 Retry-After 熔断 6h→half-open→最长 24h；失败在简报渲染「Yahoo unavailable / last success N h ago」，**禁伪装「本期无评级动作」**。

**管线与投递**

- [ ] **AC7 · 双管线**：`invest-ingest`（小时抓，**不受交易日历门控**——休市日公告照进）与 `invest-delivery`（08:00 组 issue，coverage cutoff + issueId，取「尚未进任何 issue」的事件；周六 issue 覆盖美股周五 session）分离；先归档后发送 + attempted/sent 账本（复用 F037 语义、独立 namespace）。
- [ ] **AC8 · 交易日历**：exchange session 静态版本表（含 early closes + 来源 URL/sha256/版本号）；当年数据缺失=测试红；次年数据缺失=Q4 提前告警；**fail-open 只许「继续抓+有新增就发」，禁止任何路径抑制简报**。
- [ ] **AC9 · 简报**：纯规则渲染（新增事件+来源+实体+日期，按实体分组，评级矩阵内资/外资双轨同表）；per-source 健康状态行；QQ SMTP 复用（独立收发 namespace）。
- [ ] **AC10 · 档案投影**：SQLite 真相源 → Markdown 投影幂等可再生（删掉全部 md 重跑=字节级一致）；实体时间线只读入口（现有 webapp）；投影写入独立 vault 目录（见 AC11）。

**边界与隔离**

- [ ] **AC11 · 隔离合同五条 + 三层测试**：①不写 `docs/`、不写 `.runtime/wiki/`（docs-watcher 视野外的独立 vault）②不进 F027 语义索引/memory_preflight ③零审批队列影响 ④`wiki_events` 不动 ⑤独立 Obsidian vault。测试三层：**AST 静态扫描**（动态 import/require/re-export 全覆盖 + 扫描集非空断言 + boot 白名单）+ **capability narrowing**（领域层只拿 InvestRepository，拿不到 raw DB/wiki service/通用 fs writer）+ **临时根集成不变量**（sentinel 预种 → 跑 ingest+delivery 全链 → wiki_events 行集/索引/树 hash 逐字节不变，只有 invest_* 变化）。**Playwright 只验 UI，不作隔离证据**（F038 harness 关 scheduler/docs-watcher，见 LL-034）。
- [ ] **AC12 · 同进程 metadata-only 硬边界**：全局并发≤2、每 host 1、响应体 2MB cap、三层 deadline（请求/源/轮次）+ AbortSignal 逐层传递；**MVP 禁 PDF 正文下载、禁 LLM 调用、禁图片**。
- [ ] **AC13 · 进程外存活监控**：进程外探针 + 故障演练为上线 AC（kill API 进程 → 一个探测周期内外部可察觉）；/health route 现不存在需新建；简报本身=人肉心跳兜底。

**Dogfood 退出标准（AC14，验收即此四条）**

- [ ] 每启用市场各 10 个已闭市 session 内：record 源公告零漏进下封简报（口径=07:55 对照快照；cutoff 后才可见的单独计延迟，不算漏报）
- [ ] 结构化归属零错配、零重发
- [ ] 源故障 + 进程停机均进程外可察觉
- [ ] 小孙 1 分钟内答出「这公司本周发生了什么」，且愿意继续用

**Out of scope（切片 2/3，写明触发条件）**

- **切片 2**（MVP dogfood 通过后）：财联社电报 firehose（best-effort，RSSHub 实例健康度低）；AI 搜索补充情报适配层（DSA 5 维度中英 query 模板，与 F029 检索 provider 形状合流）；港股 HKEXnews（watchlist 出现港股时）；外资评级媒体转述打标（财联社「高盛：」/智通/aastocks）；**手动投喂 PDF 入档+按需深读**（extractor 无工具无网络+JSON schema 白名单+字段回指页码 span，二阶注入面借鉴 F029 injection-corpus；LLM 数据外发独立授权域，手动上传默认 local-only）；F040 IM 推送 + md2img 长报告；简报「有用/噪音/归属错」反馈按钮（德彪 r1：可能比聊天入口更有价值）。
- **切片 3**：F029 异步求证钩子（适配器后挂，零编译期依赖）；兑现对账（结构化预测+到期调度，F029 只当核查器）；Finnhub 补充源。

## Dependencies

- **F037 先合并（Phase B 硬依赖——抽零件与 HTTP/邮件/账本接线门槛）**：Phase A（建表/实体归一/四源解析 fixture/交易日历/投影/隔离测试，与 F037 零交集）已解耦先行施工（小孙 2026-07-10 拍「先推进」，worktree `.worktrees/F041`，德彪中间审收敛中）。F037 合并后 Phase B 第一步=**纯移动零行为 commit** 从 daily-digest 抽共享零件（SafeHttpTransport / BoundedTaskRunner / EmailSender（窄接口已在 email-sender.ts）/ CAS+attempted-sent 账本原语），再增量改造（结构化响应 `{status,headers,body,finalUrl}`、每源 UA（SEC 要产品名+邮箱；现 fetchText 写死浏览器 UA 拿不到 Set-Cookie）、cookie jar seam；重试熔断留在 source runner）。**禁 copy-first**（D11）；**F041 永不 import daily-digest/**\*；F037 长期卡住 → 从 F037 HEAD 显式 stacked branch，绝不在 .worktrees/F037 里叠开发。
- F040（软，切片 2 IM 推送入口）。
- F029（零编译期依赖，切片 3 适配器）。

## Design Decisions

设计已过**德彪 r1+r2 双轮真 Codex 对抗审**（r1 产品切片 241k tokens：方向 GO/方案 NEEDS-WORK→MVP v2 再砍；r2 实现蓝图 238k tokens：NEEDS-WORK 四阻塞→蓝图 v2 全接收敛）。否决记录随表保留。

| # | 决策点 | 结论 | 否决项与理由 |
|---|--------|------|-------------|
| D1 | 领域边界 | 独立 invest-tracker 领域（6+ 表自持） | **否决**给 NormalizedItem 加 entityIds、**否决** F037 泛化 multi-profile——boot/settings/scheduler 侵入半径大，反噬刚收敛的 F037 稳定性；只抽纯零件 |
| D2 | 真相源 | SQLite 真相源 + Markdown 可再生投影 | **否决**纯 Markdown 真相源——幂等/多归属/假 diff/后续对账四输；Obsidian 体验以投影保留 |
| D3 | MVP 信源档位 | **C+**：巨潮+东财+EDGAR；信源三级 record/aggregator/supplemental | **否决**「未授权源默认进 MVP」——**接口可达≠自动化授权**（Yahoo ToS 禁未授权自动采集 vs SEC 明文允许并给出 UA 政策），见 LL-032 |
| D4 | Yahoo 启用 | **启用**（小孙 2026-07-10 拍板：个人用途，风险偏好决策） | 保持 supplemental 级=不担全量+故障显式渲染；个人用量低频；授权不对称性诚实脚注留档；换许可源（如 Finnhub 付费档）可无缝替换 adapter |
| D5 | 跨市场时间窗 | 拆 invest-ingest（小时抓）+ invest-delivery（08:00 issue，coverage cutoff/issueId） | **否决**单一 businessDate 日切——EDGAR 收件到 22:00 ET，北京 08:00=前日 19/20:00 ET 必截断晚间申报，见 LL-033 |
| D6 | 实体模型 | entities + listings + 外部 ID（namespace）三层 | **否决**单表加列——多地上市（如宁德 A+H）/改名换码/CIK 与 Yahoo symbol 作用域不同，单表表达不了 |
| D7 | 抓取产物 | fetch_attempts/artifacts 与 source_documents 分离，CAS 快照 | **否决**混存——失败时无 doc 也要能落健康账；`scopes(watchlist)+fetch(ctx,scope)→FetchBatch` 替代 scopeKey(doc) |
| D8 | 评级动作建模 | invest_events 的 typed extension（event_id PK/FK）+ evidence_class 独立字段 | **否决**独立平行表——时间线/简报/归属要统一查询面 |
| D9 | 隔离证据 | AST + capability narrowing + 临时根集成不变量 三层专项测试 | **否决** Playwright 作隔离证据——F038 harness kill-switch 关 scheduler/docs-watcher，验隔离=永真假绿，见 LL-034 |
| D10 | 抓取边界 | 同进程 metadata-only 硬边界（并发≤2/2MB/三层 deadline/禁 PDF 禁 LLM） | **否决** MVP 就上正文深读——注入面+资源失控；深读进切片 2 且走独立授权域 |
| D11 | 复用方式 | F037 合并后纯移动零行为 commit → 再增量 | **否决** copy-first——双份漂移，修 bug 要修两处 |
| D12 | 北极星 | 「1 分钟知道发生了什么+证据+一周演变」 | 兑现对账（研报预测 vs 公告兑现）**降级**远期愿景——frozenClaim 现为字符串撑不起对账模型；MVP 只留 forecast_observations 数据兼容 |
| D13 | 存活监控 | 进程外探针+故障演练=上线 AC | **否决**进程内 watchdog——与被监控对象同故障域，进程死一起死，见 LL-031 |

**Design Gate 已过**（架构级=agents 讨论→小孙拍板）：德彪双轮对抗审收敛 + 小孙三拍（立项 GO / watchlist 名单 / Yahoo 个人用途启用），2026-07-10。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-10 | Kickoff：需求访谈（collaborative-thinking Mode A）→ 信源全链本机活体实测（巨潮/东财/EDGAR/Yahoo RSS/Yahoo 评级 crumb 五接口真数据）→ 德彪 r1（产品切片）+ r2（实现蓝图）双轮对抗审收敛蓝图 v2 → 小孙三拍 → 立项 |

## Links

- Discussion scratch（不入库，结论已沉淀本文件）：`.runtime/reviews/F041-design-discussion-{request,codex-r1-final,r2-request,codex-r2}.md`
- 参考项目深读：[ZhuLinsen/daily_stock_analysis](https://github.com/ZhuLinsen/daily_stock_analysis)——拿：normalize_stock_code 多市场归一 / market-support.md 能力边界文档范式 / fetcher 熔断退避遥测 / 交易日历 / 5 维度搜索 query 模板 / md2img 思路；不拿：AI 搜索当新闻主源（无 source-of-record）/ 决策评分定位 / LiteLLM / GH Actions 宿主
- 产品理念源头：仓库根 `llm-wiki.md`（小孙的 LLM Wiki 理念文档；其 ingest 模式=切片 2 手动投喂入口的正确用武之地）
- Lessons：LL-031 / LL-032 / LL-033 / LL-034（本次立项沉淀）

## Evolution

- **Evolved from**: F037（日报管线——复用其纯零件与账本语义，第二条独立管线）+ F027（愿景审计 B 路线：做真实 wiki-pattern 消费者，但全隔离）
- **Blocks**: 无
- **Related**: F029（切片 3 求证钩子）、F040（切片 2 IM 推送）、F042（同期立项，无耦合）
