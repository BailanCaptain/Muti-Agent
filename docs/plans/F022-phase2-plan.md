# F022 Phase 2 Implementation Plan — Haiku 自动命名

**Feature:** F022 — `docs/features/F022-left-sidebar-redesign.md`
**Goal:** 新 session 在首条 user + 首条 assistant final message 后 ~2.5s 自动调用 claude-haiku-4-5 生成 ≤10 字 title；失败/超时回退到日期格式；已命名的 session 不重复命名；全链路结构化日志可定位。
**Phase 1 Status:** ✅ commit `0f41f1d` (AC-01~04)

## Acceptance Criteria (Phase 2)

- [ ] **AC-05** 触发时机：首条 user + 首条 assistant final 之后，等 2-3 秒
- [ ] **AC-06** 调用 Haiku（claude-haiku-4-5）总结 session，生成简短 title（≤ 10 字，产品拍板 2026-04-20 从 20 字下调）
- [ ] **AC-07** 命名结果写入 `session_groups.title`，替换默认格式
- [ ] **AC-08** Haiku 失败/超时回退到日期格式 `新会话 YYYY-MM-DD`，不阻塞
- [ ] **AC-09** 命名过程异步，不阻塞用户输入
- [ ] **AC-10** 已命名过的 session 不重复命名（除非用户手动重置）

## Architecture

- **触发层**：API 层。在 message 持久化入口（message-service / append caller）拦截 `role=assistant && messageType=final`，按 `sessionGroupId` 调 `SessionTitler.schedule()`。
- **Debounce 与幂等**：`SessionTitler` 内部 per-sessionGroupId 计时器（~2500ms），触发时读当前 title → `isDefaultTitle(title)` 才继续；非默认格式直接短路（AC-10）。
- **Haiku 调用**：`HaikuRunner.runPrompt(prompt, { timeoutMs: 5000 })`，内部 spawn `claude --print --model claude-haiku-4-5 "{prompt}"`（复用 `resolveClaudeCommand()`），stdout 作 title 原文，trim + 截断到 20 字。
- **失败回退（AC-08）**：非零退出 / 超时 / 空输出 → 写 `新会话 {YYYY-MM-DD}`（日期格式，AC-08）。
- **日志**：`createLogger("session-titler")` pino child，字段 `{ sessionGroupId, roomId, event, durationMs, error?, titleGenerated? }`，五种 event：`schedule` / `haiku.call` / `success` / `fallback` / `skip.idempotent`。

## Tech Stack

- 运行时：`node:child_process.spawn`（复用 `resolveClaudeCommand()`）
- 测试：`node:test` + `node:assert/strict`；Haiku 注入 spawn stub
- DB：drizzle-orm（已有）
- 日志：pino（`packages/api/src/lib/logger.ts`）

---

### Terminal Schema (终态接口定义)

```typescript
// packages/api/src/services/session-titler/default-title.ts
export function isDefaultTitle(title: string): boolean
// 识别两种默认模式：
//   "新会话 YYYY-MM-DD HH:mm:ss" (当前)
//   "YYYY-MM-DD · 未命名"       (spec 遗留，容错)
//   "新会话 YYYY-MM-DD"          (AC-08 回退格式)
// 其他（含用户手改）→ false

// packages/api/src/runtime/haiku-runner.ts
export interface HaikuRunResult {
  ok: boolean
  text: string           // trimmed stdout (ok=true) 或 ""（失败）
  durationMs: number
  error?: string         // 失败原因：timeout / exit-code-N / spawn-error / empty-output
}
export interface HaikuRunner {
  runPrompt(prompt: string, opts?: { timeoutMs?: number }): Promise<HaikuRunResult>
}

// packages/api/src/services/session-titler/session-titler.ts
export interface SessionTitlerDeps {
  repo: { getSessionGroup: (id: string) => { title: string; roomId: string } | undefined
          updateSessionGroupTitle: (id: string, title: string) => void }
  haiku: HaikuRunner
  logger: FastifyBaseLogger
  debounceMs?: number   // default 2500
  timeoutMs?: number    // default 5000
  buildPrompt: (sessionGroupId: string) => string    // 读 recent messages
  dateFormatter?: () => string                       // default new Date().toISOString().slice(0,10)
}
export class SessionTitler {
  schedule(sessionGroupId: string): void
  // 测试 hook：
  flushPending(): Promise<void>
}

// session-repository-drizzle.ts 新增
updateSessionGroupTitle(groupId: string, title: string): void
getSessionGroup(groupId: string): { id; title; roomId; projectTag; createdAt; updatedAt } | undefined
```

