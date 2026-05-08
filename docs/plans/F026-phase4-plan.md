---
plan: F026 Phase 4 — Registry 持久化（STALE 双档 + ParallelGroup 持久化 + kill -9 e2e）
spec: docs/features/F026-a2a-reliability-layer.md (line 369-374 P4 段 + line 85-88 I4)
worktree: .worktrees/F026-p0  (branch: feat/F026-p0-a2a-stabilize)
created: 2026-04-29
owner: 黄仁勋
status: done — T1+T2+T3+T4 全实施完成（commits c4854bd / fb6b39f / c96a4c5 / pending T4）
merge-policy: 不合 dev — P0+P1+P3+P3.1+P4+P5 验完一起合
---

# F026 Phase 4 Implementation Plan

**Feature:** F026 — `docs/features/F026-a2a-reliability-layer.md`
**Goal:** Registry 持久化跨进程重启 — `kill -9` 后所有 pending call / parallel group 状态可恢复，回程不重入
**Architecture:**
- T1 给 `CallRegistry.timeoutScan()` 加 `stalePendingMs` 二档（pending 60s queued · working 仍按 deadline_at）
- T2 把 `ParallelGroupRegistry` 从纯内存改成 SQLite-backed（drizzle 表 + JSON 列序列化 Set/Map/Array），`groups` Map 退化为 hot cache
- T3 启动时 `registry.rehydrate()` 读非 terminal 行回内存 + 按 `createdAt + timeoutMinutes` 算剩余时间 reschedule `timeoutTimer`
- T4 kill -9 e2e 集成测试（同 sqlite path 关闭/重开 connection 验状态恢复）

**Tech Stack:** better-sqlite3 (existing) · drizzle-orm (existing) · node:test

---

## Acceptance Criteria（spec line 369-374 P4 段 + I4 第二条）

- [ ] **AC-P4-1**（spec line 373）：`CallRegistry.timeoutScan()` STALE 双档 — pending 超 `stalePendingMs`（默认 60s）转 timeout，同时仍扫 working 超 `deadline_at` 的行；`stalePendingMs` 通过 env `A2A_PENDING_STALE_MS` 注入
- [ ] **AC-P4-2**（spec line 371 + I4）：`ParallelGroupRegistry` 全 mutation（create/start/markCompleted/addPhase2Reply/handleTimeout/handleFailure/addPendingConfirmations）写 `parallel_groups` 表
- [ ] **AC-P4-3**（spec line 371 + I4）：进程重启后 `registry.rehydrate()` 读非 terminal 行回内存 + 按 `createdAt + timeoutMinutes` 重算剩余时间 reschedule `timeoutTimer`
- [ ] **AC-P4-4**（spec line 374 + I4 第二条）：`__tests__/a2a-replay/p4-restart-recovery.test.ts` kill -9 e2e —— 同 sqlite path 关闭 + 重开 connection 后，a2a_calls 行还在 + parallel_groups 行还在 + status/completedResults/pendingProviders 全恢复

## Out of Scope（明确）

- ❌ A2AChainRegistry 持久化（render-only · DoD-3 删）
- ❌ RunningSlots 持久化（kill -9 时 in-flight 也死了 · 重启 = 重置 = 正确语义）
- ❌ DiscussionCoordinator + 结论卡片（P5 范围）
- ❌ `/debug/a2a` UI 视图（P5 T3）
- ❌ 双轨 flag 删除（DoD-3 cleanup commit 单独干）
- ❌ ADR-004 红线再查（P3.1 已查过，本 Phase 不动 agent-prompts.ts）
- ❌ `a2a_calls` 表字段扩（P0/P1 已落 callId/parentCallId/rootCallId/issuerId/convenerId/onBehalfOf/replyTo/deadlineAt/joinSetId/status/envelopeVersion/sessionGroupId · 不再加列）

## P3 / P3.1 修订对 P4 影响评估（rehydrate 实证）

