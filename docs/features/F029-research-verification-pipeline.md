---
id: F029
title: 调研与核查管道（fact-check + deep-research 双模式）
status: spec
owner: 黄仁勋
created: 2026-06-12
---

# F029 — 调研与核查管道（fact-check + deep-research 双模式）

> AC 体系 2026-06-12 v2 重组为 `AC-Px-n`（德彪整体审 NEEDS-WORK 后，按 Phase 拆分；旧 AC1-25 编号废弃）。

## Why

小孙愿景（2026-06-11 原话）：

> 我给出需要检索的信息之后，可以信息搜索，要有交叉验证，要给出引用源，判断是否是 fake news。类似 unifuncs U深搜。入口我还是想要。

> 我需要多 agent 验证，这样才能客观。而且我不怕引入依赖，我要的是做好，真正符合我的需求。

> （2026-06-12 追加）如果我也想要深度搜索呢？

参考产品 unifuncs「U深搜」= 深度搜索 + 事实核查一体两面。现有能力的缺口：

- CLI 内置 deep-research skill 是研究综述人设，无真伪裁决格式，且改不了源码
- runtime 现把 codex web search 压缩成 `[web search completed]`，`ToolEvent` 无 URL/query/发布时间等审计字段（`packages/api/src/runtime/codex-runtime.ts:103`、`packages/shared/src/tool-event.ts:3`），检索过程不可复现不可比较
- 纯 skill 形态无稳定状态、无结构化证据存储、无可审计引用——撑不起"真正做好"

**核心风险定位（德彪整体审）**：本 feature 最大风险不是"搜不到"，而是**高成本地产生看似严谨的错误结论**。所以质量验收（判得对不对）、真正的独立性、可审计证据、外发数据边界是第一优先，不是功能清单。

## What

在产品 runtime 落一条**调研与核查管道**：统一检索层 + 异质 agent 独立取证 + 结构化证据账本 + fail-closed 裁决，**一个中性共享底座、两个模式投影（projection）**：

| | `/fact-check <声明>` | `/deep-research <课题>` |
|---|---|---|
| 输入 | 待核查的断言 | 开放问题 |
| 拆解 | 原子 claim 拆分（时间/主体限定） | 维度/子课题拆分 |
| 检索策略 | 对抗式（disconfirm first） | 覆盖式（multi-query union） |
| 输出 projection | 四字段裁决 + 分歧 + 引用 | 综合报告（支持/反对/未定），不判真假 |

**中性底座领域模型**（德彪 D2，防底座被 fact-check 形状绑架）：`ResearchCase / QuestionUnit / RetrievalPlan / EvidenceItem / Assessment / ReportProjection`。fact-check 裁决与 deep-research 综合各是一个 ReportProjection。Phase 1 必须含 deep-research walking skeleton（固定 fixture 跑通），证明底座非单消费者。

### 裁决本体：四字段（德彪 D5，原"三轴"不正交，重做）

| 字段 | 取值 | 说明 |
|---|---|---|
| `claim_relation` | supported / contradicted / mixed / insufficient | 证据与声明的关系（核心真假轴） |
| `confidence` | 校准置信带（low/med/high，需 gold set 校准） | 不是拍脑袋，要可校准 |
| `context_flags` | misleading-context / outdated / cherry-picked（多选） | 表达/上下文属性，从真假轴拆出 |
| `fabrication` | not-assessed / evidenced | **仅有直接来源谱系证据**才标 evidenced，否则 not-assessed（v1 不自动判意图） |

例：`supported + med` = 较可能为真；`contradicted + high` 才明确判假；`insufficient` = fail-closed 弃权（"没搜到"≠假）。

### 信息渠道分层（小孙 2026-06-12："有些必须去平台搜的"；"中文英文都要"）

通用搜索引擎对平台内容覆盖结构性残缺（微信公众号基本不被索引、微博/小红书部分或不可达），而 fake news 主战场恰在平台内。四通道，每渠道 = 一个 SearchProvider 实现：

| 通道 | 适用 | 登录 |
|---|---|---|
| ① API 直连 | 通用搜索 API（中文优先+全球）、Reddit、B站、Google News、巨潮/SEC 财报库 | 无 |
| ② 网页公开搜索 | 微博(部分)、知乎、雪球(部分)、搜狗微信通道、TG 公开频道 | 免/轻 |
| ③ 登录态浏览器 | 小红书、X、雪球完整版、微博完整版 | 要（默认关闭，见安全节） |
| ④ 事实核查机构白名单 | Snopes / PolitiFact / AFP·Reuters Fact Check / 腾讯较真 / 台湾事实查核中心 | 无 |