---

### Task 1: `isDefaultTitle` util

**Files:**
- Create: `packages/api/src/services/session-titler/default-title.ts`
- Test: `packages/api/src/services/session-titler/default-title.test.ts`

**Step 1 — Write failing test:**

```typescript
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isDefaultTitle } from "./default-title"

describe("isDefaultTitle", () => {
  it("matches '新会话 YYYY-MM-DD HH:mm:ss' (Phase 1 default)", () => {
    assert.equal(isDefaultTitle("新会话 2026-04-20 14:30:00"), true)
  })
  it("matches '新会话 YYYY-MM-DD' (AC-08 fallback)", () => {
    assert.equal(isDefaultTitle("新会话 2026-04-20"), true)
  })
  it("matches 'YYYY-MM-DD · 未命名' (spec legacy)", () => {
    assert.equal(isDefaultTitle("2026-04-20 · 未命名"), true)
  })
  it("rejects user-edited titles", () => {
    assert.equal(isDefaultTitle("F022 讨论"), false)
  })
  it("rejects Haiku-generated titles", () => {
    assert.equal(isDefaultTitle("修 B017 session id 污染"), false)
  })
  it("rejects empty / null-ish", () => {
    assert.equal(isDefaultTitle(""), false)
    assert.equal(isDefaultTitle("   "), false)
  })
})
```

**Step 2 — Run:** `cd C:/Users/-/Desktop/multi-agent-f022-phase1 && pnpm --filter @multi-agent/api exec tsx --test packages/api/src/services/session-titler/default-title.test.ts`
**Expected:** FAIL `Cannot find module './default-title'`.

**Step 3 — Minimal implementation:**

```typescript
const PATTERNS: RegExp[] = [
  /^新会话 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  /^新会话 \d{4}-\d{2}-\d{2}$/,
  /^\d{4}-\d{2}-\d{2} · 未命名$/,
]
export function isDefaultTitle(title: string): boolean {
  const t = (title ?? "").trim()
  if (!t) return false
  return PATTERNS.some((re) => re.test(t))
}
```

**Step 4 — Run:** same command. **Expected:** PASS (6 tests).

**Step 5 — Commit:**
```bash
git add packages/api/src/services/session-titler/default-title.ts packages/api/src/services/session-titler/default-title.test.ts
git commit -m "feat(F022-P2): isDefaultTitle util — 识别 3 种默认/未命名 title 模式"
```

---

### Task 2: Repo — `updateSessionGroupTitle` + `getSessionGroup`

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository-drizzle.ts` (new methods next to `updateSessionGroupProjectTag` at line 173)
- Modify: `packages/api/src/db/repositories/session-repository-drizzle.test.ts`

**Step 1 — Write failing tests:**

```typescript
test("updateSessionGroupTitle writes and persists title", async () => {
  // Arrange: createSessionGroupWithDefaults → read default title (matches isDefaultTitle)
  // Act: repo.updateSessionGroupTitle(id, "学习 Drizzle ORM")
  // Assert: repo.getSessionGroup(id).title === "学习 Drizzle ORM"
})

test("getSessionGroup returns undefined for unknown id", () => {
  assert.equal(repo.getSessionGroup("no-such-id"), undefined)
})

test("updateSessionGroupTitle bumps updatedAt", async () => {
  // Assert: after update, updatedAt >= pre-update timestamp
})
```

**Step 2 — Run:** `pnpm --filter @multi-agent/api exec tsx --test packages/api/src/db/repositories/session-repository-drizzle.test.ts`
**Expected:** FAIL.

**Step 3 — Implementation (insert after line 179):**

```typescript
updateSessionGroupTitle(groupId: string, title: string) {
  const now = new Date().toISOString()
  this.db
    .update(sessionGroups)
    .set({ title, updatedAt: now })
    .where(eq(sessionGroups.id, groupId))
    .run()
}

