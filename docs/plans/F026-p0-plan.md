# F026 P0 — A2A 可靠通信层 · P0 阶段实施计划

**Feature:** F026 — `docs/features/F026-a2a-reliability-layer.md`
**Goal:** 三天内做掉 P0 三件事——前端并发 @ 立即可用 / 后端 Broadcaster 强隔离 / Replay Harness 骨架与 R-185 fuzz 与 callbacks 业务失败冒泡——**不引入新对象、不改主干 message-service**，全部是局部修补 + 测试基建。
**Acceptance Criteria（覆盖 F026 spec 中可在 P0 闭环的子集）：**
- 场景 1（小孙连发两条 @）Day 1 可用 → 对应 F026 AC「场景 1 · 并发 @」
- I3 Broadcaster 后端强隔离（fuzz 10000 条 0 泄漏）→ 对应 F026 AC「I3」
- M2 R-185 chunk 边界 fuzz 用例落库 → 对应 F026 AC「M2 R-185」
- P14 trigger_mention 业务失败冒泡 error event → 对应 F026 AC「P14」
- Replay Harness 骨架（仅骨架 + R-185 一个用例，其它症状用例由 P1+ 持续填充）

**不在 P0 范围（明确）：**
- 不动 `message-service.ts`、`return-path.ts`、`dispatch.ts` 主干
- 不建 `a2a_calls` 表、不动 callId 链路、不接 SettlementDetector
- 前端 pill / `/debug/a2a` / Tombstone / burst 全部留 P1+

**Architecture：** P0 是「止血 + 立基」。Day 1/2 是局部修补（前端 isBusy 范围 + WS Broadcaster 加 sessionGroupId 过滤），Day 3 是建一个独立的 Replay Harness 骨架（`__tests__/a2a-replay/`），把 R-185 chunk 边界 fuzz 作为第一个回归用例，并在 callbacks 路由层补 trigger_mention 业务失败短补丁。所有产物在终态系统中保留：Day 1 修复直接保留；Day 2 的 `socket → sessionGroupId` 订阅模型是 I3 不变量的实现；Day 3 的 Replay Harness 是 14 症状回归测试的载体。

**Tech Stack：** TypeScript / Node.js test runner（`node:test`）/ Fastify WebSocket / Zustand（前端 store）/ React 18

---

## Design Decisions（P0 局部）

| 决策 | 选项 | 结论 | 原因 |
|---|---|---|---|
| Day 1 isBusy 范围 | A 改成只看当前 group 的 providers / B 全局看但加 group 维度 hasPendingDispatches | **A** | 后端 `runningSlots` 早已是 per-(group, provider) 维度，前端 `providers[provider].running` 是过期建模；改 A 同时不破坏现有 `handleStop` 语义（它只对 running 的 provider stop） |
| Day 2 socket → sessionGroupId 绑定方式 | A 客户端显式 `subscribe` 事件 / B query string 在 connect 时携带 / C 服务端从 first event 推断 | **A** | A 支持同一 tab 切换房间不重连，C 会丢首屏 snapshot，B 不能切换。A 是 clowder-ai 同款做法 |
| Day 2 无 sessionGroupId 的事件如何处理 | A 全部 fan-out / B 强制要求所有事件带 sessionGroupId | **A（带 warn 日志）** | `status`/`message.created`/`preview.auto_open` 三类事件 sessionGroupId 在 shared 类型上是 optional；强制补全是 P1+ 的事，P0 不动 wire 协议 |
| Day 2 socket 未订阅时是否收事件 | A 不收（严格） / B 收所有（宽松，向后兼容） | **A** | 前端首屏一定会发 subscribe；不订阅必是异常状态，宽松等于 I3 残留泄漏 |
| Day 3 Replay Harness 选型 | A node:test 直接驱动 / B 单独 vitest workspace | **A** | 仓内已统一 node:test，新增 vitest = 双跑 = 维护税；harness 只是 fixture 加载器 + assertion helper |
| Day 3 R-185 fuzz 范围 | A 仅 codex-runtime decode round-trip / B 把 claude-runtime 也带上 | **A** | R-185 现场证据指向 Codex chunk 边界（spec 已定位 `codex-runtime.ts:240-266`）；Claude 链路无证据，YAGNI |
| trigger_mention 失败冒泡 | A 抛异常返 5xx / B `{ ok:false, error }` 200 / C 200 但 emit `error` event | **C** | HTTP 200 已是合约不能改；emit error 让前端 console 显形，是 F026 P14 AC 的最小满足 |

