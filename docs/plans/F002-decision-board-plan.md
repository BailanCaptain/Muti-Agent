# F002 Decision Board Implementation Plan

**Feature:** F002 — `docs/features/F002-decision-board.md`
**Goal:** 把 `[拍板]` 从"inline 即时卡片"改造成"讨论级收敛的批量面板"，实现 Hold→Settle→Flush→Single Dispatch 语义，解决决策静默吞掉 / 多 agent 不收敛 / 讨论消化问题被忽略三重 bug。
**Architecture:** 新增 `DecisionBoard`（session 级 pending 状态机）+ `SettlementDetector`（三信号防抖检测器）+ `ChainStarterResolver`（A2A 链起点定位）三个纯后端模块；`MessageService` 集成：`detectAndEmitInlineConfirmations` 改为 `board.add`，新增 `[撤销拍板]` 解析分支，settle 事件触发 `flushBoard → emit decision.board_flush`；前端新增 `<DecisionBoardModal>` 组件（深墨蓝庄严风格）监听 `decision.board_flush` 事件。MCP `request_decision` 路径完全不动。
**Tech Stack:** TypeScript, Node.js test runner, Fastify (后端), Next.js + React + Tailwind (前端), better-sqlite3, crypto SHA-1
**AC 覆盖**：本 plan 覆盖 F002 feature doc 中 AC1-AC15 全部 15 条验收标准。

---

## Acceptance Criteria 映射表

| AC | 描述 | 覆盖的 Phase/Task |
|----|------|----------------|
| AC1 | 决策落地 写 thread | P2.T3 |
| AC2 | Hold 不弹卡（讨论期） | P1.T1 + P2.T2（detectAndEmitInlineConfirmations 改造） |
| AC3 | Settle 后批量弹（单事件） | P1.T2 + P2.T4 |
| AC4 | 同问题 dedupe | P1.T1（board.add 带归一化 hash） |
| AC5 | 单点 dispatch 收敛 | P1.T3 + P2.T5 |
| AC6 | 撤销生效 | P1.T1（withdraw）+ P2.T2（parser 扩展） |
| AC7 | MCP 路径回归 | P2.T6（回归测试） |
| AC8 | 面板聚合显示 | P3.T2 |
| AC9 | 未决前不可忽略 | P3.T3（关闭 ✕ 语义） |
| AC10 | 提交前可修改 | P3.T2（受控 state） |
| AC11 | 不破坏 F001 视觉 | P3.T2（独立 modal，不动 message 组件） |
| AC12 | 无 hold 超时 | P1.T2（SettlementDetector 无超时字段）|
| AC13 | Settlement debounce | P1.T2 |
| AC14 | 测试覆盖 | 贯穿所有 Task |
| AC15 | Break 1 修复（100% 进 Board） | P2.T2 |

---

## Terminal Schema（终态数据结构）

这些类型是每个 Task 的产物都必须兼容的最终形态。任何 Task 不允许引入会在后续被重写的临时类型。

### `packages/api/src/orchestrator/decision-board.ts`

```typescript
import crypto from "node:crypto"

export type DecisionOption = { id: string; label: string }

export type DecisionRaiser = {
  threadId: string
  provider: import("@multi-agent/shared").Provider
  alias: string
  raisedAt: string // ISO
}

export type DecisionBoardEntry = {
  id: string              // internal uuid, stable across flushes
  questionHash: string    // normalized-hash dedupe key
  question: string        // first raiser's original wording
  options: DecisionOption[]
  raisers: DecisionRaiser[]  // multiple if dedup'd across agents
  sessionGroupId: string
  firstRaisedAt: string   // earliest raiser's timestamp
}

export type AddEntryInput = {
  sessionGroupId: string
  raiser: DecisionRaiser
  question: string
  options: DecisionOption[]
}

export type AddEntryResult =
  | { kind: "added"; entry: DecisionBoardEntry }
  | { kind: "merged"; entry: DecisionBoardEntry } // hash matched, raiser appended

export class DecisionBoard {
  private readonly bySession = new Map<string, Map<string, DecisionBoardEntry>>()
  //                                       ^sessionGroupId  ^questionHash

  add(input: AddEntryInput): AddEntryResult { /* impl in P1.T1 */ }
  withdraw(sessionGroupId: string, raiserThreadId: string, substring: string): DecisionBoardEntry | null { /* impl in P1.T1 */ }
  getPending(sessionGroupId: string): DecisionBoardEntry[] { /* impl in P1.T1 */ }
  drain(sessionGroupId: string): DecisionBoardEntry[] { /* impl in P1.T1 */ }
  hasPending(sessionGroupId: string): boolean { /* impl in P1.T1 */ }
  size(sessionGroupId: string): number { /* impl in P1.T1 */ }
}

export function normalizeQuestion(text: string): string { /* impl in P1.T1 */ }
export function hashQuestion(normalized: string): string { /* impl in P1.T1 */ }
```

### `packages/api/src/orchestrator/settlement-detector.ts`

```typescript
import { EventEmitter } from "node:events"

export type SettlementSignals = {
  hasActiveParallelGroup: (sessionGroupId: string) => boolean
  hasQueuedDispatches: (sessionGroupId: string) => boolean
  hasRunningTurn: (sessionGroupId: string) => boolean
}

export type SettlementDetectorOptions = {
  debounceMs?: number // default 2000
}

export class SettlementDetector extends EventEmitter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly debounceMs: number

  constructor(
    private readonly signals: SettlementSignals,
    options: SettlementDetectorOptions = {},
  ) {
    super()
    this.debounceMs = options.debounceMs ?? 2000
  }

  /** Call whenever any of the three signals may have changed. */
  notifyStateChange(sessionGroupId: string): void { /* impl in P1.T2 */ }

  /** Immediate sync check (no debounce). */
  isSettledNow(sessionGroupId: string): boolean { /* impl in P1.T2 */ }

  /** Cancel any pending timer for this session. */
  cancel(sessionGroupId: string): void { /* impl in P1.T2 */ }

  dispose(): void { /* impl in P1.T2 */ }

  // Event: "settle", payload: { sessionGroupId: string }
}
```

### `packages/api/src/orchestrator/chain-starter-resolver.ts`

```typescript
import type { SessionRepository } from "../db/repositories/session-repository"

export type ChainStarterTarget = {
  threadId: string
  provider: import("@multi-agent/shared").Provider
  alias: string
}

export type ResolveInput = {
  sessionGroupId: string
  boardEntries: Array<{ raisers: Array<{ threadId: string; raisedAt: string }> }>
}

export class ChainStarterResolver {
  constructor(private readonly repository: SessionRepository) {}

  /** Returns null when no resolvable target; caller should fall back to
      earliest raiser in boardEntries. */
  resolve(input: ResolveInput): ChainStarterTarget | null { /* impl in P1.T3 */ }
}
```

### 新增 Shared Event Type

`packages/shared/src/types.ts`（新增类型，不动现有 `DecisionRequest`）：

```typescript
export type DecisionBoardItem = {
  id: string
  question: string
  options: Array<{ id: string; label: string }>
  raisers: Array<{ alias: string; provider: Provider; avatarHint?: string }>
  firstRaisedAt: string
}

export type DecisionBoardFlushEvent = {
  type: "decision.board_flush"
  payload: {
    sessionGroupId: string
    items: DecisionBoardItem[]
    flushedAt: string
  }
}

export type DecisionBoardRespondPayload = {
  sessionGroupId: string
  decisions: Array<{
    itemId: string
    choice:
      | { kind: "option"; optionId: string }
      | { kind: "custom"; text: string }
  }>
  skipped?: boolean // if true → user clicked 暂不回答
}
```

### 前端组件

`apps/web/src/components/decision-board/DecisionBoardModal.tsx`（新）
`apps/web/src/components/decision-board/DecisionBoardModal.module.css`（新）
`apps/web/src/stores/decision-board-store.ts`（新，Zustand）

---

## Phase 划分

| Phase | 主题 | 预估代码量 | TDD 可测性 | 碰头 |
|------|------|---------|----------|------|
| **P1** | 后端纯模块（DecisionBoard + SettlementDetector + ChainStarterResolver） | ~280 行 impl + ~220 行 test | 100% 纯单测 | 无（内部实现节奏） |
| **P2** | 后端集成（MessageService wiring + 解析扩展 + flush/respond endpoint）| ~160 行 impl + ~180 行 test | 单测 + 集成测试 | 是（P2 merge 后） |
| **P3** | 前端（DecisionBoardModal + store + styling + 移除 inline 旧路径） | ~250 行 impl + ~80 行 test | component test + E2E | 是（P3 merge 后） |

