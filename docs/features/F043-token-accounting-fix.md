---
id: F043
title: Token 用量口径修复 + 上下文可观测：封存假阳性根治（P0 止血）+ per-call token 可见（P1）
status: done
owner: 黄仁勋
created: 2026-07-10
completed: 2026-07-11
---

# F043 — Token 用量口径修复 + 上下文可观测

## Why

小孙 07-10 报三症状：①每个 agent 基本发一条消息就被封存 ②每次调用的 token 数看不到 ③状态面板"上下文"感觉不准。当日 5 路并行深挖 + 对抗核验（报告：`.runtime/reviews/seal-context-audit-2026-07-10.md`），三症状全部坐实且同根：

1. **usedTokens 口径从 adapter 起点就错**——拿的是"累计计费值"不是"当前上下文占用"：
   - claude：turn 末 `result` 事件 usage = 整轮所有 API 调用累加（cache_read 每次调用重复计），且 result 恒为最后事件，latest-wins 覆盖 `message_start` 的真实足迹（`claude-runtime.ts:277-280` + `cli-orchestrator.ts:234`）。07-10 实锤：一条消息 15 次工具调用累加 989,369 → /200k → 100% 封存，真实足迹 77,238。
   - codex：`turn.completed` usage = session 级累计（跨 turn 不清零）+ `cached_input_tokens ⊆ input_tokens` 再相加双计缓存（`codex-runtime.ts:233-235`，注释语义实测为假）。DB fill 0.418873×1M=418,873 与 rollout 文件精确对账，虚高 9.35×。
   - gemini：模型不在兜底表 + CLI 不报窗口 → snapshot 永不生成，既无封存保护也无显示。
2. **窗口分母全错**：兜底表只映射 opus-4-7→1M，现役 opus-4-8 落 200k（真 1M，5× 放大）；gpt-5.5 表值 1M vs Codex CLI 自报 258,400；gemini-2.5 无条目。claude CLI 自报的 `result.modelUsage[*].contextWindow` 被整个丢弃。
3. **实测坐实**：4/26-5/14 封存 161 次、session 存活中位数 1 turn；当前 F040 preview 近 4 次封存全部假阳性（真实占用 22.6%-75.6%）。
4. **token 绝对数无持久化无出口**：parseUsage 边界折叠成单数、`onUsageSnapshot` 零订阅、唯一落盘 `threads.last_fill_ratio` 单浮点；前端 MessageMeta token 胶囊 UI 建好恒空转（`message-bubble.tsx:193-217`，后端从未赋值）。
5. **面板五重失真**：分子膨胀 + 分母错 + Math.min clip + 封存后 fill 不复位（1.0 挂新 session）/轮中冻结 + 前端 ratio×自算窗口反推 token 数（与后端分母不同源）。

对标 `C:\Users\-\Desktop\cafe\clowder-ai`（HEAD 05-01）：每刀都有现成正确实现——claude 两套语义分离（footprint vs 计费统计）、codex rollout 回读器、窗口 CLI-exact 优先兜底表殿后、ContextHealth+lastUsage 持久化、UI 后端直传真值。当年只抄了它的 seal 阈值没抄解析口径。

## What

小孙可感知的变化：

- agent 不再一条消息就被封存——封存只在上下文真接近满时发生，通知里的百分比是真实占用
- 每条 agent 消息下方出现 token 胶囊：本次调用 N tokens（缓存命中 x%）
- 状态面板"上下文"条 = 真实占用/真实窗口（后端直传，approx 来源有标注），封存后归零不再挂旧 100%
- 运行中面板实时刷新，不再冻结在上一轮

## Acceptance Criteria

**AC0 · CLI 事件结构实测前置（小孙 07-10 拍板附带提醒：最新 CLI 可能有变化，不许拿 3-5 月的 clowder 实现或 4 月的 ANALYSIS.md 当现役契约）**
- [x] 实测本机 claude CLI 当前版本：带工具调用的 stream-json 探针，核 `message_start/message_delta/result` 的 usage 字段结构 + `modelUsage[*].contextWindow` 字段名与取值（200k vs 1M 账户生效值以此为准）
- [x] 实测本机 codex CLI 当前版本：`codex exec --json` 探针 + rollout 文件 `token_count.info.last_token_usage / model_context_window` 字段结构核对
- [x] gemini：CLI 地区墙坏死（IneligibleTierError）→ 以本机安装版 bundle 源码分析为准，标注"未活测"，seal 行为保守处理（见 AC3）
- [x] 探针原始 ndjson 归档到 feature 证据目录，解析实现的每个字段引用可回指探针行号