getSessionGroup(groupId: string) {
  const rows = this.db
    .select()
    .from(sessionGroups)
    .where(eq(sessionGroups.id, groupId))
    .limit(1)
    .all()
  return rows[0]
}
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:**
```bash
git add packages/api/src/db/repositories/session-repository-drizzle.ts packages/api/src/db/repositories/session-repository-drizzle.test.ts
git commit -m "feat(F022-P2): repo 增补 updateSessionGroupTitle + getSessionGroup"
```

---

### Task 3: `HaikuRunner` (CLI headless 单轮 + 5s 超时 + 结构化日志)

**Files:**
- Create: `packages/api/src/runtime/haiku-runner.ts`
- Test: `packages/api/src/runtime/haiku-runner.test.ts`

**Step 1 — Failing tests:**

```typescript
import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createHaikuRunner } from "./haiku-runner"

function fakeSpawn(result: { code: number; stdout: string; delayMs?: number }) {
  return () => {
    const proc: any = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = mock.fn()
    setTimeout(() => {
      proc.stdout.emit("data", Buffer.from(result.stdout))
      proc.emit("close", result.code)
    }, result.delayMs ?? 1)
    return proc
  }
}

describe("HaikuRunner", () => {
  it("returns ok=true with trimmed stdout on exit 0", async () => {
    const r = createHaikuRunner({ spawn: fakeSpawn({ code: 0, stdout: "  学习 Drizzle\n" }) })
    const res = await r.runPrompt("summarize this")
    assert.equal(res.ok, true)
    assert.equal(res.text, "学习 Drizzle")
    assert.ok(res.durationMs >= 0)
  })

  it("returns ok=false on non-zero exit", async () => {
    const r = createHaikuRunner({ spawn: fakeSpawn({ code: 2, stdout: "" }) })
    const res = await r.runPrompt("x")
    assert.equal(res.ok, false)
    assert.match(res.error!, /exit-code-2/)
  })

  it("kills process and returns error=timeout after timeoutMs", async () => {
    const spawn = fakeSpawn({ code: 0, stdout: "late", delayMs: 200 })
    const r = createHaikuRunner({ spawn })
    const res = await r.runPrompt("x", { timeoutMs: 50 })
    assert.equal(res.ok, false)
    assert.equal(res.error, "timeout")
  })

  it("returns empty-output error when stdout is blank", async () => {
    const r = createHaikuRunner({ spawn: fakeSpawn({ code: 0, stdout: "   " }) })
    const res = await r.runPrompt("x")
    assert.equal(res.ok, false)
    assert.equal(res.error, "empty-output")
  })
})
```

**Step 2 — Run:** FAIL.

**Step 3 — Implementation:**

```typescript
import type { ChildProcess } from "node:child_process"
import { spawn as realSpawn } from "node:child_process"
import { resolveClaudeCommand } from "./claude-runtime-util"  // 抽 claude-runtime.ts 里 resolveClaudeCommand

export interface HaikuRunResult {
  ok: boolean
  text: string
  durationMs: number
  error?: string
}

export interface HaikuRunner {
  runPrompt(prompt: string, opts?: { timeoutMs?: number }): Promise<HaikuRunResult>
}

type SpawnFn = (...args: Parameters<typeof realSpawn>) => ChildProcess

export function createHaikuRunner(deps: { spawn?: SpawnFn } = {}): HaikuRunner {
  const spawn = deps.spawn ?? realSpawn
  return {
    async runPrompt(prompt, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 5000
      const runtime = resolveClaudeCommand()
      const args = [...runtime.prefixArgs, "--print", "--model", "claude-haiku-4-5", prompt]
      const start = Date.now()
      const proc = spawn(runtime.command, args, { shell: runtime.shell })
      let stdout = ""
      proc.stdout?.on("data", (c) => { stdout += c.toString() })
      return new Promise<HaikuRunResult>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill()
          resolve({ ok: false, text: "", durationMs: Date.now() - start, error: "timeout" })
        }, timeoutMs)
        proc.on("close", (code) => {
          clearTimeout(timer)
          const text = stdout.trim()
          const durationMs = Date.now() - start
          if (code !== 0) return resolve({ ok: false, text: "", durationMs, error: `exit-code-${code}` })
          if (!text) return resolve({ ok: false, text: "", durationMs, error: "empty-output" })
          resolve({ ok: true, text, durationMs })
        })
        proc.on("error", (err) => {
          clearTimeout(timer)
          resolve({ ok: false, text: "", durationMs: Date.now() - start, error: `spawn-error:${err.message}` })
        })
      })
    },
  }
}
```