---

## Task 0 · 仓库准备

**Files：** 无（仅工作流）

**Step 0.1 — 进 worktree（writing-plans 完即转 worktree skill）**

新建 worktree：`.worktrees/F026-p0`，分支 `feat/F026-p0-a2a-stabilize`。命令由 worktree skill 执行。

**Step 0.2 — 在 worktree 内 install + 跑一次 baseline**

```bash
pnpm install
pnpm --filter @multi-agent/api test 2>&1 | tail -20
```

预期：现有测试全绿（baseline 必须干净，否则后续无法判断回归来源）。

**Step 0.3 — Commit baseline note**

```bash
git commit --allow-empty -m "chore(F026-p0): kickoff worktree, baseline green [黄仁勋/Opus-47 🐾]"
```

---

## Task 1 · Day 1 · composer.tsx isBusy 改成只看当前 group

**根因（实测）：** `components/chat/composer.tsx:83-85`：
```tsx
const runningProviders = PROVIDERS.filter((provider) => providers[provider].running)
const hasRunningProvider = runningProviders.length > 0
const isBusy = hasRunningProvider || Boolean(activeGroup?.hasPendingDispatches)
```
`providers` 来自 `useThreadStore`，`providers[provider].running` 是**全局**布尔（任一房间该 provider 跑就 true），导致小孙在 A 房间发 `@黄仁勋` 后，B 房间的 composer 也被 lock。后端 `runningSlots` 早就是 `(sessionGroupId, provider)` 维度并发，前端是单点错误。

**Files：**
- Modify: `components/chat/composer.tsx:83-85`
- Modify: `components/stores/thread-store.ts`（如需暴露 per-group running 视图）
- Test: `components/chat/__tests__/composer.isbusy.test.tsx`（**先确认仓内是否已有前端测试 runner；没有则降级为 store 级单测，详见 Step 1.0**）

### Step 1.0 — Spike（30 分钟限时）：摸清 thread-store 与是否有前端测试 runner

```bash
grep -n "running" components/stores/thread-store.ts | head
ls components/**/__tests__ 2>/dev/null
grep -n "test" package.json
```

**产出（决策）：**
- A. 若有前端 test runner（jsdom/vitest）→ 写组件级测试
- B. 若没有 → 抽 `selectIsBusyForGroup(state, groupId)` 纯函数到 `thread-store.ts`，用 node:test 测纯函数
- 任一都满足"先红后绿"。优先 B（最小依赖）

### Step 1.1 — 写失败测试（按 Spike 决策走 B 路径示例）

`components/stores/__tests__/thread-store.isbusy.test.ts`（新建）：

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { selectIsBusyForGroup } from "../thread-store"