**P0 · 止血四刀**
- [x] **AC1 · claude 口径分离**：上下文足迹 = 最后一个 `message_start`（或 delta fallback）的 `input+cache_read+cache_creation`，每次 message_start 重置防陈旧；`result` 累计 usage 不再进 seal 判定（仅供 P1 统计展示）。验收：重放 07-10 封存现场事件序列（15 次调用），usedTokens=真实足迹 ~77k 而非 989k。
- [x] **AC2 · codex 口径修复**：turn 结束后回读 rollout 文件末条 `token_count` 取 `last_token_usage`（当前上下文）+ `model_context_window`（真窗口）；rollout 不可得时退化为 `input_tokens` 单值（不加 cached，消双计）并标 approx。验收：重放 07-05 封存现场，usedTokens 从 1,633,256 修正到真实量级；rollout 缺失路径有测试。
- [x] **AC3 · 窗口解析修复**：claude 解析 `result.modelUsage[*].contextWindow` 为 exact 窗口；兜底表补 opus-4-8（按 AC0 实测值）+ `gemini-2.5 → 1,048,576`，gpt-5.5 表值与 CLI 自报核对修正；**gemini 因 usedTokens 仍为累计口径且无活测，只 warn 不自动封存（fail-open），代码注释写明解封条件=活测后**。验收：三 provider 窗口来源单测 + fillRatio 用例更新。
- [x] **AC4 · 封存后状态复位**：shouldSeal 落库时 `last_fill_ratio` 置 null；`prevUsedTokens`（F-BLOAT 基线）同步清零防新 session 首轮误报；面板 sealed 态显示"待重启"不显示旧百分比。验收：模拟封存 → DB 行 fill=null → 面板显示占位而非 100%。

**P1 · token 可见性**
- [x] **AC5 · usage 明细持久化**：UsageRaw/TokenUsageSnapshot 扩明细（input/output/cacheRead/cacheCreation），messages 表加 token 列（additive migration），turn 聚合值随 assistant 消息落库。
- [x] **AC6 · MessageMeta 点亮**：`mapTimelineMessage` 透传 inputTokens/outputTokens/cachedPercent → 现成 UI 渲染。验收：网页发消息，回复气泡下出现"N tokens · 缓存 x%"胶囊，数值与探针档案一致。*（活体闭环：quality-gate 真 claude 轮浏览器截图「57.1k tokens · 缓存 50%」与 DB 四层对账精确一致；guardian 独立复核；修1 后 page-as-sender 帧抓取实收 message.updated + 回复卡 DOM 同帧渲染「56.4k tokens缓存 51%」无刷新点亮；codex 归一化对照 32.7k/31%→23.3k/96% 浏览器可见）*
- [x] **AC7 · 面板真值直传**：ProviderThreadView 加 usedTokens/windowTokens/source 三字段，前端停止 ratio×自算窗口反推；source=approx 时 UI 加标注。验收：面板 token 数 = 后端真值；gemini 无数据时显示"无数据"而非猜测值。*（活体闭环：面板「57k/1M (剩余 84%)」=DB 真值直显（剩余%=距封存阈值，F021 语义）；codex 面板 23k/353k=rollout 真窗口；桂芬无数据显「待运行」占位不编造——quality-gate 截图 + guardian 独立截图双证）*
- [x] **AC8 · 轮中实时更新**：message-service 订阅 `onUsageSnapshot` → 节流 WS 事件 → 运行中面板上下文条实时变化。验收：长轮运行中面板数字至少更新一次（E2E 或活体录屏）。*（活体闭环：quality-gate 轮中 WS 实收 usage.snapshot（57,053/1M approx→收尾 exact 升级）；guardian 自发探针轮中实收 51,608/approx 三方对账；v4 帧抓取确认浏览器页面 socket 同样实收（page-as-sender 直发通道））*