| 修订点 | 影响 | 结论 |
|---|---|---|
| P3 `buildReturnPathPayload` + cold-target burst | 仅修 dispatch.ts payload + assemblePrompt | P4 0 阻塞 |
| P3 `A2A_PAYLOAD_MAX_TOKENS` env | 不动 a2a_calls / call-registry | P4 0 阻塞 |
| P3.1 `messages.retry_count` migration | messages 表加列，a2a_calls 不动 | P4 0 阻塞 |
| P3.1 `agent_events:dispatch_validation_retry` | agent_events 加事件类型 | P5 `/debug/a2a` UI 渲染分支增加 |
| P3.1 retry exhausted → 红条警示 | 提前实现 P5 "@ pill 失败状态" 失败分支 | P5 这条 AC 已部分落 |
| P3.1 R-057 `naked_at_with_real_teammate` retry | 行首裸 @ 真实队友也触发 retry | P4 0 阻塞 |
| P3.1 follow-up retry-badge realtime | settled/exhausted payload 携带 retryCount/retryReasons | P4 0 阻塞 |

**结论**：P3 / P3.1 修订无 P4 方案级冲突；P5 受益于 retry exhausted 已实现的部分失败分支。

---

## Task 1 · CallRegistry STALE 双档（pending 60s）

**Files:**
- Modify: `packages/api/src/orchestrator/call-registry.ts:168-185`（`timeoutScan()` 签名 + 实现）
- Test: `packages/api/src/orchestrator/call-registry.test.ts`（新增 4 case）
- Modify: `packages/api/src/server.ts`（`A2A_PENDING_STALE_MS` env 注入 + clamp）

### Step 1.1 · 写失败测试 — pending 超 60s → timeout

在 `call-registry.test.ts` 末尾追加（参考 stash@{1} 当时形态，但重新实证写）：

```typescript
test("F026 P4 T1: timeoutScan with stalePendingMs sweeps pending older than threshold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p4-t1-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  let clock = Date.parse("2026-04-29T12:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const registry = new CallRegistry({ db: store.db, now })
  try {
    const id = registry.openCall({
      issuerId: "A", convenerId: "A", replyTo: "r", sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    clock += 61_000
    const swept = registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(swept, 1)
    const row = store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(id) as { status: CallStatus }
    assert.equal(row.status, "timeout")
  } finally {
    try { store.db.close() } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})
```

### Step 1.2 · 跑测试确认失败

Run: `cd .worktrees/F026-p0 && pnpm --filter @multi-agent/api test -- --test-name-pattern "P4 T1"`
Expected: FAIL — `timeoutScan` 不接受 opts 或不扫 pending

### Step 1.3 · 写最少实现

Modify `call-registry.ts:168-185`：

```typescript
timeoutScan(opts: { stalePendingMs?: number } = {}): number {
  let total = 0
  const nowIso = this.now()

  const workingResult = this.db
    .prepare(
      `UPDATE a2a_calls SET status = 'timeout', updated_at = ?
       WHERE status = 'working' AND deadline_at < ?`,
    )
    .run(nowIso, nowIso)
  total += Number(workingResult.changes)

  if (opts.stalePendingMs && opts.stalePendingMs > 0) {
    const cutoffIso = new Date(Date.parse(nowIso) - opts.stalePendingMs).toISOString()
    const pendingResult = this.db
      .prepare(
        `UPDATE a2a_calls SET status = 'timeout', updated_at = ?
         WHERE status = 'pending' AND created_at < ?`,
      )
      .run(nowIso, cutoffIso)
    total += Number(pendingResult.changes)
  }

  return total
}
```

### Step 1.4 · 跑测试确认通过

Run: `cd .worktrees/F026-p0 && pnpm --filter @multi-agent/api test -- --test-name-pattern "P4 T1"`
Expected: PASS

### Step 1.5 · 补另外 3 case（fresh pending 不动 / 双扫一次过 / no opts back-compat）

按 stash@{1} 验证过的 3 个 case 形态写：
- pending 30s 不超 60s 阈值 → swept=0
- working 90s 超 deadline_at + pending 90s 超 60s → swept=2
- timeoutScan() 不传 opts → pending 不动（保留旧 call site 语义）

### Step 1.6 · 接入 server.ts env

Modify `server.ts` `installCallRegistryTimeoutScan` 处（grep `timeoutScan` 找）：