describe("selectIsBusyForGroup", () => {
  it("returns false when running provider is in a different group", () => {
    const state = {
      activeGroupId: "group-A",
      groups: {
        "group-A": { providers: { claude: { running: false }, codex: { running: false }, gemini: { running: false } }, hasPendingDispatches: false },
        "group-B": { providers: { claude: { running: true },  codex: { running: false }, gemini: { running: false } }, hasPendingDispatches: false },
      },
    } as any
    assert.equal(selectIsBusyForGroup(state, "group-A"), false)
  })

  it("returns true when running provider is in the same group", () => {
    const state = {
      activeGroupId: "group-A",
      groups: {
        "group-A": { providers: { claude: { running: true },  codex: { running: false }, gemini: { running: false } }, hasPendingDispatches: false },
      },
    } as any
    assert.equal(selectIsBusyForGroup(state, "group-A"), true)
  })

  it("returns true when active group has pending dispatches", () => {
    const state = {
      activeGroupId: "group-A",
      groups: {
        "group-A": { providers: { claude: { running: false }, codex: { running: false }, gemini: { running: false } }, hasPendingDispatches: true },
      },
    } as any
    assert.equal(selectIsBusyForGroup(state, "group-A"), true)
  })
})
```

### Step 1.2 — 跑测试确认失败

```bash
pnpm --filter @multi-agent/web test -- thread-store.isbusy
```
预期：FAIL `selectIsBusyForGroup is not a function`

### Step 1.3 — 在 thread-store 暴露 selector + 调整状态形状（最小化）

**先读 `components/stores/thread-store.ts` 确认实际形状**，可能现存只有顶层 `providers`，需新增 `groups[id].providers` 的 per-group 视图（这个视图后端 `thread_snapshot` 里其实早有 — `ActiveGroupView.providers`），把它持久化到 store 即可，不动 wire 协议。

最小实现伪码（实际写时贴近现有命名）：

```ts
export function selectIsBusyForGroup(state: ThreadState, groupId: string | null): boolean {
  if (!groupId) return false
  const group = state.groups[groupId]
  if (!group) return false
  const anyRunning = (Object.values(group.providers ?? {}) as ProviderThreadView[]).some(p => p.running)
  return anyRunning || Boolean(group.hasPendingDispatches)
}
```

### Step 1.4 — 跑测试确认通过

```bash
pnpm --filter @multi-agent/web test -- thread-store.isbusy
```
预期：PASS

### Step 1.5 — composer.tsx 切到 selector

```tsx
const isBusy = useThreadStore((s) => selectIsBusyForGroup(s, activeGroupId))
const hasRunningProvider = useThreadStore((s) => {
  const g = activeGroupId ? s.groups[activeGroupId] : null
  return g ? Object.values(g.providers ?? {}).some((p: any) => p.running) : false
})
const runningProviders = useThreadStore((s) => {
  const g = activeGroupId ? s.groups[activeGroupId] : null
  if (!g) return [] as Provider[]
  return PROVIDERS.filter((p) => g.providers?.[p]?.running)
})
```
注意 `runningProviders` 用于 `handleStop`（只 stop 当前房间的），语义同步收紧。

### Step 1.6 — 浏览器手测（必须）

按 CLAUDE.md：UI 改动起 dev server 实测。

```bash
# 在 worktree 内（端口走 F024 registry，不能用 :3000）
pnpm dev
```

手测脚本：
1. 房间 A：`@黄仁勋 写 hello`，等开始 streaming
2. 切到房间 B（左侧 sidebar）
3. 房间 B 的 composer 必须可输入、可发送
4. 在房间 B：`@范德彪 写 world`，确认能发出
5. 切回房间 A，确认 stop 按钮只 stop A 房间

记录截图到 `.agents/acceptance/F026-p0/day1-concurrent-mention.png`（被 .gitignore 忽略，本地证据）。

### Step 1.7 — Commit

```bash
git add components/chat/composer.tsx components/stores/thread-store.ts components/stores/__tests__/
git commit -m "fix(F026-p0): scope composer isBusy to active group (concurrent @ Day1) [黄仁勋/Opus-47 🐾]"
```

---

## Task 2 · Day 2 · ws.ts Broadcaster 加 sessionGroupId 强过滤

**根因（实测）：** `packages/api/src/routes/ws.ts:48-59`：
```ts
const sockets = new Set<SocketLike>();
options.broadcaster.broadcast = (event) => {
  for (const socket of sockets) {
    if (!sendSocketEvent(socket, event)) sockets.delete(socket);
  }
};
```
sockets 是单一 Set，broadcast 无差别 fan-out。前端单 WS 连接虽然 UI 只渲染当前房间，但所有房间的 streaming delta、snapshot 都进了同一根管子，是 P6 窜房间 14.38% 的根因（前端兜底失效时直接污染）。

**Files：**
- Modify: `packages/api/src/routes/ws.ts`（socket 加 subscribed 状态 + broadcast 过滤）
- Modify: `packages/shared/src/realtime.ts`（新增 client event `subscribe`）
- Modify: `components/ws/client.ts`（前端 subscribe 时机）
- Test: `packages/api/src/routes/__tests__/ws.broadcast-isolation.test.ts`（新建，含 fuzz 10000 条用例）

### Step 2.1 — shared/realtime.ts 加 subscribe client event

读现有 `RealtimeClientEvent` 联合，append：

```ts
| {
    type: "subscribe"
    payload: { sessionGroupId: string }
  }
