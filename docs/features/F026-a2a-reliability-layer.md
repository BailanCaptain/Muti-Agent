---
id: F026
title: A2A 可靠通信层（对齐 clowder-ai worklist + 修三处抄错 + 六条不变量）
status: spec
owner: 黄仁勋
created: 2026-04-22
---

# F026 — A2A 可靠通信层

> Supersedes F015（调度状态持久化） · Evolved from F003（A2A 运行时闭环）

## Why

A2A（agent-to-agent）是 Multi-Agent 项目贯穿所有场景的核心通信层。经过全量 `messages` 表扫描 + `events.jsonl` 事件流分析 + 代码逆向 + clowder-ai 源码逐行对照，确认**当前 A2A 不是单一 bug，是架构级不变量漏失**。大规模高频症状全部基于真实 DB 统计：

| 症状 | 频率 | 影响 |
|---|---|---|
| P11 孤儿消息（content_blocks 为空） | **95%** | 富文本元数据缺失 |
| P6 窜房间（group_id 指向已不存在房间） | **14.38%** | 信任红线，系统感觉在崩坏 |
| P5 空壳回复（≤16 字节或 `[empty response]`） | **10.84%** | 小孙原话："德彪明明回复了但你看不到" |
| P9 tool-use 执行中被 @ 打断 | 9.25% | 状态机错乱 |
| M1 R-184 双消息（一个 turn 拆成两行 DB） | 偶发 | 逻辑重入 |
| M2 R-185 中文乱码 | 偶发 | 入库前编码链坏 |
| M3 R-190 @ 不生效（要小孙手动补 @） | 常见 | 正则穿透 / 吞句中 @ |
| M4 R-188 讨论不收敛（Phase 2 断在半空） | 常见 | 靠小孙口头"够了" |
| P14 MCP trigger_mention 失败静默 | 常见 | HTTP 200 ≠ 业务送达 |
| P12 重复派发 | 未锁 | 同 @ 触发两次 invocation |

**根因定位**（三层裂缝叠加）：
- **消息层**：抄 clowder worklist 抄错——F003 的 return-path 启动新 invocation 而非 worklist 续推，造成 R-184
- **编码层**：Codex 双路事件（`codex-runtime.ts:249-261` delta + `item.completed.agent_message`）拼接 + stream chunk UTF-8 边界无保护
- **协议层**：五条不变量全漏（地址 / 收条 / 隔离 / 持久化 / 对账）

**北极星**：
> A2A = 一次有身份、有寿命、有上下文、有边界、有对账能力的 durable work item。
> 骨架抄 clowder，细节修三处抄错 + 一处前端必修。

## What

六条不变量全绿 + 14 类症状全部有对应回归测试 + 小孙两个痛点场景体感改变：

1. **小孙能连发两条 @**（Day 1 可用）：前端 `composer.tsx` 的 `isBusy` 改成只看当前线程，后端 `runningSlots` 早就支持跨 provider 并发
2. **A2A @ 时 system prompt 硬编码 "Direct message from X; reply to X"**：被 @ 者一眼知道谁 @ 的、该回给谁
3. **长对话召新 agent 不再状况外**：burst 动态检测（15min gap）+ 语义链保护（tool_use→tool_result / Q→A）+ Omitted Tombstone 呈现被省消息（条数/时间/参与者/关键词/retrieval hint）
4. **0 跨房间污染**：Broadcaster 后端 `sessionGroupId` 强过滤，不靠前端兜底
5. **MCP 失败不再静默**：trigger_mention HTTP 200 仅代表 callId 创建，业务结果走 lifecycle，30s 超时强制 NACK
6. **R-184 根治**：废 F003 return-path new-invocation，改同一 routeSerial 里 worklist 续推（同一 turn 不产生第二行 DB message）
7. **进程重启不丢链**：A2AChainRegistry / ParallelGroupRegistry / RunningSlots 下沉 DB，CAS 状态转移
8. **每条 @ 可见生命周期**：前端 pill（发送中/已阅/处理中/完成/超时/失败）+ `/debug/a2a` 对账面板