**回归防护**
- [x] **AC9 · 测试口径翻正**：`context-seal.test.ts` / `claude-runtime.test.ts` 中把错误语义当正确行为的断言重写（codex input+cached 相加、claude result 产生 snapshot、gemini stats.context_window 存在性）；新增"真实录制事件序列驱动 runTurn → 断言 usedTokens=末次足迹非累加"回归测试，语料来自 AC0 探针档案。

**Out of scope**（触发条件写明）：F33 式策略层 compress/hybrid（触发=P0 上线后观察封存频率，若 Claude Code 自压缩可用再立项）；绝对余量触发 remaining<turnBudget（同上一并评估）；fBloatDetected 死旗标接线/删除（转 TD）；thread_seal_events 表接线 + warn 落盘（转 TD）；seal 通知三条合一（转 TD）；execution-bar 死组件清理（转 TD）；gemini 活体验证与解封（触发=桂芬 CLI 地区墙恢复）。

## Dependencies

- **F040 合并优先（软依赖）**：F043 与 F040 在 `message-service.ts` / `status-panel.tsx` 有交集面（adapter 层五文件 F040 零 diff 已实测）。F040 已在验收尾声；若 F043 先完工，合并前必须对 origin/dev rebase 并 diff 核倒灌（F038 教训）。
- 参考实现：`C:\Users\-\Desktop\cafe\clowder-ai`（抄架构不抄数值，字段以 AC0 实测为准）。
- 排查证据链：`.runtime/reviews/seal-context-audit-2026-07-10.md` + workflow 探针档案 `scratchpad/usage-probe/`。

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 修复方案来源 | 自研 / 对标 clowder-ai | **对标 clowder**（小孙 07-10 拍"可以开工"） | 每刀都有经生产验证的实现；当年只抄阈值没抄口径是本病根 |
| 字段契约真相源 | clowder 代码 / 4 月 ANALYSIS.md / **本机 CLI 实测** | **实测优先**（小孙特别提醒 CLI 可能已变） | Measure Before Assert 家规；clowder 基于 3-5 月 CLI |
| claude 双语义 | 单一 usedTokens / 分离 footprint 与计费统计 | **分离** | footprint 喂 seal 判定，result 累计喂 P1 展示，各司其职 |
| codex 数据源 | turn.completed 聚合 / rollout 回读 | **rollout 回读 + 聚合退化兜底** | exec --json 只给累计值，footprint 只在 rollout token_count 里 |
| gemini seal 姿态 | 补窗口即启用 seal / warn-only | **warn-only fail-open** | 累计口径未修净 + 无活测（地区墙），approx 数据不触发硬动作（clowder F062 原则） |
| 阈值调参 | 顺手调 / 不动 | **不动**（gemini .7/.8 维持 F004 值） | 病在数据不在阈值；口径修对后再看频率 |
| 策略层（compress/hybrid） | 本期做 / 押后 | **押后** | 止血不与增强混装；观察 P0 效果再定 |