```

### Step 2.2 — 写失败测试：跨房间 0 泄漏 + fuzz 10000

`packages/api/src/routes/__tests__/ws.broadcast-isolation.test.ts`（新建）：

```ts
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createInMemoryBroadcaster, makeFakeSocket } from "./ws.test-helpers"

describe("ws Broadcaster sessionGroupId isolation (F026 I3)", () => {
  it("delivers room-scoped event only to subscribed sockets", () => {
    const { sockets, broadcaster, addSocket } = createInMemoryBroadcaster()
    const sockA = makeFakeSocket(); addSocket(sockA, { sessionGroupId: "room-A" })
    const sockB = makeFakeSocket(); addSocket(sockB, { sessionGroupId: "room-B" })

    broadcaster.broadcast({ type: "assistant_delta", payload: { sessionGroupId: "room-A", messageId: "m1", delta: "hi" } })

    assert.equal(sockA.received.length, 1)
    assert.equal(sockB.received.length, 0)
  })

  it("fan-outs events without sessionGroupId to all sockets (legacy)", () => {
    const { broadcaster, addSocket } = createInMemoryBroadcaster()
    const sockA = makeFakeSocket(); addSocket(sockA, { sessionGroupId: "room-A" })
    const sockB = makeFakeSocket(); addSocket(sockB, { sessionGroupId: "room-B" })

    broadcaster.broadcast({ type: "dispatch.blocked", payload: { attempts: [] } })

    assert.equal(sockA.received.length, 1)
    assert.equal(sockB.received.length, 1)
  })

  it("drops events to unsubscribed sockets (strict mode)", () => {
    const { broadcaster, addSocket } = createInMemoryBroadcaster()
    const sockA = makeFakeSocket(); addSocket(sockA, undefined) // never subscribed
    broadcaster.broadcast({ type: "assistant_delta", payload: { sessionGroupId: "room-A", messageId: "m1", delta: "hi" } })
    assert.equal(sockA.received.length, 0)
  })

  it("fuzz: 10000 mixed events to room A produce 0 leakage to room B", () => {
    const { broadcaster, addSocket } = createInMemoryBroadcaster()
    const sockA = makeFakeSocket(); addSocket(sockA, { sessionGroupId: "room-A" })
    const sockB = makeFakeSocket(); addSocket(sockB, { sessionGroupId: "room-B" })

    for (let i = 0; i < 10000; i++) {
      broadcaster.broadcast({
        type: "assistant_delta",
        payload: { sessionGroupId: "room-A", messageId: `m${i}`, delta: String(i) },
      })
    }
    assert.equal(sockB.received.length, 0, "B must be a black hole for A traffic")
    assert.equal(sockA.received.length, 10000)
  })
})
```

### Step 2.3 — 跑测试确认失败

```bash
pnpm --filter @multi-agent/api test -- ws.broadcast-isolation
```
预期：FAIL（因为还未实现订阅过滤）

### Step 2.4 — 提取 sessionGroupId 工具

新文件 `packages/api/src/routes/ws-routing.ts`：

```ts
import type { RealtimeServerEvent } from "@multi-agent/shared"

