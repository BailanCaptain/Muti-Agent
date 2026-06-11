---
id: F029
title: 调研与核查管道（fact-check + deep-research 双模式）
status: spec
owner: 黄仁勋
created: 2026-06-12
---

# F029 — 调研与核查管道（fact-check + deep-research 双模式）

## Why

小孙愿景（2026-06-11 原话）：

> 我给出需要检索的信息之后，可以信息搜索，要有交叉验证，要给出引用源，判断是否是 fake news。类似 unifuncs U深搜。入口我还是想要。

> 我需要多 agent 验证，这样才能客观。而且我不怕引入依赖，我要的是做好，真正符合我的需求。

> （2026-06-12 追加）如果我也想要深度搜索呢？

参考产品 unifuncs「U深搜」= 深度搜索 + 事实核查一体两面。现有能力的缺口：

- CLI 内置 deep-research skill 是研究综述人设，无真伪裁决格式，且改不了源码
- runtime 现把 codex web search 压缩成 `[web search completed]`，`ToolEvent` 无 URL/query/发布时间等审计字段（`packages/api/src/runtime/codex-runtime.ts:103`、`packages/shared/src/tool-event.ts:3`），检索过程不可复现不可比较
- 纯 skill 形态无稳定状态、无结构化证据存储、无可审计引用——撑不起"真正做好"

## What

在产品 runtime 落一条**调研与核查管道**：统一检索层 + 异质 agent 独立取证 + 结构化证据账本 + fail-closed 裁决，**一个共享底座、两个模式入口**：

| | `/fact-check <声明>` | `/deep-research <课题>` |
|---|---|---|
| 输入 | 待核查的断言 | 开放问题 |
| 拆解 | 原子 claim 拆分（时间/主体限定） | 维度/子课题拆分 |
| 检索策略 | 对抗式（disconfirm first，主动找反例） | 覆盖式（multi-query union，求全） |
| 输出 | 三轴裁决 + 分歧 + 引用 | 综合报告（支持/反对/未定），不判真假 |

中间共享：SearchProvider 检索层、证据账本、多 agent 编排（独立取证→交叉审计→收敛）、信源卫生五问、渐进式报告 + 可点击引用 UI、case ledger。

### 信息渠道分层（2026-06-12 小孙补充需求："有些必须去平台搜的"）

通用搜索引擎对国内平台覆盖结构性残缺（微信公众号基本不被索引、微博部分、抖音/小红书不可达），而中文 fake news 主战场恰在平台内。渠道按三层收纳，每个渠道 = 一个 SearchProvider 实现：

| 层 | 渠道 | v1 处置 |
|---|---|---|
| L1 通用搜索 | 中文优先 + 全球双 API（新闻站/门户/官网） | 全量接入 |
| L2 平台专项 | 国内：微博、微信公众号（搜狗通道）、知乎、B站；国外：X/Twitter、Reddit、Telegram；+ 官方信源白名单直查（政府/企业官网官微，支撑"官方沉默"弱信号） | 按基准实测接 2-3 个最高优先级 + 官方白名单 |
| L3 浏览器自动化兜底 | 需登录态/JS 重的平台内搜索 | Phase 2+，不进 v1 默认链路 |

选型基准集必须含"仅平台内传播"用例，实测 L1 盲区大小后定 L2 优先级，不预设。

#### 四条检索通道与声明类型路由（2026-06-12 小孙追加："不仅中文，英文也是；先整合一轮信源；小红书/雪球/X 怎么登录"）

| 通道 | 适用 | 登录 |
|---|---|---|
| ① API 直连 | 通用搜索 API、Reddit、B站、Google News、巨潮/SEC 财报库 | 无 |
| ② 网页公开搜索 | 微博(部分)、知乎、雪球(部分)、搜狗微信通道、TG 公开频道 | 免/轻 |
| ③ 登录态浏览器 | 小红书、X、雪球完整版、微博完整版 | 要 |
| ④ 事实核查机构白名单 | Snopes / PolitiFact / AFP·Reuters Fact Check / 腾讯较真 / 台湾事实查核中心 | 无 |