不做 P4 独立阶段：E2E 手工验证挂在 P3 的 merge-gate 里完成。三 Phase 符合 feat-lifecycle "3+ Phase 需要碰头" 触发条件。

---

## Straight-Line Check 三问

对每个 Phase 过一遍：

**P1 纯模块**
- 终态保留？✓ DecisionBoard / SettlementDetector / ChainStarterResolver 都是最终产物，后续 Phase 只调用不重写
- 能 demo 什么？✓ 完整单测套件 + `board.add → board.getPending → board.drain` 的直接调用
- 去掉的代价？没 P1 → P2 无 lib 可集成 → 无法推进

**P2 集成**
- 终态保留？✓ message-service 的 detectAndEmitInlineConfirmations 改造是最终形态，新增的 flushBoard / handleBoardRespond 也是
- 能 demo 什么？✓ 后端 curl 模拟：发 agent 消息含 `[拍板]` → board 有条目 → 手工触发 settle → 收到 `decision.board_flush` WS 事件 → POST respond → 看到汇总消息写入 thread
- 去掉的代价？没 P2 → 前端无事件可订阅 → 无法联调

**P3 前端**
- 终态保留？✓ DecisionBoardModal 是最终组件
- 能 demo 什么？✓ 完整用户流程：agent 讨论 → 静默期 → modal 弹出 → 选择 → 提交 → agent 继续
- 去掉的代价？没 P3 → 用户仍看不到决策 → feature 未完成

**非绕路确认** ✓ 三 Phase 都是线性通向 B，无脚手架。

---

## Phase 1: 后端纯模块

### Task P1.T1 — DecisionBoard 状态机

**Files:**
- Create: `packages/api/src/orchestrator/decision-board.ts`
- Create: `packages/api/src/orchestrator/decision-board.test.ts`

**Step 1: 写失败测试 — 基础 add 和 getPending**

```typescript
// decision-board.test.ts
import test from "node:test"
import assert from "node:assert/strict"
import { DecisionBoard } from "./decision-board"

const baseRaiser = {
  threadId: "t-claude",
  provider: "claude" as const,
  alias: "黄仁勋",
  raisedAt: "2026-04-10T10:00:00Z",
}

test("DecisionBoard.add stores a new entry", () => {
  const board = new DecisionBoard()
  const result = board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库用 PG 还是 SQLite？",
    options: [{ id: "A", label: "PG" }, { id: "B", label: "SQLite" }],
  })
  assert.equal(result.kind, "added")
  assert.equal(result.entry.question, "数据库用 PG 还是 SQLite？")
  assert.equal(result.entry.raisers.length, 1)
  const pending = board.getPending("g1")
  assert.equal(pending.length, 1)
})

test("DecisionBoard.add merges same-hash questions across raisers", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型要用 PostgreSQL 还是 SQLite",
    options: [{ id: "A", label: "PG" }],
  })
  const second = board.add({
    sessionGroupId: "g1",
    raiser: { ...baseRaiser, threadId: "t-codex", provider: "codex", alias: "范德彪" },
    question: "数据库选型要用 PostgreSQL 还是 SQLite",
    options: [{ id: "A", label: "PG" }],
  })
  assert.equal(second.kind, "merged")
  assert.equal(second.entry.raisers.length, 2)
  assert.equal(board.getPending("g1").length, 1)
})

test("DecisionBoard.add dedupes paraphrased question via normalization", () => {
  const board = new DecisionBoard()
  const first = board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库是否要用PG？",
    options: [],
  })
  const second = board.add({
    sessionGroupId: "g1",
    raiser: { ...baseRaiser, threadId: "t2" },
    question: "数据库要用PG吗",
    options: [],
  })
  // Normalization strips 是否/吗/？→ same hash
  assert.equal(second.kind, "merged")
  assert.equal(first.entry.questionHash, second.entry.questionHash)
})

test("DecisionBoard.withdraw removes matching entry for same raiser", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型要不要换 PG",
    options: [],
  })
  const withdrawn = board.withdraw("g1", "t-claude", "数据库")
  assert.notEqual(withdrawn, null)
  assert.equal(board.getPending("g1").length, 0)
})

test("DecisionBoard.withdraw refuses cross-raiser withdrawal", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型",
    options: [],
  })
  const withdrawn = board.withdraw("g1", "t-other-agent", "数据库")
  assert.equal(withdrawn, null)
  assert.equal(board.getPending("g1").length, 1)
})

test("DecisionBoard.withdraw keeps entry when another raiser still owns it", () => {
  const board = new DecisionBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: baseRaiser,
    question: "数据库选型",
    options: [],
  })
  board.add({
    sessionGroupId: "g1",
    raiser: { ...baseRaiser, threadId: "t-codex", provider: "codex", alias: "范德彪" },
    question: "数据库选型",
    options: [],
  })
  board.withdraw("g1", "t-claude", "数据库")
  // Entry remains with just one raiser (范)
  const pending = board.getPending("g1")
  assert.equal(pending.length, 1)
  assert.equal(pending[0].raisers.length, 1)
  assert.equal(pending[0].raisers[0].threadId, "t-codex")
})

test("DecisionBoard.drain returns and clears all entries for a session", () => {
  const board = new DecisionBoard()
  board.add({ sessionGroupId: "g1", raiser: baseRaiser, question: "Q1", options: [] })
  board.add({ sessionGroupId: "g1", raiser: { ...baseRaiser, threadId: "t2" }, question: "Q2", options: [] })
  const drained = board.drain("g1")
  assert.equal(drained.length, 2)
  assert.equal(board.getPending("g1").length, 0)
})

test("DecisionBoard.drain is scoped to one session", () => {
  const board = new DecisionBoard()
  board.add({ sessionGroupId: "g1", raiser: baseRaiser, question: "Q1", options: [] })
  board.add({ sessionGroupId: "g2", raiser: baseRaiser, question: "Q2", options: [] })
  board.drain("g1")
  assert.equal(board.getPending("g2").length, 1)
})
```

**Step 2: 跑测试确认失败**

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/decision-board.test.ts
```
Expected: FAIL — `DecisionBoard is not defined` / `Cannot find module './decision-board'`

**Step 3: 写最小实现**

```typescript
// packages/api/src/orchestrator/decision-board.ts
import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"

export type DecisionOption = { id: string; label: string }

export type DecisionRaiser = {
  threadId: string
  provider: Provider
  alias: string
  raisedAt: string
}

export type DecisionBoardEntry = {
  id: string
  questionHash: string
  question: string
  options: DecisionOption[]
  raisers: DecisionRaiser[]
  sessionGroupId: string
  firstRaisedAt: string
}

export type AddEntryInput = {
  sessionGroupId: string
  raiser: DecisionRaiser
  question: string
  options: DecisionOption[]
}

export type AddEntryResult =
  | { kind: "added"; entry: DecisionBoardEntry }
  | { kind: "merged"; entry: DecisionBoardEntry }

const FILLER_PATTERN = /(是否|还是|要不要|需不需要|吗|呢|嘛|呀|的话|么|一下)/g

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(FILLER_PATTERN, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
}

export function hashQuestion(normalized: string): string {
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12)
}

export class DecisionBoard {
  private readonly bySession = new Map<string, Map<string, DecisionBoardEntry>>()

  add(input: AddEntryInput): AddEntryResult {
    const normalized = normalizeQuestion(input.question)
    const questionHash = hashQuestion(normalized)

    let sessionMap = this.bySession.get(input.sessionGroupId)
    if (!sessionMap) {
      sessionMap = new Map()
      this.bySession.set(input.sessionGroupId, sessionMap)
    }

    const existing = sessionMap.get(questionHash)
    if (existing) {
      // Don't add same raiser twice
      const alreadyRaised = existing.raisers.some(r => r.threadId === input.raiser.threadId)
      if (!alreadyRaised) {
        existing.raisers.push(input.raiser)
      }
      return { kind: "merged", entry: existing }
    }

    const entry: DecisionBoardEntry = {
      id: crypto.randomUUID(),
      questionHash,
      question: input.question,
      options: input.options,
      raisers: [input.raiser],
      sessionGroupId: input.sessionGroupId,
      firstRaisedAt: input.raiser.raisedAt,
    }
    sessionMap.set(questionHash, entry)
    return { kind: "added", entry }
  }