```typescript
const stalePendingMs = (() => {
  const raw = Number(process.env.A2A_PENDING_STALE_MS ?? 60_000)
  if (!Number.isFinite(raw) || raw < 1_000 || raw > 600_000) {
    console.warn(`[F026 P4 T1] A2A_PENDING_STALE_MS=${process.env.A2A_PENDING_STALE_MS} out of [1s, 10min], fallback 60s`)
    return 60_000
  }
  return raw
})()
const tick = (): void => { void registry.timeoutScan({ stalePendingMs }) }
```

### Step 1.7 · 全套测试 + commit

```bash
cd .worktrees/F026-p0
pnpm --filter @multi-agent/api test
git add packages/api/src/orchestrator/call-registry.ts packages/api/src/orchestrator/call-registry.test.ts packages/api/src/server.ts
git commit -m "feat(F026-P4 T1): CallRegistry STALE 双档 — pending 60s queued + working past deadline [黄仁勋/Opus-47 🐾]"
```

---

## Task 2 · ParallelGroup schema + Registry 持久化

**Files:**
- Modify: `packages/api/src/db/schema.ts:253`（追加 `parallelGroups` drizzle 表）
- Modify: `packages/api/src/db/sqlite.ts`（追加 raw DDL，drizzle 不做 auto migrate）
- Modify: `packages/api/src/orchestrator/parallel-group.ts:74-318`（Registry 全 mutation 加写库）
- Test: `packages/api/src/orchestrator/parallel-group.persistence.test.ts`（新建 · 6 case）

### Step 2.1 · 追加 drizzle schema

In `schema.ts:253` 之后：

```typescript
export const parallelGroups = sqliteTable(
  "parallel_groups",
  {
    id: text("id").primaryKey(),
    parentMessageId: text("parent_message_id").notNull(),
    originatorAgentId: text("originator_agent_id").notNull(),
    originatorProvider: text("originator_provider").notNull(),
    sessionGroupId: text("session_group_id").notNull().default(""),
    callbackTo: text("callback_to"),
    question: text("question"),
    initiatedBy: text("initiated_by").notNull(),
    participantProviders: text("participant_providers").notNull(), // JSON Array<Provider>
    pendingProviders: text("pending_providers").notNull(),         // JSON Array<Provider>
    completedResults: text("completed_results").notNull(),         // JSON Record<Provider, {messageId, content}>
    phase2Replies: text("phase2_replies").notNull(),               // JSON Array<Phase2Reply>
    pendingConfirmations: text("pending_confirmations").notNull(), // JSON Array<PendingConfirmationItem>
    joinBehavior: text("join_behavior").notNull(),
    status: text("status").notNull(),
    timeoutMinutes: integer("timeout_minutes").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_parallel_groups_status").on(table.status),
    index("idx_parallel_groups_session").on(table.sessionGroupId),
    index("idx_parallel_groups_idempotency").on(table.idempotencyKey),
  ],
)
```

### Step 2.2 · 追加 raw DDL 到 sqlite.ts

Run: `grep -n "CREATE TABLE IF NOT EXISTS a2a_calls" .worktrees/F026-p0/packages/api/src/db/sqlite.ts` 找位置，下方追加 `parallel_groups` 同等 DDL（带 idx 索引）。

### Step 2.3 · 写失败测试 — create → reload 还在

新建 `parallel-group.persistence.test.ts`：

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SqliteStore } from "../db/sqlite.js"
import { ParallelGroupRegistry } from "./parallel-group.js"

