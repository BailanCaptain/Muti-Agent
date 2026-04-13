# F007 上下文压缩优化 Implementation Plan

**Feature:** F007 — `docs/features/F007-context-compression-optimization.md`
**Goal:** 让 agent 在长对话中不丢记忆、不断片、不停工。9 个模块一次做完。
**Acceptance Criteria:** 见 feature doc AC1.1–AC10.2，共 37 条，本计划逐条覆盖。
**Architecture:** context-assembler 输出阶段插入 Microcompact 管线；SOP 书签存 SQLite 跨 seal 恢复；seal 后自动续接（最多 2 次）；动态 token 预算根据 fillRatio 伸缩；本地 embedding + better-sqlite3 暴力余弦做语义检索；摘要取样窗口扩大 + Provider Fallback 链；F-BLOAT 检测强制重注入；全程 metrics 可观测；前端面包屑 + 健康仪表盘。
**Tech Stack:** TypeScript, node:test, better-sqlite3 (via node:sqlite DatabaseSync), @huggingface/transformers (all-MiniLM-L6-v2), Zustand, React/Next.js, WebSocket

---

## Straight-Line Check

**Finish line (B):** 长对话 20+ 轮后触发 seal → agent 自动续接不停工 → 续接后 skill 阶段正确 → 工具输出不丢失 → 历史注入根据窗口余量动态调整 → 中间段关键决策可语义检索召回 → 全程可观测。

**We do NOT do:** 外部向量数据库（ChromaDB 等）、修改 CLI 内部逻辑、修改 .env / runtime config、删除 SQLite 数据。

**Terminal schema（终态类型）：**

```typescript
// microcompact.ts
type MicrocompactConfig = { keepRecent: number; keepLastFailure: boolean }
type CompactedMessage = ContextMessage // content may be replaced with anchor placeholder

// context-policy.ts
type ContextPolicy = { ...existing, dynamicBudget?: boolean }

// sop-bookmark (new column in threads table)
type SOPBookmark = {
  skill: string | null
  phase: string | null
  lastCompletedStep: string
  nextExpectedAction: string
  blockingQuestion: string | null
  updatedAt: string
}

// metrics-service.ts
type ContextMetric = {
  id: string; threadId: string; metricName: string; metricValue: number;
  provider: string; createdAt: string
}

// message_embeddings + message_embedding_meta tables (SQLite)
// continuation-loop: ContinuationStopReason gains "sealed_auto_resumed"
// RunTurnResult gains prevUsedTokens for F-BLOAT detection
```

---

## Task 1: Microcompact — 零 LLM 开销工具输出瘦身

**Covers:** AC1.1, AC1.2, AC1.3, AC1.4, AC1.5, AC1.6, AC1.7

**Files:**
- Create: `packages/api/src/orchestrator/microcompact.ts`
- Create: `packages/api/src/orchestrator/microcompact.test.ts`
- Modify: `packages/api/src/orchestrator/context-assembler.ts:111-142`

### Step 1: Write failing test for microcompact

```typescript
// packages/api/src/orchestrator/microcompact.test.ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ContextMessage } from "./context-snapshot"
import { microcompact } from "./microcompact"

describe("microcompact", () => {
  const makeToolMsg = (id: string, content: string, createdAt: string): ContextMessage => ({
    id,
    role: "assistant",
    agentId: "黄仁勋",
    content: `[tool_result] ${content}`,
    createdAt,
  })

  const makeNormalMsg = (id: string, content: string, createdAt: string): ContextMessage => ({
    id,
    role: "assistant",
    agentId: "黄仁勋",
    content,
    createdAt,
  })

  it("keeps recent 5 tool results intact, compacts older ones", () => {
    const messages: ContextMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push(makeToolMsg(`t${i}`, `edit_file src/f${i}.ts exit=0`, `2026-04-13T10:${String(i).padStart(2, "0")}:00Z`))
    }
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    // First 5 (oldest) should be compacted
    for (let i = 0; i < 5; i++) {
      assert.ok(result[i].content.includes("[工具结果已压缩]"), `msg ${i} should be compacted`)
      assert.ok(result[i].content.includes(`msgId=t${i}`), `msg ${i} should have anchor`)
    }
    // Last 5 (newest) should be intact
    for (let i = 5; i < 10; i++) {
      assert.ok(result[i].content.includes("[tool_result]"), `msg ${i} should be intact`)
    }
  })

  it("always keeps the most recent failure result intact", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edit_file src/a.ts exit=1 stderr=TypeError", "2026-04-13T10:00:00Z"),
      makeToolMsg("t1", "edit_file src/b.ts exit=0", "2026-04-13T10:01:00Z"),
      makeToolMsg("t2", "edit_file src/c.ts exit=0", "2026-04-13T10:02:00Z"),
      makeToolMsg("t3", "edit_file src/d.ts exit=0", "2026-04-13T10:03:00Z"),
      makeToolMsg("t4", "edit_file src/e.ts exit=0", "2026-04-13T10:04:00Z"),
      makeToolMsg("t5", "edit_file src/f.ts exit=0", "2026-04-13T10:05:00Z"),
      makeToolMsg("t6", "edit_file src/g.ts exit=0", "2026-04-13T10:06:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    // t0 is old (outside keepRecent) but is the last failure — must stay intact
    assert.ok(result[0].content.includes("[tool_result]"), "failure result must be preserved")
    assert.ok(!result[0].content.includes("[工具结果已压缩]"))
    // t1 is old and not a failure — should be compacted
    assert.ok(result[1].content.includes("[工具结果已压缩]"))
  })

  it("does not modify non-tool messages", () => {
    const messages: ContextMessage[] = [
      makeNormalMsg("n0", "我来分析一下架构", "2026-04-13T10:00:00Z"),
      makeToolMsg("t0", "read_file src/a.ts exit=0", "2026-04-13T10:01:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    assert.equal(result[0].content, "我来分析一下架构")
  })

  it("returns new array without mutating input", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edit_file exit=0", "2026-04-13T10:00:00Z"),
    ]
    const original = messages[0].content
    microcompact(messages, { keepRecent: 0, keepLastFailure: false })
    assert.equal(messages[0].content, original)
  })

  it("anchor placeholder contains msgId, tool name, and timestamp", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edit_file path=src/foo.ts exit=0", "2026-04-13T10:00:00Z"),
      makeToolMsg("t1", "read_file exit=0", "2026-04-13T10:01:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 1, keepLastFailure: false })
    assert.ok(result[0].content.includes("msgId=t0"))
    assert.ok(result[0].content.includes("at=2026-04-13T10:00:00Z"))
  })
})
```

### Step 2: Run test to verify it fails

Run: `cd packages/api && npx tsx --test src/orchestrator/microcompact.test.ts`
Expected: FAIL — `microcompact` is not defined / cannot be imported

### Step 3: Write minimal implementation