  withdraw(sessionGroupId: string, raiserThreadId: string, substring: string): DecisionBoardEntry | null {
    const sessionMap = this.bySession.get(sessionGroupId)
    if (!sessionMap) return null

    const needle = substring.trim()
    if (!needle) return null

    // Find entries where this raiser is a member and question contains substring.
    // Most recent match wins (by firstRaisedAt desc).
    const candidates = Array.from(sessionMap.values())
      .filter(e => e.raisers.some(r => r.threadId === raiserThreadId))
      .filter(e => e.question.includes(needle))
      .sort((a, b) => b.firstRaisedAt.localeCompare(a.firstRaisedAt))

    const target = candidates[0]
    if (!target) return null

    // Remove this raiser from the entry
    target.raisers = target.raisers.filter(r => r.threadId !== raiserThreadId)

    // If no raisers left → delete the entry entirely
    if (target.raisers.length === 0) {
      sessionMap.delete(target.questionHash)
    }

    return target
  }

  getPending(sessionGroupId: string): DecisionBoardEntry[] {
    const sessionMap = this.bySession.get(sessionGroupId)
    if (!sessionMap) return []
    return Array.from(sessionMap.values()).sort((a, b) =>
      a.firstRaisedAt.localeCompare(b.firstRaisedAt),
    )
  }

  drain(sessionGroupId: string): DecisionBoardEntry[] {
    const entries = this.getPending(sessionGroupId)
    this.bySession.delete(sessionGroupId)
    return entries
  }

  hasPending(sessionGroupId: string): boolean {
    return (this.bySession.get(sessionGroupId)?.size ?? 0) > 0
  }

  size(sessionGroupId: string): number {
    return this.bySession.get(sessionGroupId)?.size ?? 0
  }
}
```

**Step 4: 跑测试确认通过**

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/decision-board.test.ts
```
Expected: PASS — 全部 8 个用例通过

**Step 5: Commit**

```bash
git add packages/api/src/orchestrator/decision-board.ts packages/api/src/orchestrator/decision-board.test.ts
git commit -m "feat(F002): DecisionBoard state machine — add/withdraw/drain with normalized-hash dedupe [黄仁勋/Opus-46 🐾]"
```

---

### Task P1.T2 — SettlementDetector

**Files:**
- Create: `packages/api/src/orchestrator/settlement-detector.ts`
- Create: `packages/api/src/orchestrator/settlement-detector.test.ts`

**Step 1: 写失败测试**

```typescript
// settlement-detector.test.ts
import test from "node:test"
import assert from "node:assert/strict"
import { SettlementDetector, type SettlementSignals } from "./settlement-detector"

function makeFakeSignals(state: {
  hasActiveGroup?: boolean
  hasQueuedDispatches?: boolean
  hasRunningTurn?: boolean
}): SettlementSignals {
  return {
    hasActiveParallelGroup: () => state.hasActiveGroup ?? false,
    hasQueuedDispatches: () => state.hasQueuedDispatches ?? false,
    hasRunningTurn: () => state.hasRunningTurn ?? false,
  }
}

test("SettlementDetector emits settle after debounce when all signals false", async () => {
  const signals = makeFakeSignals({})
  const detector = new SettlementDetector(signals, { debounceMs: 50 })
  const events: string[] = []
  detector.on("settle", (p: { sessionGroupId: string }) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  assert.equal(events.length, 0, "should not fire immediately")
  await new Promise(r => setTimeout(r, 80))
  assert.deepEqual(events, ["g1"])
  detector.dispose()
})

test("SettlementDetector cancels timer when signal changes during debounce", async () => {
  const state = { hasRunningTurn: false }
  const signals: SettlementSignals = {
    hasActiveParallelGroup: () => false,
    hasQueuedDispatches: () => false,
    hasRunningTurn: () => state.hasRunningTurn,
  }
  const detector = new SettlementDetector(signals, { debounceMs: 50 })
  const events: string[] = []
  detector.on("settle", (p) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  // Halfway through debounce, a new turn starts
  await new Promise(r => setTimeout(r, 20))
  state.hasRunningTurn = true
  detector.notifyStateChange("g1")
  await new Promise(r => setTimeout(r, 60))
  assert.equal(events.length, 0, "must not fire because turn became active")
  detector.dispose()
})

test("SettlementDetector does not fire when any signal still true", async () => {
  const signals = makeFakeSignals({ hasRunningTurn: true })
  const detector = new SettlementDetector(signals, { debounceMs: 30 })
  const events: string[] = []
  detector.on("settle", (p) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  await new Promise(r => setTimeout(r, 60))
  assert.equal(events.length, 0)
  detector.dispose()
})

test("SettlementDetector isSettledNow returns correct sync value", () => {
  let active = true
  const signals: SettlementSignals = {
    hasActiveParallelGroup: () => active,
    hasQueuedDispatches: () => false,
    hasRunningTurn: () => false,
  }
  const detector = new SettlementDetector(signals)
  assert.equal(detector.isSettledNow("g1"), false)
  active = false
  assert.equal(detector.isSettledNow("g1"), true)
  detector.dispose()
})

test("SettlementDetector tracks per-session timers independently", async () => {
  const signals = makeFakeSignals({})
  const detector = new SettlementDetector(signals, { debounceMs: 40 })
  const events: string[] = []
  detector.on("settle", (p) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  await new Promise(r => setTimeout(r, 20))
  detector.notifyStateChange("g2")
  await new Promise(r => setTimeout(r, 30))
  // g1 should have fired by now (40ms elapsed), g2 not yet
  assert.deepEqual(events, ["g1"])
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(events, ["g1", "g2"])
  detector.dispose()
})

test("SettlementDetector cancel clears pending timer", async () => {
  const signals = makeFakeSignals({})
  const detector = new SettlementDetector(signals, { debounceMs: 50 })
  const events: string[] = []
  detector.on("settle", (p) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  detector.cancel("g1")
  await new Promise(r => setTimeout(r, 80))
  assert.equal(events.length, 0)
  detector.dispose()
})
```

**Step 2: 跑测试确认失败**

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/settlement-detector.test.ts
```
Expected: FAIL — module missing

**Step 3: 写实现**

```typescript
// packages/api/src/orchestrator/settlement-detector.ts
import { EventEmitter } from "node:events"

export type SettlementSignals = {
  hasActiveParallelGroup: (sessionGroupId: string) => boolean
  hasQueuedDispatches: (sessionGroupId: string) => boolean
  hasRunningTurn: (sessionGroupId: string) => boolean
}

export type SettlementDetectorOptions = {
  debounceMs?: number
}

export class SettlementDetector extends EventEmitter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly debounceMs: number

  constructor(
    private readonly signals: SettlementSignals,
    options: SettlementDetectorOptions = {},
  ) {
    super()
    this.debounceMs = options.debounceMs ?? 2000
  }

  notifyStateChange(sessionGroupId: string): void {
    // Always clear any existing timer first (re-arm pattern)
    this.cancel(sessionGroupId)

    if (!this.isSettledNow(sessionGroupId)) {
      return
    }

    const timer = setTimeout(() => {
      this.timers.delete(sessionGroupId)
      // Re-verify before firing: signals may have changed under us
      if (this.isSettledNow(sessionGroupId)) {
        this.emit("settle", { sessionGroupId })
      }
    }, this.debounceMs)

    this.timers.set(sessionGroupId, timer)
  }

  isSettledNow(sessionGroupId: string): boolean {
    return (
      !this.signals.hasActiveParallelGroup(sessionGroupId) &&
      !this.signals.hasQueuedDispatches(sessionGroupId) &&
      !this.signals.hasRunningTurn(sessionGroupId)
    )
  }

  cancel(sessionGroupId: string): void {
    const timer = this.timers.get(sessionGroupId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionGroupId)
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.removeAllListeners()
  }
}
```

**Step 4: 跑测试确认通过**

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/settlement-detector.test.ts
```
Expected: PASS — 全部 6 个用例通过

**Step 5: Commit**

```bash
git add packages/api/src/orchestrator/settlement-detector.ts packages/api/src/orchestrator/settlement-detector.test.ts
git commit -m "feat(F002): SettlementDetector — 3-AND signals + 2000ms debounce (default) [黄仁勋/Opus-46 🐾]"
```

---

### Task P1.T3 — ChainStarterResolver

**Files:**
- Create: `packages/api/src/orchestrator/chain-starter-resolver.ts`
- Create: `packages/api/src/orchestrator/chain-starter-resolver.test.ts`

**Step 1: 写失败测试**