**注**：Step 3 额外子步骤 —— 从 `claude-runtime.ts` 抽 `resolveClaudeCommand` 到 `claude-runtime-util.ts`（纯 export move，不改逻辑），供 `claude-runtime.ts` 和 `haiku-runner.ts` 共享。

**Step 4 — Run:** PASS（4 tests）。

**Step 5 — Commit:**
```bash
git add packages/api/src/runtime/haiku-runner.ts packages/api/src/runtime/haiku-runner.test.ts packages/api/src/runtime/claude-runtime-util.ts packages/api/src/runtime/claude-runtime.ts
git commit -m "feat(F022-P2): HaikuRunner — claude --print --model claude-haiku-4-5 单轮 + 5s 超时"
```

---

### Task 4: `SessionTitler` service (debounce + 幂等 + 回退 + 日志)

**Files:**
- Create: `packages/api/src/services/session-titler/session-titler.ts`
- Test: `packages/api/src/services/session-titler/session-titler.test.ts`

**Step 1 — Failing tests（覆盖 AC-05/07/08/09/10）:**

```typescript
describe("SessionTitler", () => {
  it("AC-05: debounces multiple schedule() calls to a single Haiku call", async () => {
    // Arrange: mock haiku ok -> "学习 TDD"
    // Act: titler.schedule(sid) * 3 within 100ms; wait debounceMs+50
    // Assert: haiku.runPrompt called once
  })

  it("AC-07: writes Haiku result to session_groups.title on success", async () => {
    // Assert: repo.updateSessionGroupTitle called with (sid, "学习 TDD")
    // Assert: logger received event="success" with { sessionGroupId, roomId, titleGenerated, durationMs }
  })

  it("AC-06: truncates Haiku output to 10 chars", async () => {
    // Arrange: haiku returns "这是一个会被截断的超长标题"
    // Assert: updateSessionGroupTitle called with title.length <= 10
  })

  it("AC-08: falls back to '新会话 YYYY-MM-DD' on haiku failure", async () => {
    // Arrange: haiku ok=false error=timeout
    // Assert: updateSessionGroupTitle called with "新会话 2026-04-20" (via injected dateFormatter)
    // Assert: logger received event="fallback" with { error: "timeout" }
  })

  it("AC-10: skips when current title is NOT default", async () => {
    // Arrange: getSessionGroup returns { title: "用户改过的标题" }
    // Assert: haiku.runPrompt NOT called
    // Assert: updateSessionGroupTitle NOT called
    // Assert: logger received event="skip.idempotent"
  })

  it("AC-10: also skips when session already has Haiku-generated title", async () => {
    // getSessionGroup returns { title: "学习 Drizzle" } → skip
  })

  it("AC-09: schedule() is non-blocking (returns sync void)", () => {
    assert.equal(titler.schedule("sid"), undefined)
    // Act: immediately check no repo calls yet
  })

  it("logs event=haiku.call when invoking runner", async () => { /* ... */ })
  it("logs event=schedule on each schedule() call", () => { /* ... */ })
})
```

**Step 2 — Run:** FAIL.

**Step 3 — Implementation:**

