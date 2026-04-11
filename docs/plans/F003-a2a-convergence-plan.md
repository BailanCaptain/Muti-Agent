# F003 A2A 运行时闭环 Implementation Plan

**Feature:** F003 — `docs/features/F003-a2a-convergence.md`
**Goal:** 让 A2A 流程在前端视角 100% 运行时闭环 — 截断隐形、SOP 自动推进、回程必达。
**Acceptance Criteria:**
- **AC1** Stop Reason 感知：三 runtime 对称解析 `stop_reason` / `finish_reason`，输出 `"complete" | "truncated" | "refused" | "tool_wait" | "aborted"`，`AgentRunOutput` 新增 `stopReason` 字段。
- **AC2** 透明续写管线：`runThreadTurn` 读到 `truncated`/`aborted` 自动续写，append 到同一条 assistant message；无硬上限但有连续 2 次 <50 字重复检测；续写期间 settlement in-flight；seal 触发中止续写。
- **AC3** A2A Invocation Chain + 回程派发：新增 `orchestrator/a2a-chain.ts`；子 invocation 完成后若不含出站 mention 且 parent 可回程 → 自动合成一跳回程派发；前端 connector header 标 "A2A 回程"。
- **AC4** SOP-driven Dispatch：manifest 新增 `next_dispatch: { target, prompt }`；`SopTracker.advance` 返回 `nextStageDispatch`；`advanceSopIfNeeded` 强制派发，LLM 已写 @ 时走 `invocationTriggered` 去重。
- **AC5** 愿景对照：三症状前端可见消失；小孙全链路零手动干预跑一个 feat-lifecycle。

**Architecture:**
- Phase 1 独立落地 stop_reason 解析（runtime 层，单测覆盖，无 runtime 语义变化）。
- Phase 2 在 Phase 1 之上引入续写循环，复用同一 assistant message 和 usage/seal 流。
- Phase 3 新增 `A2AChainRegistry` 跟踪 parent→child invocation 栈，`runThreadTurn` 尾部在"child reply 无出站 mention 且 parent 可回程"时合成一跳 synthetic dispatch。
- Phase 4 扩展 skill manifest YAML + `SkillRegistry.getNextDispatch()` + `SopTracker.advance()` 返回值，`advanceSopIfNeeded` 改为直接 `enqueuePublicMentions` / 内部派发（复用 Phase 3 的 invocationTriggered 去重）。

**Tech Stack:**
- TypeScript + node:test / assert (`pnpm --filter @multi-agent/api test`)
- Biome (`pnpm check`) + tsc (`pnpm lint`)
- 已有模块：`BaseCliRuntime` / `runTurn` / `DispatchOrchestrator` / `SopTracker` / `SkillRegistry`

**PR 策略：4 个独立 PR，按 Phase 顺序合入**（design decisions 表已确认）。每个 Phase 对应一次 worktree → tdd → quality-gate → request-review → merge-gate 完整轮次。

---

## Pin the Finish Line

**B = 小孙在一条新会话里跑一个小 feature，从 kickoff 到 merge 全链路零手动 A2A 干预；同时前端绝不出现半截 bubble。**

**不做什么：**
- 不改 DispatchOrchestrator 的队列/slot 语义（Phase 3 只新增并行的 chain registry，不动现有 queue）。
- 不改 CLI 启动/liveness/seal 的现有机制（只新增 stopReason 字段读取）。
- 不试图照搬 clowder-ai 的 `WorklistRegistry` async-generator 模型（跨进程不可行，Design Decisions 已定）。
- 不重写 settlement detector（只新增 "in-flight continuation" 抑制）。

## Terminal Schema

```ts
// packages/api/src/runtime/base-runtime.ts
export type StopReason =
  | "complete"     // end_turn / STOP / task.complete
  | "truncated"    // max_tokens / MAX_TOKENS
  | "refused"      // refusal / SAFETY
  | "tool_wait"    // tool_use (未消耗)，本项目走自动批准故一般不出现
  | "aborted"      // 进程退出但未见终态事件

export type AgentRunOutput = {
  finalText?: string
  rawStdout: string
  rawStderr: string
  exitCode: number | null
  stopReason: StopReason | null  // NEW — null = 无法判定
}
```

```ts
// packages/api/src/runtime/cli-orchestrator.ts
export type RunTurnResult = {
  content: string
  nativeSessionId: string | null
  currentModel: string | null
  stopped: boolean
  rawStdout: string
  rawStderr: string
  exitCode: number | null
  usage: TokenUsageSnapshot | null
  sealDecision: SealDecision | null
  stopReason: StopReason | null  // NEW — 从 runtime 透传
}
```

```ts
// packages/api/src/orchestrator/a2a-chain.ts (Phase 3 新增)
export type A2AChainEntry = {
  invocationId: string
  threadId: string
  provider: Provider
  alias: string
  parentInvocationId: string | null
  rootMessageId: string
  sessionGroupId: string
  createdAt: number
}

export class A2AChainRegistry {
  register(entry: A2AChainEntry): void
  get(invocationId: string): A2AChainEntry | null
  getParent(invocationId: string): A2AChainEntry | null
  isParentStillOnSameRoot(parentInvocationId: string, rootMessageId: string): boolean
  release(invocationId: string): void
}
```

```yaml
# manifest.yaml (Phase 4) — 新增 next_dispatch 字段
quality-gate:
  next: [requesting-review]        # 已存在，stage 推进
  next_dispatch:                   # NEW — 运行时直接派发
    target: "@reviewer"            # reviewer 由 runtime 按角色解析
    prompt_template: "quality-gate 已完成，请进入 receiving-review 处理反馈"
```

---

# Phase 1 — Stop Reason Parser

**Goal**：三 runtime 对称解析终态事件，`AgentRunOutput.stopReason` 输出结构化值；不改变任何现有行为（续写仍不发生，仅新增可观测）。

**PR 标题**：`feat(F003/P1): parse stop_reason across claude/codex/gemini runtimes`

**终态产物**：
- `base-runtime.ts` 新增 `parseStopReason` 抽象 + `StopReason` 类型 + `AgentRunOutput.stopReason` 字段
- 三 runtime 各自实现 `parseStopReason`
- `runTurn` 在 `onStdoutLine` 里累积 `latestStopReason`，`promise.then` 透传
- 单测覆盖全部分支

## Task P1-1: StopReason 类型 + 抽象方法

**Files:**
- Modify: `packages/api/src/runtime/base-runtime.ts:32-37` (AgentRunOutput type), `:467-469` (parseActivityLine 下方新增)

**Step 1: 写失败测试** — 新建 `packages/api/src/runtime/base-runtime.stop-reason.test.ts`

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { BaseCliRuntime, type AgentRunInput, type RuntimeCommand, type StopReason } from "./base-runtime"

class TestRuntime extends BaseCliRuntime {
  readonly agentId = "test"
  protected buildCommand(_input: AgentRunInput): RuntimeCommand {
    return { command: "echo", args: [], shell: false }
  }
}

