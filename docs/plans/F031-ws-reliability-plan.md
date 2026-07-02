# F031 WS 消息可靠性 Implementation Plan

**Feature:** F031 — `docs/features/F031-ws-message-reliability-seq-epoch.md`
**Goal:** WS 广播流丢事件从"不可检测的玄学"变成"可观测 + 自愈"（per-sessionGroup seq + 进程 epoch + 客户端 gap 检测 → catch-up 全量重拉；delta offset 幂等化保证 catch-up 不把丢变重复）。
**Design Gate:** 范德彪 r1→r3 GO（2026-07-03，.runtime/reviews/F031-design-r1/r2/r3-verdict）

**Acceptance Criteria（从 feature doc 逐条抄录）:**

- AC1: 服务端 sequencer 模块（per-sessionGroup 单调 seq + 进程 epoch UUID）在 broadcast 咽喉注入；直发通道显式不注（含设计注释）；单测覆盖（多组独立计数 / 无 groupId 跳过 / N socket 同 seq）
- AC2: 快照水位线：**仅** `GET /api/session-groups/:groupId` 响应携带 `{ epoch, seq }`（bootstrap 不带）；客户端以水位线换基线，seq ≤ 水位线的流事件丢弃不误报
- AC3: 客户端 gap 检测：连续通过 / 跳号触发 catch-up（复用 selectSessionGroup 全量重拉）+ console.warn 丢失区间 / 陈旧 seq 丢弃 / epoch 变化重置 + 全量重拉；catch-up debounce + 失败重试上限 + 降级；切房间改 subscribe-before-fetch；单测覆盖
- AC4: delta 幂等化：`assistant_delta` / `assistant_thinking_delta` 携带 offset（emit 源头注入，双通道，thinking 两个 emit 源 :1877/:1955 都注）；客户端 segment 入队 + **flush 时刻**逐段判定（dup 丢弃 / hole 丢段并触发 catch-up / 对齐追加），snapshot 与 RAF 任意交错收敛；content 与 thinking 独立 offset；retry 清零重启对齐；单测覆盖
- AC5: 集成测试五场景：① socket evict 丢广播 → gap → catch-up 收敛 ② 服务端重启（epoch 变化）→ 重置收敛 ③ 同组双 socket 一方收直发事件不造成另一方假 gap ④ catch-up 快照已含某 streamed delta，随后到达的同 delta 不得重复追加 ⑤ delta 已入 RAF pending 队列 → 快照换基线 → flush 不得重复追加
- AC6: 可观测性：gap / dup / hole 事件客户端有结构化 console.warn（组 / epoch / 丢失区间 / 触发的动作）

**Architecture:** 服务端一个 `GroupSequencer`（in-memory Map + 进程 epoch UUID）在 ws.ts broadcast 闭包给带 groupId 的事件盖 `{seq, epoch}`；快照端点先读水位线再组装（read-before-build）；delta 三个 emit 源在 append 前捕获 offset。客户端一个 `StreamMonitor`（基线=快照水位线，观测带 seq 事件判 ok/stale/gap/epoch-change）+ thread-store pendingDeltas 改 offset segment 队列、幂等判定移到 flushDeltas 时刻；catch-up 统一走 `selectSessionGroup` 全量重拉（debounce + 重试上限）。

**Tech Stack:** 无新依赖。api 侧 node:test；组件侧 vitest + happy-dom（F025 基建）。

**我们不做什么（Non-Goals）:** ring-buffer 增量回放 / 分布式 sequencer / per-socket seq / 修直发通道多标签不对称 / scheduler.* `as never` type debt。

**终态 Schema（所有步骤围绕此构建）:**

```typescript
// packages/shared/src/realtime.ts
export type WsWatermark = { epoch: string; seq: number }
// assistant_delta / assistant_thinking_delta payload 增加 offset?: number（可选=向后兼容）
// broadcast 通道事件线格式（不改 union 分支，交集类型一处定义）：
export type SequencedRealtimeServerEvent = RealtimeServerEvent & { seq?: number; epoch?: string }
// GET /api/session-groups/:groupId 响应：{ activeGroup, wsWatermark: WsWatermark }
```

---

## Task 1: shared 类型

**Files:**
- Modify: `packages/shared/src/realtime.ts`（assistant_delta / assistant_thinking_delta payload 加 `offset?: number`；文件尾加 `WsWatermark` + `SequencedRealtimeServerEvent` 导出）

**Steps:**
1. 加类型（三处：两个 delta payload `offset?: number` + 两个新导出类型，各带 F031 注释：offset=服务端该消息累计内容长度 append 前快照；seq/epoch 仅 broadcast 通道注入）
2. Run: `pnpm typecheck` → PASS（纯增量可选字段，零破坏）
3. Commit: `feat(F031): shared 类型 — delta offset + WsWatermark + SequencedRealtimeServerEvent [黄仁勋]`