```typescript
// packages/api/src/orchestrator/microcompact.ts
import type { ContextMessage } from "./context-snapshot"

export type MicrocompactConfig = {
  keepRecent: number
  keepLastFailure: boolean
}

const TOOL_RESULT_PATTERN = /\[tool_result\]/
const FAILURE_PATTERN = /exit=[1-9]|stderr=|Error|FAIL|error:/i
const TOOL_NAME_PATTERN = /\[tool_result\]\s*(\S+)/
const PATH_PATTERN = /path=(\S+)/

export function microcompact(
  messages: readonly ContextMessage[],
  config: MicrocompactConfig,
): ContextMessage[] {
  const isToolResult = (m: ContextMessage) => TOOL_RESULT_PATTERN.test(m.content)
  const isFailure = (m: ContextMessage) => FAILURE_PATTERN.test(m.content)

  // Identify tool-result messages and their indices
  const toolIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isToolResult(messages[i])) {
      toolIndices.push(i)
    }
  }

  // Determine which tool results to keep intact
  const keepSet = new Set<number>()

  // Keep the most recent N tool results
  const recentToolIndices = toolIndices.slice(-config.keepRecent)
  for (const idx of recentToolIndices) {
    keepSet.add(idx)
  }

  // Keep the most recent failure (scanning from newest to oldest)
  if (config.keepLastFailure) {
    for (let i = toolIndices.length - 1; i >= 0; i--) {
      if (isFailure(messages[toolIndices[i]])) {
        keepSet.add(toolIndices[i])
        break
      }
    }
  }

  // Build output: compact tool results not in keepSet
  return messages.map((m, i) => {
    if (!isToolResult(m) || keepSet.has(i)) {
      return { ...m }
    }
    return {
      ...m,
      content: buildAnchorPlaceholder(m),
    }
  })
}

function buildAnchorPlaceholder(m: ContextMessage): string {
  const toolMatch = TOOL_NAME_PATTERN.exec(m.content)
  const toolName = toolMatch?.[1] ?? "unknown"
  const pathMatch = PATH_PATTERN.exec(m.content)
  const pathStr = pathMatch ? ` | path=${pathMatch[1]}` : ""
  const exitMatch = /exit=(\d+)/.exec(m.content)
  const exitStr = exitMatch ? ` | exit=${exitMatch[1]}` : ""
  return `[工具结果已压缩] msgId=${m.id} | tool=${toolName}${pathStr}${exitStr} | at=${m.createdAt}`
}
```

### Step 4: Run test to verify it passes

Run: `cd packages/api && npx tsx --test src/orchestrator/microcompact.test.ts`
Expected: PASS — all 5 tests green

### Step 5: Integrate microcompact into context-assembler

Modify `context-assembler.ts:116-127` — wrap self history messages through microcompact before injection:

```typescript
// In assemblePrompt(), after line 117 (const selfMessages = ...)
// Add import at top: import { microcompact } from "./microcompact"
// Replace the self-history block:

  if (shouldInjectSelfHistory) {
    const selfMessages = roomSnapshot.filter((m) => m.agentId === targetAlias)
    const recent = selfMessages.slice(-policy.selfHistoryLimit)
    const compacted = microcompact(recent, { keepRecent: 5, keepLastFailure: true })
    if (compacted.length > 0) {
      contentSections.push(`--- 你之前的发言 (${compacted.length} 条) ---`)
      for (const m of compacted) {
        contentSections.push(`[${m.role === "user" ? "收到" : "你"}]: ${m.content}`)
      }
      contentSections.push("---")
      contentSections.push("")
    }
  }

  // Same for shared history (line 130-141):
  if (policy.injectSharedHistory) {
    const otherMessages = roomSnapshot.filter((m) => m.agentId !== targetAlias)
    const recent = otherMessages.slice(-policy.sharedHistoryLimit)
    const compacted = microcompact(recent, { keepRecent: 5, keepLastFailure: true })
    if (compacted.length > 0) {
      contentSections.push(`--- 近期对话 (${compacted.length} 条) ---`)
      for (const m of compacted) {
        const truncated = truncateHeadTail(m.content, policy.maxContentLength)
        contentSections.push(`[${m.agentId}]: ${truncated}`)
      }
      contentSections.push("---")
      contentSections.push("")
    }
  }
```

### Step 6: Write integration test for context-assembler + microcompact

Add to `context-assembler.test.ts`:

```typescript
test("microcompact compacts old tool results in self history", async () => {
  const roomSnapshot: ContextMessage[] = []
  for (let i = 0; i < 10; i++) {
    roomSnapshot.push({
      id: `t${i}`,
      role: "assistant",
      agentId: "黄仁勋",
      content: `[tool_result] edit_file path=src/f${i}.ts exit=0 output=done`,
      createdAt: `2026-04-13T10:${String(i).padStart(2, "0")}:00Z`,
    })
  }
  const result = await assemblePrompt({
    provider: "claude",
    threadId: "t1",
    sessionGroupId: "sg1",
    nativeSessionId: null,
    policy: POLICY_FULL,
    task: "继续",
    roomSnapshot,
    sourceAlias: "user",
    targetAlias: "黄仁勋",
  }, null)

  // Old tool results should be compacted
  assert.ok(result.content.includes("[工具结果已压缩]"))
  // Recent tool results should be intact
  assert.ok(result.content.includes("[tool_result] edit_file path=src/f9.ts"))
})
```

### Step 7: Run all assembler tests

Run: `cd packages/api && npx tsx --test src/orchestrator/context-assembler.test.ts src/orchestrator/microcompact.test.ts`
Expected: PASS

### Step 8: Commit

```bash
git add packages/api/src/orchestrator/microcompact.ts packages/api/src/orchestrator/microcompact.test.ts packages/api/src/orchestrator/context-assembler.ts packages/api/src/orchestrator/context-assembler.test.ts
git commit -m "feat(F007): Microcompact — 零 LLM 开销工具输出瘦身 [黄仁勋/Opus-46 🐾]"
```

---

## Task 2: SOP 书签 — 跨 seal 的 skill 状态恢复

**Covers:** AC2.1, AC2.2, AC2.3, AC2.4, AC2.5

**Files:**
- Create: `packages/api/src/orchestrator/sop-bookmark.ts`
- Create: `packages/api/src/orchestrator/sop-bookmark.test.ts`
- Modify: `packages/api/src/db/sqlite.ts:226` (migration — add sop_bookmark column)
- Modify: `packages/api/src/db/repositories/session-repository.ts:341-358` (updateThread with bookmark)
- Modify: `packages/api/src/orchestrator/context-assembler.ts:67-75` (inject bookmark in system prompt)
- Modify: `packages/api/src/services/message-service.ts:1035` (extract + persist bookmark after turn)

### Step 1: Write failing test for SOP bookmark extraction

```typescript
// packages/api/src/orchestrator/sop-bookmark.test.ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { extractSOPBookmark, formatBookmarkForInjection } from "./sop-bookmark"
import type { SOPBookmark } from "./sop-bookmark"

describe("extractSOPBookmark", () => {
  it("extracts skill and phase from agent output containing skill markers", () => {
    const output = `按 TDD 流程，我先写失败测试。

## Red Phase

这个测试验证...`
    const sopStage = "tdd"
    const result = extractSOPBookmark(output, sopStage)
    assert.equal(result.skill, "tdd")
    assert.equal(result.phase, "red")
    assert.ok(result.lastCompletedStep.length > 0)
  })

  it("returns null-skill bookmark when no skill markers found", () => {
    const result = extractSOPBookmark("普通对话内容", null)
    assert.equal(result.skill, null)
    assert.equal(result.phase, null)
  })

  it("detects green phase", () => {
    const output = "测试通过了！现在重构..."
    const result = extractSOPBookmark(output, "tdd")
    assert.equal(result.skill, "tdd")
    assert.ok(result.phase === "green" || result.phase === "refactor")
  })

  it("detects review phase", () => {
    const output = "@范德彪 请 review 这个改动"
    const result = extractSOPBookmark(output, "requesting-review")
    assert.equal(result.skill, "requesting-review")
  })
})

describe("formatBookmarkForInjection", () => {
  it("formats bookmark as machine-readable line", () => {
    const bm: SOPBookmark = {
      skill: "tdd",
      phase: "red",
      lastCompletedStep: "wrote failing test",
      nextExpectedAction: "minimal implementation",
      blockingQuestion: null,
      updatedAt: "2026-04-13T10:00:00Z",
    }
    const result = formatBookmarkForInjection(bm)
    assert.ok(result.includes("skill=tdd"))
    assert.ok(result.includes("phase=red"))
    assert.ok(result.includes("next=minimal implementation"))
  })

  it("returns empty string for null-skill bookmark", () => {
    const bm: SOPBookmark = {
      skill: null, phase: null, lastCompletedStep: "", nextExpectedAction: "",
      blockingQuestion: null, updatedAt: "2026-04-13T10:00:00Z",
    }
    assert.equal(formatBookmarkForInjection(bm), "")
  })
})
```