- 路由：claim 打类型标 → 财经→雪球/财新/巨潮/公告；社会新闻→微博/官方通报；国外科技→X/Reddit/HN/官方博客
- 通道④定位：他方已核结论 = 高性价比线索，但按 source-audit 当二手来源标注，不直接替代裁决
- **不每个 case 强制全跑所有官方源+核查机构**（德彪砍），按路由命中触发

### 登录态通道工程方案（德彪登录态深审 6 [DISAGREE] 收敛）

- **独立 `AuthenticatedBrowserService`**（不并入 screenshot-service）；复用 playwright 定位工具，业务生命周期分离
- profile `.runtime/browser-profiles/<platform>/<account>/`；**复用磁盘状态非长驻 context**；每平台单并发 FIFO + 跨进程 lease；元数据库不存 cookie
- 登录链路：前端点"登录X" → `POST login-session` 取 lease → headed context 只开登录页 → WS 状态机（waiting_user→verifying→ready/failed）→ 平台适配器 `probeAuth()`+`probeSearchCapability()` 双探判定（URL/单 cookie/头像不足以判定）；非交互桌面报 `interactive_session_unavailable`
- **能力隔离 = 防注入与只读的核心防线**（不是 prompt 承诺）：agent 只能调类型化 `search(platform,query)`/`fetchPublicResult(ref)`，代码中无 `click/goto/evaluate` 入口；网络 fail-closed allowlist（只放核定读 operation，未知 POST 默认阻断）；`serviceWorkers:"block"` 后 `context.route()`；DOM 经确定性 extractor 转 `EvidenceDocument` 标 `UNTRUSTED_CONTENT`，不把原始 HTML/脚本/账号信息/私信交给模型
- **小号是硬要求**（网页登录拿不到真正只读 scope，非为防 cookie 泄露）；雪球先行但验收须用"登录后才新增的能力"场景（否则改微博等有真实门槛平台）

### 外发数据边界与安全硬约束（德彪 D6 + 小孙"信息会不会泄露"）

**诚实定调**：网页登录凭证本质可代表账号，**无法承诺零泄露**；外发面也不止 cookie——用户输入的声明会发给外部搜索 API 与三家 LLM。策略是把风险压到可控 + 对小孙透明，不是吹绝对安全。

- **外发边界**：用户输入/网页摘录/房间历史不默认全量发所有 provider；执行前展示将访问哪些 provider；检测密钥/私人身份/未公开业务信息并提示或本地降级；case 级记录实际外发对象/字段/时间
- **登录凭证默认关闭**，逐平台授权；profile 与 agent/LLM 进程隔离，cookie/localStorage/路径不进 prompt/日志/截图/通用子进程；ACL 限当前 Windows 用户 + 推荐 BitLocker；禁导出 storageState；登录态截图**不进 `.runtime/uploads`（静态暴露路径）**；日志脱敏 Cookie/token/query URL/postData
- **SSRF**：拒绝 loopback/私网/link-local/`file:`/非 HTTP(S)/DNS rebinding/重定向逃逸内网（Iron Law §4 网络边界延伸）
- **只读由执行器强制 + 自动测试**：禁 POST 写/表单/上传/点赞/关注/发帖/私信
- **v1 不接主号**（主号风险工程 guard 降不到零）

### 用户入口与 UX 三态

- **入口 A（主）**：composer 打 `/` → 命令面板（复用 F027 `components/chat/composer-slash-menu.tsx`，加 `/fact-check`；`/deep-research` 在 Phase 1 先 disabled/preview）
- **入口 B**：自然语言"帮我核查/深挖 XXX" → 路由；**执行前显示识别模式 + 冻结声明 + 预计档位 + 外发范围，一键确认或改写**（防误触多模型长任务）
- 入口 C「核查这条消息」→ 见 Open Decisions（未拍板，不进 AC）

UX 三态：入口态 → 进行中态（渐进可见：声明冻结/claim 拆分/双 agent 检索中/证据计数，复用观测带）→ 报告态（结论摘要置顶 + 证据链/分歧区/引用源折叠）。

## Acceptance Criteria

### Phase 0A — 信源与质量基线（可与 P1a 并行，不整体阻塞）