## Task 2: GroupSequencer（服务端核心，AC1 前半）

**Files:**
- Create: `packages/api/src/routes/ws-sequencer.ts`
- Test: `packages/api/src/routes/ws-sequencer.test.ts`

**Step 1 失败测试**（node:test）：
- next("g1") 连续调用 → 1,2,3（单调）
- next("g1") / next("g2") 独立计数
- current("g1") 不递增；未知组 current → 0
- epoch 是稳定 UUID（两次读相同、格式匹配 /^[0-9a-f-]{36}$/）

**Step 3 最小实现**：

```typescript
import { randomUUID } from "node:crypto"

/**
 * F031 · per-sessionGroup 单调序列号 + 进程 epoch。
 * 单实例 in-memory（clowder KD-9：明确拒绝分布式 sequencer）。
 * 重启后 seq 归零，靠 epoch 变化让客户端区分"重启"与"跳号"。
 */
export class GroupSequencer {
  readonly epoch = randomUUID()
  private seqs = new Map<string, number>()

  next(groupId: string): number {
    const n = (this.seqs.get(groupId) ?? 0) + 1
    this.seqs.set(groupId, n)
    return n
  }

  current(groupId: string): number {
    return this.seqs.get(groupId) ?? 0
  }
}
```

**Run:** `pnpm --filter @multi-agent/api test -- --test-name-pattern sequencer`（按仓里现行跑法调整）
**Commit:** `feat(F031): GroupSequencer per-group seq + 进程 epoch [黄仁勋]`

## Task 3: broadcast 咽喉注入（AC1 后半）

**Files:**
- Modify: `packages/api/src/routes/ws.ts`（broadcast 闭包 + registerWsRoute options 加 `sequencer: GroupSequencer`）
- Modify: `packages/api/src/server.ts`（new GroupSequencer() 单例，传给 registerWsRoute + 后续 Task 4 的 threads routes）
- Test: `packages/api/src/routes/ws.test.ts`（如无则新建；已有则追加）

**Step 1 失败测试**：fake socket 两个订阅 g1、一个订阅 g2：
- broadcast 带 g1 事件 → g1 两 socket 收到**同一** seq + epoch；g2 socket 未收到
- 连续两次 broadcast → seq 递增
- broadcast 无 groupId 事件（如 status 无 groupId）→ 三 socket 都收到且**无** seq/epoch 字段
- 直发通道对照：直接调 `sendSocketEvent(socket, event)` → 无 seq（结构上不经过注入点，测试固化契约）

**Step 3 实现**（ws.ts:58 闭包内，注入放 extractSessionGroupId 之后、循环之前）：

```typescript
options.broadcaster.broadcast = (event) => {
  const eventGroupId = extractSessionGroupId(event)
  // F031 · 仅 broadcast 通道注 seq：直发通道（下方 handleClientEvent 的 socket-bound
  // emit）只达单 socket，若消耗同组计数器会给其他订阅 socket 制造假 gap。
  const outbound: RealtimeServerEvent = eventGroupId
    ? ({ ...event, seq: options.sequencer.next(eventGroupId), epoch: options.sequencer.epoch } as RealtimeServerEvent)
    : event
  for (const socket of sockets) {
    if (!shouldDeliver(socket.sessionGroupId, eventGroupId)) continue
    if (!sendSocketEvent(socket, outbound)) {
      sockets.delete(socket)
    }
  }
}
```

**Commit:** `feat(F031): broadcast 咽喉注入 seq/epoch — 直发通道显式不注 [黄仁勋]`

## Task 4: 快照水位线（AC2 服务端）

**Files:**
- Modify: `packages/api/src/routes/threads.ts`（`GET /api/session-groups/:groupId` handler + options 加 sequencer）
- Modify: `packages/api/src/server.ts`（传 sequencer）
- Test: threads 路由现有测试文件追加（找 `GET /api/session-groups` 现有用例落点）

**Step 1 失败测试**：响应含 `wsWatermark: { epoch, seq }`，seq === sequencer.current(groupId)；`/api/bootstrap` 响应**不含** wsWatermark。

**Step 3 实现**（read-before-build：水位线必须在 flushActiveStreaming **之前**读——组装期间新事件 seq > 水位线 = 过投递（offset/messageId 幂等兜底）；反序会欠投递=真丢失）：

```typescript
app.get("/api/session-groups/:groupId", async (request) => {
  const params = request.params as { groupId: string }
  // F031 · read-before-build：先取水位线再组装快照（含 flush）。
  const wsWatermark = { epoch: options.sequencer.epoch, seq: options.sequencer.current(params.groupId) }
  options.flushActiveStreaming?.(params.groupId)
  return {
    activeGroup: options.sessions.getActiveGroup(...),
    wsWatermark,
  }
})
```