export function extractSessionGroupId(event: RealtimeServerEvent): string | null {
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload) return null

  // Direct field
  const direct = payload.sessionGroupId
  if (typeof direct === "string" && direct.length > 0) return direct

  // approval.request / decision.request: payload itself is the request object
  if (event.type === "approval.request" || event.type === "decision.request") {
    const sgid = (payload as any).sessionGroupId
    return typeof sgid === "string" ? sgid : null
  }

  // dispatch.blocked: derive from first attempt (all attempts share session in practice)
  if (event.type === "dispatch.blocked") {
    const attempts = (payload as any).attempts as Array<{ sessionGroupId?: string }> | undefined
    return attempts?.[0]?.sessionGroupId ?? null
  }

  return null
}
```

### Step 2.5 — 改 ws.ts：socket 加 subscribed state + 过滤

```ts
type SubscribedSocket = SocketLike & { sessionGroupId?: string }
const sockets = new Set<SubscribedSocket>()

options.broadcaster.broadcast = (event) => {
  const eventGroupId = extractSessionGroupId(event)
  for (const socket of sockets) {
    // Strict isolation: room-scoped events only go to matching subscribed sockets.
    // Events without a sessionGroupId (e.g. dispatch.blocked when no attempts)
    // fan out to everyone — explicit legacy fallback.
    if (eventGroupId !== null) {
      if (socket.sessionGroupId !== eventGroupId) continue
    }
    if (!sendSocketEvent(socket, event)) sockets.delete(socket)
  }
}
```

并在 `socket.on("message", ...)` 里加：
```ts
if (event.type === "subscribe") {
  (socket as SubscribedSocket).sessionGroupId = event.payload.sessionGroupId
  log.debug({ sessionGroupId: event.payload.sessionGroupId }, "socket subscribed")
  return
}
```

### Step 2.6 — 跑测试确认通过

```bash
pnpm --filter @multi-agent/api test -- ws.broadcast-isolation
```
预期：PASS（含 fuzz 用例）

### Step 2.7 — 前端 ws/client.ts 在房间切换时发 subscribe

读 `components/ws/client.ts` 现状，在 connect 成功 + activeGroupId 变化时发：
```ts
socket.send(JSON.stringify({ type: "subscribe", payload: { sessionGroupId } }))
```
注意：activeGroupId 切换不重连，但要重发 subscribe 覆盖旧值。

### Step 2.8 — 不破坏现有测试 + 浏览器手测

```bash
pnpm --filter @multi-agent/api test 2>&1 | tail -10
pnpm dev
```

手测脚本：
1. 开两个 tab：tab1 房间 A、tab2 房间 B
2. tab1 `@黄仁勋 数到 30 慢慢说`
3. **tab2 不应出现任何 streaming**（这是 P6 14.38% 的核心场景）
4. F12 Network → WS → 确认 tab2 收到的 frame 数为 0

记录截图到 `.agents/acceptance/F026-p0/day2-isolation.png`。

### Step 2.9 — Commit

```bash
git add packages/api/src/routes/ws.ts packages/api/src/routes/ws-routing.ts packages/api/src/routes/__tests__/ packages/shared/src/realtime.ts components/ws/client.ts
git commit -m "feat(F026-p0): broadcaster sessionGroupId strict isolation (I3) [黄仁勋/Opus-47 🐾]"
```

---

## Task 3 · Day 3 · Replay Harness 骨架 + R-185 chunk 边界 fuzz

**目的：** 给 P1+ 的 14 症状回归测试建一个统一的 fixture 加载器 + 断言入口，避免每个症状各自写一遍。R-185 是第一个落地用例，证明骨架可用。

**Files：**
- Create: `packages/api/src/__tests__/a2a-replay/README.md`
- Create: `packages/api/src/__tests__/a2a-replay/harness.ts`
- Create: `packages/api/src/__tests__/a2a-replay/fixtures/R185-utf8-boundary.ts`
- Create: `packages/api/src/__tests__/a2a-replay/R185.test.ts`

### Step 3.1 — 写失败测试（先有 R-185 用例）

`packages/api/src/__tests__/a2a-replay/R185.test.ts`（新建）：

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { decodeChunkedUtf8 } from "../../runtime/codex-runtime"
import { generateBoundaryFuzzCases } from "./fixtures/R185-utf8-boundary"

describe("R-185 · UTF-8 chunk boundary fuzz (codex-runtime)", () => {
  it("round-trips multi-byte UTF-8 split at every byte boundary", () => {
    const cases = generateBoundaryFuzzCases()
    for (const { input, splits } of cases) {
      const reassembled = decodeChunkedUtf8(splits)
      assert.equal(reassembled, input, `failed for input=${JSON.stringify(input)}`)
    }
  })

  it("does not produce U+FFFD on any single-byte mid-codepoint split", () => {
    const cases = generateBoundaryFuzzCases()
    for (const { splits } of cases) {
      const out = decodeChunkedUtf8(splits)
      assert.equal(out.includes("�"), false, "no replacement char allowed")
    }
  })
})
```