- 路由：claim 拆解时打类型标 → 财经→雪球/财新/巨潮/公司公告；社会新闻→微博/官方通报；国外科技→X/Reddit/HN/官方博客。验证 agent 带 source mix quota（≥2 类通道）
- 执行流：L1 通用 API 先扫 → 命中线索去平台追原帖/原文 → 官方白名单+核查机构必查 → 全部进证据账本
- 通道④定位：他方已核结论 = 高性价比证据，但按 source-audit 当二手来源标注，不直接替代裁决

#### 登录态方案（通道③）

专用浏览器 profile：小孙对小红书/X/微博等**人工登录一次** → session/cookie 持久化本地 profile（gitignore，不进 git 不进 .env 明文）→ agent 复用 profile 平台内搜索，过期重登。
安全边界三条（硬约束）：**只读**（绝不代发/点赞/关注）；**专用小号**（平台限流/封号风险摊开，不用主账号）；**频控队列**（统一限速模拟人速）。

#### Phase 0 信源整合调研（小孙 2026-06-12 提议采纳）

30+ 平台逐个**实测**（禁脑补）产出信源矩阵：可达通道/登录需求/反爬强度/成本/内容类型/对应声明类型/v1 进否。范围中外全列：国内 微博/公众号/知乎/小红书/抖音/B站/雪球/股吧/头条；国外 X/Reddit/YouTube/Telegram/HN/Substack；中外通讯社；核查机构。基准声明集对照矩阵验收。

### 用户入口与 UX 三态

入口：
- **入口 A（主）**：composer 打 `/` → 命令面板选 `/fact-check` / `/deep-research`（复用 F027 已建 `components/chat/composer-slash-menu.tsx` SLASH_COMMANDS，加两条命令，零新基建）
- **入口 B**：自然语言"帮我核查 XXX"/"深挖 XXX" → 路由进管道
- **入口 C（Phase 2 提案，待小孙拍）**：对已有消息 hover/右键「核查这条」

UX 三态：入口态（发起）→ 进行中态（渐进可见：声明冻结/claim 拆分/双 agent 检索中/证据计数增长，复用现有观测带）→ 报告态（结论摘要置顶 + 证据链/分歧区/引用源折叠展开）。

## Acceptance Criteria

### Phase 0 — 信源整合调研（前置，2026-06-12 小孙提议）

- [ ] AC23: 信源矩阵落盘：30+ 中外平台逐个实测（可达通道/登录需求/反爬强度/成本/内容类型/对应声明类型/v1 进否），禁查资料脑补
- [ ] AC24: 登录态通道设计验证：专用浏览器 profile 人工登录一次 + session 持久化（gitignore）+ 三条硬边界（只读/专用小号/频控队列）在 ≥1 个登录态平台（候选雪球）真实跑通搜索
- [ ] AC25: 事实核查机构白名单（中外 ≥5 家）+ 声明类型→渠道路由表 v1 定稿

### Phase 1 — 共享底座 + fact-check 纵向闭环

- [ ] AC1: 房间内 `/fact-check <声明>` 命令 + UI 入口可触发完整管道
- [ ] AC2: 声明原文冻结 + 原子 claim 拆分（带时间/主体限定），逐 claim 核查
- [ ] AC3: 统一 `SearchProvider` 接口：≥2 个外部 provider（中文优先 + 全球）可配置可替换，不写死厂商；与 F027 memory 域 `HybridSearchProvider` 命名/模块隔离
- [ ] AC4: 三家模型原生检索接入为独立异议通道（Claude WebSearch / Codex `--search` / Gemini `google_web_search`，均已实测在位 2026-06-11）
- [ ] AC5: 证据账本结构化落盘：query / URL / 标题 / 发布时间 / 抓取时间 / 内容 hash / provider / 来源类型 / 共同源头谱系；搜索结果只算线索，必须 fetch 原文
- [ ] AC6: 两阶段独立验证：Phase A ≥2 异质模型独立检索、互不可见、dispatch 仅含中性声明（禁带预判/framing）；Phase B 合并证据池、URL+共同源头去重、交叉质询冲突证据
- [ ] AC7: 三正交轴裁决：`evidence_status`(supported/unverified/misleading/contradicted) × `confidence`(high/medium/low) × `fabrication`(not-assessed/suspected/evidenced)，每个核心判断带 Evidence/Reasoning/So-what/Confidence 四格
- [ ] AC8: fail-closed：证据不足强制 `unverified`（"没搜到"≠假）；任一异质验证者不可用 → 只出"单 agent 初步结果"标记，不给正式裁决章
- [ ] AC9: 检索纪律：disconfirm-first 反例检索；absence 判定需正反两路 + 相关概念均 0 命中；中英双语各搜一遍；"≥N 路无新源即停"停止判据
- [ ] AC10: 防注入：fetch 的网页内容按数据隔离处理，不当指令执行；恶意页面指令不得影响裁决
- [ ] AC11: 渐进式报告 UI：结论摘要 → 证据链 → 分歧区（不抹平，保留各方理由）→ 可点击引用（Gemini grounding redirect URL 解析为真实源 URL）
- [ ] AC12: case ledger 全程落盘：从声明到裁决全链路可审计可复现
- [ ] AC18: 渠道分层落地：L1 双通用 provider 全量 + L2 ≥2 个平台专项 provider（按基准实测定优先级，候选微博/微信公众号）+ 官方信源白名单直查；所有渠道走统一 SearchProvider 接口
- [ ] AC19: 选型基准集（30-50 条中英文声明）含"仅平台内传播"用例，L1 盲区有实测数据支撑 L2 选择
- [ ] AC20: 入口 A（slash 命令面板加 /fact-check、/deep-research 两条）+ 入口 B（自然语言路由）可用；进行中态在房间渐进可见