**Commit:** `feat(F031): group snapshot 携带 wsWatermark（read-before-build）[黄仁勋]`

## Task 5: 服务端 delta offset（AC4 服务端，三 emit 源）

**Files:**
- Modify: `packages/api/src/services/message-service.ts`（三处：onAssistantDelta ~:1840 / onToolActivity ~:1876 / stderr cleaned chunk ~:1955）
- Test: `packages/api/src/services/message-service.test.ts` 追加（用现有 fixture runner 模式）

**Step 1 失败测试**：fixture 发三段 delta "AB"/"C"/"DE" → 收到 offset 0/2/3；thinking 两源交错（onToolActivity 一行 + stderr chunk 一段）→ offset 按共用 `thinking` 累计器连续。

**Step 3 实现**（德彪 r3 要点：offset 在 `+=` **之前**捕获，现代码先 append 后 emit）：

```typescript
onAssistantDelta: (delta: string) => {
  const offset = assistantContent.length  // F031 · append 前捕获
  assistantContent += delta
  options.emit({
    type: "assistant_delta",
    payload: { sessionGroupId: thread.sessionGroupId, messageId: assistant.id, delta, offset },
  })
  // ...原有 interval flush 不动
}
// onToolActivity / stderr chunk 同型：const offset = thinking.length 在 thinking += 之前
```

**Commit:** `feat(F031): 三 delta emit 源 append 前捕获 offset [黄仁勋]`

## Task 6: 客户端 segment 队列 + flush 时刻幂等判定（AC4 客户端 · r2 P1 核心）

**Files:**
- Modify: `components/stores/thread-store.ts`（pendingDeltas 结构 / applyAssistantDelta / applyThinkingDelta / flushDeltas / resetAssistantStream / restoreAssistantContent 的 pendingDeltas 清理）
- Test: `components/stores/thread-store.deltas.test.ts`（vitest，新建）

**Step 1 失败测试**（覆盖 AC5 ④⑤ 场景在 store 层的形态）：
- 无 offset（legacy）→ 盲追加（现行为回归保护）
- offset === 当前长度 → 追加
- offset < 当前长度（dup）→ 丢弃，内容不变
- offset > 当前长度（hole）→ 丢段 + hole handler 收到 {messageId, expected, got, kind}
- **⑤ r2 P1 复现**：segment(offset=3,"D") 入队 → replaceActiveGroup 快照 content="ABCD"（已含）→ RAF flush → 内容仍 "ABCD" 不是 "ABCDD"
- **④**：快照 content="ABCD" 先落 → 迟到 segment(offset=2,"C") → 丢弃
- thinking 与 content 独立 offset 空间互不干扰
- resetAssistantStream 清段队列（retry 对齐）

**Step 3 实现**（核心结构）：

```typescript
type DeltaSegment = { offset?: number; text: string }
type PendingDelta = { content: DeltaSegment[]; thinking: DeltaSegment[] }
let pendingDeltas = new Map<string, PendingDelta>()

type DeltaHoleInfo = { messageId: string; kind: "content" | "thinking"; expected: number; got: number }
let deltaHoleHandler: ((info: DeltaHoleInfo) => void) | null = null
export function setDeltaHoleHandler(fn: ((info: DeltaHoleInfo) => void) | null) { deltaHoleHandler = fn }

// F031 · 幂等判定在 flush 时刻不在入口（德彪 r2 P1）：入口判重拦不住
// "已入 RAF 队列、快照换基线后才 flush" 的 delta。以 flush 时刻 timeline
// 当前长度为准，snapshot 与 RAF 任意交错顺序均收敛。
function applySegments(base: string, segments: DeltaSegment[], messageId: string, kind: "content" | "thinking"): string {
  let out = base
  for (const seg of segments) {
    if (seg.offset === undefined) { out += seg.text; continue }        // legacy 盲追加
    if (seg.offset === out.length) { out += seg.text; continue }       // 对齐
    if (seg.offset < out.length) continue                              // dup：快照已覆盖
    deltaHoleHandler?.({ messageId, kind, expected: out.length, got: seg.offset })  // hole → catch-up
  }
  return out
}
```

flushDeltas 改为对每条消息调 `applySegments`；applyAssistantDelta/applyThinkingDelta 只 push segment + scheduleDeltaFlush。

**Run:** `pnpm test:components`
**Commit:** `feat(F031): pendingDeltas 改 offset segment 队列 — flush 时刻幂等判定 [黄仁勋]`

## Task 7: StreamMonitor（AC3 gap 检测 + AC6 可观测性）

