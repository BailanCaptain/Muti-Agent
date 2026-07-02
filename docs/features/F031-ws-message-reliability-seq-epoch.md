---
id: F031
title: WS 消息可靠性：sessionGroup seq + epoch + gap 检测/catch-up（F-B）
status: done
owner: 黄仁勋
created: 2026-06-13
completed: 2026-07-03
---

# F031 — WS 消息可靠性：sessionGroup seq + epoch（F-B）

> clowder-ai 借鉴批次第 2 个。2026-07-02 启动（F030 已 DONE）。
> 参考：clowder-ai `ThreadSequencer.ts`（单实例 in-memory，明确拒绝分布式 sequencer）。
> ⚠ 本仓 `reference-code/clowder-ai` 快照是旧版**不含** ThreadSequencer——设计以德彪当时对上游的核实结论 + 本仓实测拓扑为准。

## Why

WS 广播流中丢失的事件目前**不可检测**——表现为"这条消息怎么没显示/状态不对"，排查无从下手。seq 单调号 + 启动 epoch UUID + 客户端 gap 检测自动 catch-up，可把这一整类沉默 bug 变成**可观测、可自愈**。

## 实测拓扑（2026-07-02 立项复核，HEAD c7ad1f2）

服务端事件有**两条投递通道**（spec 骨架未提，立项实测补上）：

1. **broadcast 通道**：所有生产者统一走 `broadcaster.broadcast`（server.ts 全部 lazy wrap）→ `ws.ts:58` 闭包按 sessionGroupId 强过滤逐 socket 发送。A2A 派发 turn 的流事件（server.ts:706 `emit: broadcaster.broadcast`）、pending.change、wake.trigger、scheduler.alert 等都在此通道。**这是唯一中央咽喉，seq 注入点。**
2. **单 socket 直发通道**：用户从某 socket 发 send_message → `ws.ts:144` 把 socket-bound emit 传给 `messages.handleClientEvent` → 该 turn 的 status/message.created/thread_snapshot/assistant_delta **只发给发起 socket**，不经过 broadcast。

客户端：单 socket + 指数退避重连（`components/ws/client.ts`）；`onReconnect` → `selectSessionGroup(activeGroupId)` 全量重拉（app/page.tsx:97，B001 Fix 2）；切房间 → `subscribe(groupId)` + `selectSessionGroup` 拉快照。

## What（细化设计提案 · 待 Design Gate）

### 核心决策：只对 broadcast 通道注 seq

- seq 作用域 = per-sessionGroup，注入点 = broadcast 咽喉（ws.ts:58 闭包或其上游 wrap），事件带 groupId 才注，同一事件发 N 个 socket 带同一 seq。
- **直发通道不注 seq**（显式设计，不是遗漏）：直发事件只去一个 socket，若从同组计数器取号，同组其他 socket 会看到假 gap → catch-up 风暴。直发通道的丢失已由现有 B001 路径兜底（send 失败 → evict → close → 重连全量重拉）。
- 无 groupId 的 legacy fan-out 事件（部分 status/preview.auto_open）不注 seq，客户端忽略无 seq 事件。
- epoch = 进程启动时 `randomUUID()`，全局一个；seq 内存 Map<groupId, number>，重启归零靠 epoch 区分。**不做分布式**（clowder KD-9 反 over-engineering 结论照搬）。

### 水位线（watermark）对齐

快照必须携带 `{ epoch, seq }` 水位线，否则客户端换基线时无法对齐流与快照：

- **仅** `GET /api/session-groups/:groupId` 响应附带当前组水位线（德彪 r1 P2：`/api/bootstrap` 只返回组列表、无单组语义，v1 不带，避免造出无消费语义的全局水位线）；
- 客户端收快照 → 基线 = 水位线；此后 seq ≤ 基线的流事件视为快照已覆盖（丢弃），seq = 基线+1 起校验连续性；
- 水位线读取时机 = 快照组装开始前（read-before-build）：只保证不把归零/跳号误判成已覆盖；"过投递"由 delta offset 幂等化兜底（见下），不再假设 store merge 幂等。

### delta 幂等化：offset 字段（德彪 r1 P1）

**问题**：`assistant_delta` 非幂等——客户端 `flushDeltas` 盲追加（thread-store.ts:375），快照 merge 只按 messageId 偏长内容（:321 启发式）；而 HTTP 快照 handler 先 `flushActiveStreaming` 再组装（threads.ts:100），快照必含 flush 时点全部流内容。catch-up 拉快照期间在途/RAF 缓冲里的 delta 随后追加 → **内容重复**。没有 offset，F031 会把"丢"变成"重复"。

**修法**：`assistant_delta` / `assistant_thinking_delta` payload 加 `offset: number` = 服务端该消息累计内容长度（append 前，emit 源头注入，双通道通用、不依赖 seq）：