### Phase 2 — deep-research 模式（复用底座）

- [ ] AC13: 房间内 `/deep-research <课题>` 命令 + UI 入口
- [ ] AC14: 维度拆解器：课题 → 子课题/子问题集
- [ ] AC15: 覆盖式检索：multi-query union（agent 主动 expand 同义/缩写/中英）+ coverage matrix + 停止判据
- [ ] AC16: 综合报告：支持/反对/未定三类证据表 + 置信度总评 + "我们没考虑到的维度"节；无真假裁决
- [ ] AC17: 复用 Phase 1 证据账本/引用/渐进式 UI，零重复实现
- [ ] AC21: 入口 C「核查这条消息」（hover/右键已有消息发起核查；小孙拍板后生效，否则降为候选）
- [ ] AC22: L3 浏览器自动化兜底通道评估（登录态平台内搜索）：可行性报告 + 接入决策（做/不做留档）

## Dependencies

- 外部 search API 选型与接入（中文优先 + 全球各一）：**API key 进 `.env` 为小孙人工操作**（Iron Law 3 配置不可变）；选型前按 Design Gate 用 30-50 条中英文基准声明实测召回
- codex CLI `--search` flag、gemini CLI `google_web_search`（2026-06-11 已实测在位）
- F026 A2A 派单/续推机制（worklist 续推现仅靠重读聊天历史 `packages/api/src/orchestrator/worklist-continuation.ts:34`，本 feature 需结构化 assessment 回传，不依赖自由文本解析）
- Related: F027（memory 域 HybridSearchProvider 命名区分；case ledger 持久化可评估复用其 SQLite 基建）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 产品形态 | 纯 skill 先行 vs 直接 runtime 纵向闭环 | **runtime 纵向闭环**，skill 只承载方法论 | 德彪 Q3 [DISAGREE] 成立：纯 skill 无状态/无证据存储/无可审计引用，会成废脚手架；小孙要"入口+真正做好"（2026-06-11） |
| 多 agent 验证 | 同 family 多 lens vs 跨 family 异质 | **两阶段独立性**：Phase A 异质模型独立检索互不可见 → Phase B 合并交叉质询；同 family 多 lens 只算查询扩展 | 德彪 Q1 [DISAGREE] 成立：客观性 = 独立取证+异质模型+来源独立+分歧可见，非 agent 数量 |
| 分档 | 轻案降级同 family vs 档位只调深度 | Light=2 异质模型 / Full=3 模型+传播溯源+二轮对抗；**任何档位不降异质性** | 同上；fail-closed 兜底 |
| verdict 模型 | 五档线性（confirmed→fabricated） vs 三正交轴 | **三轴**：evidence_status × confidence × fabrication | 德彪 Q4 [DISAGREE] 成立：真假/置信度/捏造意图不同轴，线性混淆语义（`supported+medium`=较可能真；`contradicted+high` 才判假） |
| 检索引擎 | 三家原生检索替代外部 API vs 仅做补充 | **双外部 provider（中文+全球，SearchProvider 统一接口）为主，三家原生为独立异议通道** | 德彪 Q2 半成立：原生检索事件现不可审计；外部 API 营销能力≠中文覆盖达标，选型须基准实测 |
| feature 边界 | fact-check / deep-research 分立 feature vs 同 feature 双模式 | **同 feature 双模式，Phase 1 底座+核查，Phase 2 调研** | 底座占工作量 70%+，分立会出空心 feature 且底座长成单消费者形状；小孙 2026-06-12 拍板 |
| v1 砍掉 | — | 预测市场、完整传播图、图像/视频鉴伪、意图自动判断、复杂来源评分公式 | 德彪 Q4/Q5：预测市场反映预期非事实；其余另开能力域 |
| 官方沉默信号 | 进 v1 裁决因子 vs 弱信号 | 仅作弱负向信号，且须先证明该机构通常应当公开表态 | 德彪 Q4：防过度裁决 |
| 信息渠道 | 仅通用 search API vs 三层渠道 | L1 通用全量 / L2 平台专项（实测定优先级）+ 官方白名单 / L3 浏览器兜底 Phase 2+ | 小孙 2026-06-12："有些必须去平台搜的"；中文平台不被通用引擎索引是结构性盲区 |
| 用户入口 | — | 入口 A slash 面板（复用 F027 composer-slash-menu）+ 入口 B 自然语言；入口 C 消息级核查待拍 | 小孙 2026-06-12 问入口；零新基建优先 |