test("F026 P4 T2: create then reload from db", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p4-t2-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  try {
    const reg1 = new ParallelGroupRegistry({ db: store.db })
    const g = reg1.create({
      parentMessageId: "m1",
      originatorAgentId: "A",
      originatorProvider: "claude",
      targetProviders: ["codex", "gemini"],
      joinBehavior: "notify_originator",
      sessionGroupId: "sg-1",
    })
    // close + reopen db
    store.db.close()
    const store2 = new SqliteStore(path.join(dir, "db.sqlite"))
    const reg2 = new ParallelGroupRegistry({ db: store2.db })
    reg2.rehydrate()
    const reloaded = reg2.get(g.id)
    assert.ok(reloaded)
    assert.equal(reloaded.parentMessageId, "m1")
    assert.deepEqual([...reloaded.pendingProviders], ["codex", "gemini"])
    store2.db.close()
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})
```

### Step 2.4 · 跑测试确认失败

Run: `cd .worktrees/F026-p0 && pnpm --filter @multi-agent/api test -- --test-name-pattern "P4 T2: create"`
Expected: FAIL — `ParallelGroupRegistry` constructor 不接 `{db}` / 没 rehydrate / 没 get

### Step 2.5 · 写最少实现 — constructor + create 写库 + get/rehydrate

Modify `parallel-group.ts:74-X` 改 `class ParallelGroupRegistry`：
- constructor `{ db }: { db: BetterSqlite3.Database }`
- create() 末尾 `this.persist(group)`
- 新增 `private persist(group)` 序列化 Set/Map/Array → JSON insert
- 新增 `get(id)` 走 hot cache
- 新增 `rehydrate()` SELECT non-terminal 行 → 反序列化回 group

### Step 2.6 · 跑测试确认通过

Run: `cd .worktrees/F026-p0 && pnpm --filter @multi-agent/api test -- --test-name-pattern "P4 T2"`
Expected: PASS

### Step 2.7 · 补 5 个 case + 全 mutation 写库

补测试：
- markCompleted → reload completedResults 含
- addPhase2Reply 顺序保留（reload 后顺序不乱）
- pendingConfirmations 加 → reload 含
- idempotencyKey 索引（同 key 二次 create 返同 group）
- terminal status (done/failed/timeout) 后 rehydrate 不回内存

每个 red → 改 markCompleted/addPhase2Reply/handleTimeout/handleFailure/addPendingConfirmations 在末尾调 `this.persist(group)` → green。

### Step 2.8 · commit

```bash
cd .worktrees/F026-p0
pnpm --filter @multi-agent/api test
git add packages/api/src/db/schema.ts packages/api/src/db/sqlite.ts \
        packages/api/src/orchestrator/parallel-group.ts \
        packages/api/src/orchestrator/parallel-group.persistence.test.ts
git commit -m "feat(F026-P4 T2): ParallelGroupRegistry SQLite-backed — 全 mutation 写库 + JSON 列序列化 [黄仁勋/Opus-47 🐾]"
```

---

## Task 3 · rehydrate + timeoutTimer reschedule

**Files:**
- Modify: `packages/api/src/orchestrator/parallel-group.ts`（`rehydrate()` 内 reschedule timer）
- Modify: `packages/api/src/server.ts`（`installA2AGateway` 启动时调 `registry.rehydrate()`）
- Test: `packages/api/src/orchestrator/parallel-group.timeout-rehydrate.test.ts`（新建 · 2 case）

### Step 3.1 · 写失败测试 — timeoutTimer 按剩余时间 reschedule

```typescript
test("F026 P4 T3: rehydrate reschedules timeoutTimer with remaining time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p4-t3-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  try {
    const reg1 = new ParallelGroupRegistry({ db: store.db })
    const g = reg1.create({
      parentMessageId: "m1",
      originatorAgentId: "A",
      originatorProvider: "claude",
      targetProviders: ["codex"],
      joinBehavior: "notify_originator",
      timeoutMinutes: 0.05, // 3s
    })
    reg1.start(g.id, () => {/* timeout cb */})
    // close + reopen + rehydrate after 1s
    store.db.close()
    await new Promise((r) => setTimeout(r, 1000))
    const store2 = new SqliteStore(path.join(dir, "db.sqlite"))
    const reg2 = new ParallelGroupRegistry({ db: store2.db })
    let timedOut = false
    reg2.rehydrate({
      onTimeout: (id) => { if (id === g.id) timedOut = true },
    })
    // wait remaining ~2s + buffer
    await new Promise((r) => setTimeout(r, 2500))
    assert.equal(timedOut, true)
    store2.db.close()
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})
```

### Step 3.2 · 跑测试 → FAIL

### Step 3.3 · 实现 rehydrate({ onTimeout })

`rehydrate()` 改签名 `rehydrate(opts?: { onTimeout?: (id: string) => void })`：
- 读 non-terminal 行
- 反序列化回内存
- 对 status='running' 的：算 `timeoutAt = createdAt + timeoutMinutes*60_000`，剩余时间 = max(0, timeoutAt - now)
- `setTimeout(() => opts?.onTimeout?.(id), remaining)` 写到 group.timeoutTimer

### Step 3.4 · 跑测试 → PASS

### Step 3.5 · server.ts 接入 rehydrate

Grep `new ParallelGroupRegistry` 在 server.ts/installA2AGateway 找点位，在 registry 创建后立刻调 `registry.rehydrate({ onTimeout: ... })`，onTimeout 复用现有 handleTimeout 路径（找 dispatch.ts/message-service.ts 现有 timeout 入口）。

### Step 3.6 · commit

```bash
cd .worktrees/F026-p0
pnpm --filter @multi-agent/api test
git add packages/api/src/orchestrator/parallel-group.ts \
        packages/api/src/orchestrator/parallel-group.timeout-rehydrate.test.ts \
        packages/api/src/server.ts