describe("BaseCliRuntime.parseStopReason", () => {
  it("returns null by default (unclassified event)", () => {
    const runtime = new TestRuntime()
    assert.equal(runtime.parseStopReason({ type: "unknown" }), null)
  })

  it("AgentRunOutput has stopReason field in type", () => {
    // Type-level test — compile-time assertion
    const output: import("./base-runtime").AgentRunOutput = {
      rawStdout: "",
      rawStderr: "",
      exitCode: 0,
      stopReason: null,
    }
    assert.equal(output.stopReason, null)
  })
})
```

**Step 2: 跑测试确认失败**

```bash
pnpm --filter @multi-agent/api test -- --test-name-pattern "parseStopReason"
```
Expected: FAIL — `StopReason` type not exported / `stopReason` missing from `AgentRunOutput`.

**Step 3: 最小实现**

`base-runtime.ts:32` 改为：

```ts
export type StopReason =
  | "complete"
  | "truncated"
  | "refused"
  | "tool_wait"
  | "aborted"

export type AgentRunOutput = {
  finalText?: string
  rawStdout: string
  rawStderr: string
  exitCode: number | null
  stopReason: StopReason | null
}
```

`base-runtime.ts:467-469` 下方新增默认实现：

```ts
/**
 * Parse a terminal stop reason from a single stream-json event.
 * Return null when the event doesn't carry terminal info — orchestrator will
 * keep accumulating until a later event classifies the turn, or default to
 * "aborted" when the process exits without ever seeing a terminal event.
 */
parseStopReason(_event: Record<string, unknown>): StopReason | null {
  return null
}
```

**Step 4: 在 `close` 处理里回填 `stopReason`**（`base-runtime.ts:385-390` 修改 resolve）：

```ts
resolve({
  finalText: this.extractFinalText(rawStdout),
  rawStdout,
  rawStderr,
  exitCode: cancelled && code === null ? 0 : code,
  stopReason: null,  // 默认 null — 实际值由 runStream 外层累积器在 cli-orchestrator 里填
})
```

（注：stopReason 累积由 cli-orchestrator.ts 的 onStdoutLine 负责，base-runtime 的 resolve 不单独判定。但 base-runtime 必须返回字段以保持类型完整。）

**Step 5: 跑测试**

```bash
pnpm --filter @multi-agent/api test -- --test-name-pattern "parseStopReason"
```
Expected: PASS。

**Step 6: Commit**

```bash
git add packages/api/src/runtime/base-runtime.ts packages/api/src/runtime/base-runtime.stop-reason.test.ts
git commit -m "feat(F003/P1): add StopReason type + parseStopReason abstract [黄仁勋/Opus-46 🐾]"
```

---

## Task P1-2: ClaudeRuntime parseStopReason

**Files:**
- Modify: `packages/api/src/runtime/claude-runtime.ts` (append method 在 `parseAssistantDelta` 后)
- Test: `packages/api/src/runtime/claude-runtime.stop-reason.test.ts` (新建)

**参考**：Claude Code stream-json `result` event 形如：
```json
{"type":"result","subtype":"success","stop_reason":"end_turn","usage":{...}}
```
可能值：`end_turn` / `max_tokens` / `tool_use` / `refusal` / `stop_sequence`。

**Step 1: 写失败测试**

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ClaudeRuntime } from "./claude-runtime"

describe("ClaudeRuntime.parseStopReason", () => {
  const runtime = new ClaudeRuntime()

  it("maps end_turn → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "end_turn" }),
      "complete",
    )
  })

  it("maps max_tokens → truncated", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "max_tokens" }),
      "truncated",
    )
  })

  it("maps refusal → refused", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "refusal" }),
      "refused",
    )
  })

  it("maps tool_use → tool_wait", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "tool_use" }),
      "tool_wait",
    )
  })

  it("maps stop_sequence → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "stop_sequence" }),
      "complete",
    )
  })

  it("reads message_delta stop_reason (streaming close)", () => {
    assert.equal(
      runtime.parseStopReason({ type: "message_delta", delta: { stop_reason: "max_tokens" } }),
      "truncated",
    )
  })

  it("returns null for non-terminal events", () => {
    assert.equal(runtime.parseStopReason({ type: "content_block_delta" }), null)
    assert.equal(runtime.parseStopReason({ type: "message_start" }), null)
  })
})
```

**Step 2: 跑测试确认失败** — FAIL "ClaudeRuntime.parseStopReason returns null"

**Step 3: 实现** — 在 `claude-runtime.ts` 类中追加：

```ts
parseStopReason(event: Record<string, unknown>): StopReason | null {
  const readRaw = (raw: unknown): string | null => {
    if (typeof raw === "string") return raw
    return null
  }

  // `result` event at turn close
  if (event.type === "result") {
    const raw = readRaw(event.stop_reason)
    return this.mapClaudeStopReason(raw)
  }

  // Streaming close comes via message_delta with nested delta.stop_reason
  if (event.type === "message_delta") {
    const delta = event.delta as Record<string, unknown> | undefined
    const raw = readRaw(delta?.stop_reason)
    return this.mapClaudeStopReason(raw)
  }

  return null
}

private mapClaudeStopReason(raw: string | null): StopReason | null {
  if (!raw) return null
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "complete"
    case "max_tokens":
      return "truncated"
    case "refusal":
      return "refused"
    case "tool_use":
      return "tool_wait"
    default:
      return null
  }
}
```