- **幂等判定在 flush 时刻，不在入口**（德彪 r2 P1）：入口判重拦不住"已进 RAF 队列、快照换基线后才 flush"的 delta——`replaceActiveGroup` 只 merge timeline 不 prune pendingDeltas，快照把 timeline 更到 110 后，队列里 offset=100/len=10 的 segment 盲 flush 仍拼成 120。
- 修：`applyAssistantDelta`/`applyThinkingDelta` 只把 `{offset, text}` segment 入队；`flushDeltas` 以**flush 时刻的 timeline 当前长度**逐段判定：`offset === 长度` → 追加；`offset <` → 重复丢弃（快照已覆盖）；`offset >` → 丢弃该段 + 标记消息内空洞 → 触发同一 catch-up（不留队，快照会带全量内容）。snapshot 与 RAF 任意交错顺序均收敛。
- content 与 thinking 各自独立 offset 空间；**thinking 有两个 emit 源都要注 offset**：onToolActivity（message-service.ts:1877）+ stderr cleaned chunk（:1955），不能只改 onAssistantDelta（德彪 r2 residual risk）。
- retry（resetAssistantStream 清零）后服务端重写流 offset 从 0 重启，天然对齐。

### 客户端 gap 检测 + catch-up

- 只跟踪当前订阅组：`(lastEpoch, lastSeq)`；
- seq 连续 → 通过；seq 跳号 → **gap：console.warn 记录（含丢失区间）+ 触发 catch-up**；seq ≤ lastSeq → 陈旧丢弃；epoch 变化 → 重置基线 + 全量重拉；
- **catch-up v1 = 复用现有全量重拉**（`selectSessionGroup`，与 onReconnect 同路径）：单用户小房间规模下全量永远正确且便宜，**不做 ring-buffer 增量回放**（显式 non-goal，防 over-engineering）；
- 风暴护栏：catch-up 进行中不重复触发（debounce）+ 连续失败重试上限 → 降级为下次重连全量拉 + 可见状态提示；
- 切房间顺序改为 **subscribe-before-fetch**（德彪 r1 P2）：现状 `selectSessionGroup` 先 HTTP fetch 再 `subscribeToRoom`（thread-store.ts:469），fetch 与 subscribe 之间的新组事件被 shouldDeliver 过滤 = 明确丢失窗口；改为先订阅再拉快照，缩窄窗口；残余 race 靠 gap→catch-up 自愈（不上订阅 ACK）。

### Non-Goals（v1 显式不做）

- ring-buffer 增量 catch-up / 服务端事件重放
- 分布式 / 持久化 sequencer
- per-socket seq（TCP 已保证连接内有序，检测不到任何东西）
- 修直发通道多标签不对称（同组第二个标签页收不到别人 turn 的流事件——**既有行为**，F031 不改投递拓扑，只保证不因 seq 恶化；如需修另立 feature）

## Acceptance Criteria（2026-07-02 立项细化）

- [x] AC1: 服务端 sequencer 模块（per-sessionGroup 单调 seq + 进程 epoch UUID）在 broadcast 咽喉注入；直发通道显式不注（含设计注释）；单测覆盖（多组独立计数 / 无 groupId 跳过 / N socket 同 seq）
- [x] AC2: 快照水位线：**仅** `GET /api/session-groups/:groupId` 响应携带 `{ epoch, seq }`（bootstrap 不带，德彪 r1 P2）；客户端以水位线换基线，seq ≤ 水位线的流事件丢弃不误报
- [x] AC3: 客户端 gap 检测：连续通过 / 跳号触发 catch-up（复用 selectSessionGroup 全量重拉）+ console.warn 丢失区间 / 陈旧 seq 丢弃 / epoch 变化重置 + 全量重拉；catch-up debounce + 失败重试上限 + 降级；切房间改 subscribe-before-fetch；单测覆盖
- [x] AC4: delta 幂等化：`assistant_delta` / `assistant_thinking_delta` 携带 offset（emit 源头注入，双通道，thinking 两个 emit 源 :1877/:1955 都注）；客户端 segment 入队 + **flush 时刻**逐段判定（dup 丢弃 / hole 丢段并触发 catch-up / 对齐追加），snapshot 与 RAF 任意交错收敛；content 与 thinking 独立 offset；retry 清零重启对齐；单测覆盖
- [x] AC5: 集成测试五场景：① socket evict 丢广播 → gap → catch-up 收敛 ② 服务端重启（epoch 变化）→ 重置收敛 ③ 同组双 socket 一方收直发事件不造成另一方假 gap ④ catch-up 快照已含某 streamed delta，随后到达的同 delta 不得重复追加（德彪 r1 OQ5）⑤ **delta 已入 RAF pending 队列 → 快照换基线 → flush 不得重复追加**（德彪 r2 P1 复现场景）
- [x] AC6: 可观测性：gap / dup / hole 事件客户端有结构化 console.warn（组 / epoch / 丢失区间 / 触发的动作），让"消息没显示"从玄学变成一行日志