```typescript
// chain-starter-resolver.test.ts
import test from "node:test"
import assert from "node:assert/strict"
import { ChainStarterResolver } from "./chain-starter-resolver"

function makeFakeRepo(messages: Array<{
  threadId: string
  role: "user" | "assistant"
  createdAt: string
  provider?: string
  alias?: string
}>) {
  const threads = new Map<string, { id: string; provider: string; alias: string; sessionGroupId: string }>()
  for (const m of messages) {
    if (m.role === "assistant" && !threads.has(m.threadId)) {
      threads.set(m.threadId, {
        id: m.threadId,
        provider: m.provider ?? "claude",
        alias: m.alias ?? "unknown",
        sessionGroupId: "g1",
      })
    }
  }

  return {
    listThreadsByGroup: (_sg: string) => Array.from(threads.values()),
    listMessages: (threadId: string) =>
      messages.filter(m => m.threadId === threadId).map(m => ({
        id: `${m.threadId}-${m.createdAt}`,
        role: m.role,
        content: "",
        createdAt: m.createdAt,
        threadId: m.threadId,
      })),
    getThread: (id: string) => threads.get(id) ?? null,
  } as any
}

test("ChainStarterResolver returns first assistant after most recent user msg", () => {
  const repo = makeFakeRepo([
    { threadId: "t-claude", role: "user",      createdAt: "2026-04-10T10:00:00Z" },
    { threadId: "t-claude", role: "assistant", createdAt: "2026-04-10T10:00:05Z", alias: "黄仁勋" },
    { threadId: "t-codex",  role: "assistant", createdAt: "2026-04-10T10:00:15Z", alias: "范德彪" },
    { threadId: "t-claude", role: "assistant", createdAt: "2026-04-10T10:00:25Z", alias: "黄仁勋" },
  ])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({
    sessionGroupId: "g1",
    boardEntries: [{ raisers: [{ threadId: "t-codex", raisedAt: "2026-04-10T10:00:15Z" }] }],
  })
  assert.equal(target?.threadId, "t-claude")
  assert.equal(target?.alias, "黄仁勋")
})

test("ChainStarterResolver picks earliest assistant when multiple threads started simultaneously", () => {
  const repo = makeFakeRepo([
    { threadId: "root-user", role: "user",      createdAt: "2026-04-10T10:00:00Z" },
    { threadId: "t-codex",   role: "assistant", createdAt: "2026-04-10T10:00:10Z", alias: "范德彪" },
    { threadId: "t-gemini",  role: "assistant", createdAt: "2026-04-10T10:00:12Z", alias: "桂芬" },
  ])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({
    sessionGroupId: "g1",
    boardEntries: [{ raisers: [{ threadId: "t-gemini", raisedAt: "2026-04-10T10:00:12Z" }] }],
  })
  assert.equal(target?.threadId, "t-codex") // earlier timestamp wins
})

test("ChainStarterResolver falls back to earliest raiser if no user trigger found", () => {
  const repo = makeFakeRepo([])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({
    sessionGroupId: "g1",
    boardEntries: [
      { raisers: [{ threadId: "t-codex", raisedAt: "2026-04-10T10:00:20Z" }] },
      { raisers: [{ threadId: "t-claude", raisedAt: "2026-04-10T10:00:10Z" }] },
    ],
  })
  // Fallback uses earliest firstRaisedAt across entries
  assert.equal(target?.threadId, "t-claude")
})

test("ChainStarterResolver returns null when board empty and no messages", () => {
  const repo = makeFakeRepo([])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({ sessionGroupId: "g1", boardEntries: [] })
  assert.equal(target, null)
})
```

**Step 2: 跑测试确认失败**

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/chain-starter-resolver.test.ts
```
Expected: FAIL — module missing

**Step 3: 写实现**

```typescript
// packages/api/src/orchestrator/chain-starter-resolver.ts
import type { Provider } from "@multi-agent/shared"

export type ChainStarterTarget = {
  threadId: string
  provider: Provider
  alias: string
}

export type BoardEntryLite = {
  raisers: Array<{ threadId: string; raisedAt: string }>
}

export type ResolveInput = {
  sessionGroupId: string
  boardEntries: BoardEntryLite[]
}

type RepoLike = {
  listThreadsByGroup(sessionGroupId: string): Array<{
    id: string
    provider: string
    alias: string
    sessionGroupId: string
  }>
  listMessages(threadId: string): Array<{
    id: string
    role: string
    createdAt: string
    threadId: string
  }>
  getThread(threadId: string): { id: string; provider: string; alias: string } | null
}

export class ChainStarterResolver {
  constructor(private readonly repository: RepoLike) {}

  resolve(input: ResolveInput): ChainStarterTarget | null {
    // 1. Gather all messages across all threads in the session group
    const threads = this.repository.listThreadsByGroup(input.sessionGroupId)
    type Msg = { threadId: string; role: string; createdAt: string }
    const all: Msg[] = []
    for (const t of threads) {
      for (const m of this.repository.listMessages(t.id)) {
        all.push({ threadId: m.threadId, role: m.role, createdAt: m.createdAt })
      }
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    // 2. Find most recent user message
    const lastUserIdx = (() => {
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role === "user") return i
      }
      return -1
    })()

    // 3. First assistant after it
    if (lastUserIdx >= 0) {
      for (let i = lastUserIdx + 1; i < all.length; i++) {
        if (all[i].role === "assistant") {
          const starterThreadId = all[i].threadId
          const thread = threads.find(t => t.id === starterThreadId)
          if (thread) {
            return {
              threadId: thread.id,
              provider: thread.provider as Provider,
              alias: thread.alias,
            }
          }
        }
      }
    }

    // 4. Fallback: earliest raiser across board entries
    if (input.boardEntries.length === 0) return null

    let earliest: { threadId: string; raisedAt: string } | null = null
    for (const entry of input.boardEntries) {
      for (const r of entry.raisers) {
        if (!earliest || r.raisedAt.localeCompare(earliest.raisedAt) < 0) {
          earliest = r
        }
      }
    }
    if (!earliest) return null

    const thread = threads.find(t => t.id === earliest!.threadId) ??
                   this.repository.getThread(earliest.threadId)
    if (!thread) return null
    return {
      threadId: thread.id,
      provider: thread.provider as Provider,
      alias: thread.alias,
    }
  }
}
```

**Step 4: 跑测试确认通过**

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/chain-starter-resolver.test.ts
```
Expected: PASS — 4 用例通过

**Step 5: Commit**

```bash
git add packages/api/src/orchestrator/chain-starter-resolver.ts packages/api/src/orchestrator/chain-starter-resolver.test.ts
git commit -m "feat(F002): ChainStarterResolver — find A2A chain starter for dispatch target [黄仁勋/Opus-46 🐾]"
```

---

### P1 Phase 收尾

**P1 完整测试 run**：

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/decision-board.test.ts src/orchestrator/settlement-detector.test.ts src/orchestrator/chain-starter-resolver.test.ts
```
Expected: 18 用例全绿

**P1 没有 merge-gate 碰头**（它们还没接进 message-service，没有用户可感知变化）。P1 是纯内部产物。直接进 P2。

---

## Phase 2: 后端集成

### Task P2.T1 — extractDecisionItems 扩展支持 [撤销拍板]

**Files:**
- Modify: `packages/api/src/orchestrator/aggregate-result.ts`（新增 `extractWithdrawals` 函数，不动 `extractDecisionItems`）
- Modify: `packages/api/src/orchestrator/aggregate-result.test.ts`（添加 withdrawal 解析用例）

**Step 1: 写失败测试**

```typescript
// 追加到 aggregate-result.test.ts
test("extractWithdrawals parses single withdrawal marker", () => {
  const content = "我们讨论后发现\n[撤销拍板] 数据库选型\n这个问题已经有答案了"
  const result = extractWithdrawals(content)
  assert.deepEqual(result, ["数据库选型"])
})

test("extractWithdrawals returns multiple withdrawals in order", () => {
  const content = "[撤销拍板] 问题A\n中间文字\n[撤销拍板] 问题B"
  assert.deepEqual(extractWithdrawals(content), ["问题A", "问题B"])
})