```typescript
import type { FastifyBaseLogger } from "fastify"
import type { HaikuRunner } from "../../runtime/haiku-runner"
import { isDefaultTitle } from "./default-title"

export interface SessionTitlerDeps {
  repo: {
    getSessionGroup: (id: string) => { title: string; roomId: string | null } | undefined
    updateSessionGroupTitle: (id: string, title: string) => void
    listRecentMessagesForTitling?: (sessionGroupId: string, limit: number) => Array<{ role: string; content: string }>
  }
  haiku: HaikuRunner
  logger: FastifyBaseLogger
  debounceMs?: number
  timeoutMs?: number
  dateFormatter?: () => string
  buildPrompt?: (sessionGroupId: string) => string
  clock?: () => number
}

const MAX_TITLE_CHARS = 10
const DEFAULT_DEBOUNCE_MS = 2500
const DEFAULT_TIMEOUT_MS = 5000

export class SessionTitler {
  private timers = new Map<string, NodeJS.Timeout>()
  private pending: Promise<void>[] = []
  constructor(private readonly deps: SessionTitlerDeps) {}

  schedule(sessionGroupId: string): void {
    const log = this.deps.logger
    const existing = this.timers.get(sessionGroupId)
    if (existing) clearTimeout(existing)
    log.info({ event: "schedule", sessionGroupId }, "session-titler scheduled")
    const timer = setTimeout(() => {
      this.timers.delete(sessionGroupId)
      const p = this.run(sessionGroupId).catch((err) =>
        log.error({ event: "error", sessionGroupId, error: String(err) }, "session-titler unexpected error"),
      )
      this.pending.push(p)
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.timers.set(sessionGroupId, timer)
  }

  async flushPending(): Promise<void> {
    while (this.pending.length > 0) {
      const [p] = this.pending.splice(0, 1)
      await p
    }
  }

  private async run(sessionGroupId: string): Promise<void> {
    const { repo, haiku, logger, dateFormatter, buildPrompt, timeoutMs } = this.deps
    const row = repo.getSessionGroup(sessionGroupId)
    if (!row) return
    const roomId = row.roomId
    if (!isDefaultTitle(row.title)) {
      logger.info({ event: "skip.idempotent", sessionGroupId, roomId, currentTitle: row.title }, "already titled")
      return
    }
    const prompt = (buildPrompt ?? defaultBuildPrompt)(sessionGroupId)
    logger.info({ event: "haiku.call", sessionGroupId, roomId }, "calling haiku")
    const result = await haiku.runPrompt(prompt, { timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS })
    if (result.ok) {
      const title = result.text.slice(0, MAX_TITLE_CHARS)
      repo.updateSessionGroupTitle(sessionGroupId, title)
      logger.info(
        { event: "success", sessionGroupId, roomId, titleGenerated: title, durationMs: result.durationMs },
        "session-titler success",
      )
    } else {
      const fallback = `新会话 ${(dateFormatter ?? defaultDate)()}`
      repo.updateSessionGroupTitle(sessionGroupId, fallback)
      logger.warn(
        { event: "fallback", sessionGroupId, roomId, error: result.error, durationMs: result.durationMs, titleGenerated: fallback },
        "session-titler fallback",
      )
    }
  }
}

function defaultDate(): string { return new Date().toISOString().slice(0, 10) }
function defaultBuildPrompt(sessionGroupId: string): string {
  // Task 4 最小实现占位；Task 5 之前补真实 prompt（读近 N 条消息）
  return "用 10 字以内中文总结本会话主题，只返回标题本身，无标点、无前缀。"
}
```

**Step 4 — Run:** PASS（~9 tests）。

**Step 5 — Commit:**
```bash
git add packages/api/src/services/session-titler/session-titler.ts packages/api/src/services/session-titler/session-titler.test.ts
git commit -m "feat(F022-P2): SessionTitler — debounce + 幂等 + Haiku 调用 + 失败回退 + 结构化日志"
```

---

### Task 5: Hook 点 — message 写入时触发 SessionTitler

**Files:**
- Recon first: `packages/api/src/services/message-service.ts`（找 assistant final append 调用）
- Modify: 最靠近消息持久化且持有 DI container 的层（倾向 `message-service.ts`）
- Modify: `packages/api/src/server.ts`（在 server 启动时构造 `SessionTitler` 单例 + 注入）
- Test: `session-titler.hook.test.ts` 或扩展 `message-service.test.ts`