### 方法论移植清单（cat-cafe-skills 借鉴，2026-06-12 核定）

| 来源 | 移植物 | 落点 |
|------|--------|------|
| `source-audit`（整套） | Claim Ledger / 五问 checklist / verdict 思想 / provenance 行 / 回声室互引识别 | 裁决层 + 证据账本 |
| `refs/research-prompt-template.md` | 8 槽位 brief（Disconfirm First / Source Mix Quota 四项信源卫生标注 / 支持-反对-未定 Output Schema / Quality Gate"全支持=确认偏误"回收检查） | 检索 agent dispatch prompt + 自动质检规则 |
| `memory-search-best-practices` | 题型→recipe（coverage ≥3 刀 / absence 正反两路）/ "何时停"判据 / magic-word 刹车（"碎片够了"→强制补刀）/ 中英双语 / query expansion 归 agent 不归系统 | 检索纪律（AC9/AC15） |
| `expert-panel` | WHY 链四格 / dispatch 防锚定（禁带 Lead 判断）/ 收敛不抹平分歧 | 验证层编排 + 报告分歧区 |
| `deep-research`（cat-cafe 版） | 三家族训练偏差论（分歧=最有价值信号）/ prompt 落盘可追溯 | 异质验证设计依据 + case ledger |

**不移植**：Chrome 自动化驱动三家网页版 Deep Research（专有依赖重、半人工）、multi_mention/rich block/语音/DOCX 交付链（绑死 cat-cafe runtime）。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-11 | 小孙提出愿景（unifuncs U深搜对标）；黄仁勋初版方案；德彪（真 codex）设计讨论 4 [DISAGREE] 全收敛（两阶段独立性/三轴 verdict/产品优先/双 provider+异议通道）；三家原生检索实测确认 |
| 2026-06-12 | 小孙拍板双模式同 feature；cat-cafe 借鉴清单核定；Kickoff（1302a7d） |
| 2026-06-12 | 小孙补充需求：平台渠道（"有些必须去平台搜的"）+ 入口确认 → 渠道三层架构 + 入口 A/B/C + UX 三态入档，AC18-22 新增 |
| 2026-06-12 | 小孙追加：中英双侧平台盲区 + 先整合一轮信源 + 小红书/雪球/X 登录 → Phase 0 信源矩阵 + 四通道路由 + 登录态 profile 方案 + 核查机构白名单，AC23-25 新增 |

## Links

- Discussion: 设计讨论原始记录 `.runtime/reviews/fact-check-design-discussion-to-debiao.md` + `fact-check-design-codex-reply.md`（scratch 不入库，结论已沉淀本文档 Design Decisions）
- Plan: 待 `writing-plans` 产出
- Related: F026 / F027

## Evolution

- **Evolved from**: 无（全新能力域）
- **Blocks**: 无
- **Related**: F026（A2A 派单底座）、F027（memory 检索命名区分 + 持久化基建评估复用）