- [ ] AC-P0a-1: 信源矩阵——30+ 中外平台先轻量可达扫描（可达通道/登录/反爬/成本/内容类型/声明类型/ToS 与账号风险），再对基准命中前 8-12 渠道深测，长尾按需扩展
- [ ] AC-P0a-2: gold set 真值基准 ≥50 条中英文声明，每条预注册真值标签/时间截点/预期主来源/声明类型；含"仅平台内传播"用例 + 不可证伪/观点/预测/讽刺负样本
- [ ] AC-P0a-3: provider smoke test——候选外部 provider 对 gold set 实测召回率/官方源命中/中文覆盖/重复源比例/发布时间准确率 → 选型决策
- [ ] AC-P0a-4: 声明类型→渠道路由表 + 核查机构白名单（中外 ≥5 家）v1 定稿
- [ ] AC-P0a-5: 平台合规登记——每平台 ToS/API 条件/账号风险/允许访问方式；禁止绕过验证码/反爬/访问控制

### Phase 0B — 登录态安全 spike（独立，不进 v1 默认链路）

- [ ] AC-P0b-1: AuthenticatedBrowserService 独立 + profile 独占串行 FIFO + 跨进程 lease + 元数据库不存 cookie
- [ ] AC-P0b-2: headed 登录链路（login-session → lease → WS 状态机 → probeAuth+probeSearchCapability 双探）；非交互桌面报 interactive_session_unavailable
- [ ] AC-P0b-3: 雪球 pilot 跑通，验收用例必须是**登录后才新增的内容能力**（否则改有真实登录门槛平台）
- [ ] AC-P0b-4: 默认关闭 + 逐平台授权 + 未 ready 绝不自动弹登录窗 + 小号硬要求

### Phase 1A — 中性底座 + 隔离执行 + 安全 fetch

- [ ] AC-P1a-1: 中性领域模型底座（ResearchCase/QuestionUnit/RetrievalPlan/EvidenceItem/Assessment/ReportProjection），与 F027 HybridSearchProvider 命名/模块隔离
- [ ] AC-P1a-2: durable case 状态机——表达 case 阶段/重试/预算/取消/部分报告；幂等 task key + 断点恢复 + provider retry policy（不依赖 worklist 自由文本续推）
- [ ] AC-P1a-3: Phase A 真隔离——每个异质验证者独立 thread/context，只收同一份 hash 固定 neutral brief；测试放 **sibling-canary**，任何 agent 输出 canary 即 fail
- [ ] AC-P1a-4: SSRF 防护——拒绝 loopback/私网/link-local/file:/非 HTTP(S)/DNS rebinding/重定向逃逸内网
- [ ] AC-P1a-5: 防注入——prompt-injection 攻击 corpus 验证网页文本不能触发工具/改检索计划/访问新域/泄露 prompt 或 cookie/改 verdict schema；内容标 UNTRUSTED_CONTENT 经 extractor 转 EvidenceDocument
- [ ] AC-P1a-6: 只读执行器——agent 仅类型化 search()/fetchPublicResult()，无通用浏览器能力；禁写操作并自动测试；登录态走网络 fail-closed allowlist + serviceWorkers block
- [ ] AC-P1a-7: 证据可复现——存最终 URL + redirect chain + HTTP 状态 + 抓取时间 + 规范化摘录 + 摘录 hash + 失败原因；版权约束下快照策略

### Phase 1B — L1 检索 + 拆解 + 裁决 + 质量门槛

- [ ] AC-P1b-1: 声明原文冻结 + 原子 claim 拆分（时间/主体限定）+ 语义保真校验 + 歧义确认
- [ ] AC-P1b-2: claim eligibility 分类——截图/视频/观点/预测/讽刺/不可证伪 → out-of-scope/not-verifiable，禁硬套真假
- [ ] AC-P1b-3: 统一 SearchProvider ≥2 外部 provider（中文+全球）可配可换
- [ ] AC-P1b-4: 原生检索（codex/gemini）**仅作线索，不计入正式 verdict quorum**（不可结构化采集 query/结果/原文者不得当正式证据）
- [ ] AC-P1b-5: 四字段 verdict ontology（claim_relation × confidence × context_flags × fabrication），每核心判断带 Evidence/Reasoning/So-what/Confidence
- [ ] AC-P1b-6: quorum——正式 verdict 需 ≥2 异质模型 **且** 来源独立性（≥1 primary-source 或 2 独立 origin）；缺席者进 degradation disclosure 不永久废
- [ ] AC-P1b-7: citation entailment——每核心结论绑定精确 evidence span，独立步骤校验引用真正蕴含结论
- [ ] AC-P1b-8: 检索纪律——disconfirm-first 反例；absence 需正反两路+相关概念均 0 命中；中英双语各搜一遍；按档位停止判据
- [ ] AC-P1b-9: **裁决质量门槛（gold set 验收，最关键）**——claim 拆解正确率 / 证据召回 / 引用支持率 / 裁决准确率 / 高置信错误率上限 / 合理弃权率，全设通过阈值
- [ ] AC-P1b-10: 档位预算——Light/Full 硬成本+延迟+并发上限+超时+取消；超预算降级报告