**Step 1 — Read message-service.ts，锁定 hook 点**（2 min）:
- 找所有 `appendMessage(..., "assistant", ..., "final", ...)` 写入路径
- 拿到 `sessionGroupId` 的路径（通过 thread.sessionGroupId）

**Step 2 — Failing test:**

```typescript
it("triggers SessionTitler.schedule on every assistant final message in a session", async () => {
  // Arrange: spy on titler.schedule
  // Act: messageService.recordAssistantFinal({ threadId, content: "..." })
  // Assert: titler.schedule called with thread.sessionGroupId
})

it("does NOT trigger on assistant progress/thinking messages", () => { /* messageType=progress */ })
it("does NOT trigger on user messages", () => { /* role=user */ })
```

**Step 3 — Implementation:**
- `MessageService` 构造函数新增可选 `sessionTitler?: { schedule: (sid: string) => void }` 参数
- 在 `recordAssistantFinal` / `appendMessage` (或相应的 assistant final 写入点) 之后，查 `thread.sessionGroupId` 并调 `sessionTitler?.schedule(sid)`
- `server.ts` 启动时：
  ```typescript
  const haiku = createHaikuRunner()
  const titler = new SessionTitler({
    repo: sessionRepo,
    haiku,
    logger: createLogger("session-titler"),
    buildPrompt: (sid) => buildTitlePromptFromRecentMessages(sid, sessionRepo),
  })
  const messageService = new MessageService({ ..., sessionTitler: titler })
  ```
- 补 `buildTitlePromptFromRecentMessages`（读 thread 近 4-6 条 user+assistant final 消息拼 prompt）

**Step 4 — Run:** PASS + 全量 `pnpm --filter @multi-agent/api test` 绿。

**Step 5 — Commit:**
```bash
git add packages/api/src/services/message-service.ts packages/api/src/server.ts packages/api/src/services/session-titler/
git commit -m "feat(F022-P2): message-service 挂 SessionTitler hook — assistant final 触发命名"
```

---

### Task 6: Feature doc 同步 + Phase 2 完工标记

**Files:**
- Modify: `docs/features/F022-left-sidebar-redesign.md`

**Step 1 — 逐条打勾 AC-05~10：**

```diff
- - [ ] AC-05: 触发时机：首条 user + 首条 assistant 之后，等 2-3 秒
+ - [x] AC-05: 触发时机：首条 user + 首条 assistant 之后，等 2-3 秒
...
- - [ ] AC-07: 命名结果写入 session.title，替换原有 `YYYY-MM-DD · 未命名` 格式
+ - [x] AC-07: 命名结果写入 session.title，替换默认格式（现实为 `新会话 YYYY-MM-DD HH:mm:ss` + 回退 `新会话 YYYY-MM-DD`；spec 原文"YYYY-MM-DD · 未命名"作为历史遗留也被识别）
```

**Step 2 — Timeline 加一行：**
```
| 2026-04-20 | Phase 2 完成（AC-05~10） |
```

**Step 3 — Commit:**
```bash
git add docs/features/F022-left-sidebar-redesign.md docs/plans/F022-phase2-plan.md
git commit -m "docs(F022): Phase 2 完成标记（AC-05~10 ✅）"
```

---

## 合入决策（铁律：feature 未完工不合 dev）

Phase 2 完工后 **不合 dev**。继续 Phase 3（AC-11~18 左 sidebar + 顶部 ROOM 徽章）/ Phase 4（AC-19~21 验收）。全 feature ✅ + worktree 验收通过后由 `feat-lifecycle` completion 一次性合 dev。

## Out of Scope (Phase 2)

- AC-11~15 左侧 Sidebar UI（Phase 3）
- AC-16~18 顶部 ROOM 徽章（Phase 3）
- AC-19~21 桂芬视觉 / 范德彪 review / 小孙搜索验收（Phase 4）
- Haiku 命名的重试 / 退避（拍板：失败即回退，不重试）
- 用户手动"重新命名"按钮（本 Feature 不覆盖）