## Acceptance Criteria

### 六条不变量 AC（客观可测）

- [ ] **I1 · AgentRef + Markdown-AST mention**：code block / backtick 里的 `@xxx` 不派发；公文标签（`**Reviewer:** @xxx`）后的 @ 派发；所有 line-start miss 记日志
- [ ] **I2 · Worklist 续推 + Call Lifecycle**：
  - 任一 a2a_call 必达终态（done/failed/timeout/cancelled）
  - 同一 turn 不产生两行 DB message（R-184 回归必绿）
  - 超 `deadline_at` 的 working call 必 timeout
- [ ] **I3 · Broadcaster 后端强隔离**：fuzz 测试向 A 房间发 10000 条，B 房间 SSE 零泄漏
- [ ] **I4 · Registry 持久化 + CAS**：`kill -9` 重启后所有 pending call 状态可恢复，回程不重入
- [ ] **I5 · Observable State**：`/debug/a2a` 任意时刻可查 pending/working/timeout；前端每个 @ 有可见状态 pill
- [ ] **I6 · 身份贯穿**：
  - 所有 A2A 入口（dispatch/trigger_mention/post_message）返回 callId
  - MCP trigger_mention HTTP 200 仅代表 callId 创建，业务结果走 lifecycle
  - 30s 无心跳强制 NACK
  - callback token 2h TTL

### 14 症状回归测试

- [ ] M1 R-184 双消息：replay-R184.ts 触发 return-path 场景，断言 DB 只产生一条 message
- [ ] M2 R-185 乱码：chunk 边界 fuzz（3-byte UTF-8 切在第二字节），runtime decode round-trip 一致
- [ ] M3 R-190 @ 不生效：`**Reviewer:** @范德彪` AST 识别派发
- [ ] M4 R-188 不收敛：DiscussionCoordinator 每次讨论必生成 [结论卡片]
- [ ] P5 空壳 10.84%：fake-runtime 回 12 字节后断流，30s 后 timeout NACK
- [ ] P6 窜房间 14.38%：跨 sessionGroup 广播零泄漏
- [ ] P7 Phase 越界：Phase 状态机 CAS 转移单调
- [ ] P9 tool-use 打断 9.25%：tool_use 期间新 @ 进入不破坏状态机
- [ ] P11 孤儿 95%：content_blocks 回填（依赖 I4）
- [ ] P12 重复派发：同 callId 第二次 dispatch 幂等拒绝
- [ ] P13 时序错乱：DB created_at 单调 fuzz
- [ ] P14 MCP 静默：trigger_mention 业务失败冒泡 error event

### 小孙两个痛点场景（体感验收）

- [ ] **场景 1 · 并发 @**：小孙连发 "@黄仁勋 做 A" + "@范德彪 做 B"，两人并发开跑（Day 1 可用）
- [ ] **场景 3 · 长对话召新 agent**：100 轮对话后 @ 范德彪，范德彪收到 burst + Tombstone + rollingSummary 三层上下文，不主动调 MCP 也能理解主线

## Dependencies