**Design Gate**：架构级（跨 shared/api/前端）→ 方案经 07-10 排查报告 + clowder 对照呈小孙，小孙拍板"可以开工"（附 CLI 实测提醒）✅；实现期德彪 review 硬门。

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-10 | 三症状排查闭环（5 路 workflow + 对抗核验，token 级对账）；clowder-ai 对照补查；小孙拍板开工（附 CLI 变化提醒）；kickoff |
| 2026-07-10 | 实施六连 commit（worktree feat/F043-token-accounting）：`a8978e1` AC1-3 adapter 双语义+rollout 回读+窗口实测值+gemini fail-open（rider：ingest-modal gate flaky 根治）→ `a55c54c` orchestrator scope 路由（seal 只见真足迹）→ `bd4a82b` AC4 封存复位（fill→null+F-BLOAT 基线清零）→ `c8edc53` AC5 七列双源 migration+双 repo → `55fe0ba` AC6+AC7 MessageMeta 点亮+面板真值直传 → AC8 轮中实时+AC9 清扫。AC1 现场重放按 plan 预案走探针序列（主仓无当日原始事件日志，断言注释回指排查报告 77,238 vs 989,369）。AC6/7/8 代码全绿，活体验证待验收阶段（需真 CLI 轮）。 |
| 2026-07-10 | quality-gate PASS（worktree preview 真 claude 轮四层同位对账 57,053）→ acceptance-guardian 零上下文 PASS（自跑 95/95+19/19、fixture 逐字节对账、自发两探针轮中真收 usage.snapshot）→ 真德彪 r1 **NO-GO**（0 P0/3 P1，档 `.runtime/reviews/F043-debiao-r1-raw.md`）。三 P1 逐条独立坐实后修复：**修1-P1-1** 新增 `message.updated` 事件（收尾终稿全量重推 + store 按 id upsert）——占位 created 无 token、catch-up 只查 created_at>since、store 去重不替换，开着的页面刷新前看不到胶囊（gate/guardian 均新开页取证致漏）；**修1-P1-2** codex resolveUsage 归一化 inputTokens=input−cached（UsageDetail 统一契约=非缓存输入，活体实锤旧值双计 32,721/31% vs 真值 22,737/44%）；**修1-P1-3** `resolveEffectiveTurnResult`：retry 后足迹/seal/session=末次尝试、turnTotals 跨尝试聚合（旧代码 retry 越阈漏封存）。修1=`b752975`（gate 全绿 824/824）。 |
| 2026-07-10 | 德彪 r2 复核（档 `.runtime/reviews/F043-debiao-r2-raw.md`）：P1-1/P1-2 确认修复；**P1-3 残留一处**——seal 生命周期钩子（digest/ThreadMemory/sessionChain/auto-resume，message-service :2707/:2732）仍判 retry 前的 `loopResult.stoppedReason`，retry 越阈时钩子被跳过而 seal 事件/session 清空照发（脑裂）。**修2**：提取 `sealedThisTurn(result)` 唯一谓词（continuation-loop.ts:52 证明非 retry 路径与旧谓词严格 1:1），两站点统一吃最终生效结果；全文件 `loopResult.` 消费点全扫仅 4 处无第三漏网；settlement 测试 14/14（+2 双向收敛测）。修2=`26caffd`。 |
| 2026-07-10 | **德彪 r3 = GO**（档 `.runtime/reviews/F043-debiao-r3-raw.md`）："确认修复，未发现明确 bug 或回归风险"，自跑定向 43/43（settlement 14 + continuation/auto-resume 回归 29）+ api typecheck + git diff --check。审查链收束：r1 NO-GO(3 P1)→修1 `b752975`→r2 NO-GO(1 残留)→修2 `26caffd`→GO。AC6/7/8 活体证据链齐勾框（quality-gate 四层对账 + guardian 独立复核 + page-as-sender 帧抓取/DOM 解剖 + codex 归一化前后对照）。待小孙 preview 活体验收（:3103）→ merge-gate。 |
| 2026-07-10 | **小孙活体验收通过**：足迹五连增 44,616→48,960 累加实锤（cache_read 逐轮扩大=历史真续接），三症状全过。随验收发现「发消息后 ~13.7s 无可见进度死区」（计时探针：0.34s running 已推 ↔ 14.03s 首字），归因非 F043 引入（diff 全在收尾侧）——小孙拍板为**独立 BUG，F043 合并后立即修**。 |
| 2026-07-11 | **MERGED**：squash `4282172` push origin/dev（先 squash 后 rebase 单遍解 12 文件双侧追加冲突；倒灌核查=diff 恰 37 F043 面文件 + F040 内容抽查全存活；rebased 树全量 gate 重验绿——中途修一处冲突合并括号漏损 + 补装 F040 新依赖；F027 fuzz 满载抖红一次，隔离双跑绿后重试过门）。Status → done。 |

## Links

- 排查报告：`.runtime/reviews/seal-context-audit-2026-07-10.md`
- Evolved from: [F021](F021-right-panel-redesign.md)（Phase 6 seal 阈值齿轮 + fillRatio 观测——本 feature 修其数据源）
- Related: [F004](F004-context-memory-authoritative.md)（gemini seal 阈值放宽史）/ [F018](F018-context-resume-rebuild.md)（seal 后处理生命周期）/ [F036](F036-notion-restyle.md)（进度条对齐封存阈值——本 feature 修其分子）