git commit -m "feat(F026-P4 T3): rehydrate + timeoutTimer reschedule — 重启不丢长讨论态 [黄仁勋/Opus-47 🐾]"
```

---

## Task 4 · kill -9 e2e + 验证 + 收尾

**Files:**
- Test: `packages/api/__tests__/a2a-replay/p4-restart-recovery.test.ts`（新建）

### Step 4.1 · 写 e2e 集成测试

```typescript
test("F026 P4 T4: kill -9 restart recovery e2e", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p4-t4-"))
  const dbPath = path.join(dir, "db.sqlite")
  try {
    // step 1-2: open call + create parallel group + markCompleted (1/3)
    {
      const store = new SqliteStore(dbPath)
      const callReg = new CallRegistry({ db: store.db })
      const callId = callReg.openCall({...})
      callReg.advance(callId, "working")
      const pgReg = new ParallelGroupRegistry({ db: store.db })
      const g = pgReg.create({ targetProviders: ["codex","gemini","claude"], ... })
      pgReg.start(g.id, () => {})
      pgReg.markCompleted(g.id, "codex", "msg-1", "result-1")
      // step 3: simulate kill -9
      store.db.close()
    }
    // step 4-5: reopen + assert state
    {
      const store2 = new SqliteStore(dbPath)
      const callReg2 = new CallRegistry({ db: store2.db })
      const pgReg2 = new ParallelGroupRegistry({ db: store2.db })
      pgReg2.rehydrate()
      // a2a_calls 行还在，status='working'
      assert.equal(callReg2.get(callId)?.status, "working")
      // parallel_groups 行还在
      const reloaded = pgReg2.get(g.id)
      assert.ok(reloaded)
      assert.equal(reloaded.completedResults.size, 1)
      assert.equal(reloaded.pendingProviders.size, 2)
      // step 6: timeoutScan 仍正确转 timeout
      // step 7: settle 仍可正常 CAS 转终态
      store2.db.close()
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})
```

### Step 4.2 · 跑测试 → 应该已被 T1+T2+T3 覆盖直接 PASS

如果 FAIL → 缺什么补什么。

### Step 4.3 · 验证（合 dev 前 DoD-1 第 5 条）

- [ ] `cd .worktrees/F026-p0 && pnpm --filter @multi-agent/api test` 全绿（target 1380+ tests, 0 fail）
- [ ] `cd .worktrees/F026-p0 && pnpm --filter @multi-agent/web test` 全绿（target 156+ tests, 0 fail）
- [ ] `cd .worktrees/F026-p0 && pnpm typecheck` 0 error
- [ ] grep `ParallelGroupRegistry` 生产消费方仍命中（不是孤岛）
- [ ] grep `parallel_groups` 字段全在生产被读 / 写
- [ ] grep `A2A_PENDING_STALE_MS` server.ts 命中

### Step 4.4 · commit

```bash
git add packages/api/__tests__/a2a-replay/p4-restart-recovery.test.ts
git commit -m "test(F026-P4 T4): kill -9 重启恢复 e2e — CallRegistry + ParallelGroupRegistry 全状态恢复 [黄仁勋/Opus-47 🐾]"
```

---

## Phase 边界

- **依赖**：P1 wiring（CallRegistry SQLite 直接落、a2a-lifecycle wired · 已落）+ P3.1 retry coordinator（已落）
- **下游**：P5 `/debug/a2a` UI 读 `parallel_groups` 表渲染 pending 卡片；DiscussionCoordinator 直接复用
- **未合 dev**：P0+P1+P3+P3.1+P4+P5 全验完一起 squash merge dev