- **F003**（done）：本 feature Evolved from F003；废 F003 return-path new-invocation 是最大手术
- **F024**（done）：Replay Harness 在 F024 worktree 范式内跑（不污染主仓 dev）
- **F018**（done）：SessionBootstrap 基础设施已就位，F026 在其上叠 burst + Tombstone
- **F007**（done）：rollingSummary 机制已有，F026 不动它的生成策略
- **F023**（done）：MCP 挂载统一已就位，F026 的 callback token 在 MCP 层做

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|---|---|---|---|
| 抄 clowder worklist 续推 vs 保留 F003 return-path | A 抄 / B 保留 | **A 全抄** | F003 的 return-path new-invocation 是 R-184 双消息根因。clowder 原版 `route-serial.ts:1290` 同一 routeSerial 内 `worklist[++index]` 续推，不产生新 invocation |
| 抄 clowder `a2aFrom + triggerMessageId` 注入 system prompt | A 抄 / B 保留现状事后补救 | **A 全抄** | 被 @ 者直接知道谁 @ 的、该回给谁，不再靠回程文本拼接 |
| 抄 clowder Burst 动态检测 vs 保留固定 40 条快照 | A 抄 / B 保留 | **A 全抄，参数保留 clowder 默认** | 固定 40 条对长对话召新 agent 明显不够；clowder `burstSilenceGapMs=900000ms` + min=4/max=12 + `protectSemanticChains` 递归保护 |
| 抄 clowder Omitted Tombstone | A 抄 / B 不做 | **A 全抄** | 被省消息完全不可见是场景 3 根因；Tombstone ~40 tokens 给被召 agent 一个"有东西被省、怎么查"的明确信号 |
| 抄 clowder ThreadMemory 单段 cap 300 tokens | A 抄 / B 保留 1200-3000 动态 | **B 保留** | clowder 是 ToC 猫 app 单一领域；我们跨编程/文档/决策多角色，300 tokens 摘要会丢 signal。但加软上限 2000 防失控 |
| 抄 clowder Rolling Summary 纯规则提取 | A 抄 / B 保留 Gemini→Claude→规则三级降级 | **B 保留** | clowder 单 session 事务集中，规则够用；我们跨多天多会话，LLM 摘要的"话题/决策/待办"结构对长对话召新 agent 更友好。加缓存命中率监控 |
| F015（调度状态持久化）关系 | A 并行 / B 吞并 / C 独立 | **B 吞并 Supersedes F015** | F015 "DispatchOrchestrator 关键 Map 写入 DB + 进程重启恢复"完全被 I4 超集覆盖；F015 spec 未开动，直接关停 |
| "统一 A2ASession 对象" vs "六条不变量驱动" | A 对象 / B 不变量 | **B 不变量** | 对象只是实现手段，不是卖点。真正需要验收的是"五条漏不变量全焊死"+"14 症状全回归"，不是多了一个 class |
| Day 1 前端 composer.tsx isBusy fix 放 P0 还是 P5 | A P0 Day1 / B P5 统一做 | **A P0 Day1** | 小孙原痛点场景 1 必须立刻解。半天工作量，不阻塞任何 Phase |
| 废 F003 return-path 的风险 | A 直接删 / B 保留 feature flag 双轨 | **B 双轨上线** | `message-service.ts` 是核心主干，回归面大。新 callId 路径 + 旧 return-path 并行 2 周，flag 切换 |

## Timeline

| 日期 | 事件 |
|---|---|
| 2026-04-22 | Kickoff（五轮讨论后收敛立项） |

## Links

- Discussion: 五轮迭代在 room R-190 对话记录（Phase 1-3 + 自我翻案 + Clowder 源码逆向）
- Plan: 见下方 Phase 拆分（writing-plans 阶段补 `docs/plans/F026-*.md`）
- Clowder 源码证据：`/c/Users/-/Desktop/cafe/clowder-ai`
  - WorklistRegistry: `packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts:26-208`
  - context-transport (Burst + Tombstone + protectSemanticChains): `context-transport.ts:60-302`
  - SessionPromptBuilder (a2aFrom 注入): `SystemPromptBuilder.ts:480-483`
  - InvocationRegistry (callback token TTL): `InvocationRegistry.ts:37-199`
  - InvocationQueue (STALE 阈值): `InvocationQueue.ts:430-545`
- 当前实现关键位置：
  - `packages/api/src/orchestrator/mention-router.ts:21-80`
  - `packages/api/src/orchestrator/dispatch.ts:59-362`
  - `packages/api/src/orchestrator/return-path.ts:30-63`（本 feature 将废除）
  - `packages/api/src/orchestrator/a2a-chain.ts:14-34`
  - `packages/api/src/services/message-service.ts:841/895/1402-1435`
  - `packages/api/src/runtime/codex-runtime.ts:240-266`
  - `packages/api/src/orchestrator/context-snapshot.ts`
  - `packages/api/src/orchestrator/context-assembler.ts`
  - `packages/api/src/orchestrator/session-bootstrap.ts`
  - `packages/api/src/ws.ts:50-58`
  - `apps/web/components/chat/composer.tsx:84-85`