test("extractWithdrawals ignores malformed markers", () => {
  const content = "[撤销拍板]\n空白行没有问题文本"
  assert.deepEqual(extractWithdrawals(content), [])
})
```

**Step 2: 跑测试确认失败**

Expected: FAIL — `extractWithdrawals is not defined`

**Step 3: 写实现**

```typescript
// aggregate-result.ts — 追加到文件末尾
export function extractWithdrawals(content: string): string[] {
  const results: string[] = []
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const match = line.trim().match(/^\[撤销拍板\]\s*(.+)$/)
    if (match && match[1].trim()) {
      results.push(match[1].trim())
    }
  }
  return results
}
```

**Step 4: 跑测试确认通过**

```bash
cd packages/api && pnpm exec tsx --test src/orchestrator/aggregate-result.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/orchestrator/aggregate-result.ts packages/api/src/orchestrator/aggregate-result.test.ts
git commit -m "feat(F002): extractWithdrawals parser for [撤销拍板] marker [黄仁勋/Opus-46 🐾]"
```

---

### Task P2.T2 — MessageService 集成 DecisionBoard（替换 detectAndEmitInlineConfirmations）

**Files:**
- Modify: `packages/api/src/services/message-service.ts`
  - Constructor: 新增 `decisionBoard`, `settlementDetector`, `chainStarterResolver` 依赖注入
  - `detectAndEmitInlineConfirmations` → 改名为 `collectDecisionsIntoBoard`，替换逻辑
  - 在 turn 完成路径上调用 `settlementDetector.notifyStateChange()`
- Modify: `packages/api/src/server.ts` — 构造期装配三个新模块
- Modify: `packages/api/src/services/message-service.test.ts` — 更新现有 inline confirmation 测试

**Step 1: 写失败集成测试**

```typescript
// message-service.test.ts — 新增测试
test("agent output with [拍板] goes into DecisionBoard instead of emitting decision.request", async () => {
  const { service, emit, board } = setupServiceForBoard()
  // ... setup a running thread with provider claude ...

  await service.handleAgentReply({
    threadId: "t-claude",
    sessionGroupId: "g1",
    content: "这是我的回答\n[拍板] 数据库要用 PG 吗\n[A] 是\n[B] 否",
    // ... other fields ...
  })

  // No decision.request event emitted to frontend
  const requestEvents = emit.captured.filter(e => e.type === "decision.request")
  assert.equal(requestEvents.length, 0, "inline [拍板] must not emit decision.request directly")

  // Board contains the entry
  assert.equal(board.size("g1"), 1)
})

test("agent output with [撤销拍板] removes board entry", async () => {
  const { service, board } = setupServiceForBoard()
  board.add({
    sessionGroupId: "g1",
    raiser: { threadId: "t-claude", provider: "claude", alias: "黄仁勋", raisedAt: "2026-04-10T10:00:00Z" },
    question: "数据库选型",
    options: [],
  })

  await service.handleAgentReply({
    threadId: "t-claude",
    sessionGroupId: "g1",
    content: "讨论后觉得不用问了\n[撤销拍板] 数据库选型",
    // ...
  })

  assert.equal(board.size("g1"), 0)
})

test("MCP request_decision path is unaffected (regression)", async () => {
  // Use DecisionManager.request() directly, verify it still
  // emits decision.request and returns a Promise
  // ... (mirror existing test, verify it doesn't break) ...
})
```

**Step 2: 跑测试确认失败**

Expected: FAIL — integration points not yet wired

**Step 3: 写最小实现（MessageService 改造）**

```typescript
// message-service.ts — 关键改动

// 1. Constructor 新增参数
constructor(
  // ... existing params ...
  private readonly decisionBoard: DecisionBoard,
  private readonly settlementDetector: SettlementDetector,
  private readonly chainStarterResolver: ChainStarterResolver,
) { ... }

// 2. 替换 detectAndEmitInlineConfirmations
private collectDecisionsIntoBoard(
  thread: { id: string; provider: Provider; alias: string; sessionGroupId: string },
  messageId: string,
  content: string,
): void {
  // Additions
  const items = extractDecisionItems(content)
  for (const item of items) {
    const options: DecisionOption[] = item.options.map((opt, i) => ({
      id: `opt_${i}`,
      label: opt,
    }))
    this.decisionBoard.add({
      sessionGroupId: thread.sessionGroupId,
      raiser: {
        threadId: thread.id,
        provider: thread.provider,
        alias: thread.alias,
        raisedAt: new Date().toISOString(),
      },
      question: item.question,
      options,
    })
  }

  // Withdrawals
  const withdrawals = extractWithdrawals(content)
  for (const substring of withdrawals) {
    this.decisionBoard.withdraw(thread.sessionGroupId, thread.id, substring)
  }
}

// 3. Call sites: replace the old detectAndEmit call, add settlement notify
// Find: this.detectAndEmitInlineConfirmations(thread, messageId, content, emit)
// Replace with:
this.collectDecisionsIntoBoard(thread, messageId, content)
this.settlementDetector.notifyStateChange(thread.sessionGroupId)

// Also call notifyStateChange at turn-complete / queue-flush sites (exact locations
// identified at P2.T2 Step 2 time by grepping existing flushDispatchQueue / releaseSlot)

// 4. Add helper the detector uses
hasRunningTurn(sessionGroupId: string): boolean {
  return this.dispatch.getAgentStatuses(sessionGroupId).some(a => a.running) ||
         this.flushingGroups.has(sessionGroupId)
}
```

```typescript
// server.ts — 构造期装配

import { DecisionBoard } from "./orchestrator/decision-board"
import { SettlementDetector } from "./orchestrator/settlement-detector"
import { ChainStarterResolver } from "./orchestrator/chain-starter-resolver"

// After dispatch + parallelGroups created:
const decisionBoard = new DecisionBoard()
const chainStarterResolver = new ChainStarterResolver(repository)
const settlementDetector = new SettlementDetector({
  hasActiveParallelGroup: (sg) => parallelGroups.hasAnyActiveInSession(sg),
  hasQueuedDispatches: (sg) => dispatch.hasQueuedDispatches(sg),
  hasRunningTurn: (sg) => messageService.hasRunningTurn(sg),
})

// Pass to MessageService constructor
const messageService = new MessageService(
  // ... existing ...
  decisionBoard,
  settlementDetector,
  chainStarterResolver,
)

// Wire settle → flush handler (added in P2.T4)
settlementDetector.on("settle", ({ sessionGroupId }) => {
  messageService.flushDecisionBoard(sessionGroupId)
})
```

**Also need:** add `ParallelGroupRegistry.hasAnyActiveInSession(sessionGroupId: string)` helper. Scan groups, return true if any has `status === "running" || "pending" || "partial"`.

**Step 4: 跑测试确认通过**

```bash
cd packages/api && pnpm exec tsx --test src/services/message-service.test.ts
```
Expected: PASS + 现有 inline confirmation 相关测试需要更新（原先期待 `decision.request` 的 assertion 改为期待 board 有条目）

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/services/message-service.test.ts packages/api/src/server.ts packages/api/src/orchestrator/parallel-group.ts
git commit -m "feat(F002): wire DecisionBoard into MessageService, remove direct inline emit [黄仁勋/Opus-46 🐾]"
```

---

### Task P2.T3 — flushDecisionBoard + WebSocket 事件

**Files:**
- Modify: `packages/api/src/services/message-service.ts` — 新增 `flushDecisionBoard` 方法
- Modify: `packages/shared/src/types.ts` — 新增 `decision.board_flush` 事件类型
- Modify: `packages/api/src/services/message-service.test.ts` — 添加 flush 集成测试

**Step 1: 写失败测试**

```typescript
test("flushDecisionBoard emits single board_flush event with all pending entries", () => {
  const { service, board, emit } = setupServiceForBoard()
  board.add({ sessionGroupId: "g1", raiser: /*...*/, question: "Q1", options: [] })
  board.add({ sessionGroupId: "g1", raiser: /*...*/, question: "Q2", options: [] })

  service.flushDecisionBoard("g1")

  const flushEvents = emit.captured.filter(e => e.type === "decision.board_flush")
  assert.equal(flushEvents.length, 1)
  assert.equal(flushEvents[0].payload.items.length, 2)
  assert.equal(board.size("g1"), 0, "board drained after flush")
})

test("flushDecisionBoard is no-op when board empty", () => {
  const { service, emit } = setupServiceForBoard()
  service.flushDecisionBoard("g1")
  assert.equal(emit.captured.filter(e => e.type === "decision.board_flush").length, 0)
})
```

**Step 2: 跑测试确认失败** — `flushDecisionBoard` not defined

**Step 3: 写实现**