`fixtures/R185-utf8-boundary.ts`（新建）：

```ts
export function generateBoundaryFuzzCases(): Array<{ input: string; splits: Uint8Array[] }> {
  const samples = [
    "你好，世界",                        // 3-byte 中文
    "范德彪 review 了 PR：✅ 通过",       // 中英混排 + emoji
    "𝓗𝓮𝓵𝓵𝓸",                          // 4-byte surrogate pair
    "abc",                               // ascii baseline
  ]
  const cases: Array<{ input: string; splits: Uint8Array[] }> = []
  const enc = new TextEncoder()
  for (const s of samples) {
    const bytes = enc.encode(s)
    for (let cut = 1; cut < bytes.length; cut++) {
      cases.push({
        input: s,
        splits: [bytes.slice(0, cut), bytes.slice(cut)],
      })
    }
  }
  return cases
}
```

### Step 3.2 — 跑测试确认失败

```bash
pnpm --filter @multi-agent/api test -- a2a-replay/R185
```
预期：FAIL `decodeChunkedUtf8 is not a function`

### Step 3.3 — 在 codex-runtime.ts 抽出 decodeChunkedUtf8（最小实现 + export）

读 `packages/api/src/runtime/codex-runtime.ts:240-266` 看现有 chunk 处理逻辑（spec 已定位），把字节累积 + `TextDecoder({stream:true})` 的核心抽成：

```ts
export function decodeChunkedUtf8(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let out = ""
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    out += decoder.decode(chunks[i], { stream: !isLast })
  }
  return out
}
```

**关键约束**：现有 codex-runtime 内部如果是按 string 拼接 chunk（而不是 byte buffer + stream decoder），那 R-185 根因就是它 — 这一步的实现替换是 P1 的事，P0 仅证明 fuzz 框架本身能验出对错。如果现有实现已正确，R-185 的真因在更上游（双路 splice），harness 在 P1 用同一框架追加用例即可。

### Step 3.4 — 跑测试确认通过

```bash
pnpm --filter @multi-agent/api test -- a2a-replay/R185
```
预期：PASS

### Step 3.5 — Replay Harness skeleton（README + 占位 harness.ts）

`packages/api/src/__tests__/a2a-replay/README.md`：