### Phase 1C — L2 渠道 + UI + 入口 + 外发边界

- [ ] AC-P1c-1: 渠道落地——L1 双通用全量 + L2 ≥2 平台专项（基准定优先级）+ 官方白名单，统一 SearchProvider
- [ ] AC-P1c-2: 渐进式报告 UI——结论摘要→证据链→分歧区（不抹平）→可点击引用（Gemini grounding redirect 解析真实源）；进行中态渐进可见
- [ ] AC-P1c-3: 外发数据边界——执行前展示将访问 provider + 敏感信息（密钥/私人身份/未公开业务）检测提示或本地降级 + case 级记录外发对象/字段/时间
- [ ] AC-P1c-4: 入口 A（slash 加 /fact-check）+ 入口 B（自然语言，执行前显示模式/冻结声明/档位/外发范围 + 一键确认/改写）
- [ ] AC-P1c-5: 缓存——按 canonical URL+内容版本+语言+抓取时间；时效型 claim 有 freshness policy
- [ ] AC-P1c-6: 保留与清理——case ledger 访问范围 + 日志脱敏（Cookie/token/query URL/postData）+ 保留期限 + 用户清理；登录态截图不进 .runtime/uploads

### Phase 2 — deep-research projection（复用底座）

- [ ] AC-P2-1: `/deep-research` 入口 enable + 维度拆解器（课题→子问题集）
- [ ] AC-P2-2: 覆盖式检索 multi-query union（agent 主动 expand 同义/缩写/中英）+ coverage matrix + 停止判据
- [ ] AC-P2-3: 综合报告 projection（支持/反对/未定 + 置信度总评 + "没考虑到的维度"），无真假裁决
- [ ] AC-P2-4: 共享契约 + contract test（替代"零重复实现"字面，证明底座两个 projection 共用同一中性契约）

## Open Decisions（待小孙拍板，非 AC）

- **OD-1 入口 C**：「核查这条消息」（hover/右键已有消息发起）是否进 scope（德彪 D3-6 移出 AC；我倾向要，最自然动线）
- **OD-2 主号覆盖**：未来是否提供主号高级覆盖（默认关闭 + 逐平台风险确认）；v1 一律小号
- **OD-3 登录态默认态**：v1 是否登录态通道全默认关闭、逐平台授权才开（倾向是）
- **OD-4 UI 方向**：报告卡 + 三态 mockup 是否 OK（上轮已发小孙）

## Dependencies

- 外部 search API 选型与接入（中文优先 + 全球）：**API key 进 `.env` 为小孙人工操作**（Iron Law §3）；选型前 AC-P0a-3 基准实测
- codex CLI `--search`、gemini CLI `google_web_search`（2026-06-11 实测在位；但原生检索事件不可结构化审计，仅线索）
- playwright `^1.59.1` 已装（`packages/api`）+ screenshot-service 先例；`.mcp.json` 无 browser MCP
- 长任务恢复：现 worklist 仅 active/settled + 自由文本续推（`orchestrator/worklist-continuation.ts`），本 feature 需 durable case 状态机自建，不依赖其解析
- Related: F027（memory 域命名区分；case ledger 持久化评估复用其 SQLite 基建）/ F026（A2A 派单底座）

## Design Decisions