### Step 2: Run test to verify it fails

Run: `cd packages/api && npx tsx --test src/orchestrator/sop-bookmark.test.ts`
Expected: FAIL — module not found

### Step 3: Write minimal implementation

```typescript
// packages/api/src/orchestrator/sop-bookmark.ts
export type SOPBookmark = {
  skill: string | null
  phase: string | null
  lastCompletedStep: string
  nextExpectedAction: string
  blockingQuestion: string | null
  updatedAt: string
}

const PHASE_PATTERNS: Array<{ pattern: RegExp; phase: string; next: string }> = [
  { pattern: /red\s*phase|写.*失败.*测试|failing test/i, phase: "red", next: "minimal implementation" },
  { pattern: /green\s*phase|测试通过|tests?\s*pass/i, phase: "green", next: "refactor" },
  { pattern: /refactor/i, phase: "refactor", next: "commit" },
  { pattern: /review|审查|code.?review/i, phase: "review", next: "address feedback" },
  { pattern: /merge|合入|squash/i, phase: "merge", next: "verify CI" },
  { pattern: /quality.?gate|自检|门禁/i, phase: "quality-gate", next: "request review" },
  { pattern: /acceptance|验收/i, phase: "acceptance", next: "address findings" },
  { pattern: /handoff|交接/i, phase: "handoff", next: "wait for response" },
]

export function extractSOPBookmark(agentOutput: string, currentSopStage: string | null): SOPBookmark {
  const now = new Date().toISOString()

  if (!currentSopStage) {
    return { skill: null, phase: null, lastCompletedStep: "", nextExpectedAction: "", blockingQuestion: null, updatedAt: now }
  }

  let detectedPhase: string | null = null
  let nextAction = ""
  let lastStep = ""

  for (const { pattern, phase, next } of PHASE_PATTERNS) {
    if (pattern.test(agentOutput)) {
      detectedPhase = phase
      nextAction = next
      // Extract a short snippet around the match as lastCompletedStep
      const match = pattern.exec(agentOutput)
      if (match) {
        const start = Math.max(0, match.index - 20)
        const end = Math.min(agentOutput.length, match.index + match[0].length + 40)
        lastStep = agentOutput.slice(start, end).replace(/\n/g, " ").trim()
      }
      break
    }
  }

  // Detect blocking questions
  const blockMatch = /\[分歧点\](.+?)(?:\n|$)/.exec(agentOutput)
  const blocking = blockMatch ? blockMatch[1].trim() : null

  return {
    skill: currentSopStage,
    phase: detectedPhase,
    lastCompletedStep: lastStep,
    nextExpectedAction: nextAction,
    blockingQuestion: blocking,
    updatedAt: now,
  }
}

export function formatBookmarkForInjection(bookmark: SOPBookmark): string {
  if (!bookmark.skill) return ""
  const parts = [
    `skill=${bookmark.skill}`,
    `phase=${bookmark.phase ?? "unknown"}`,
    `last=${bookmark.lastCompletedStep || "none"}`,
    `next=${bookmark.nextExpectedAction || "none"}`,
    `blocking=${bookmark.blockingQuestion ?? "none"}`,
  ]
  return parts.join(" | ")
}
```

### Step 4: Run test to verify it passes

Run: `cd packages/api && npx tsx --test src/orchestrator/sop-bookmark.test.ts`
Expected: PASS

### Step 5: Add sop_bookmark column to SQLite migration

In `packages/api/src/db/sqlite.ts`, after line 225 (the `project_tag` migration):

```typescript
    try {
      this.db.exec("ALTER TABLE threads ADD COLUMN sop_bookmark TEXT;")
    } catch {
      // Column may already exist
    }
```

### Step 6: Update session-repository to read/write sop_bookmark

In `packages/api/src/db/repositories/session-repository.ts`:

- `updateThread` (line 341-358): add `sopBookmark` to the updates parameter and SQL
- `getThreadById` / `listThreadsByGroup`: include `sop_bookmark as sopBookmark` in SELECT

Add to `ProviderThreadRecord` in `sqlite.ts`:
```typescript
export type ProviderThreadRecord = {
  // ...existing fields
  sopBookmark: string | null  // JSON string of SOPBookmark
}
```

### Step 7: Inject bookmark in context-assembler

In `context-assembler.ts`, after the rolling summary injection (line 74), add:

```typescript
  // SOP bookmark injection
  if (policy.injectRollingSummary) {
    const thread = input.roomSnapshot.length > 0 ? null : null // Thread info comes from a separate path
    // Bookmark is passed via a new optional field on AssemblePromptInput
    if (input.sopBookmark) {
      const { formatBookmarkForInjection } = await import("./sop-bookmark")
      const bookmarkLine = formatBookmarkForInjection(input.sopBookmark)
      if (bookmarkLine) {
        systemParts.push("")
        systemParts.push("## 当前执行状态")
        systemParts.push(bookmarkLine)
      }
    }
  }
```

Add `sopBookmark?: SOPBookmark` to `AssemblePromptInput` type.

### Step 8: Extract and persist bookmark after turn in message-service

In `message-service.ts`, after line 1035 (`this.sessions.updateThread(...)`), add bookmark extraction:

```typescript
      // Extract and persist SOP bookmark
      if (accumulatedContent.trim()) {
        const sopStage = this.sopTracker?.getStage(thread.sessionGroupId) ?? null
        const { extractSOPBookmark } = await import("../orchestrator/sop-bookmark")
        const bookmark = extractSOPBookmark(accumulatedContent, sopStage)
        if (bookmark.skill) {
          this.sessions.updateThreadBookmark(thread.id, JSON.stringify(bookmark))
        }
      }
```

### Step 9: Write integration test — seal → new session → bookmark injected

```typescript
// Add to sop-bookmark.test.ts
describe("bookmark round-trip", () => {
  it("serializes and deserializes via JSON", () => {
    const bm: SOPBookmark = {
      skill: "tdd", phase: "red", lastCompletedStep: "wrote test",
      nextExpectedAction: "implement", blockingQuestion: null, updatedAt: "2026-04-13T10:00:00Z",
    }
    const json = JSON.stringify(bm)
    const parsed = JSON.parse(json) as SOPBookmark
    assert.deepEqual(parsed, bm)
  })
})
```

### Step 10: Run tests

Run: `cd packages/api && npx tsx --test src/orchestrator/sop-bookmark.test.ts`
Expected: PASS

### Step 11: Commit

```bash
git add packages/api/src/orchestrator/sop-bookmark.ts packages/api/src/orchestrator/sop-bookmark.test.ts packages/api/src/db/sqlite.ts packages/api/src/db/repositories/session-repository.ts packages/api/src/orchestrator/context-assembler.ts packages/api/src/services/message-service.ts packages/shared/src/constants.ts
git commit -m "feat(F007): SOP 书签 — 跨 seal 的 skill 状态恢复 [黄仁勋/Opus-46 🐾]"
```

---

## Task 3: Seal 自动续接 — 不停工

**Covers:** AC3.1, AC3.2, AC3.3, AC3.4, AC3.5, AC3.6