## Evolution

- **Evolved from**: F003（A2A 运行时闭环 — StopReason 续写 + 回程派发 + SOP 强制交接）
- **Supersedes**: F015（调度状态持久化 — 被 I4 吞并）
- **Blocks**: 无
- **Related**: F020（决策卡片挂载矩阵 — Coordinator 触发点）、F023（MCP 挂载统一 — callback token 层）、F007（上下文压缩 — rollingSummary 复用）、F018（SessionBootstrap — burst + Tombstone 叠加）

## Phase 拆分（6 周，依赖严格）

### P0 · 证据与 Day 1 Fix（3 天）

- **Day 1**：M3 `composer.tsx:84-85` isBusy 修掉（小孙场景 1 并发 @ 立即可用）
- **Day 2**：M4 `ws.ts:50-58` Broadcaster 加 `sessionGroupId` 过滤（P6 窜房间 14.38% 归零）
- **Day 3**：Replay Harness 骨架（`packages/api/src/__tests__/a2a-replay/`）+ R-185 chunk 边界 fuzz 用例 + `callbacks.ts:398-407` 业务失败冒泡短补丁

### P1 · L1 地基（1.5 周，无依赖）

- `a2a_calls` 表 + drizzle migration
- I1 AgentRef + Markdown-AST mention（替换 `mention-router.ts` 纯正则）
- I6 callId 贯穿所有 A2A 入口（dispatch / trigger_mention / post_message）
- callback token + 2h TTL
- Lifecycle 状态机 CAS 转移
- 双轨 feature flag：新 callId 路径 + 旧路径并行

### P2 · Worklist 续推（1.5 周，依赖 P1）

- 废 F003 `return-path.ts` new-invocation 逻辑
- 实现同一 routeSerial 内 `worklist[++index]` 续推
- `a2a-chain.ts` 补 `senderAlias + triggerMessageId` 字段
- system prompt 硬编码 `Direct message from X; reply to X (trigger: msgId)`
- R-184 回归测试必绿

### P3 · Context 改造（1 周，依赖 P1）

- 抄 clowder `context-transport.ts:detectRecentBurst`（`burstSilenceGapMs=15min`, min=4/max=12）
- 抄 `protectSemanticChains`（Q→A / tool_use→tool_result 递归保护）
- 抄 `buildTombstone` + `formatTombstone`（~40 tokens 紧凑段）
- `context-snapshot.ts` 从固定 40 条 → 动态 burst 检测
- `context-assembler.ts` 注入 Tombstone section

### P4 · 持久化（1 周，依赖 P1+P2）

- A2AChainRegistry / ParallelGroupRegistry / RunningSlots 下沉 DB
- CAS 转移 + "return-path 已消费"标记
- STALE 阈值扫描任务（60s queued / 10min processing）
- `kill -9` 重启恢复测试

### P5 · 对账与体验（1 周，依赖 P1+P4）

- `/debug/a2a` 视图（show pending/working/timeout）
- 前端 @ pill 状态（发送中/已阅/处理中/完成/超时/失败）+ 失败重发按钮
- DiscussionCoordinator + [结论卡片] 渲染
- Trace-ID 溯源图（可选，P5 后段）

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| P2 改造 `message-service.ts` 主干回归面大 | 高 | 核心 | **双轨上线**：新 callId 路径 + 旧 return-path 并行 2 周，flag 切换 |
| P4 DB 写入成瓶颈 | 中 | 性能 | callId 转移走异步队列，CAS 失败自动重试 |
| P4 回程 race 未修净 | 中 | 数据 | shadow-mode：写 DB 但仍以内存为准，对账一致后切 |
| Phase 2 超时触发误杀长思考 | 低 | 体验 | `deadline_at` 按 agent/skill 分档（默认 30s，tdd 类 180s） |
| 双轨 flag 切换期间状态不一致 | 中 | 数据 | 切换窗口内禁止新 A2A，等所有在飞 call 完成再切 |