| 决策 | 结论 | 原因 |
|------|------|------|
| 产品形态 | runtime 纵向闭环，skill 只承载方法论 | 德彪：纯 skill 无状态/无证据存储/无可审计引用；小孙要"入口+真正做好" |
| 底座抽象 | **中性领域模型 + 两个 projection**，非 fact-check 专用 schema | 德彪 D2：防底座被单消费者绑架；Phase 1 含 deep-research walking skeleton 证明 |
| 多 agent 验证 | 两阶段独立性（Phase A 独立 thread + sibling-canary 测试 / Phase B 合并交叉质询） | 德彪 D3：现 runtime 续推喂全历史，"互不可见"必须独立 context + canary 才可证 |
| verdict 本体 | **四字段**（claim_relation × confidence × context_flags × fabrication） | 德彪 D5：原三轴不正交，misleading 是上下文属性、fabrication 非真假轴 |
| quorum | ≥2 异质模型 **且** 来源独立性（primary-source 或 2 独立 origin） | 德彪 D5：模型异质≠证据独立（可能同一通讯社/转载/索引） |
| 原生检索定位 | 仅线索，不计正式 quorum | 德彪 D3：不可结构化审计的证据不能进裁决 |
| 引用 | citation entailment（绑 evidence span + 独立校验蕴含） | 德彪 D5：有链接≠链接支持结论 |
| 质量验收 | gold set 真值基准 + 裁决准确率/高置信错误率/弃权率阈值 | 德彪 D1：原 AC 只验格式，系统稳定胡判也能过——最致命缺口 |
| 外发边界 | feature 级 outbound-data policy（不只 cookie，含声明外发提示+脱敏+记录） | 德彪 D1/D6：用户声明发往外部 API/LLM 也是泄露面 |
| 登录凭证 | 默认关闭 + 小号硬要求 + 能力隔离 + v1 不接主号；无法承诺零泄露 | 德彪登录态深审：网页凭证本质可代表账号，guard 只降险不归零 |
| 安全底座 | SSRF + prompt-injection corpus + 只读执行器自动测试 | 德彪 D6：Iron Law §4 延伸；防注入靠能力隔离非 prompt |
| Phase 切分 | 0A 基线+0B 登录 spike（不阻塞）/ 1a 底座+1b 裁决+1c 渠道UI / 2 调研 | 德彪 D4：Phase 0 不整体阻塞，Phase 1 过大须拆三段 |
| 成本 | Light/Full 硬预算+超时+取消+缓存+降级 | 德彪 D7：多 API×多模型×多通道单 case 慢且贵 |
| 平台合规 | Phase 0 登记 ToS/账号风险；禁绕验证码/反爬 | 德彪 D7：抓取合规边界 |
| v1 砍掉 | 预测市场 / 完整传播图（先做 lineage 标签）/ 图像视频鉴伪 / 意图自动判断 / 第三原生模型作 Light 硬依赖 / 入口 C（待拍）/ AC17"零重复"字面 | 德彪 D7/D2：YAGNI |

### 方法论移植清单（cat-cafe-skills 借鉴，2026-06-12 核定）

| 来源 | 移植物 | 落点 |
|------|--------|------|
| `source-audit` | Claim Ledger / 五问 / verdict 思想 / provenance / 回声室互引识别 | 裁决层 + 证据账本 |
| `refs/research-prompt-template.md` | 8 槽位 brief（Disconfirm First / Source Mix Quota / 支持-反对-未定 schema / "全支持=确认偏误"回收检查） | 检索 dispatch prompt + 自动质检 |
| `memory-search-best-practices` | coverage ≥3 刀 / absence 正反两路 / "何时停" / magic-word 刹车 / 中英双语 / expansion 归 agent | 检索纪律（AC-P1b-8/P2-2） |
| `expert-panel` | WHY 链四格 / dispatch 防锚定 / 收敛不抹平分歧 | 验证层编排 + 分歧区 |
| `deep-research`（cat-cafe） | 三家族训练偏差论（分歧=信号）/ prompt 落盘可追溯 | 异质验证依据 + case ledger |

**不移植**：Chrome 驱动网页版 Deep Research（专有依赖重、半人工）、multi_mention/rich block/语音/DOCX 交付链（绑死 cat-cafe runtime）。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | 小孙提出愿景（unifuncs 对标）；黄仁勋初版；德彪设计讨论 4 [DISAGREE] 收敛；三家原生检索实测 |
| 2026-06-12 | 小孙拍板双模式同 feature；cat-cafe 借鉴核定；Kickoff（1302a7d） |
| 2026-06-12 | 渠道三层 + 入口 A/B/C + UX 三态（e8cdfe2）；Phase 0 信源矩阵 + 四通道 + 登录态（b04b13c） |
| 2026-06-12 | 德彪登录态深审 6 [DISAGREE]（能力隔离/profile 隔离/小号硬要求/雪球验收陷阱）+ 整体审 **NEEDS-WORK 9 P1**（质量验收/外发边界/真隔离/四字段 ontology/quorum/citation/SSRF/成本/AC 冲突）→ **全文修订 v2**，AC 重组 AC-Px-n |

## Links

- Discussion（scratch 不入库，结论已沉淀本文档）：
  - `.runtime/reviews/fact-check-design-*.md`（首轮设计讨论）
  - `.runtime/reviews/F029-login-channel-*.md`（登录态深审）
  - `.runtime/reviews/F029-full-design-review-*.md`（整体审 NEEDS-WORK）
- Plan: 待修订版德彪复审 GO 后进 `writing-plans`
- Related: F026 / F027

## Evolution

- **Evolved from**: 无（全新能力域）
- **Blocks**: 无
- **Related**: F026（A2A 派单底座）、F027（memory 检索命名区分 + 持久化基建评估复用）