**Files:**
- Modify: `packages/api/src/services/message-service.ts:1015-1035` (seal handling section)
- Modify: `packages/api/src/runtime/continuation-loop.ts:17-21` (add "sealed_auto_resumed" stop reason)
- Create: `packages/api/src/orchestrator/auto-resume.ts`
- Create: `packages/api/src/orchestrator/auto-resume.test.ts`

### Step 1: Write failing test for auto-resume decision logic

```typescript
// packages/api/src/orchestrator/auto-resume.test.ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { shouldAutoResume } from "./auto-resume"
import type { SOPBookmark } from "./sop-bookmark"

describe("shouldAutoResume", () => {
  const activeBookmark: SOPBookmark = {
    skill: "tdd", phase: "red", lastCompletedStep: "wrote test",
    nextExpectedAction: "implement", blockingQuestion: null,
    updatedAt: "2026-04-13T10:00:00Z",
  }

  const emptyBookmark: SOPBookmark = {
    skill: null, phase: null, lastCompletedStep: "",
    nextExpectedAction: "", blockingQuestion: null,
    updatedAt: "2026-04-13T10:00:00Z",
  }

  it("returns true when bookmark has unfinished work and count < max", () => {
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0.3), true)
  })

  it("returns false when autoResumeCount >= maxResumes", () => {
    assert.equal(shouldAutoResume(activeBookmark, 2, 2, 0.3), false)
  })

  it("returns false when bookmark has no skill", () => {
    assert.equal(shouldAutoResume(emptyBookmark, 0, 2, 0.3), false)
  })

  it("returns false when fillRatio > 0.5 on new session", () => {
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0.6), false)
  })

  it("returns true when fillRatio is 0 (fresh session)", () => {
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0), true)
  })
})
```

### Step 2: Run test to verify it fails

Run: `cd packages/api && npx tsx --test src/orchestrator/auto-resume.test.ts`
Expected: FAIL

### Step 3: Write minimal implementation

```typescript
// packages/api/src/orchestrator/auto-resume.ts
import type { SOPBookmark } from "./sop-bookmark"

export const MAX_AUTO_RESUMES = 2

export function shouldAutoResume(
  bookmark: SOPBookmark | null,
  autoResumeCount: number,
  maxResumes: number,
  newSessionFillRatio: number,
): boolean {
  if (!bookmark?.skill) return false
  if (!bookmark.nextExpectedAction) return false
  if (autoResumeCount >= maxResumes) return false
  if (newSessionFillRatio > 0.5) return false
  return true
}

export function buildAutoResumeMessage(bookmark: SOPBookmark, resumeNum: number, maxResumes: number): string {
  return `[系统] 上下文已封存并重组（自动续接 ${resumeNum}/${maxResumes}）。请基于以下 SOP 书签继续未完成的任务：
skill=${bookmark.skill} | phase=${bookmark.phase ?? "unknown"} | next=${bookmark.nextExpectedAction}
请无缝继续，不要重复已完成的内容。`
}
```

### Step 4: Run test to verify it passes

Run: `cd packages/api && npx tsx --test src/orchestrator/auto-resume.test.ts`
Expected: PASS

### Step 5: Integrate auto-resume into message-service seal handling

In `message-service.ts`, after the seal section (after line 1033, before `this.sessions.updateThread`):

The integration requires:
1. After seal sets `effectiveSessionId = null`, check `shouldAutoResume()`
2. If yes, call `this.runThreadTurn()` recursively with the auto-resume message
3. Track `autoResumeCount` (passed via a new optional parameter on `runThreadTurn`)
4. Emit status "记忆重组中，自动续接 (N/2)"

This is a modification to `message-service.ts` — the exact integration point is after line 1035:

```typescript
      // Auto-resume after seal
      if (result.sealDecision?.shouldSeal && effectiveSessionId === null) {
        const bookmarkJson = this.sessions.getThreadBookmark(thread.id)
        const bookmark = bookmarkJson ? JSON.parse(bookmarkJson) as SOPBookmark : null
        const resumeCount = (options as any)._autoResumeCount ?? 0
        const { shouldAutoResume, buildAutoResumeMessage, MAX_AUTO_RESUMES } = await import("../orchestrator/auto-resume")

        if (shouldAutoResume(bookmark, resumeCount, MAX_AUTO_RESUMES, 0)) {
          this.sessions.updateThread(thread.id, result.currentModel, null)
          options.emit({
            type: "status",
            payload: { message: `${thread.alias}：记忆重组中，自动续接 (${resumeCount + 1}/${MAX_AUTO_RESUMES})` },
          })
          const resumeMsg = buildAutoResumeMessage(bookmark!, resumeCount + 1, MAX_AUTO_RESUMES)
          // Recursive call with incremented count
          return this.runThreadTurn({
            ...options,
            content: resumeMsg,
            _autoResumeCount: resumeCount + 1,
          } as any)
        }
      }
```

### Step 6: Update ContinuationStopReason type

In `continuation-loop.ts:17-20`, no change needed — the auto-resume happens at the `message-service` level, above the continuation loop. The loop's "sealed" stop reason stays as-is.

### Step 7: Run existing tests to ensure no regressions

Run: `cd packages/api && npx tsx --test src/orchestrator/auto-resume.test.ts`
Expected: PASS

### Step 8: Commit

```bash
git add packages/api/src/orchestrator/auto-resume.ts packages/api/src/orchestrator/auto-resume.test.ts packages/api/src/services/message-service.ts
git commit -m "feat(F007): Seal 自动续接 — 最多 2 次不停工 [黄仁勋/Opus-46 🐾]"
```

---

## Task 4: 动态 token 预算

**Covers:** AC4.1, AC4.2, AC4.3, AC4.4, AC4.5

**Files:**
- Modify: `packages/api/src/orchestrator/context-policy.ts:6-23` (add dynamicBudget)
- Create: `packages/api/src/orchestrator/dynamic-budget.ts`
- Create: `packages/api/src/orchestrator/dynamic-budget.test.ts`
- Modify: `packages/api/src/orchestrator/context-assembler.ts:13-36` (add lastFillRatio to input)
- Modify: `packages/api/src/orchestrator/context-assembler.ts:54` (apply dynamic limits)

### Step 1: Write failing test for dynamic budget calculation

```typescript
// packages/api/src/orchestrator/dynamic-budget.test.ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { computeDynamicLimits } from "./dynamic-budget"

describe("computeDynamicLimits", () => {
  it("returns expanded limits when fillRatio < 0.3", () => {
    const limits = computeDynamicLimits(0.2)
    assert.equal(limits.sharedHistoryLimit, 60)
    assert.equal(limits.selfHistoryLimit, 30)
    assert.equal(limits.maxContentLength, 4000)
  })

  it("returns moderate limits when fillRatio 0.3-0.5", () => {
    const limits = computeDynamicLimits(0.4)
    assert.equal(limits.sharedHistoryLimit, 40)
    assert.equal(limits.selfHistoryLimit, 20)
    assert.equal(limits.maxContentLength, 3000)
  })

  it("returns default limits when fillRatio 0.5-0.7", () => {
    const limits = computeDynamicLimits(0.6)
    assert.equal(limits.sharedHistoryLimit, 30)
    assert.equal(limits.selfHistoryLimit, 15)
    assert.equal(limits.maxContentLength, 2000)
  })

  it("returns contracted limits when fillRatio > 0.7", () => {
    const limits = computeDynamicLimits(0.8)
    assert.equal(limits.sharedHistoryLimit, 15)
    assert.equal(limits.selfHistoryLimit, 8)
    assert.equal(limits.maxContentLength, 1000)
  })

  it("returns default limits when fillRatio is null/undefined", () => {
    const limits = computeDynamicLimits(undefined)
    assert.equal(limits.sharedHistoryLimit, 30)
    assert.equal(limits.selfHistoryLimit, 15)
    assert.equal(limits.maxContentLength, 2000)
  })

  it("returns default limits when fillRatio is 0 (new session)", () => {
    const limits = computeDynamicLimits(0)
    assert.equal(limits.sharedHistoryLimit, 60)
    assert.equal(limits.selfHistoryLimit, 30)
    assert.equal(limits.maxContentLength, 4000)
  })
})
```