```typescript
// message-service.ts
flushDecisionBoard(sessionGroupId: string): void {
  const entries = this.decisionBoard.drain(sessionGroupId)
  if (entries.length === 0) return

  const items: DecisionBoardItem[] = entries.map(e => ({
    id: e.id,
    question: e.question,
    options: e.options,
    raisers: e.raisers.map(r => ({
      alias: r.alias,
      provider: r.provider,
    })),
    firstRaisedAt: e.firstRaisedAt,
  }))

  // Stash for respond handler to look up later
  this.pendingBoardFlushes.set(sessionGroupId, entries)

  this.emit({
    type: "decision.board_flush",
    payload: {
      sessionGroupId,
      items,
      flushedAt: new Date().toISOString(),
    },
  })
}

// Class field
private readonly pendingBoardFlushes = new Map<string, DecisionBoardEntry[]>()
```

Add type to `packages/shared/src/types.ts`:

```typescript
// Append to existing RealtimeServerEvent union
export type DecisionBoardItem = { /* ... as in terminal schema ... */ }
export type DecisionBoardFlushEvent = {
  type: "decision.board_flush"
  payload: {
    sessionGroupId: string
    items: DecisionBoardItem[]
    flushedAt: string
  }
}

export type RealtimeServerEvent =
  | /* ... existing events ... */
  | DecisionBoardFlushEvent
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/services/message-service.test.ts packages/shared/src/types.ts
git commit -m "feat(F002): flushDecisionBoard emits decision.board_flush single event [黄仁勋/Opus-46 🐾]"
```

---

### Task P2.T4 — handleBoardRespond: 写 thread + 单点 dispatch

**Files:**
- Modify: `packages/api/src/services/message-service.ts` — 新增 `handleDecisionBoardRespond`
- Create: `packages/api/src/routes/decision-board.ts` — 新路由 `POST /decision-board/respond`
- Modify: `packages/api/src/server.ts` — 注册路由
- Modify: `packages/api/src/services/message-service.test.ts` — 添加 respond 集成测试

**Step 1: 写失败测试**

```typescript
test("handleDecisionBoardRespond writes summary to chain-starter thread and triggers single dispatch", async () => {
  const { service, board, repository, runTurnSpy } = setupServiceForBoard()

  // Setup: simulate two prior turns so ChainStarterResolver finds a target
  repository.appendMessage("t-user-root", "user", "开始讨论")
  repository.appendMessage("t-claude", "assistant", "我觉得...")
  repository.appendMessage("t-codex", "assistant", "我同意...")

  // Board has two entries from different raisers
  board.add({ sessionGroupId: "g1", raiser: { threadId: "t-claude", /*...*/ }, question: "Q1", options: [{ id: "A", label: "PG" }] })
  board.add({ sessionGroupId: "g1", raiser: { threadId: "t-codex", /*...*/ }, question: "Q2", options: [{ id: "A", label: "是" }] })
  service.flushDecisionBoard("g1")

  await service.handleDecisionBoardRespond({
    sessionGroupId: "g1",
    decisions: [
      { itemId: /* q1 id */, choice: { kind: "option", optionId: "A" } },
      { itemId: /* q2 id */, choice: { kind: "custom", text: "走 B 方案" } },
    ],
  })

  // 1. Summary written to t-claude (chain starter, earliest assistant)
  const claudeMsgs = repository.listMessages("t-claude")
  const summary = claudeMsgs[claudeMsgs.length - 1]
  assert.equal(summary.role, "user")
  assert.ok(summary.content.includes("Q1"))
  assert.ok(summary.content.includes("PG"))
  assert.ok(summary.content.includes("Q2"))
  assert.ok(summary.content.includes("走 B 方案"))

  // 2. Only ONE runThreadTurn called, targeting t-claude
  assert.equal(runTurnSpy.callCount, 1)
  assert.equal(runTurnSpy.calls[0].threadId, "t-claude")

  // 3. decision.resolved broadcast for each item
  // (or one board-level resolved event — TBD at impl time)
})

test("handleDecisionBoardRespond with skipped=true writes '产品暂不回答' and still dispatches", async () => {
  // ... setup ...
  await service.handleDecisionBoardRespond({
    sessionGroupId: "g1",
    decisions: [],
    skipped: true,
  })

  const summary = /* last message on chain starter thread */
  assert.ok(summary.content.includes("产品暂未就以下问题作出决定"))
  assert.equal(runTurnSpy.callCount, 1)
})
```

**Step 2: 跑测试确认失败**

**Step 3: 写实现**

```typescript
// message-service.ts
async handleDecisionBoardRespond(payload: DecisionBoardRespondPayload): Promise<void> {
  const entries = this.pendingBoardFlushes.get(payload.sessionGroupId)
  if (!entries) return

  this.pendingBoardFlushes.delete(payload.sessionGroupId)

  // 1. Resolve chain starter
  const target = this.chainStarterResolver.resolve({
    sessionGroupId: payload.sessionGroupId,
    boardEntries: entries,
  })
  if (!target) {
    // Log warning, no-op
    return
  }

  // 2. Build summary message
  const summary = payload.skipped
    ? this.buildSkippedSummary(entries)
    : this.buildDecisionSummary(entries, payload.decisions)

  // 3. Write as user role to chain-starter thread
  const savedMsg = this.repository.appendMessage(target.threadId, "user", summary)

  // 4. Broadcast resolved events
  for (const entry of entries) {
    this.emit({
      type: "decision.board_item_resolved",
      payload: { sessionGroupId: payload.sessionGroupId, itemId: entry.id },
    })
  }

  // 5. Single dispatch: trigger runThreadTurn on chain starter
  await this.runThreadTurn({
    threadId: target.threadId,
    triggerMessageId: savedMsg.id,
    // ... whatever runThreadTurn needs ...
  })
}

private buildDecisionSummary(
  entries: DecisionBoardEntry[],
  decisions: DecisionBoardRespondPayload["decisions"],
): string {
  const lines = ["产品已就以下问题作出决定："]
  for (const entry of entries) {
    const d = decisions.find(x => x.itemId === entry.id)
    if (!d) {
      lines.push(`- ${entry.question} → (未决定)`)
      continue
    }
    if (d.choice.kind === "option") {
      const opt = entry.options.find(o => o.id === d.choice.optionId)
      lines.push(`- ${entry.question} → ${opt?.label ?? d.choice.optionId}`)
    } else {
      lines.push(`- ${entry.question} → 自定义答复："${d.choice.text}"`)
    }
    if (entry.raisers.length > 1) {
      lines.push(`  (由 ${entry.raisers.map(r => r.alias).join("、")} 共同提出)`)
    }
  }
  return lines.join("\n")
}

private buildSkippedSummary(entries: DecisionBoardEntry[]): string {
  const lines = ["产品暂未就以下问题作出决定："]
  for (const entry of entries) {
    const who = entry.raisers.map(r => r.alias).join("、")
    lines.push(`- [${entry.question}] ${who} 提出`)
  }
  lines.push("\n你可以基于当前讨论继续推进，必要时再次 [拍板] 提问。")
  return lines.join("\n")
}
```

```typescript
// packages/api/src/routes/decision-board.ts
import type { FastifyInstance } from "fastify"
import type { MessageService } from "../services/message-service"

export function registerDecisionBoardRoutes(
  app: FastifyInstance,
  deps: { messageService: MessageService },
): void {
  app.post<{ Body: DecisionBoardRespondPayload }>(
    "/decision-board/respond",
    async (request, reply) => {
      await deps.messageService.handleDecisionBoardRespond(request.body)
      return { ok: true }
    },
  )
}
```

```typescript
// server.ts — register route
import { registerDecisionBoardRoutes } from "./routes/decision-board"
registerDecisionBoardRoutes(app, { messageService })
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/services/message-service.test.ts packages/api/src/routes/decision-board.ts packages/api/src/server.ts
git commit -m "feat(F002): handleDecisionBoardRespond — single dispatch to chain starter [黄仁勋/Opus-46 🐾]"
```

---

### Task P2.T5 — MCP 路径回归测试

**Files:**
- Modify: `packages/api/src/orchestrator/decision-manager.test.ts` — 确保 `DecisionManager.request()` 的 blocking Promise 行为不变

**Step 1: 写回归测试**

```typescript
test("DecisionManager.request still emits decision.request event (MCP path unchanged, AC7)", async () => {
  const emitted: any[] = []
  const dm = new DecisionManager((e) => emitted.push(e))

  const promise = dm.request({
    kind: "inline_confirmation",
    title: "test",
    options: [{ id: "A", label: "yes" }],
    sessionGroupId: "g1",
  })

  const reqEvent = emitted.find(e => e.type === "decision.request")
  assert.ok(reqEvent, "MCP path must still emit decision.request")

  dm.respond(reqEvent.payload.requestId, [{ optionId: "A", verdict: "approved" }])
  const result = await promise
  assert.equal(result.decisions[0].optionId, "A")
})
```