Import `StopReason` 到 `claude-runtime.ts:3`。

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/runtime/claude-runtime.ts packages/api/src/runtime/claude-runtime.stop-reason.test.ts
git commit -m "feat(F003/P1): ClaudeRuntime.parseStopReason [黄仁勋/Opus-46 🐾]"
```

---

## Task P1-3: CodexRuntime parseStopReason

**Files:**
- Modify: `packages/api/src/runtime/codex-runtime.ts`
- Test: `packages/api/src/runtime/codex-runtime.stop-reason.test.ts` (新建)

**参考**：Codex `exec --json` 在 turn 结束时发 `{"type":"turn.completed","usage":{...}}`；若 `error` 字段存在或 `turn.failed` 则异常。Codex 没有独立 `stop_reason`，我们以 `turn.completed` 无 error → `complete`，`turn.failed` → `aborted` 作为映射；`max_tokens`-like 信号在 Codex 里体现为 `error: { type: "context_length_exceeded" }` 或类似，映射为 `truncated`。

**Step 1: 写失败测试**

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CodexRuntime } from "./codex-runtime"

describe("CodexRuntime.parseStopReason", () => {
  const runtime = new CodexRuntime()

  it("maps turn.completed → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "turn.completed", usage: {} }),
      "complete",
    )
  })

  it("maps turn.failed with context_length_exceeded → truncated", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "turn.failed",
        error: { type: "context_length_exceeded" },
      }),
      "truncated",
    )
  })

  it("maps generic turn.failed → aborted", () => {
    assert.equal(
      runtime.parseStopReason({ type: "turn.failed", error: { type: "unknown" } }),
      "aborted",
    )
  })

  it("maps item.completed reasoning → null (not terminal)", () => {
    assert.equal(runtime.parseStopReason({ type: "item.completed" }), null)
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现** — 在 `codex-runtime.ts` 追加：

```ts
parseStopReason(event: Record<string, unknown>): StopReason | null {
  if (event.type === "turn.completed") {
    return "complete"
  }
  if (event.type === "turn.failed") {
    const error = event.error as { type?: string } | undefined
    if (error?.type === "context_length_exceeded" || error?.type === "max_output_tokens") {
      return "truncated"
    }
    return "aborted"
  }
  return null
}
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/runtime/codex-runtime.ts packages/api/src/runtime/codex-runtime.stop-reason.test.ts
git commit -m "feat(F003/P1): CodexRuntime.parseStopReason [黄仁勋/Opus-46 🐾]"
```

---

## Task P1-4: GeminiRuntime parseStopReason

**Files:**
- Modify: `packages/api/src/runtime/gemini-runtime.ts`
- Test: `packages/api/src/runtime/gemini-runtime.stop-reason.test.ts` (新建)

**参考**：Gemini stream-json 在 turn 结束时发 `{"type":"result","status":"success","stats":{...},"finishReason":"STOP"}`。可能值：`STOP` / `MAX_TOKENS` / `SAFETY` / `RECITATION` / `OTHER`。

**Step 1: 写失败测试**

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { GeminiRuntime } from "./gemini-runtime"

describe("GeminiRuntime.parseStopReason", () => {
  const runtime = new GeminiRuntime()

  it("maps STOP → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "STOP" }),
      "complete",
    )
  })

  it("maps MAX_TOKENS → truncated", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "MAX_TOKENS" }),
      "truncated",
    )
  })

  it("maps SAFETY → refused", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "SAFETY" }),
      "refused",
    )
  })

  it("maps RECITATION → refused", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "RECITATION" }),
      "refused",
    )
  })

  it("falls back to stats.finishReason when top-level missing", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "result",
        status: "success",
        stats: { finishReason: "MAX_TOKENS" },
      }),
      "truncated",
    )
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现** — 在 `gemini-runtime.ts` 追加：

```ts
parseStopReason(event: Record<string, unknown>): StopReason | null {
  if (event.type !== "result") return null
  const topLevel = typeof event.finishReason === "string" ? event.finishReason : null
  const stats = event.stats as Record<string, unknown> | undefined
  const nested = typeof stats?.finishReason === "string" ? (stats.finishReason as string) : null
  const raw = topLevel ?? nested
  if (!raw) return null
  switch (raw.toUpperCase()) {
    case "STOP":
    case "END_TURN":
      return "complete"
    case "MAX_TOKENS":
      return "truncated"
    case "SAFETY":
    case "RECITATION":
      return "refused"
    default:
      return null
  }
}
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/runtime/gemini-runtime.ts packages/api/src/runtime/gemini-runtime.stop-reason.test.ts
git commit -m "feat(F003/P1): GeminiRuntime.parseStopReason [黄仁勋/Opus-46 🐾]"
```

---

## Task P1-5: cli-orchestrator 透传 stopReason + aborted 兜底

**Files:**
- Modify: `packages/api/src/runtime/cli-orchestrator.ts:38-48` (RunTurnResult), `:84-141` (onStdoutLine + promise.then)
- Test: `packages/api/src/runtime/cli-orchestrator.stop-reason.test.ts` (新建)

**Step 1: 写失败测试** — 测试用假 runtime 驱动 runTurn，验证 stopReason 从 stream-json events 累积到最终 result：

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
// ... (setup minimal runTurn invocation with a fake runtime emitting a "result" line)

describe("runTurn stopReason propagation", () => {
  it("accumulates last non-null stopReason from runtime events", async () => {
    // setup: fake runtime emitting [content_block_delta, message_delta(stop_reason=max_tokens)]
    // assert result.stopReason === "truncated"
  })

  it("defaults to 'aborted' when process exits with no terminal event", async () => {
    // setup: fake runtime emitting only content deltas, then exit(0)
    // assert result.stopReason === "aborted"
  })

  it("preserves 'complete' when result event seen", async () => {
    // setup: fake runtime emitting deltas + result(end_turn)
    // assert result.stopReason === "complete"
  })
})
```

（测试架构：新增一个 `FakeRuntime extends BaseCliRuntime`，`buildCommand` 返回一个能控制输出的 echo-like 命令；或者直接 mock `dependencies.spawn`。后者更干净——复用 `base-runtime.test.ts` 里现有的 spawn mock 模式。）

**Step 2: 跑测试确认失败**

**Step 3: 实现 — cli-orchestrator.ts 改动**

在 `RunTurnResult` 类型（`:38-48`）末尾追加：
```ts
  stopReason: StopReason | null
```

在 `runTurn` 函数（`:56`）顶部累积状态：
```ts
let latestStopReason: StopReason | null = null
```

在 `onStdoutLine` (`:85-134`) 里，`runtime.parseUsage` 调用旁新增：
```ts
const stopReason = runtime.parseStopReason(event)
if (stopReason) {
  latestStopReason = stopReason
}
```

在 `promise.then` (`:148-158`) 的 return 对象新增：
```ts
stopReason: latestStopReason ?? (output.exitCode === 0 && content.length > 0 ? null : "aborted"),
```

**注意语义**：如果 runtime 从未发终态事件（`latestStopReason=null`）且 exit 0 且有内容 → 返回 `null`（未分类，下游保守处理为 complete）；如果 exit 非 0 或无内容 → `"aborted"`。最终方案："finalize" 阶段 null 转 "aborted" 由续写层自己决定。这里先保持 latestStopReason 原值，让 Phase 2 的续写逻辑处理。

**改回**：
```ts
stopReason: latestStopReason,
```

并在 Phase 2 的续写判定里把 `stopReason === null && exit=0 && content.length > 0` 视为 complete；否则 `stopReason === null` 视为 `aborted`。

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/runtime/cli-orchestrator.ts packages/api/src/runtime/cli-orchestrator.stop-reason.test.ts
git commit -m "feat(F003/P1): propagate stopReason through runTurn [黄仁勋/Opus-46 🐾]"
```

---

## Task P1-6: Phase 1 PR 出口

**Step 1**：`pnpm check && pnpm lint && pnpm --filter @multi-agent/api test` 全过。
**Step 2**：进 `quality-gate` → `vision-guardian`（愿景对照：AC1 全打勾）→ `request-review`（选非实现者、非 reviewer 之外的 agent，默认 @范德彪）。
**Step 3**：review 通过 → `merge-gate` 合 Phase 1 → PR 关闭后标记 AC1 ✅ 在 F003.md Timeline 里。

---

# Phase 2 — 透明续写管线

**Goal**：`runThreadTurn` 读到 `stopReason === "truncated"` 或 `"aborted"` 时自动续写，append 到同一 assistant message；无硬上限；连续 2 次续写 <50 字 → 中止；续写期间 settlement 视为 in-flight；seal 触发中止。

**PR 标题**：`feat(F003/P2): transparent continuation pipeline on truncation`

**终态产物**：
- `runThreadTurn` 在 run.promise 解析后进入续写 while 循环
- 复用现有 `assistant.id` + `overwriteMessage` 实现 append 语义
- 新增 `ContinuationGuard` 类管理重复检测 / seal 短路 / in-flight 计数
- SettlementDetector 新增 "continuation in-flight" 信号

## Task P2-1: ContinuationGuard 模块

**Files:**
- Create: `packages/api/src/runtime/continuation-guard.ts`
- Create: `packages/api/src/runtime/continuation-guard.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ContinuationGuard } from "./continuation-guard"