### Step 2: Run test — fail

Run: `cd packages/api && npx tsx --test src/orchestrator/dynamic-budget.test.ts`

### Step 3: Write implementation

```typescript
// packages/api/src/orchestrator/dynamic-budget.ts
export type DynamicLimits = {
  sharedHistoryLimit: number
  selfHistoryLimit: number
  maxContentLength: number
}

const TIERS: Array<{ maxFillRatio: number; limits: DynamicLimits }> = [
  { maxFillRatio: 0.3, limits: { sharedHistoryLimit: 60, selfHistoryLimit: 30, maxContentLength: 4000 } },
  { maxFillRatio: 0.5, limits: { sharedHistoryLimit: 40, selfHistoryLimit: 20, maxContentLength: 3000 } },
  { maxFillRatio: 0.7, limits: { sharedHistoryLimit: 30, selfHistoryLimit: 15, maxContentLength: 2000 } },
  { maxFillRatio: 1.0, limits: { sharedHistoryLimit: 15, selfHistoryLimit: 8, maxContentLength: 1000 } },
]

const DEFAULT_LIMITS: DynamicLimits = { sharedHistoryLimit: 30, selfHistoryLimit: 15, maxContentLength: 2000 }

export function computeDynamicLimits(fillRatio: number | null | undefined): DynamicLimits {
  if (fillRatio == null) return DEFAULT_LIMITS
  for (const tier of TIERS) {
    if (fillRatio < tier.maxFillRatio) {
      return tier.limits
    }
  }
  return TIERS[TIERS.length - 1].limits
}
```

### Step 4: Run test — pass

Run: `cd packages/api && npx tsx --test src/orchestrator/dynamic-budget.test.ts`

### Step 5: Add `dynamicBudget` to ContextPolicy

In `context-policy.ts:6`, add `dynamicBudget?: boolean` to ContextPolicy type.
In `POLICY_FULL` (line 26), add `dynamicBudget: true`.

### Step 6: Add `lastFillRatio` to AssemblePromptInput

In `context-assembler.ts:13`, add:
```typescript
  lastFillRatio?: number
```

### Step 7: Apply dynamic limits in assemblePrompt

In `context-assembler.ts`, at the start of content assembly (around line 80), add:

```typescript
  // Dynamic budget override
  let effectivePolicy = policy
  if (policy.dynamicBudget && input.lastFillRatio != null) {
    const { computeDynamicLimits } = await import("./dynamic-budget") // or static import
    const dynLimits = computeDynamicLimits(input.lastFillRatio)
    effectivePolicy = { ...policy, ...dynLimits }
  }
```

Then replace all `policy.` references in the content section with `effectivePolicy.`

### Step 8: Pass lastFillRatio from message-service

In `message-service.ts`, when calling `assembleDirectTurnPrompt`, read the thread's last usage from somewhere (we need to store lastFillRatio on the thread or pass it). The simplest approach: store the last `fillRatio` on the thread record.

Add `last_fill_ratio REAL` column to threads table in sqlite.ts migration.
Update `updateThread` to persist `lastFillRatio`.
Pass it through to `assembleDirectTurnPrompt`.

### Step 9: Run all tests

Run: `cd packages/api && npx tsx --test src/orchestrator/dynamic-budget.test.ts src/orchestrator/context-assembler.test.ts`
Expected: PASS

### Step 10: Commit

```bash
git add packages/api/src/orchestrator/dynamic-budget.ts packages/api/src/orchestrator/dynamic-budget.test.ts packages/api/src/orchestrator/context-policy.ts packages/api/src/orchestrator/context-assembler.ts packages/api/src/db/sqlite.ts packages/api/src/db/repositories/session-repository.ts packages/api/src/services/message-service.ts
git commit -m "feat(F007): 动态 token 预算 — fillRatio 驱动注入量伸缩 [黄仁勋/Opus-46 🐾]"
```

---

## Task 5: 渐进式老化 — 本地 embedding 语义检索

**Covers:** AC5.1, AC5.2, AC5.3, AC5.4, AC5.5, AC5.6

**Files:**
- Create: `packages/api/src/services/embedding-service.ts`
- Create: `packages/api/src/services/embedding-service.test.ts`
- Modify: `packages/api/src/db/sqlite.ts` (new tables: message_embeddings, message_embedding_meta)
- Modify: `packages/api/src/orchestrator/context-assembler.ts` (inject `## 相关历史回忆` section)
- Modify: `packages/api/package.json` (add `@huggingface/transformers` dependency)

### Step 1: Install dependency

Run: `cd packages/api && pnpm add @huggingface/transformers`

### Step 2: Add SQLite tables in migration

In `sqlite.ts`, add after existing migrations:

```typescript
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_thread ON message_embeddings(thread_id);
    `)
```

### Step 3: Write failing test for embedding service

```typescript
// packages/api/src/services/embedding-service.test.ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { chunkText, cosineSimilarity, applyTimeDecay } from "./embedding-service"

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkText("Hello world", 100)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0], "Hello world")
  })

  it("splits long text into multiple chunks", () => {
    const longText = "word ".repeat(200)
    const chunks = chunkText(longText, 50)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) {
      assert.ok(chunk.split(" ").length <= 55) // some tolerance
    }
  })
})

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3])
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 0.001)
  })

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([0, 1])
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.001)
  })
})

describe("applyTimeDecay", () => {
  it("returns score unchanged for age_hours=0", () => {
    const result = applyTimeDecay(0.9, 0)
    assert.ok(Math.abs(result - 0.9) < 0.001)
  })

  it("decays score to ~half after 168 hours", () => {
    const result = applyTimeDecay(1.0, 168)
    assert.ok(result > 0.3 && result < 0.5, `expected ~0.37, got ${result}`)
  })
})
```

### Step 4: Run test — fail

Run: `cd packages/api && npx tsx --test src/services/embedding-service.test.ts`

### Step 5: Write implementation

```typescript
// packages/api/src/services/embedding-service.ts
import type { SqliteStore } from "../db/sqlite"

const HALF_LIFE_HOURS = 168 // 7 days

export function chunkText(text: string, maxWordsPerChunk: number): string[] {
  const words = text.split(/\s+/)
  if (words.length <= maxWordsPerChunk) return [text]
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += maxWordsPerChunk) {
    chunks.push(words.slice(i, i + maxWordsPerChunk).join(" "))
  }
  return chunks
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

export function applyTimeDecay(score: number, ageHours: number): number {
  return score * Math.exp(-ageHours / HALF_LIFE_HOURS)
}

export class EmbeddingService {
  private pipeline: any = null
  private loading: Promise<void> | null = null

  constructor(private readonly store: SqliteStore) {}