**Files:**
- Create: `components/ws/stream-monitor.ts`
- Test: `components/ws/stream-monitor.test.ts`（vitest）

**Step 1 失败测试**：
- setBaseline(g1, {epoch:"e1", seq:5}) 后 seq 6,7,8 连续 → 全 "apply"
- seq ≤ 5 → "drop"（快照已覆盖，不误报）
- seq 跳到 8（期望 6）→ "apply" + catch-up 回调触发一次 + console.warn 结构化（组/epoch/丢失区间 [6,7]/动作）
- catch-up 进行中再遇 gap → 不重复触发（debounce）；catchUpDone() 后恢复
- epoch "e1"→"e2" → 重置基线 + catch-up 触发（全量重拉）+ warn
- 无 seq 事件 → "apply" 且不动基线
- 非当前订阅组事件 → "apply" 不参与校验
- 连续失败重试上限（3 次）→ 降级 warn（"degraded：等下次重连全量拉"）不再触发
- hole 通道（Task 6 的 deltaHoleHandler 接进来）复用同一 catch-up + debounce

**Step 3 实现**：单例 class，`setBaseline / observe(event): "apply" | "drop" / onCatchUp(fn) / catchUpDone(ok)`，内部 lastEpoch/lastSeq/catchUpInFlight/failCount；console.warn 统一 `[F031:ws-gap]` 前缀 + 结构化对象。

**Commit:** `feat(F031): StreamMonitor gap/stale/epoch 检测 + catch-up 护栏 [黄仁勋]`

## Task 8: 客户端接线（AC2 客户端 + AC3 收尾）

**Files:**
- Modify: `components/stores/thread-store.ts`（selectSessionGroup：subscribe-before-fetch 重排 + 响应取 wsWatermark → streamMonitor.setBaseline + catchUpDone(true)）
- Modify: `app/page.tsx`（onMessage 入口：`streamMonitor.observe(event) === "drop"` 则跳过；注册 streamMonitor.onCatchUp(() => selectSessionGroup(activeGroupId)) 与 setDeltaHoleHandler；onReconnect 保持现行为）
- Test: `components/stores/thread-store.select-group.test.ts`（vitest：mock fetch + spy subscribeToRoom 断言先 subscribe 后 fetch；watermark 传给 monitor）

**要点**：依赖方向 = page.tsx 注入 catch-up 回调进 monitor，monitor 不 import store（无环）；subscribeToRoom 挪到 fetchJson **之前**（德彪 r1 P2，缩窄过滤窗口，残余 race 靠 gap 自愈）。

**Commit:** `feat(F031): subscribe-before-fetch + 水位线换基线 + page 接线 [黄仁勋]`

## Task 9: AC5 集成测试五场景（客户端合成流）

**Files:**
- Test: `components/ws/f031-integration.test.ts`（vitest：monitor + store 组合，喂模拟事件流）
- Test: api 侧 ws.test.ts 已在 Task 3 覆盖 ①③ 的服务端半边（evict 后 seq 继续递增 / 直发无 seq）

五场景（客户端侧收敛断言）：
1. evict 丢广播：喂 seq 1,2,[丢 3,4],5 → gap 触发 catch-up → 模拟快照落地 + catchUpDone → 后续 6,7 正常
2. epoch 变化：e1 seq 5 后喂 e2 seq 1 → 重置 + catch-up → 收敛
3. 双 socket 直发不误伤：喂 无 seq 直发事件若干穿插 seq 1,2,3 → 无 gap 误报
4. 快照已含 streamed delta：快照 "ABCD" 落地后迟到 offset=2 delta → 内容不变
5. RAF pending + 快照换基线：segment 入队 → 快照落地 → flush → 无重复（Task 6 已有 store 层版，此处走 monitor+store 全链）

**Commit:** `test(F031): AC5 集成五场景 [黄仁勋]`

## Task 10: 收尾

1. `pnpm typecheck` + `pnpm --filter @multi-agent/api test` + `pnpm test:components` 全绿
2. Feature doc AC 打勾 + Timeline 补实现记录
3. quality-gate skill 自检 → requesting-review 派德彪 code review（r3 verdict 说好实现后打实际 diff）
4. Review GO → merge-gate（worktree rebase origin/dev + squash + push HEAD:dev，F036 教训：merge 前必 fetch 对 origin/dev rebase）

---

**Worktree 注意事项（memory 沉淀）**：创建后 `pnpm install` + build shared；手动起后端注 `API_PORT` + `SQLITE_PATH=.runtime/worktree-preview/data/multi-agent.sqlite`；preview 端口走 F024 registry（:3100+/:8800+）；改 NEXT_PUBLIC_* 要重启 next dev。