describe("ContinuationGuard", () => {
  it("allows first continuation on truncated", () => {
    const guard = new ContinuationGuard()
    assert.equal(guard.shouldContinue("truncated", "substantial content here over fifty characters fixed length"), true)
  })

  it("stops after 2 consecutive <50 char continuations", () => {
    const guard = new ContinuationGuard()
    guard.recordContinuation("short reply")      // #1 — <50
    guard.recordContinuation("another short")    // #2 — <50 → STOP next
    assert.equal(guard.shouldContinue("truncated", "third one"), false)
  })

  it("resets repeat counter when a long continuation appears", () => {
    const guard = new ContinuationGuard()
    guard.recordContinuation("short")
    guard.recordContinuation("a ".repeat(30))  // long — resets
    guard.recordContinuation("short")
    assert.equal(guard.shouldContinue("truncated", "another"), true)  // only 1 short in a row now
  })

  it("doesn't continue on stopReason=complete", () => {
    const guard = new ContinuationGuard()
    assert.equal(guard.shouldContinue("complete", ""), false)
  })

  it("doesn't continue on stopReason=refused", () => {
    const guard = new ContinuationGuard()
    assert.equal(guard.shouldContinue("refused", ""), false)
  })

  it("continues on stopReason=aborted", () => {
    const guard = new ContinuationGuard()
    assert.equal(guard.shouldContinue("aborted", ""), true)
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现**

```ts
// packages/api/src/runtime/continuation-guard.ts
import type { StopReason } from "./base-runtime"

const SHORT_THRESHOLD = 50
const MAX_CONSECUTIVE_SHORT = 2

export class ContinuationGuard {
  private consecutiveShort = 0

  shouldContinue(stopReason: StopReason | null, _previousContent: string): boolean {
    if (stopReason !== "truncated" && stopReason !== "aborted") return false
    return this.consecutiveShort < MAX_CONSECUTIVE_SHORT
  }

  recordContinuation(appendedContent: string): void {
    const effective = appendedContent.trim().length
    if (effective < SHORT_THRESHOLD) {
      this.consecutiveShort += 1
    } else {
      this.consecutiveShort = 0
    }
  }

  reset(): void {
    this.consecutiveShort = 0
  }
}
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/runtime/continuation-guard.ts packages/api/src/runtime/continuation-guard.test.ts
git commit -m "feat(F003/P2): ContinuationGuard with repeat detection [黄仁勋/Opus-46 🐾]"
```

---

## Task P2-2: runThreadTurn 续写循环

**Files:**
- Modify: `packages/api/src/services/message-service.ts:849-957` (run.promise await 段落)
- Test: `packages/api/src/services/message-service.continuation.test.ts` (新建)

**Step 1: 写失败测试** — 测试用 mock runTurn 驱动 MessageService，模拟一次 `stopReason=truncated` 后一次 `stopReason=complete`：

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
// ... (setup: MessageService with mocked runTurn that emits truncated-then-complete)

describe("runThreadTurn continuation", () => {
  it("auto-continues on stopReason=truncated and appends to same message", async () => {
    // setup runTurn mock:
    //  call 1 → content="part A", stopReason="truncated"
    //  call 2 → content="part B", stopReason="complete"
    // execute runThreadTurn
    // assert: single assistant message, final content contains "part A" + "part B"
    // assert: runTurn called twice, second call's userMessage is the continuation prompt
  })

  it("stops after 2 consecutive short continuations", async () => {
    // setup: 4 truncated calls each producing <50 chars
    // assert: runTurn called 3 times (initial + 2 short → stop before 4th)
  })

  it("stops when sealDecision.shouldSeal triggers", async () => {
    // setup: truncated with sealDecision.shouldSeal=true
    // assert: no continuation, thread session cleared
  })

  it("preserves content when stopReason=complete on first call", async () => {
    // setup: single complete call
    // assert: runTurn called exactly once
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现** — 改写 `message-service.ts:849-957`

核心改动：把 `run.promise await` 的单次逻辑包在 `while` 循环里，用 `ContinuationGuard` 决定是否继续。每次续写时：
1. 保留同一 `assistant.id` 和 `assistant_delta` emit stream
2. 以 `userMessage = "你上一轮被截断，请无缝续写，不要重复上一轮已经输出的内容"` 调用新的 `runTurn`
3. 累计 content 到同一变量，`overwriteMessage` 用累计 content
4. 每次循环后检查 `sealDecision` — 触发 seal 时立即 break
5. `invocation.finished` 事件只在循环结束时发一次

伪代码（插在 `:849` 附近，完全重写这一段）：

```ts
try {
  const continuationGuard = new ContinuationGuard()
  let accumulatedContent = ""
  let accumulatedThinking = ""
  let lastResult: Awaited<typeof run.promise> | null = null
  let loopUserMessage = options.content
  let continuationCount = 0

  // Inform SettlementDetector that a multi-turn continuation may be in progress.
  // Cleared in finally below. SettlementDetector treats this as hasRunningTurn=true.
  this.settlementDetector?.markContinuationInFlight(thread.sessionGroupId, identity.invocationId)

  while (true) {
    const loopRun = runTurn({ /* same options but userMessage=loopUserMessage */ })
    // record loopRun as active (for cancellation)
    this.invocations.attachRun(thread.id, identity.invocationId, loopRun)

    const result = await loopRun.promise
    lastResult = result
    accumulatedContent += result.content
    // accumulatedThinking tracked via the onToolActivity callback into the enclosing `thinking` var
    this.sessions.overwriteMessage(assistant.id, {
      content: accumulatedContent || "[empty response]",
      thinking,
    })

    // Seal check — if context is near full, break before attempting further continuation
    if (result.sealDecision?.shouldSeal) {
      options.emit({
        type: "status",
        payload: { message: `${thread.alias} 上下文已用 ${Math.round(result.sealDecision.fillRatio * 100)}%，自动封存，续写中止。` },
      })
      break
    }

    // Decide continuation
    if (!continuationGuard.shouldContinue(result.stopReason, accumulatedContent)) {
      break
    }

    // Record and loop
    continuationGuard.recordContinuation(result.content)
    continuationCount += 1
    loopUserMessage = "你上一轮被截断（stop_reason=" + result.stopReason + "），请无缝续写。不要重复上一轮已输出的内容，直接接着写。"
    options.emit({
      type: "status",
      payload: { message: `${thread.alias} 续写中（第 ${continuationCount} 次）...` },
    })
  }

  this.invocations.detachRun(thread.id)
  this.releaseInvocation(identity.invocationId, dispatchCleanupTimer)

  // ... existing post-turn logic (effectiveSessionId, self-heal, collectDecisionsIntoBoard,
  //     invocation.finished, enqueuePublicMentions, advanceSopIfNeeded, flushDispatchQueue,
  //     notifyStateChange) — operates on `accumulatedContent` and `lastResult`
  const result = lastResult!
  // ... (rest unchanged, but substitute result.content → accumulatedContent)
} finally {
  this.settlementDetector?.clearContinuationInFlight(thread.sessionGroupId, identity.invocationId)
}
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/services/message-service.continuation.test.ts
git commit -m "feat(F003/P2): transparent continuation loop in runThreadTurn [黄仁勋/Opus-46 🐾]"
```

---

## Task P2-3: SettlementDetector in-flight 信号

**Files:**
- Modify: `packages/api/src/orchestrator/settlement-detector.ts` (add `markContinuationInFlight` / `clearContinuationInFlight` / `hasContinuationInFlight`)
- Modify: `settlement-detector.test.ts`

**Step 1: 写失败测试**

```ts
describe("SettlementDetector continuation in-flight", () => {
  it("does not settle while a continuation is in flight", () => {
    const detector = new SettlementDetector(...)
    detector.markContinuationInFlight("sg1", "inv1")
    // simulate all three signals = false except continuation in-flight
    assert.equal(detector.isSettledNow("sg1"), false)
  })

  it("settles after continuation is cleared", () => {
    const detector = new SettlementDetector(...)
    detector.markContinuationInFlight("sg1", "inv1")
    detector.clearContinuationInFlight("sg1", "inv1")
    assert.equal(detector.isSettledNow("sg1"), true)
  })

  it("supports multiple concurrent continuations per session group", () => {
    // two invocations mid-continuation → only settles when both cleared
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现** — `settlement-detector.ts` 新增：

```ts
private readonly continuationInFlight = new Map<string, Set<string>>()

markContinuationInFlight(sessionGroupId: string, invocationId: string): void {
  const set = this.continuationInFlight.get(sessionGroupId) ?? new Set()
  set.add(invocationId)
  this.continuationInFlight.set(sessionGroupId, set)
}

clearContinuationInFlight(sessionGroupId: string, invocationId: string): void {
  const set = this.continuationInFlight.get(sessionGroupId)
  if (!set) return
  set.delete(invocationId)
  if (set.size === 0) this.continuationInFlight.delete(sessionGroupId)
}

hasContinuationInFlight(sessionGroupId: string): boolean {
  return (this.continuationInFlight.get(sessionGroupId)?.size ?? 0) > 0
}
```

在 `isSettledNow` 的三信号判定里新增第 4 信号：`hasContinuationInFlight(sessionGroupId)` → 返回 true 则 `isSettledNow=false`。

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/orchestrator/settlement-detector.ts packages/api/src/orchestrator/settlement-detector.test.ts
git commit -m "feat(F003/P2): SettlementDetector continuation in-flight signal [黄仁勋/Opus-46 🐾]"
```

---

## Task P2-4: 手动验证 + Phase 2 PR 出口

**Step 1: 手动验证** — 构造一个会触发 `max_tokens` 的长 prompt（e.g., "请把以下 10000 字文本翻译为英文" 配合很小的 max_tokens），在前端打开新会话验证：
- 单条 bubble 持续流式追加
- 状态栏显示"续写中（第 N 次）..."
- 不出现两条分裂的 assistant message

**Step 2:** `pnpm check && pnpm lint && pnpm --filter @multi-agent/api test` 全过。

**Step 3:** `quality-gate` → `vision-guardian`（AC2 对照） → `request-review` → `merge-gate`。

---

# Phase 3 — A2A Invocation Chain + 回程派发

**Goal**：新增 `A2AChainRegistry`，在 `runThreadTurn` 的 outbound dispatch 之后检查"child reply 无出站 mention 且 parent 可回程"条件 → 合成一跳回程派发投递到 parent thread；前端 connector header 标记 "A2A 回程"。

**PR 标题**：`feat(F003/P3): auto return-path dispatch via A2AChainRegistry`

**终态产物**：
- 新增 `orchestrator/a2a-chain.ts` + test
- `MessageService` 构造函数新增 `chainRegistry` 字段
- `runThreadTurn` 在 `bindInvocation` 旁同步 `chainRegistry.register`
- `runThreadTurn` 的 post-dispatch 尾部新增 `maybeDispatchReturnPath()`
- 前端 `dispatch` event payload 新增 `returnPath: true` 标记（复用现有 connector header 渲染）

## Task P3-1: A2AChainRegistry 模块

**Files:**
- Create: `packages/api/src/orchestrator/a2a-chain.ts`
- Create: `packages/api/src/orchestrator/a2a-chain.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { A2AChainRegistry, type A2AChainEntry } from "./a2a-chain"

const entry = (overrides: Partial<A2AChainEntry> = {}): A2AChainEntry => ({
  invocationId: "inv-1",
  threadId: "th-1",
  provider: "claude",
  alias: "@黄仁勋",
  parentInvocationId: null,
  rootMessageId: "root-1",
  sessionGroupId: "sg-1",
  createdAt: 1,
  ...overrides,
})

describe("A2AChainRegistry", () => {
  it("registers and retrieves by invocationId", () => {
    const reg = new A2AChainRegistry()
    const e = entry()
    reg.register(e)
    assert.deepEqual(reg.get("inv-1"), e)
  })

  it("resolves parent via parentInvocationId", () => {
    const reg = new A2AChainRegistry()
    const parent = entry()
    const child = entry({ invocationId: "inv-2", parentInvocationId: "inv-1", alias: "@范德彪", provider: "codex" })
    reg.register(parent)
    reg.register(child)
    assert.deepEqual(reg.getParent("inv-2"), parent)
  })

  it("parent is still on same root when rootMessageId matches", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry())
    assert.equal(reg.isParentStillOnSameRoot("inv-1", "root-1"), true)
    assert.equal(reg.isParentStillOnSameRoot("inv-1", "root-2"), false)
  })

  it("release removes entry", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry())
    reg.release("inv-1")
    assert.equal(reg.get("inv-1"), null)
  })

  it("getParent returns null when parentInvocationId missing from registry", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry({ parentInvocationId: "gone" }))
    assert.equal(reg.getParent("inv-1"), null)
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现**

```ts
// packages/api/src/orchestrator/a2a-chain.ts
import type { Provider } from "@multi-agent/shared"

export type A2AChainEntry = {
  invocationId: string
  threadId: string
  provider: Provider
  alias: string
  parentInvocationId: string | null
  rootMessageId: string
  sessionGroupId: string
  createdAt: number
}

export class A2AChainRegistry {
  private readonly entries = new Map<string, A2AChainEntry>()

  register(entry: A2AChainEntry): void {
    this.entries.set(entry.invocationId, entry)
  }

  get(invocationId: string): A2AChainEntry | null {
    return this.entries.get(invocationId) ?? null
  }

  getParent(invocationId: string): A2AChainEntry | null {
    const child = this.entries.get(invocationId)
    if (!child?.parentInvocationId) return null
    return this.entries.get(child.parentInvocationId) ?? null
  }

  isParentStillOnSameRoot(parentInvocationId: string, rootMessageId: string): boolean {
    const parent = this.entries.get(parentInvocationId)
    return parent?.rootMessageId === rootMessageId
  }

  release(invocationId: string): void {
    this.entries.delete(invocationId)
  }
}
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/orchestrator/a2a-chain.ts packages/api/src/orchestrator/a2a-chain.test.ts
git commit -m "feat(F003/P3): A2AChainRegistry [黄仁勋/Opus-46 🐾]"
```

---

## Task P3-2: MessageService 注入 chainRegistry + register/release

**Files:**
- Modify: `packages/api/src/services/message-service.ts` (constructor, runThreadTurn bindInvocation 后, releaseInvocation 里)

**Step 1: 写失败测试** — 在 `message-service.*.test.ts` 里新增：

```ts
it("registers A2A chain entry on runThreadTurn", async () => {
  // setup MessageService with a mock A2AChainRegistry
  // execute a turn with parentInvocationId="parent-1"
  // assert chainRegistry.register called once with matching fields
})

it("releases chain entry after turn completes", async () => {
  // ... assert chainRegistry.release called
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现**
- constructor 接收 `chainRegistry: A2AChainRegistry`
- `runThreadTurn` 在 `bindInvocation` (`:715-720`) 旁调用 `this.chainRegistry.register(...)`
- `releaseInvocation` 里调用 `this.chainRegistry.release(invocationId)`
- 在 `packages/api/src/index.ts` 或 wiring 文件里 `new A2AChainRegistry()` 并传入

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/index.ts packages/api/src/services/message-service.*.test.ts
git commit -m "feat(F003/P3): wire A2AChainRegistry into MessageService [黄仁勋/Opus-46 🐾]"
```

---

## Task P3-3: 回程派发 maybeDispatchReturnPath

**Files:**
- Modify: `packages/api/src/services/message-service.ts` (new private method + call site)

**Step 1: 写失败测试**

```ts
describe("A2A return path dispatch", () => {
  it("auto-dispatches back to parent when child reply has no outbound mentions", async () => {
    // setup: parent(@黄仁勋) → child(@范德彪) chain
    // child replies "review done, here are findings..."（无行首 @黄仁勋）
    // assert: a new dispatch enqueued to @黄仁勋 thread with payload formatted as
    //         "[范德彪 的 requesting-review 答复]\n\n<content>\n\n请继续你的流程"
  })

  it("does NOT dispatch return path when child already wrote @parentAlias at line start", async () => {
    // child replies "...\n@黄仁勋 请 review 反馈"
    // assert: mention-router natural path handles it, no synthetic return dispatch
  })

  it("skips return dispatch when parent is already on a new rootMessageId", async () => {
    // mutate chainRegistry so parent's rootMessageId !== child's rootMessageId
    // assert: no dispatch
  })

  it("respects MAX_HOPS — return path consumes a hop", async () => {
    // setup chain at hop 14, return dispatch → enqueue goes through
    // setup chain at hop 15, return dispatch → blocked
  })

  it("does not return when child's parentInvocationId is null (top-level user turn)", async () => {
    // assert: no dispatch
  })

  it("does not return when child is aborted/refused (incomplete content)", async () => {
    // assert: no dispatch; user sees the failure directly
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现** — 新增私有方法 `maybeDispatchReturnPath`，在 `runThreadTurn` 的 `enqueuePublicMentions` 之后、`advanceSopIfNeeded` 之前调用：

```ts
private maybeDispatchReturnPath(args: {
  childInvocationId: string
  childAlias: string
  childContent: string
  childThread: ThreadState
  rootMessageId: string
  enqueueResult: EnqueueMentionsResult
  activeSkillName: string | null
  emit: EmitEvent
}): void {
  // 0. Short-circuit: child already enqueued an outbound mention → natural path handles it
  if (args.enqueueResult.queued.length > 0) return

  // 1. Lookup parent
  const parentEntry = this.chainRegistry.getParent(args.childInvocationId)
  if (!parentEntry) return
  if (!parentEntry.parentInvocationId && parentEntry.invocationId !== parentEntry.invocationId) {
    // parentEntry may itself be top-level; that's OK — we still return to it
  }

  // 2. Parent must still be on same root
  if (parentEntry.rootMessageId !== args.rootMessageId) return

  // 3. Parent thread must exist
  const parentThread = this.sessions.findThread(parentEntry.threadId)
  if (!parentThread) return

  // 4. Don't return empty / refused / aborted content
  if (!args.childContent.trim()) return

  // 5. Build return-path prompt
  const skillLabel = args.activeSkillName ? ` 的 ${args.activeSkillName} 答复` : " 的答复"
  const prompt = `[${args.childAlias}${skillLabel}]\n\n${args.childContent}\n\n请继续你的流程。`

  // 6. Post a user-role message into parent's thread and fire runThreadTurn
  const rootMessage = this.sessions.appendUserMessage(parentThread.id, prompt)
  this.dispatch.attachMessageToRoot(rootMessage.id, args.rootMessageId)

  // 7. Emit a distinguishable status so the frontend can label the connector header
  args.emit({
    type: "status",
    payload: {
      message: `A2A 回程 — ${args.childAlias} → ${parentThread.alias}`,
      connectorHeader: `A2A 回程 — ${args.childAlias} → ${parentThread.alias}`,
    },
  })

  // 8. Fire and forget — flushDispatchQueue's caller loop will pick up the new turn
  void this.runThreadTurn({
    threadId: parentThread.id,
    content: prompt,
    emit: args.emit,
    rootMessageId: args.rootMessageId,
    parentInvocationId: null,  // parent is resuming its own flow, no further return-path chaining
  })
}
```

**去环保证**：
- 回程调用里 `parentInvocationId: null` → 这次 parent 的 turn 若再派发 child，将是一条新的 chain（无 return-path 后续）。
- 依然走现有 `rootHopCounts` / `MAX_HOPS=15` — 回程 turn 在 parent 中触发新 mention 时会正常消耗 hop。
- `invocationTriggered` dedup 机制保证同一 rootMessageId 同一 provider 不被重复派发。

在 `runThreadTurn` 里 `enqueuePublicMentions` (`:935-946`) 之后、`advanceSopIfNeeded` (`:951`) 之前插入：

```ts
if (!promptRequestedByCli && accumulatedContent.trim() && !options.suppressOutboundDispatch) {
  const activeSkillName = this.skillRegistry?.match(accumulatedContent)[0]?.skill.name ?? null
  this.maybeDispatchReturnPath({
    childInvocationId: identity.invocationId,
    childAlias: thread.alias,
    childContent: accumulatedContent,
    childThread: thread,
    rootMessageId: options.rootMessageId,
    enqueueResult,
    activeSkillName,
    emit: options.emit,
  })
}
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/services/message-service.return-path.test.ts
git commit -m "feat(F003/P3): maybeDispatchReturnPath in runThreadTurn [黄仁勋/Opus-46 🐾]"
```

---

## Task P3-4: 前端 connector header

**Files:**
- Modify: `packages/web/src/...` (message renderer / connector pill component — 具体路径在实现时 grep 现有 `connector`)

**Step 1: Grep 前端连接器渲染**

```bash
```
(use Grep on `packages/web/src/` for "connector" to find the pill component)

**Step 2: 扩展 dispatch status event schema** — 后端 `maybeDispatchReturnPath` 已经 emit `connectorHeader` 字段。前端在 connector 渲染处读这个字段，若存在则显示为标签。

**Step 3: 写前端测试**（RTL / vitest）— 渲染一条包含 `connectorHeader: "A2A 回程 — ..."` 的消息，assert 标签出现。

**Step 4: 实现前端改动**

**Step 5: Commit**

```bash
git add packages/web/src/...
git commit -m "feat(F003/P3): frontend A2A 回程 connector label [黄仁勋/Opus-46 🐾]"
```

---

## Task P3-5: 手动验证 13:14 复现场景

**Step 1**：新会话 → 小孙给一个 feature 让黄仁勋跑 → 黄仁勋进到 `requesting-review` 阶段 → 派发到 @范德彪 → 德彪出完整 review（**不写行首 @黄仁勋**）。

**Expected**：
- 德彪的 turn 完成后，前端自动看到一条新的"A2A 回程"状态
- 黄仁勋的 thread 收到 `[范德彪 的 requesting-review 答复]\n\n...\n\n请继续你的流程` 的 user-role 消息
- 黄仁勋自动进入 `receiving-review`（注：这一步在 Phase 4 之前可能仍需 skill trigger 匹配；若不匹配，至少黄仁勋会被唤起并看到 review 内容，后续 Phase 4 补齐自动 skill 切换）

**Step 2**：`pnpm check && pnpm lint && pnpm --filter @multi-agent/api test && pnpm --filter @multi-agent/web test` 全过。

**Step 3**：`quality-gate` → `vision-guardian`（AC3 对照） → `request-review` → `merge-gate`。

---

# Phase 4 — SOP-driven Dispatch

**Goal**：manifest 新增 `next_dispatch: { target, prompt_template }`；`SkillRegistry` 暴露 `getNextDispatch`；`SopTracker.advance` 返回 `{ nextStage, nextDispatch }`；`advanceSopIfNeeded` 检测到 `nextDispatch` → 直接 `enqueuePublicMentions` 或 API 内部派发；LLM 已写 @ 时走 `invocationTriggered` 去重。

**PR 标题**：`feat(F003/P4): SOP-driven auto dispatch via manifest.next_dispatch`

**终态产物**：
- `manifest.yaml` 为 `quality-gate` / `requesting-review` / `receiving-review` 填 `next_dispatch`
- `SkillRegistry.getNextDispatch(skillName)` + `SkillMeta.nextDispatch` 字段
- `SopTracker.advance` 返回结构体
- `advanceSopIfNeeded` 改为直接派发
- 回归测试：自然 @ 场景不重复派发

## Task P4-1: Skill manifest schema 扩展

**Files:**
- Modify: `packages/api/src/skills/registry.ts:13-23` (SkillMeta), `:58-80` (loadManifest), `:132-134` (getNext 旁新增 getNextDispatch)
- Modify: `packages/api/src/skills/registry.test.ts`
- Modify: `multi-agent-skills/manifest.yaml` (Phase 4 单测先用 fixture，避免改真 manifest；真 manifest 改在 P4-4)

**Step 1: 写失败测试**

```ts
describe("SkillRegistry.getNextDispatch", () => {
  it("returns next_dispatch when defined", () => {
    const registry = new SkillRegistry()
    registry.loadManifest(fixturePath("with-next-dispatch.yaml"))
    assert.deepEqual(registry.getNextDispatch("quality-gate"), {
      target: "@reviewer",
      promptTemplate: "quality-gate 已完成，请进入 receiving-review",
    })
  })

  it("returns null when not defined", () => {
    const registry = new SkillRegistry()
    registry.loadManifest(fixturePath("plain.yaml"))
    assert.equal(registry.getNextDispatch("tdd"), null)
  })

  it("preserves getNext (stage) semantics untouched", () => {
    // existing behavior unchanged
  })
})
```

创建两个 fixture yaml 在 `packages/api/src/skills/__fixtures__/`。

**Step 2: 跑测试确认失败**

**Step 3: 实现**

`SkillMeta` 新增：
```ts
next_dispatch?: { target: string; promptTemplate: string } | null
nextDispatch: { target: string; promptTemplate: string } | null  // camelCase for TS consumers
```

`loadManifest` 解析逻辑新增：
```ts
const nd = entry.next_dispatch
  ? {
      target: entry.next_dispatch.target,
      promptTemplate: entry.next_dispatch.prompt_template ?? entry.next_dispatch.promptTemplate ?? "",
    }
  : null
// ...
nextDispatch: nd,
```

新方法：
```ts
getNextDispatch(skillName: string): { target: string; promptTemplate: string } | null {
  return this.skills.get(skillName)?.nextDispatch ?? null
}
```

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/skills/registry.ts packages/api/src/skills/registry.test.ts packages/api/src/skills/__fixtures__/
git commit -m "feat(F003/P4): SkillRegistry.getNextDispatch [黄仁勋/Opus-46 🐾]"
```

---

## Task P4-2: SopTracker.advance 返回结构体

**Files:**
- Modify: `packages/api/src/skills/sop-tracker.ts:18-29`
- Modify: `packages/api/src/skills/sop-tracker.test.ts`

**Step 1: 写失败测试**

```ts
describe("SopTracker.advance return value", () => {
  it("returns { nextStage, nextDispatch } when manifest defines next_dispatch", () => {
    const tracker = new SopTracker()
    const result = tracker.advance("sg1", "quality-gate", registry)
    assert.equal(result?.nextStage, "requesting-review")
    assert.deepEqual(result?.nextDispatch, { target: "@reviewer", promptTemplate: "..." })
  })

  it("returns { nextStage, nextDispatch: null } when no dispatch defined", () => {
    // ...
  })

  it("returns null when skill has no next", () => {
    // ...
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现**

```ts
export type SopAdvancement = {
  nextStage: string
  nextDispatch: { target: string; promptTemplate: string } | null
}

advance(
  sessionGroupId: string,
  completedSkill: string,
  registry: SkillRegistry,
): SopAdvancement | null {
  const nextSkills = registry.getNext(completedSkill)
  if (!nextSkills.length) return null
  const nextStage = nextSkills[0]
  this.stages.set(sessionGroupId, nextStage)
  const nextDispatch = registry.getNextDispatch(completedSkill)
  return { nextStage, nextDispatch }
}
```

更新 `message-service.ts:1838-1851` 适配新返回值（Task P4-3）。

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/skills/sop-tracker.ts packages/api/src/skills/sop-tracker.test.ts
git commit -m "feat(F003/P4): SopTracker returns SopAdvancement [黄仁勋/Opus-46 🐾]"
```

---

## Task P4-3: advanceSopIfNeeded 强制派发

**Files:**
- Modify: `packages/api/src/services/message-service.ts:1831-1852`
- Modify: `packages/api/src/services/message-service.*.test.ts`

**Step 1: 写失败测试**

```ts
describe("advanceSopIfNeeded auto dispatch", () => {
  it("dispatches to next_dispatch.target when LLM didn't write @", async () => {
    // setup: completed content containing quality-gate trigger keywords but NO @reviewer mention
    // execute advanceSopIfNeeded
    // assert: enqueuePublicMentions called with target alias in content
  })

  it("skips dispatch when LLM already wrote @target (dedup via invocationTriggered)", async () => {
    // setup: content containing "\n@reviewer 请 review..."
    // assert: no duplicate enqueue
  })

  it("no dispatch when skill has no next_dispatch", async () => {
    // existing behavior
  })

  it("resolves @reviewer to the correct thread when chain originated from @黄仁勋", async () => {
    // reviewer role resolution: use chain parent's reviewer mapping
  })
})
```

**Step 2: 跑测试确认失败**

**Step 3: 实现**

```ts
private advanceSopIfNeeded(
  sessionGroupId: string,
  content: string,
  sourceThread: ThreadState,
  sourceInvocationId: string,
  rootMessageId: string,
  emit: EmitEvent,
): void {
  if (!this.skillRegistry || !this.sopTracker) return

  const matched = this.skillRegistry.match(content)
  if (!matched.length) return

  for (const { skill } of matched) {
    const advancement = this.sopTracker.advance(sessionGroupId, skill.name, this.skillRegistry)
    if (!advancement) continue

    // Surface stage transition
    const sopInfo = this.skillRegistry.getSopStage(advancement.nextStage)
    const skillSuggestion = sopInfo?.suggestedSkill ? ` 建议加载 skill: ${sopInfo.suggestedSkill}` : ""
    emit({
      type: "status",
      payload: { message: `SOP 推进到 ${advancement.nextStage}。${skillSuggestion}` },
    })

    // Auto-dispatch if next_dispatch defined
    if (advancement.nextDispatch) {
      const targetAlias = advancement.nextDispatch.target.startsWith("@")
        ? advancement.nextDispatch.target
        : `@${advancement.nextDispatch.target}`

      // Synthesize a mention-bearing content so existing enqueuePublicMentions dedup works
      // The LLM may have already written this mention — invocationTriggered map catches it.
      const syntheticContent = `${content}\n\n${targetAlias} ${advancement.nextDispatch.promptTemplate}`
      this.dispatch.enqueuePublicMentions({
        messageId: `sop-auto-${sourceInvocationId}`,
        sessionGroupId,
        sourceProvider: sourceThread.provider,
        sourceAlias: sourceThread.alias,
        rootMessageId,
        content: syntheticContent,
        matchMode: "line-start",
        parentInvocationId: sourceInvocationId,
        buildSnapshot: () => this.captureSnapshot(sessionGroupId, null),
        extractSnippet: (c, alias) => extractTaskSnippet(c, alias),
      })
    }

    break  // only advance once per turn
  }
}
```

**注意**：`advanceSopIfNeeded` 的 signature 变了，call site `:951` 要传新参数。

**Step 4: 跑测试** — PASS

**Step 5: Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/services/message-service.*.test.ts
git commit -m "feat(F003/P4): advanceSopIfNeeded force-dispatches next_dispatch [黄仁勋/Opus-46 🐾]"
```

---

## Task P4-4: 填真 manifest + skill 文档

**Files:**
- Modify: `multi-agent-skills/manifest.yaml`
- Modify: `multi-agent-skills/quality-gate/SKILL.md` (补充 "next_dispatch" 段落，说明此 skill 完成后运行时会自动派发)
- Modify: `multi-agent-skills/requesting-review/SKILL.md`（存在性校验，若不存在跳过）
- Modify: `multi-agent-skills/receiving-review/SKILL.md`（存在性校验）

**需要的条目**：
```yaml
quality-gate:
  next: [requesting-review]
  next_dispatch:
    target: "@reviewer"
    prompt_template: "quality-gate 已完成，请对照 AC 做 review，review 完直接 @发起方 返回结果。"

requesting-review:
  next: [receiving-review]
  # next_dispatch 由 runtime 的回程派发负责（Phase 3），此处不填以避免双派发

receiving-review:
  next: [merge-gate]
  next_dispatch:
    target: "@merge-gate-owner"  # 或按角色解析
    prompt_template: "review 反馈已处理完毕，请走 merge-gate 流程。"
```

**注意 `@reviewer` 解析**：Phase 4 需要一个 reviewer 解析规则（按当前 chain 里谁是"对侧"或默认 Codex）。方案：
- 新增 `packages/api/src/services/reviewer-resolver.ts`：根据 `sourceThread.provider` 返回另一 provider 的 alias（claude → codex → gemini → claude 的轮转）
- 或者：在 `enqueuePublicMentions` 的 alias → provider 解析前加一层"角色占位符替换"

为了不把范围撑爆，Phase 4 采用**固定映射**：claude→codex, codex→claude, gemini→codex（范德彪为默认 reviewer）。

**Step 1: 写 reviewer-resolver 测试** (`packages/api/src/services/reviewer-resolver.test.ts`)

**Step 2: 实现 resolver 并把它接入 `advanceSopIfNeeded` 的 `targetAlias` 计算**

**Step 3: 更新 manifest + SKILL.md 文档**

**Step 4: 端到端测试** — 一个完整的 quality-gate 通过的 fixture turn → 期望自动 enqueue 到 reviewer

**Step 5: Commit**

```bash
git add multi-agent-skills/ packages/api/src/services/reviewer-resolver.ts packages/api/src/services/reviewer-resolver.test.ts
git commit -m "feat(F003/P4): populate manifest next_dispatch + reviewer resolver [黄仁勋/Opus-46 🐾]"
```

---

## Task P4-5: Phase 4 PR 出口 + AC5 愿景对照

**Step 1: 全量测试**

```bash
pnpm check && pnpm lint && pnpm --filter @multi-agent/api test && pnpm --filter @multi-agent/web test
```

**Step 2: 手动端到端验证**（AC5）

小孙在一条新会话跑一个小 feature：
- 说"新功能：给 A 加个 B 按钮" → @黄仁勋
- 黄仁勋进 feat-lifecycle → writing-plans → worktree → tdd → quality-gate → （自动）派发到 @范德彪 → 德彪 review → （自动回程）→ 黄仁勋 receiving-review → （自动派发）→ merge-gate → feat-lifecycle completion
- **全程小孙零手动 @ 干预**

**对照表**（填到 F003.md 的 AC5）：

| 小孙原话 | 现状 | 匹配 |
|---|---|---|
| "会话突然截断...我手动问你为什么停了" | Phase 2 续写管线，单 bubble 流式追加 | ☐ |
| "quality-gate 之后应该去请求 review 但是仁勋没有" | Phase 4 自动派发 | ☐ |
| "A2A 根本不会主动收敛...我当人肉 router" | Phase 3 回程派发 | ☐ |

**Step 3**：`quality-gate` → `vision-guardian`（AC5 对照全打勾）→ 跨 agent 交叉验证 → `request-review` → `merge-gate` 合 Phase 4。

**Step 4**：回 F003 做 `feat-lifecycle` Completion — Status: done，Timeline 加收尾。

---

## Done 状态

- 4 个 PR 全部合入 main
- F003.md Status: done + Completed: YYYY-MM-DD
- ROADMAP 从活跃移到已完成
- 小孙全链路验收通过