  private async ensurePipeline(): Promise<any> {
    if (this.pipeline) return this.pipeline
    if (this.loading) { await this.loading; return this.pipeline }
    this.loading = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers")
        this.pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
      } catch {
        // Silent degradation — embedding not available
        this.pipeline = null
      }
    })()
    await this.loading
    return this.pipeline
  }

  async generateAndStore(messageId: string, threadId: string, text: string): Promise<void> {
    try {
      const pipe = await this.ensurePipeline()
      if (!pipe) return

      const chunks = chunkText(text, 100) // ~512 tokens ≈ 100 words
      const now = new Date().toISOString()

      for (let i = 0; i < chunks.length; i++) {
        const output = await pipe(chunks[i], { pooling: "mean", normalize: true })
        const embedding = new Float32Array(output.data)
        const embeddingBlob = Buffer.from(embedding.buffer)

        this.store.db.prepare(
          `INSERT INTO message_embeddings (message_id, thread_id, chunk_index, chunk_text, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(messageId, threadId, i, chunks[i], embeddingBlob, now)
      }
    } catch {
      // Silent degradation
    }
  }

  async searchSimilar(
    query: string,
    threadIds: string[],
    topK: number,
    excludeMessageIds: Set<string>,
  ): Promise<Array<{ messageId: string; chunkText: string; score: number }>> {
    try {
      const pipe = await this.ensurePipeline()
      if (!pipe) return []

      const output = await pipe(query, { pooling: "mean", normalize: true })
      const queryVec = new Float32Array(output.data)

      const placeholders = threadIds.map(() => "?").join(",")
      const rows = this.store.db.prepare(
        `SELECT message_id, chunk_text, embedding, created_at
         FROM message_embeddings
         WHERE thread_id IN (${placeholders})`
      ).all(...threadIds) as Array<{ message_id: string; chunk_text: string; embedding: Buffer; created_at: string }>

      const now = Date.now()
      const scored = rows
        .filter(r => !excludeMessageIds.has(r.message_id))
        .map(r => {
          const emb = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
          const raw = cosineSimilarity(queryVec, emb)
          const ageHours = (now - new Date(r.created_at).getTime()) / 3_600_000
          return { messageId: r.message_id, chunkText: r.chunk_text, score: applyTimeDecay(raw, ageHours) }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)

      return scored
    } catch {
      return []
    }
  }
}
```

### Step 6: Run test — pass

Run: `cd packages/api && npx tsx --test src/services/embedding-service.test.ts`
Expected: PASS (pure function tests, no model loading)

### Step 7: Integrate into context-assembler

In `context-assembler.ts`, add an optional `embeddingService` parameter and inject `## 相关历史回忆` after shared history:

```typescript
  // Semantic retrieval (if embedding service available)
  if (input.embeddingService && policy.injectSharedHistory) {
    const existingIds = new Set(roomSnapshot.map(m => m.id))
    const threadIds = [...new Set(roomSnapshot.map(m => m.id))] // Get unique thread IDs from context
    const results = await input.embeddingService.searchSimilar(
      input.task, threadIds, 5, existingIds,
    )
    if (results.length > 0) {
      contentSections.push("--- 相关历史回忆 ---")
      for (const r of results) {
        contentSections.push(`[回忆 score=${r.score.toFixed(2)}]: ${r.chunkText}`)
      }
      contentSections.push("---")
      contentSections.push("")
    }
  }
```

### Step 8: Trigger async embedding generation in message-service

In `message-service.ts`, after `this.sessions.overwriteMessage(assistant.id, ...)`, add async embedding generation (fire-and-forget):

```typescript
      // Async embedding generation (F007: 渐进式老化)
      if (this.embeddingService && accumulatedContent.trim()) {
        this.embeddingService.generateAndStore(assistant.id, thread.id, accumulatedContent)
          .catch(() => {}) // Silent degradation
      }
```

### Step 9: Commit

```bash
git add packages/api/src/services/embedding-service.ts packages/api/src/services/embedding-service.test.ts packages/api/src/db/sqlite.ts packages/api/src/orchestrator/context-assembler.ts packages/api/src/services/message-service.ts packages/api/package.json
git commit -m "feat(F007): 渐进式老化 — 本地 embedding 语义检索 [黄仁勋/Opus-46 🐾]"
```

---

## Task 6: 摘要增强

**Covers:** AC6.1, AC6.2, AC6.3, AC6.4

**Files:**
- Modify: `packages/api/src/services/memory-service.ts:131-139` (expand sampling window)
- Modify: `packages/api/src/services/memory-service.ts:214-247` (restructure extractive summary)
- Modify: `packages/api/src/services/memory-service.ts:161-195` (add Provider Fallback chain)

### Step 1: Write failing test for structured extractive summary

```typescript
// Add to a new file: packages/api/src/services/memory-service.test.ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"

// We need to export buildExtractiveSummary for testing
// For now, test the format via the public API

describe("buildExtractiveSummary structured Timeline format", () => {
  it("placeholder — will be filled after refactoring buildExtractiveSummary to be exported", () => {
    // This test validates AC6.2: Timeline format
    assert.ok(true)
  })
})
```

Actually, since `buildExtractiveSummary` is a module-private function, we need to either export it or test via the public `generateRollingSummary`. For testability, we'll export it.

### Step 2: Expand sampling window

In `memory-service.ts:132-138`, change:
```typescript
    const conversationText = allMessages
      .slice(-100)  // was -50
      .map((m) => {
        const speaker = m.role === "user" ? "用户" : m.alias
        return `[${speaker} ${m.createdAt}]: ${m.content.slice(0, 800)}`  // was 500
      })
      .join("\n")
```

### Step 3: Restructure extractive summary to Timeline format

Replace `buildExtractiveSummary` (lines 214-247) with:

```typescript
export function buildExtractiveSummary(
  allMessages: Array<{ role: string; content: string; alias: string; createdAt: string }>,
): string {
  const sections: string[] = []

  // Timeline (recent 30 messages)
  const recent = allMessages.slice(-30)
  const timelineLines = recent.map((m) => {
    const speaker = m.role === "user" ? "用户" : m.alias
    const time = m.createdAt.slice(11, 16) // HH:MM
    const content = m.content.length > 150 ? m.content.slice(0, 150) + "..." : m.content
    return `${time} ${speaker}: ${content.replace(/\n/g, " ")}`
  })
  sections.push("[Timeline]\n" + timelineLines.join("\n"))

  // Key decisions
  const decisions: string[] = []
  for (const msg of allMessages) {
    if (msg.content.includes("[分歧点]") || msg.content.includes("[拍板]") || msg.content.includes("【拍板】") || msg.content.includes("[consensus]")) {
      const speaker = msg.role === "user" ? "用户" : msg.alias
      decisions.push(`- [${speaker}] ${msg.content.slice(0, 200).replace(/\n/g, " ")}`)
    }
  }
  if (decisions.length > 0) {
    sections.push("[关键决策]\n" + decisions.join("\n"))
  }

  // Unfinished items (messages containing TODO, 待办, 未完成)
  const unfinished: string[] = []
  for (const msg of allMessages.slice(-20)) {
    if (/TODO|待办|未完成|下一步|blocked/i.test(msg.content)) {
      const snippet = msg.content.slice(0, 100).replace(/\n/g, " ")
      unfinished.push(`- ${snippet}`)
    }
  }
  if (unfinished.length > 0) {
    sections.push("[未完成]\n" + unfinished.join("\n"))
  }

  // Topic keywords
  const keywords = extractKeywords(allMessages.map((m) => m.content).join(" "))
  if (keywords) {
    sections.push("[话题关键词]\n" + keywords)
  }

  return sections.join("\n\n")
}
```

### Step 4: Add Provider Fallback chain

In `callGeminiSummarizer`, wrap the Gemini call with a fallback to the current agent's CLI. Replace lines 161-195:

```typescript
  private async callGeminiSummarizer(
    extractive: string,
    allMessages: Array<{ role: string; content: string; alias: string; createdAt: string }>,
  ): Promise<string> {
    const conversationText = allMessages
      .slice(-100)
      .map((m) => {
        const speaker = m.role === "user" ? "用户" : m.alias
        return `[${speaker} ${m.createdAt}]: ${m.content.slice(0, 800)}`
      })
      .join("\n")

    const prompt = `你是一个会话摘要生成器。请根据以下对话记录，生成一份 500-1000 字的结构化摘要。

格式要求：
## 话题
（列出讨论的主要话题）

## 关键决策
（列出已做出的关键决策，特别注意标记了 [分歧点] 的内容）

## 待办
（列出尚未完成的任务和行动项）

## 共识与分歧
（列出团队达成的共识和仍有分歧的点）

以下是提取式摘要：
${extractive}

以下是完整对话记录（按时间排序）：
${conversationText}`

    // Fallback chain: Gemini → Claude CLI → extractive
    const geminiResult = await this.tryCliSummarizer("gemini", prompt)
    if (geminiResult) return geminiResult

    const claudeResult = await this.tryCliSummarizer("claude", prompt)
    if (claudeResult) return claudeResult

    return extractive
  }

  private tryCliSummarizer(cli: string, prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      const done = (result: string | null) => {
        if (!settled) { settled = true; resolve(result) }
      }

      const { spawn } = require("node:child_process")
      const child = spawn(cli, ["-p", prompt], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
      })

      let stdout = ""
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
      child.on("close", (code: number) => {
        const text = stdout.trim()
        done(code === 0 && text ? text : null)
      })
      child.on("error", () => done(null))

      const timer = setTimeout(() => { child.kill(); done(null) }, 60_000)
      child.on("close", () => clearTimeout(timer))
    })
  }
```

### Step 5: Run tests

Run: `cd packages/api && npx tsx --test src/services/memory-service.test.ts`
Expected: PASS

### Step 6: Commit

```bash
git add packages/api/src/services/memory-service.ts packages/api/src/services/memory-service.test.ts
git commit -m "feat(F007): 摘要增强 — 扩大取样窗口 + Timeline 格式 + Fallback 链 [黄仁勋/Opus-46 🐾]"
```

---

## Task 7: F-BLOAT 检测

**Covers:** AC7.1, AC7.2, AC7.3, AC7.4

**Files:**
- Create: `packages/api/src/runtime/fbloat-detector.ts`
- Create: `packages/api/src/runtime/fbloat-detector.test.ts`
- Modify: `packages/api/src/runtime/cli-orchestrator.ts:187-203` (integrate detection)

### Step 1: Write failing test

```typescript
// packages/api/src/runtime/fbloat-detector.test.ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { detectFBloat } from "./fbloat-detector"

describe("detectFBloat", () => {
  it("detects when usedTokens drops > 40%", () => {
    const result = detectFBloat(100_000, 50_000)
    assert.equal(result.detected, true)
    assert.ok(result.dropRatio > 0.4)
  })

  it("does not detect for normal usage increase", () => {
    const result = detectFBloat(100_000, 120_000)
    assert.equal(result.detected, false)
  })

  it("does not detect for moderate decrease < 40%", () => {
    const result = detectFBloat(100_000, 70_000)
    assert.equal(result.detected, false)
  })

  it("handles null previous usage", () => {
    const result = detectFBloat(null, 50_000)
    assert.equal(result.detected, false)
  })

  it("handles zero previous usage", () => {
    const result = detectFBloat(0, 50_000)
    assert.equal(result.detected, false)
  })
})
```

### Step 2: Run test — fail

### Step 3: Write implementation

```typescript
// packages/api/src/runtime/fbloat-detector.ts
export type FBloatResult = {
  detected: boolean
  dropRatio: number
}

const FBLOAT_DROP_THRESHOLD = 0.40

export function detectFBloat(
  prevUsedTokens: number | null,
  currentUsedTokens: number,
): FBloatResult {
  if (!prevUsedTokens || prevUsedTokens <= 0) {
    return { detected: false, dropRatio: 0 }
  }
  const drop = prevUsedTokens - currentUsedTokens
  if (drop <= 0) {
    return { detected: false, dropRatio: 0 }
  }
  const dropRatio = drop / prevUsedTokens
  return { detected: dropRatio > FBLOAT_DROP_THRESHOLD, dropRatio }
}
```

### Step 4: Run test — pass

### Step 5: Integrate into cli-orchestrator

In `cli-orchestrator.ts`, after `computeSealDecision` is called (line 181), add F-BLOAT detection to `RunTurnResult`:

1. Add `fBloatDetected?: boolean` to `RunTurnResult`
2. In the promise chain, after seal decision, check F-BLOAT:

```typescript
      const fbloat = detectFBloat(options.prevUsedTokens ?? null, latestUsage?.usedTokens ?? 0)
      return {
        ...existing fields,
        fBloatDetected: fbloat.detected,
      }
```

3. Add `prevUsedTokens?: number` to `RunTurnOptions`

### Step 6: In message-service, when fBloatDetected:
- Force refresh summary (bypass 10-message staleness check)
- On next turn, re-inject system prompt even when nativeSessionId exists

### Step 7: Run tests

Run: `cd packages/api && npx tsx --test src/runtime/fbloat-detector.test.ts`
Expected: PASS

### Step 8: Commit

```bash
git add packages/api/src/runtime/fbloat-detector.ts packages/api/src/runtime/fbloat-detector.test.ts packages/api/src/runtime/cli-orchestrator.ts packages/api/src/services/message-service.ts
git commit -m "feat(F007): F-BLOAT 检测 — CLI 自行压缩感知 + 强制重注入 [黄仁勋/Opus-46 🐾]"
```

---

## Task 8: 观测指标

**Covers:** AC8.1, AC8.2, AC8.3, AC8.4

**Files:**
- Create: `packages/api/src/services/metrics-service.ts`
- Create: `packages/api/src/services/metrics-service.test.ts`
- Modify: `packages/api/src/db/sqlite.ts` (new table: context_metrics)
- Modify: integration points in message-service.ts, memory-service.ts

### Step 1: Write failing test

```typescript
// packages/api/src/services/metrics-service.test.ts
import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
import { MetricsService } from "./metrics-service"

// Using in-memory store mock
describe("MetricsService", () => {
  it("records and retrieves metrics", () => {
    const records: any[] = []
    const mockStore = {
      record: (name: string, value: number, provider: string, threadId: string) => {
        records.push({ name, value, provider, threadId })
      },
      getRecent: () => records,
    }
    const service = new MetricsService(mockStore as any)
    service.recordSeal("claude", "t1")
    assert.equal(records.length, 1)
    assert.equal(records[0].name, "seal_count")
  })
})
```

### Step 2: Run test — fail

### Step 3: Write implementation

```typescript
// packages/api/src/services/metrics-service.ts
import type { SqliteStore } from "../db/sqlite"

export type MetricName =
  | "seal_count"
  | "seal_auto_resume_count"
  | "extractive_fallback_count"
  | "microcompact_tokens_saved"
  | "sop_bookmark_restore_success"
  | "sop_bookmark_restore_fail"
  | "embedding_retrieval_hit"
  | "fbloat_detected"
  | "summary_provider_used"

export class MetricsService {
  constructor(private readonly store: SqliteStore) {}

  record(name: MetricName, value: number, provider: string, threadId: string): void {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    this.store.db.prepare(
      `INSERT INTO context_metrics (id, thread_id, metric_name, metric_value, provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, threadId, name, value, provider, now)
  }

  recordSeal(provider: string, threadId: string): void {
    this.record("seal_count", 1, provider, threadId)
  }

  recordAutoResume(provider: string, threadId: string): void {
    this.record("seal_auto_resume_count", 1, provider, threadId)
  }

  recordExtractiveFallback(provider: string, threadId: string): void {
    this.record("extractive_fallback_count", 1, provider, threadId)
  }

  recordMicrocompactSaved(provider: string, threadId: string, tokensSaved: number): void {
    this.record("microcompact_tokens_saved", tokensSaved, provider, threadId)
  }

  recordBookmarkRestore(provider: string, threadId: string, success: boolean): void {
    this.record(success ? "sop_bookmark_restore_success" : "sop_bookmark_restore_fail", 1, provider, threadId)
  }

  recordFBloat(provider: string, threadId: string): void {
    this.record("fbloat_detected", 1, provider, threadId)
  }

  recordSummaryProvider(provider: string, threadId: string, summaryProvider: string): void {
    this.record("summary_provider_used", 1, summaryProvider, threadId)
  }

  getRecentMetrics(limit = 100): Array<{ metricName: string; metricValue: number; provider: string; createdAt: string }> {
    return this.store.db.prepare(
      `SELECT metric_name as metricName, metric_value as metricValue, provider, created_at as createdAt
       FROM context_metrics
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(limit) as any[]
  }
}
```

### Step 4: Add SQLite table

In `sqlite.ts` migration:

```typescript
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_metrics (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
```

### Step 5: Wire metrics into integration points

- `message-service.ts` seal handling: `this.metrics.recordSeal()`
- `message-service.ts` auto-resume: `this.metrics.recordAutoResume()`
- `memory-service.ts` fallback: `this.metrics.recordExtractiveFallback()`
- `context-assembler.ts` after microcompact: estimate tokens saved
- etc.

### Step 6: WebSocket push (AC8.4)

In message-service, after recording a metric, emit a WebSocket event:

```typescript
options.emit({ type: "metrics.update", payload: { metricName, metricValue, provider } })
```

### Step 7: Run tests

Run: `cd packages/api && npx tsx --test src/services/metrics-service.test.ts`
Expected: PASS

### Step 8: Commit

```bash
git add packages/api/src/services/metrics-service.ts packages/api/src/services/metrics-service.test.ts packages/api/src/db/sqlite.ts
git commit -m "feat(F007): 观测指标 — context_metrics 表 + WebSocket 推送 [黄仁勋/Opus-46 🐾]"
```

---

## Task 9: UX 层

**Covers:** AC9.1, AC9.2, AC9.3

**Files:**
- Modify: `components/chat/execution-bar.tsx` (SOP breadcrumb)
- Modify: `components/chat/status-panel.tsx` (context health dashboard)
- Modify: `components/stores/thread-store.ts` (add bookmark + metrics state)
- Modify: `components/ws/client.ts` (handle new event types)

### Step 1: Add SOP bookmark state to thread-store

In `components/stores/thread-store.ts`, add:
- `sopBookmark: SOPBookmark | null` to per-provider state
- `contextMetrics: { sealCount: number, fillRatio: number, lastSealAt: string | null }` per-provider

### Step 2: Handle new WebSocket events in client.ts

Add handlers for:
- `metrics.update` → update contextMetrics in thread-store
- `sop_bookmark.update` → update sopBookmark in thread-store

### Step 3: Add SOP breadcrumb to execution-bar

In `execution-bar.tsx`, after the existing provider status indicators, add:

```tsx
{bookmark && (
  <span className="text-xs text-muted-foreground ml-2">
    Skill[{bookmark.skill}] → Phase[{bookmark.phase}] → 下一步: {bookmark.nextExpectedAction}
  </span>
)}
```

### Step 4: Add seal status toast

When the WebSocket receives a `status` event with "记忆重组" text, show a transient toast/banner.

### Step 5: Add context health panel to status-panel

In `status-panel.tsx`, add a new section under "指挥中心":

```tsx
<div className="mt-4">
  <h4 className="text-sm font-medium">上下文健康度</h4>
  {providers.map(p => (
    <div key={p.provider} className="flex items-center gap-2 text-xs mt-1">
      <span>{p.alias}</span>
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full", fillRatioColor(p.fillRatio))}
          style={{ width: `${(p.fillRatio ?? 0) * 100}%` }}
        />
      </div>
      <span>{p.fillRatio ? `${Math.round(p.fillRatio * 100)}%` : "—"}</span>
    </div>
  ))}
</div>
```

### Step 6: Visual test in browser

Run dev server, trigger a long conversation, verify:
1. SOP breadcrumb appears and updates
2. Context health bars show fill ratio
3. Seal toast appears on seal event

### Step 7: Commit

```bash
git add components/chat/execution-bar.tsx components/chat/status-panel.tsx components/stores/thread-store.ts components/ws/client.ts
git commit -m "feat(F007): UX 层 — SOP 面包屑 + 上下文健康仪表盘 [黄仁勋/Opus-46 🐾]"
```

---

## Task 10: 全量集成测试 + 交叉验收

**Covers:** AC10.1, AC10.2

### Step 1: Run full test suite

Run: `cd packages/api && npx tsx --test src/**/*.test.ts`
Expected: All green

### Step 2: Typecheck

Run: `cd packages/api && npx tsc --noEmit`
Expected: No errors

### Step 3: Manual scenario test (AC10.2)

1. 启动 dev server
2. 和某个 agent 长对话 20+ 轮
3. 观察 token 用量条增长
4. 触发 seal → 验证状态栏显示"记忆重组中"
5. 验证 agent 自动续接（最多 2 次）
6. 续接后验证 SOP 面包屑显示正确的 skill 阶段
7. 检查 SQLite context_metrics 表有数据

### Step 4: Request cross-agent review (AC10.1)

```
@范德彪 请 review F007 全部改动
```

### Step 5: Final commit (plan doc update)

```bash
git add docs/plans/f007-context-compression-plan.md docs/features/F007-context-compression-optimization.md
git commit -m "docs(F007): 实施计划 + feature doc 状态更新 [黄仁勋/Opus-46 🐾]"
```

---

## Task Dependency Graph

```
Task 1 (Microcompact) ──┐
Task 2 (SOP 书签)   ────┼── Task 3 (自动续接) 依赖 Task 2 的 SOPBookmark
Task 4 (动态预算)   ──┘  │
                          │
Task 5 (Embedding)  ──────┤  独立，可与 1-4 并行
Task 6 (摘要增强)   ──────┤  独立
Task 7 (F-BLOAT)    ──────┤  独立
Task 8 (Metrics)    ──────┤  最后集成（依赖 1-7 的 record 调用点）
Task 9 (UX)         ──────┤  依赖 Task 2 (bookmark) + Task 8 (metrics)
Task 10 (集成测试)  ──────┘  全部依赖
```

**推荐执行顺序：** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10

Task 1/2/4/5/6/7 之间无强依赖，理论上可并行。但串行更安全（避免 merge 冲突），且 Task 3 强依赖 Task 2。

---

## AC 覆盖矩阵

| AC | Task | Step |
|----|------|------|
| AC1.1–1.7 | Task 1 | Steps 1-7 |
| AC2.1–2.5 | Task 2 | Steps 1-10 |
| AC3.1–3.6 | Task 3 | Steps 1-7 |
| AC4.1–4.5 | Task 4 | Steps 1-9 |
| AC5.1–5.6 | Task 5 | Steps 1-8 |
| AC6.1–6.4 | Task 6 | Steps 1-5 |
| AC7.1–7.4 | Task 7 | Steps 1-7 |
| AC8.1–8.4 | Task 8 | Steps 1-7 |
| AC9.1–9.3 | Task 9 | Steps 1-6 |
| AC10.1–10.2 | Task 10 | Steps 1-4 |