```markdown
# A2A Replay Harness

F026 14 症状回归测试的统一载体。每个症状一个 fixture + 一个 .test.ts。

## 已有用例
- R-185 · UTF-8 chunk 边界 fuzz（P0 落地）

## 待补（P1+）
M1 R-184 / M3 R-190 / M4 R-188 / P5 / P6 / P7 / P9 / P11 / P12 / P13 / P14
```

`harness.ts`：

```ts
// Placeholder for shared event-replay primitives (loadEventsJsonl, replayInto runtime, etc.)
// Filled in P1 when first event-stream-driven case lands (R-184).
export const HARNESS_VERSION = "0.1.0-skeleton"
```

### Step 3.6 — Commit

```bash
git add packages/api/src/__tests__/a2a-replay/ packages/api/src/runtime/codex-runtime.ts
git commit -m "test(F026-p0): a2a-replay harness skeleton + R-185 utf8 boundary fuzz [黄仁勋/Opus-47 🐾]"
```

---

## Task 4 · Day 3 · callbacks.ts trigger_mention 业务失败冒泡

**根因（实测）：** `packages/api/src/routes/callbacks.ts:398-407`：
```ts
if (options.triggerMention) {
  await options.triggerMention(thread.sessionGroupId, { ... })
}
return { ok: true }
```
即使 `triggerMention` throws、目标 alias 不存在、派发被拒绝，HTTP 仍 200 + `ok:true`。MCP 调用方完全收不到失败信号 — 这是 F026 P14 痛点（"trigger_mention 失败静默"）。

**Files：**
- Modify: `packages/api/src/routes/callbacks.ts:398-407`
- Modify: `packages/api/src/services/message-service.ts`（可能需暴露 `emitErrorEvent(sessionGroupId, msg)` helper；如已有等价能力则不动）
- Test: `packages/api/src/routes/__tests__/callbacks.trigger-mention-error.test.ts`

### Step 4.1 — 写失败测试

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildTestApp } from "./_helpers"