**Step 2: Run test** — Should PASS without any code changes (regression assurance)

**Step 3-5:** no new code, commit regression test only

```bash
git add packages/api/src/orchestrator/decision-manager.test.ts
git commit -m "test(F002): regression — MCP request_decision path unchanged after Board integration [黄仁勋/Opus-46 🐾]"
```

---

### P2 碰头（与小孙）🔴

**P2 完整测试 run**：

```bash
cd packages/api && pnpm exec tsx --test src/
```
Expected: 全部现有 + 新增测试绿

**端到端 curl 演示**（小孙手动验证）：

1. 启动 dev server
2. 触发一个 agent 讨论，让 agent 输出 `[拍板] 测试问题\n[A] 选 A\n[B] 选 B`
3. 确认 `data/multi-agent.sqlite` 中该 thread 无 `你提出的决策已确认` 消息（因为未 settle）
4. 确认 WebSocket 客户端没收到 `decision.request` 事件
5. 等 2 秒（debounce）
6. 确认 WebSocket 客户端收到一次 `decision.board_flush` 事件
7. POST /decision-board/respond 模拟用户选 A
8. 确认 DB 中出现 `产品已就以下问题作出决定：- 测试问题 → 选 A` 消息
9. 确认 agent 被再次触发（新 turn 启动）

**P2 碰头与小孙**：展示上述 curl 流程 → 确认后端行为符合预期 → 给 P3 前端开工绿灯。

**P2 merge commit**：`feat(F002): Phase 2 — 后端 DecisionBoard 完整集成 [黄仁勋/Opus-46 🐾]`（汇总 P2 所有 task commit）

---

## Phase 3: 前端 DecisionBoardModal

### Task P3.T1 — decision-board-store（Zustand）

**Files:**
- Create: `apps/web/src/stores/decision-board-store.ts`
- Create: `apps/web/src/stores/decision-board-store.test.ts`

**Step 1: 写失败测试**

```typescript
import test from "node:test"
import assert from "node:assert/strict"
import { useDecisionBoardStore } from "./decision-board-store"

test("decision-board-store receives board_flush event and stores items", () => {
  const store = useDecisionBoardStore.getState()
  store.receiveFlush({
    sessionGroupId: "g1",
    items: [{ id: "i1", question: "Q1", options: [{ id: "A", label: "yes" }], raisers: [], firstRaisedAt: "..." }],
    flushedAt: "...",
  })
  assert.equal(useDecisionBoardStore.getState().items.length, 1)
  assert.equal(useDecisionBoardStore.getState().isOpen, true)
})

test("decision-board-store setChoice updates selected option for an item", () => {
  /* ... */
})

test("decision-board-store setCustomText updates free-text for an item", () => {
  /* ... */
})

test("decision-board-store close clears items and sets isOpen false", () => {
  /* ... */
})
```

**Step 2-5**: implement + test + commit

```typescript
// decision-board-store.ts
import { create } from "zustand"
import type { DecisionBoardItem } from "@multi-agent/shared"

type Choice =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string }
  | null

type State = {
  isOpen: boolean
  sessionGroupId: string | null
  items: DecisionBoardItem[]
  choices: Record<string, Choice>
  receiveFlush: (payload: { sessionGroupId: string; items: DecisionBoardItem[]; flushedAt: string }) => void
  setOptionChoice: (itemId: string, optionId: string) => void
  setCustomChoice: (itemId: string, text: string) => void
  close: () => void
  reset: () => void
}

export const useDecisionBoardStore = create<State>((set) => ({
  isOpen: false,
  sessionGroupId: null,
  items: [],
  choices: {},
  receiveFlush: ({ sessionGroupId, items }) => set({ isOpen: true, sessionGroupId, items, choices: {} }),
  setOptionChoice: (itemId, optionId) =>
    set((s) => ({ choices: { ...s.choices, [itemId]: { kind: "option", optionId } } })),
  setCustomChoice: (itemId, text) =>
    set((s) => ({ choices: { ...s.choices, [itemId]: { kind: "custom", text } } })),
  close: () => set({ isOpen: false, sessionGroupId: null, items: [], choices: {} }),
  reset: () => set({ isOpen: false, sessionGroupId: null, items: [], choices: {} }),
}))
```

Commit: `feat(F002): decision-board-store — Zustand state for modal [黄仁勋/Opus-46 🐾]`

---

### Task P3.T2 — DecisionBoardModal 组件（庄严视觉）

**Files:**
- Create: `apps/web/src/components/decision-board/DecisionBoardModal.tsx`
- Create: `apps/web/src/components/decision-board/DecisionBoardModal.module.css`
- Create: `apps/web/src/components/decision-board/DecisionBoardModal.test.tsx`

**Step 1: 写组件测试（Testing Library）**

```tsx
import { render, screen, fireEvent } from "@testing-library/react"
import { DecisionBoardModal } from "./DecisionBoardModal"
import { useDecisionBoardStore } from "../../stores/decision-board-store"

test("DecisionBoardModal shows all items with raiser info", () => {
  useDecisionBoardStore.setState({
    isOpen: true,
    sessionGroupId: "g1",
    items: [
      {
        id: "i1",
        question: "数据库选型",
        options: [{ id: "A", label: "PG" }, { id: "B", label: "SQLite" }],
        raisers: [{ alias: "范德彪", provider: "codex" }, { alias: "桂芬", provider: "gemini" }],
        firstRaisedAt: "2026-04-10T10:00:00Z",
      },
    ],
    choices: {},
  })
  render(<DecisionBoardModal />)
  expect(screen.getByText("数据库选型")).toBeInTheDocument()
  expect(screen.getByText("PG")).toBeInTheDocument()
  expect(screen.getByText("范德彪")).toBeInTheDocument()
  expect(screen.getByText("桂芬")).toBeInTheDocument()
})

test("DecisionBoardModal selects option on click", () => { /* ... */ })

test("DecisionBoardModal expands custom input when '其他' selected", () => { /* ... */ })

test("DecisionBoardModal submit POSTs to /decision-board/respond", async () => { /* ... */ })

test("DecisionBoardModal ✕ button triggers skipped response", async () => { /* ... */ })
```

**Step 2-5**: 实现组件 + 样式

```tsx
// DecisionBoardModal.tsx
"use client"
import { useState } from "react"
import { useDecisionBoardStore } from "../../stores/decision-board-store"
import styles from "./DecisionBoardModal.module.css"

export function DecisionBoardModal() {
  const { isOpen, sessionGroupId, items, choices, setOptionChoice, setCustomChoice, close } =
    useDecisionBoardStore()

  if (!isOpen) return null

  async function submit(skipped = false) {
    const decisions = skipped
      ? []
      : items.map((item) => ({
          itemId: item.id,
          choice: choices[item.id] ?? { kind: "option", optionId: item.options[0]?.id },
        }))

    await fetch("/api/decision-board/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionGroupId, decisions, skipped }),
    })
    close()
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>◆ 产品决策时刻</h2>
          <button className={styles.closeBtn} onClick={() => submit(true)} aria-label="暂不回答">
            ✕
          </button>
        </header>
        <p className={styles.subtitle}>
          团队讨论已收敛，以下 {items.length} 个问题需要你拍板
        </p>
        <div className={styles.cards}>
          {items.map((item, idx) => (
            <DecisionCard key={item.id} index={idx + 1} item={item} />
          ))}
        </div>
        <footer className={styles.footer}>
          <button className={styles.skipBtn} onClick={() => submit(true)}>
            暂不回答
          </button>
          <button className={styles.submitBtn} onClick={() => submit(false)}>
            提交决策 →
          </button>
        </footer>
      </div>
    </div>
  )
}

function DecisionCard({ index, item }: { index: number; item: /* ... */ }) {
  const { choices, setOptionChoice, setCustomChoice } = useDecisionBoardStore()
  const [mode, setMode] = useState<"option" | "custom">("option")
  const choice = choices[item.id]

  return (
    <div className={styles.card}>
      <div className={styles.cardNumber}>{String(index).padStart(2, "0")}</div>
      <h3 className={styles.question}>{item.question}</h3>
      <div className={styles.raisers}>
        <span className={styles.raisersLabel}>提出者</span>
        {item.raisers.map((r) => (
          <span key={r.alias} className={styles.raiser}>
            <Avatar provider={r.provider} /> {r.alias}
          </span>
        ))}
      </div>
      <div className={styles.options}>
        {item.options.map((opt) => (
          <label key={opt.id} className={styles.option}>
            <input
              type="radio"
              checked={choice?.kind === "option" && choice.optionId === opt.id}
              onChange={() => {
                setMode("option")
                setOptionChoice(item.id, opt.id)
              }}
            />
            {opt.label}
          </label>
        ))}
        <label className={styles.option}>
          <input
            type="radio"
            checked={mode === "custom"}
            onChange={() => setMode("custom")}
          />
          其他（你来写）
        </label>
        {mode === "custom" && (
          <textarea
            className={styles.customInput}
            placeholder="输入你的决定..."
            onChange={(e) => setCustomChoice(item.id, e.target.value)}
          />
        )}
      </div>
    </div>
  )
}
```