## Dependencies

- 无硬依赖

## Design Decisions（预置约束 + 立项补充）

| 决策 | 结论 | 原因 |
|------|------|------|
| 序列域 | sessionGroup-scoped | 我们 WS 订阅按 sessionGroupId 路由非 threadId（德彪实证 ws.ts:58 / page.tsx:109） |
| 架构 | 单实例 in-memory，不做分布式 | 照搬 clowder KD-9 反 over-engineering 结论 |
| seq 注入点 | 仅 broadcast 咽喉，直发通道不注 | 直发只达单 socket，同组计数器取号会给其他 socket 造假 gap（2026-07-02 实测拓扑） |
| catch-up v1 | 全量重拉（复用 onReconnect 路径） | 单用户规模全量便宜且永远正确；ring-buffer 是伪需求前的过度设计 |
| 快照水位线 | 仅 group snapshot 端点携带 | 无水位线则流与快照无法对齐；bootstrap 无单组语义不带（德彪 r1 P2） |
| delta 幂等化 | offset 字段（服务端权威累计长度） | flushDeltas 盲追加 + 快照先 flush 流缓冲 → catch-up 必现重复追加；offset 同时判 dup 和 hole，双通道通用（德彪 r1 P1） |
| offset 判定挂点 | flush 时刻逐段判定（segment 队列），入口只入队 | 入口判重拦不住已入 RAF 队列、快照换基线后才 flush 的 delta；flush 时以当前 timeline 长度为准，任意交错收敛（德彪 r2 P1） |
| 切房间顺序 | subscribe-before-fetch | fetch→subscribe 之间新组事件被过滤是明确丢失窗口；先订阅可缩窄，残余靠 catch-up 自愈，不上 ACK（德彪 r1 P2） |
| 线格式 | 顶层 `seq?/epoch?` 可选字段（`SequencedRealtimeServerEvent` 单独类型，不逐 union 分支改） | 零迁移成本，老事件/无 seq 事件天然兼容（德彪 r1 OQ4） |
| scheduler.* `as never` 事件 | F031 不动，type debt 另记 | 无 groupId 不参与 seq；收编 union 是独立整改（德彪 r1 OQ6） |

## Timeline

- 2026-06-13 spec 登记（clowder 借鉴批次 2/6）
- 2026-07-02 立项启动：锚点复核（ws.ts:58 ✅ / client.ts:76 ✅ / 双通道拓扑为新发现）+ AC 细化 + 设计提案 → Design Gate（范德彪）
- 2026-07-03 Design Gate r1 NEEDS-WORK（范德彪）：P1 delta 非幂等（catch-up 把丢变重复，锚点全实证）→ 修订入 offset 幂等化；P2 subscribe-before-fetch + bootstrap 水位线收窄。AC 4→6 条 → r2 送审
- 2026-07-03 Design Gate r2 NEEDS-WORK（范德彪）：P1 offset 入口判重拦不住已入 RAF 队列的 delta → 修订为 segment 队列 + flush 时刻判定；residual risk：thinking 两个 emit 源（:1877/:1955）都要注 offset。集成测试 +第⑤场景 → r3 送审
- 2026-07-03 **Design Gate r3 GO**（范德彪，"可以开 worktree 进 TDD"）+ 实现要点：offset 必须在 `assistantContent += delta` 前捕获。实现启动：worktree `.worktrees/F031`（feat/F031-ws-reliability）+ plan `docs/plans/F031-ws-reliability-plan.md`
- 2026-07-03 实现完成（TDD 6 commit，43 新用例）+ quality-gate PASS（typecheck/build/test/lint 全绿 + preview :8804 活体 curl 见真 wsWatermark）
- 2026-07-03 Code Review：德彪 r4 NEEDS-WORK（P1 切房间 pending 窗口终版事件丢 / P2 dispatch.blocked 提取规则不同源）→ 全修（beginSwitch pending 对账补拉 + extractSessionGroupId 上移 shared）→ r5 NEEDS-WORK（P1 fresh monitor 静默采纳吞 pending）→ 修（pending 判定优先）→ **r6 GO（0 P1 / 0 P2）**
- 2026-07-03 **MERGED**：rebase origin/dev（608e7e7）后全量 api 3501 + 组件 781 绿 → squash `7e700d4` 合 dev + push
- 2026-07-03 **DONE（小孙拍板收口）**：跨 agent 愿景验证因桂芬不可用（gemini CLI IneligibleTierError 地区墙）由小孙直接拍板豁免；独立验证已由范德彪 r4→r6 三轮真 diff review 覆盖。活体观察项转日常：正常使用下 console 不应出现 catch-up 风暴/假 gap `[F031:ws-gap]` 日志

## Evolution

- **Evolved from**: 无
- **Related**: F030（同批次）