describe("POST /api/callbacks/trigger-mention · business error surfacing (F026 P14)", () => {
  it("returns ok:false and emits error event when triggerMention throws", async () => {
    const emittedEvents: any[] = []
    const app = await buildTestApp({
      triggerMention: async () => { throw new Error("target alias not found") },
      onEmit: (ev: any) => emittedEvents.push(ev),
    })

    const res = await app.inject({
      method: "POST",
      url: "/api/callbacks/trigger-mention",
      payload: { invocationId: "inv-1", callbackToken: "ok", targetAgentId: "@幽灵", taskSnippet: "x" },
    })

    assert.equal(res.statusCode, 200) // 合约不变
    const body = res.json()
    assert.equal(body.ok, false)
    assert.equal(typeof body.error, "string")

    const errEv = emittedEvents.find(e => e.type === "status" && /trigger.mention/.test(e.payload.message))
    assert.ok(errEv, "must emit a status event so frontend console shows the failure")
  })
})
```

（如果 `_helpers.ts` 不存在，先在 Spike 里看有没有现成的 fastify test harness，没有就抽一个最小 stub，超出 30min 就降级为对 handler 函数的纯单测。）

### Step 4.2 — 跑测试确认失败

```bash
pnpm --filter @multi-agent/api test -- callbacks.trigger-mention-error
```

### Step 4.3 — 改 callbacks.ts handler

```ts
if (options.triggerMention) {
  try {
    await options.triggerMention(thread.sessionGroupId, {
      targetAlias: body.targetAgentId.trim(),
      taskSnippet: body.taskSnippet.trim(),
      sourceProvider: thread.provider,
      invocationId: invocation.invocationId,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    options.broadcaster?.broadcast({
      type: "status",
      payload: {
        sessionGroupId: thread.sessionGroupId,
        message: `trigger_mention 失败：${msg}`,
      },
    })
    return { ok: false as const, error: msg }
  }
}

return { ok: true as const }
```

注意：`options.broadcaster` 需在 callbacks 路由 register 时注入；现有 `registerCallbacksRoute` 签名不一定有，按需加。

### Step 4.4 — 跑测试确认通过

```bash
pnpm --filter @multi-agent/api test -- callbacks.trigger-mention-error
pnpm --filter @multi-agent/api test 2>&1 | tail -10  # 全量回归
```

### Step 4.5 — MCP 调用侧不需要改（合约说明）

MCP `trigger_mention` 工具的 HTTP 调用层会拿到 `{ok:false, error}`，工具实现里把 `ok:false` 透传成 MCP 错误响应即可（如已是这个语义则跳过）。这是 F026 I6 的预备 — P0 不写"业务结果走 lifecycle"，仅做"失败不再静默"。

### Step 4.6 — Commit

```bash
git add packages/api/src/routes/callbacks.ts packages/api/src/routes/__tests__/callbacks.trigger-mention-error.test.ts
git commit -m "fix(F026-p0): surface trigger_mention business failures (P14) [黄仁勋/Opus-47 🐾]"
```

---

## Task 5 · 收尾：quality-gate + 自验

**Step 5.1 — 全量测试 + lint + typecheck**

```bash
pnpm --filter @multi-agent/api test
pnpm --filter @multi-agent/web test 2>&1 | tail -10  # 若有
pnpm typecheck
pnpm lint
```

**Step 5.2 — 三个证据截图入 worktree 本地**

- `day1-concurrent-mention.png`（A 房间 streaming 时 B 房间能发 @）
- `day2-isolation.png`（tab2 WS frame 数 0）
- `day3-tests-green.png`（terminal 截 a2a-replay/R185 + ws.broadcast-isolation + callbacks.trigger-mention-error 全绿）

**Step 5.3 — 进 quality-gate skill**

P0 不进 acceptance-guardian（依据 `feedback_skip_acceptance_guardian_for_test_infra`：测试基建类 AC 即命令，quality-gate 已等价验收 R-185 + ws-isolation + callbacks-error；Day 1 的体感场景已在 Step 1.6 浏览器实测覆盖）。

**Step 5.4 — 进 requesting-review，@范德彪 review**

P0 不合 dev（依据 `feedback_feature_completion_before_merge`）。Phase 级中间 commit 留 worktree，等 P1+ 全部完成或小孙明确 OK 再 merge。

---

## 风险与回滚

| 风险 | 概率 | 缓解 |
|---|---|---|
| Day 1 thread-store 形状改动牵连 sidebar / 面板 | 中 | 选 Spike B 路径（仅加 selector，不改现有 state shape）；selector 失败回 git revert 单 commit |
| Day 2 前端旧 tab 没发 subscribe 直接收不到事件 | 中 | 前端 client 在 connect 成功后**立即**用当前 activeGroupId 发 subscribe；测试覆盖未订阅 socket 静默掉 |
| Day 2 把"无 sessionGroupId 事件全 fan-out"是漏点 | 低 | P0 接受这个保守策略（Design Decision 已记），P1 强制全事件带 sessionGroupId |
| Day 3 抽 decodeChunkedUtf8 撞到现有 codex-runtime 拼接逻辑 | 中 | 仅 export 函数 + 让现有 chunk 处理调用它；不做"重写消息流"，保持局部 |
| Day 3 callbacks 加 broadcaster 注入面太大 | 中 | 若 register 签名改动太多，降级方案：仅返回 `{ok:false}`，emit 留 P1 |

---

## Out of Scope（再次明确，防 scope 漂移）

- ❌ a2a_calls 表 / drizzle migration（P1）
- ❌ AgentRef + Markdown-AST mention（P1）
- ❌ callId 贯穿 / callback token TTL（P1）
- ❌ 废 F003 return-path / worklist 续推（P2）
- ❌ Burst + Tombstone（P3）
- ❌ Registry 持久化（P4）
- ❌ /debug/a2a + 前端 pill（P5）

P0 三天内只做："止血 + 打地基的第一锹"。