```css
/* DecisionBoardModal.module.css — 庄严深墨蓝 */
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 150ms ease-out;
}

.panel {
  background: #0E1A2E;
  color: #F5F5F0;
  border: 1px solid #C9A876;
  box-shadow: 0 0 24px rgba(201, 168, 118, 0.25), 0 20px 60px rgba(0, 0, 0, 0.5);
  border-radius: 8px;
  padding: 32px 40px;
  max-width: 720px;
  width: 90%;
  max-height: 85vh;
  overflow-y: auto;
  animation: slideUp 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.title {
  font-family: "Source Han Serif SC", "Noto Serif SC", serif;
  color: #C9A876;
  font-size: 24px;
  margin: 0;
}

.subtitle {
  color: #A8A89C;
  font-size: 14px;
  margin: 8px 0 24px;
}

.cardNumber {
  font-family: "Source Han Serif SC", serif;
  font-size: 32px;
  color: #C9A876;
  margin-bottom: 8px;
}

.card {
  border: 1px solid rgba(201, 168, 118, 0.3);
  border-radius: 6px;
  padding: 24px;
  margin-bottom: 16px;
  background: rgba(255, 255, 255, 0.02);
}

.question {
  font-size: 18px;
  color: #F5F5F0;
  margin: 8px 0 16px;
}

.raisers {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 13px;
  color: #A8A89C;
}

.option {
  display: block;
  padding: 10px 14px;
  margin: 6px 0;
  color: #C8C8C0;
  cursor: pointer;
  border-radius: 4px;
  transition: background 120ms;
}
.option:hover { background: rgba(201, 168, 118, 0.08); color: #FFFFFF; }

.customInput {
  width: 100%;
  margin-top: 8px;
  padding: 10px;
  background: #1A2B42;
  color: #F5F5F0;
  border: 1px solid rgba(201, 168, 118, 0.4);
  border-radius: 4px;
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}

.submitBtn {
  background: #C9A876;
  color: #0E1A2E;
  padding: 12px 28px;
  border: none;
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
}
.submitBtn:hover { background: #D6B888; }

.skipBtn {
  background: transparent;
  color: #A8A89C;
  border: 1px solid rgba(168, 168, 156, 0.4);
  padding: 12px 20px;
  border-radius: 4px;
  cursor: pointer;
  margin-right: 12px;
}

.footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid rgba(201, 168, 118, 0.2);
}

@keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes slideUp {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
```

Commit: `feat(F002): DecisionBoardModal component with solemn deep-navy styling [黄仁勋/Opus-46 🐾]`

---

### Task P3.T3 — WebSocket 事件订阅接线 + 移除旧 inline 渲染

**Files:**
- Modify: `apps/web/src/hooks/useRealtimeEvents.ts`（或现有 WS hook）— 订阅 `decision.board_flush`
- Modify: `apps/web/src/components/layout/AppShell.tsx`（或等效 root 组件）— mount `<DecisionBoardModal />`
- Modify: `apps/web/src/components/messages/InlineConfirmation.tsx`（如有）— 仅在 `kind === "mcp_blocking"` 时渲染，不再渲染 `"inline_confirmation"`

**Step 1-5**: TDD + commit

```typescript
// useRealtimeEvents.ts — 追加处理
ws.on("decision.board_flush", (payload) => {
  useDecisionBoardStore.getState().receiveFlush(payload)
})
```

Commit: `feat(F002): wire decision.board_flush → modal store, remove legacy inline confirmation rendering [黄仁勋/Opus-46 🐾]`

---

### Task P3.T4 — E2E 手工验证

**不写自动化测试，走手动 checklist**：

- [ ] 单问题场景：1 个 agent 抛 1 个 `[拍板]` → 2 秒后 modal 弹出 → 选项 / 自由输入都能提交 → 对应 thread 出现汇总消息 → agent 被重新触发
- [ ] 双 agent 同问题 dedupe：范桂同时抛相似问题 → modal 只显示 1 张卡，raiser 列表显示两人 → 用户答一次 → 只 dispatch 一次到 chain starter
- [ ] 双 agent 不同问题：范抛 A，桂抛 B → modal 显示 2 张卡 → 全部回答 → 只 dispatch 一次到 chain starter
- [ ] 撤销场景：agent 先抛 `[拍板] X` 然后下一轮输出 `[撤销拍板] X` → 2 秒 settle → modal 空 → 不弹面板
- [ ] 暂不回答：modal 出现后点 ✕ → thread 出现"产品暂未决定"消息 → agent 仍被触发
- [ ] Debounce 验证：手动构造紧密连续的 agent 活动 → 确认不会误弹 modal
- [ ] MCP 路径回归：触发一次 MCP `request_decision` → 确认现有 inline 卡片仍能弹出和响应（不受 Board 影响）
- [ ] F001 视觉无回退：截图对比 message 渲染跟 decision panel 视觉清晰区分，无样式冲突

### P3 碰头（与小孙）🔴

- 成果展示：录屏演示完整决策流程
- 愿景进度：AC1-AC15 对照表（每条实际验证方式）
- 下个 Phase：无（F002 至此完成）
- 方向确认："产品决策时刻的感觉对吗？庄严感够不够？"

P3 merge commit: `feat(F002): Phase 3 — DecisionBoardModal 前端接入 + 手动 E2E 全绿 [黄仁勋/Opus-46 🐾]`

---

## 回归风险点

| 风险 | 验证方式 |
|------|--------|
| MCP `request_decision` 回归 | P2.T5 回归测试 + P3.T4 手动测试 |
| F001 视觉冲突 | P3.T4 手动截图对比 |
| B001 WebSocket 容错 | Board flush 事件能被自愈重连追到（B001 的 emit 容错已保证） |
| B002 classifier 不受影响 | Board 不接触 runtime 错误路径，机械隔离 |
| 现有 `detectAndEmitInlineConfirmations` 单测需要更新 | P2.T2 显式改写现有测试 |
| `extractDecisionItems` 行为保留（不能破坏旧 parser） | P2.T1 仅**新增** `extractWithdrawals`，不动 `extractDecisionItems` |
| 新增的 `settlementDetector.notifyStateChange` 漏调 call site | P2.T2 Step 2 grep 所有 turn-complete / queue-pop / slot-release 位置，确保全覆盖 |

---

## 测试策略汇总

| 层级 | 范围 | 工具 |
|------|------|------|
| 单测 | DecisionBoard, SettlementDetector, ChainStarterResolver, extractWithdrawals | node:test |
| 集成 | MessageService 与 Board/Detector 的交互、flush、respond、dispatch | node:test + fake repository |
| 组件 | DecisionBoardModal 渲染、交互、提交 | React Testing Library |
| E2E | 端到端用户流程 | 手动 checklist（P3.T4） |
| 回归 | MCP 路径、F001 视觉、B001/B002 通路 | 已有测试 + P2.T5 显式回归 |

**不做的事（YAGNI）**：
- 不做 embedding 语义 dedupe（契约 1 结论）
- 不做 hold 超时（小孙明确拒绝）
- 不整合 MCP 路径（死锁风险）
- 不加 Board 持久化（内存即可，session 级生命周期足够）
- 不加 Board 多实例 / 分布式协调（单进程 API 够用）

---

## 最终验收命令

P3 完成后，在 repo 根跑：

```bash
# 后端全测试
cd packages/api && pnpm exec tsx --test src/

# 前端组件测试
cd apps/web && pnpm test

# 类型检查
pnpm -r typecheck

# 手动 E2E checklist（P3.T4）
# (需要小孙参与)
```

全部绿 → 进 `quality-gate` → `vision-guardian` → `requesting-review` → `merge-gate`。
