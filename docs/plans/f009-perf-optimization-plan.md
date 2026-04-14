# F009 全链路性能优化 Implementation Plan

**Feature:** F009 — `docs/features/F009-perf-optimization.md`
**Goal:** 消除多 agent 并发场景下的全链路卡顿，端到端快照延迟 < 200ms
**Acceptance Criteria:**
- AC-01: 在 `emitThreadSnapshot`、`getActiveGroup`、`listMessages` 加耗时埋点
- AC-02: 跑 3 agent 并发场景，记录各段 P90 耗时作为基准线
- AC-03: 定义目标：端到端快照延迟 < 200ms
- AC-04: 给 messages(thread_id)、threads(session_group_id)、agent_events(invocation_id, thread_id)、session_memories(session_group_id)、tasks(session_group_id)、authorization_rules(provider, thread_id) 加索引
- AC-05: SQLite PRAGMA 补全：busy_timeout=5000、synchronous=NORMAL、cache_size=-64000、journal_size_limit=67108864
- AC-06: `listSessionGroups` N+1 治理 — 改为 JOIN 查询或 batch 查询
- AC-07: `agent_events` 降采样/批量写入
- AC-08: Phase 1 完成后复测，记录改善百分比
- AC-09: `emitThreadSnapshot` 改为 Tail Tracking 增量协议（只推新增消息 + 状态字段）
- AC-10: 前端 `mergeTimeline` 改为增量更新，跳过不必要的 sort
- AC-11: 前端渲染节流（60fps 截断）
- AC-12: 用户发消息链路加 Optimistic UI + `client_message_id` 对账
- AC-13: `status-panel` 事件滑窗（只保留最近 5 条）
- AC-14: Phase 2 完成后复测，记录累计改善百分比
- AC-15: 骨架缓存（LocalStorage/IndexedDB 界面秒开）
- AC-16: Redis 缓存层（如仍有存储瓶颈）

**Architecture:** 三阶段递进。Phase 0 插桩观测建立基准线；Phase 1 做低风险高收益的数据库层优化（索引 + PRAGMA + N+1 治理 + 事件降噪）；Phase 2 做架构级改造（增量快照协议 + 前端增量 merge + 渲染节流 + Optimistic UI + 事件滑窗）。Phase 3 视复测结果决定是否需要。
**Tech Stack:** SQLite(better-sqlite3), Fastify WebSocket, Zustand, @tanstack/react-virtual

**数据安全铁律:** 所有 schema 变更只做"加法"（加索引、加列、加表），不删表、不删列、不清数据。

---

## Straight-Line Check

**Finish line (B):** 3 个 agent 并发交互时，用户体感流畅无卡顿，端到端快照延迟 P90 < 200ms，前端渲染不掉帧。

**我们不做什么:**
- 不换存储引擎（不迁 Redis，ADR-001 已否决）
- 不做消息分页（当前消息量级不需要，留给未来）
- Phase 3（AC-15/AC-16）仅在 Phase 2 复测后仍有瓶颈时才做

**Terminal schema:**
```typescript
// packages/api/src/db/sqlite.ts — 终态 PRAGMA + 索引
// 在 initializeTables() 末尾追加
db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA journal_size_limit = 67108864;

  CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_threads_session_group_id ON threads(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_invocation_id ON agent_events(invocation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_thread_id ON agent_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_session_memories_session_group_id ON session_memories(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_session_group_id ON tasks(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_authorization_rules_provider_thread ON authorization_rules(provider, thread_id);
`);

// packages/shared/src/realtime.ts — 终态：增量快照事件
export type ThreadSnapshotDelta = {
  sessionGroupId: string
  newMessages: TimelineMessage[]
  removedMessageIds?: string[]
  providers: Record<string, ProviderView>
  invocationStats: InvocationStat[]
  updatedFields?: Partial<ActiveGroupView>
}

// RealtimeServerEvent 新增类型
| { type: "thread_snapshot_delta"; payload: ThreadSnapshotDelta }

// components/stores/thread-store.ts — 终态：Optimistic UI
export type PendingMessage = {
  clientMessageId: string
  message: TimelineMessage
  status: "pending" | "confirmed" | "failed"
}
```

---

## Phase 0: 观测 + 基准线（AC-01 ~ AC-03）

### Task 1: 后端热路径耗时埋点

**Files:**
- Modify: `packages/api/src/services/message-service.ts:1515-1531`
- Modify: `packages/api/src/services/session-service.ts:89-162`
- Modify: `packages/api/src/db/repositories/session-repository.ts:159-169`

**Step 1: 在 `emitThreadSnapshot` 加埋点**

在 `message-service.ts:1515` 的 `emitThreadSnapshot` 方法中包裹 `console.time`:

```typescript
emitThreadSnapshot(sessionGroupId: string, emit: EmitEvent) {
  const label = `[perf] emitThreadSnapshot:${sessionGroupId}`
  console.time(label)
  this.flushActiveStreaming(sessionGroupId)
  emit({
    type: "thread_snapshot",
    payload: {
      sessionGroupId,
      activeGroup: this.sessions.getActiveGroup(
        sessionGroupId,
        new Set(this.invocations.keys()),
        {
          hasPendingDispatches: this.dispatch.hasQueuedDispatches(sessionGroupId),
          dispatchBarrierActive: this.dispatch.isSessionGroupCancelled(sessionGroupId),
        },
      ),
    },
  })
  console.timeEnd(label)
}
```

**Step 2: 在 `getActiveGroup` 加埋点**

在 `session-service.ts:89` 的 `getActiveGroup` 方法中加分段计时:

```typescript
getActiveGroup(groupId: string, runningThreadIds: Set<string>, dispatchState?: DispatchState): ActiveGroupView {
  const t0 = performance.now()

  const groups = this.repository.listSessionGroups()
  const tGroups = performance.now()

  const summary = groups.find((group) => group.id === groupId)
  const threads = this.repository.listThreadsByGroup(groupId)
  const tThreads = performance.now()

  // ... providers 构建 ...
  const tProviders = performance.now()

  // ... timeline 构建 ...
  const tTimeline = performance.now()

  console.log(`[perf] getActiveGroup: listGroups=${(tGroups-t0).toFixed(1)}ms threads=${(tThreads-tGroups).toFixed(1)}ms providers=${(tProviders-tThreads).toFixed(1)}ms timeline=${(tTimeline-tProviders).toFixed(1)}ms total=${(tTimeline-t0).toFixed(1)}ms`)

  return { ... }
}
```

**Step 3: 在 `listMessages` 加埋点**

在 `session-repository.ts:159` 的 `listMessages` 方法中:

```typescript
listMessages(threadId: string) {
  const t0 = performance.now()
  const rows = this.store.db
    .prepare(...)
    .all(threadId) as MessageRow[]
  const result = rows.map(hydrateMessage)
  console.log(`[perf] listMessages(${threadId}): ${rows.length} rows, ${(performance.now()-t0).toFixed(1)}ms`)
  return result
}
```

**Step 4: 启动系统验证埋点输出**

Run: `pnpm run dev`
Expected: 控制台出现 `[perf]` 前缀的耗时日志

**Step 5: Commit**

```bash
git add packages/api/src/services/ packages/api/src/db/
git commit -m "perf(F009): Phase 0 — 热路径耗时埋点 [黄仁勋/Opus-46 🐾]"
```

### Task 2: 基准线采集与目标定义

**Step 1: 3 agent 并发场景复测**

启动系统后，创建一个包含 3 个 agent 的会话组，交互 5 分钟，收集所有 `[perf]` 日志。

**Step 2: 记录基准数据到 feature doc**

在 `docs/features/F009-perf-optimization.md` 追加基准线数据段:

```markdown
## 基准线数据（Phase 0）

| 指标 | P50 | P90 | P99 |
|------|-----|-----|-----|
| emitThreadSnapshot 总耗时 | ?ms | ?ms | ?ms |
| getActiveGroup.listGroups | ?ms | ?ms | ?ms |
| getActiveGroup.timeline | ?ms | ?ms | ?ms |
| listMessages (per thread) | ?ms | ?ms | ?ms |

**目标**: 端到端快照延迟 P90 < 200ms
```

**Step 3: Commit**

```bash
git add docs/features/F009-perf-optimization.md
git commit -m "docs(F009): Phase 0 基准线数据 [黄仁勋/Opus-46 🐾]"
```

---

## Phase 1: 低风险高收益（AC-04 ~ AC-08）

### Task 3: SQLite 索引治理（AC-04）

**Files:**
- Modify: `packages/api/src/db/sqlite.ts:80`

**Step 1: 写测试 — 验证索引存在**

```typescript
// packages/api/src/db/__tests__/sqlite-indexes.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { SqliteStore } from "../sqlite.js"
import path from "node:path"
import os from "node:os"
import fs from "node:fs"

describe("SQLite indexes", () => {
  it("should create all performance indexes on initialization", () => {
    const dbPath = path.join(os.tmpdir(), `test-idx-${Date.now()}.db`)
    try {
      const store = new SqliteStore(dbPath)
      const indexes = store.db
        .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all() as Array<{ name: string; tbl_name: string }>

      const indexNames = indexes.map((i) => i.name)
      assert.ok(indexNames.includes("idx_messages_thread_id"), "missing idx_messages_thread_id")
      assert.ok(indexNames.includes("idx_messages_created_at"), "missing idx_messages_created_at")
      assert.ok(indexNames.includes("idx_threads_session_group_id"), "missing idx_threads_session_group_id")
      assert.ok(indexNames.includes("idx_agent_events_invocation_id"), "missing idx_agent_events_invocation_id")
      assert.ok(indexNames.includes("idx_agent_events_thread_id"), "missing idx_agent_events_thread_id")
      assert.ok(indexNames.includes("idx_session_memories_session_group_id"), "missing idx_session_memories_session_group_id")
      assert.ok(indexNames.includes("idx_tasks_session_group_id"), "missing idx_tasks_session_group_id")
      assert.ok(indexNames.includes("idx_authorization_rules_provider_thread"), "missing idx_authorization_rules_provider_thread")

      store.db.close()
    } finally {
      fs.rmSync(dbPath, { force: true })
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @multi-agent/api test`
Expected: FAIL — indexes don't exist yet

**Step 3: 在 sqlite.ts 的 initializeTables 末尾加索引**

在 `packages/api/src/db/sqlite.ts` 的表定义之后追加:

```typescript
this.db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_threads_session_group_id ON threads(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_invocation_id ON agent_events(invocation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_thread_id ON agent_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_session_memories_session_group_id ON session_memories(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_session_group_id ON tasks(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_authorization_rules_provider_thread ON authorization_rules(provider, thread_id);
`);
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/db/
git commit -m "perf(F009): SQLite 索引治理 — 8 个高频查询列加索引 [黄仁勋/Opus-46 🐾]"
```

### Task 4: SQLite PRAGMA 补全（AC-05）

**Files:**
- Modify: `packages/api/src/db/sqlite.ts:80`

**Step 1: 写测试 — 验证 PRAGMA 设置**

```typescript
// 追加到 packages/api/src/db/__tests__/sqlite-indexes.test.ts
it("should set performance PRAGMAs", () => {
  const dbPath = path.join(os.tmpdir(), `test-pragma-${Date.now()}.db`)
  try {
    const store = new SqliteStore(dbPath)

    const busyTimeout = store.db.prepare("PRAGMA busy_timeout").get() as { busy_timeout: number }
    assert.equal(busyTimeout.busy_timeout, 5000)

    const synchronous = store.db.prepare("PRAGMA synchronous").get() as { synchronous: number }
    assert.equal(synchronous.synchronous, 1) // NORMAL = 1

    const cacheSize = store.db.prepare("PRAGMA cache_size").get() as { cache_size: number }
    assert.equal(cacheSize.cache_size, -64000)

    const journalSizeLimit = store.db.prepare("PRAGMA journal_size_limit").get() as { journal_size_limit: number }
    assert.equal(journalSizeLimit.journal_size_limit, 67108864)

    store.db.close()
  } finally {
    fs.rmSync(dbPath, { force: true })
  }
})
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @multi-agent/api test`
Expected: FAIL — PRAGMAs not set

**Step 3: 在现有 WAL PRAGMA 后追加性能 PRAGMA**

在 `sqlite.ts:80` 的 `PRAGMA journal_mode = WAL` 之后追加:

```typescript
this.db.exec("PRAGMA journal_mode = WAL;")
this.db.exec("PRAGMA busy_timeout = 5000;")
this.db.exec("PRAGMA synchronous = NORMAL;")
this.db.exec("PRAGMA cache_size = -64000;")
this.db.exec("PRAGMA journal_size_limit = 67108864;")
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/db/
git commit -m "perf(F009): SQLite PRAGMA 补全 — busy_timeout/synchronous/cache_size/journal_size_limit [黄仁勋/Opus-46 🐾]"
```

### Task 5: listSessionGroups N+1 治理（AC-06）

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository.ts:64-85`

**Step 1: 写测试 — 验证 listSessionGroups 返回正确结构**

```typescript
// packages/api/src/db/__tests__/session-repository-n1.test.ts
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
// ... 导入 SqliteStore, SessionRepository ...

describe("listSessionGroups N+1 fix", () => {
  let repo: SessionRepository

  beforeEach(() => {
    // 创建临时 DB + 插入测试数据（2 个 group, 每个 2 个 thread, 每个 thread 1 条消息）
  })

  it("should return groups with previews without N+1 queries", () => {
    const groups = repo.listSessionGroups()
    assert.ok(groups.length >= 2)
    for (const group of groups) {
      assert.ok(Array.isArray(group.previews))
      for (const preview of group.previews) {
        assert.ok(preview.provider)
        assert.ok(typeof preview.text === "string" || preview.text === null)
      }
    }
  })
})
```

**Step 2: Run test to verify it passes (current behavior correct, just slow)**

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS（行为正确但慢，重构后行为不变）

**Step 3: 重写 listSessionGroups 为 JOIN 查询**

```typescript
listSessionGroups() {
  const rows = this.store.db
    .prepare(`
      SELECT
        sg.id, sg.title, sg.project_tag as projectTag,
        sg.created_at as createdAt, sg.updated_at as updatedAt,
        t.provider, t.alias, t.id as threadId,
        (SELECT content FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) as lastMessage
      FROM session_groups sg
      LEFT JOIN threads t ON t.session_group_id = sg.id
      ORDER BY sg.updated_at DESC, t.created_at ASC
    `)
    .all() as Array<{
      id: string; title: string; projectTag: string | null;
      createdAt: string; updatedAt: string;
      provider: string | null; alias: string | null; threadId: string | null;
      lastMessage: string | null;
    }>

  const groupMap = new Map<string, SessionGroupRow & { previews: Array<{ provider: string; alias: string; text: string | null }> }>()

  for (const row of rows) {
    if (!groupMap.has(row.id)) {
      groupMap.set(row.id, {
        id: row.id,
        title: row.title,
        projectTag: row.projectTag ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        previews: [],
      })
    }
    if (row.provider && row.threadId) {
      const group = groupMap.get(row.id)!
      const preview = row.lastMessage
        ? row.lastMessage.length > 100 ? row.lastMessage.slice(0, 100) + "…" : row.lastMessage
        : null
      group.previews.push({
        provider: row.provider,
        alias: row.alias ?? row.provider,
        text: preview,
      })
    }
  }

  return [...groupMap.values()]
}
```

**Step 4: Run test to verify it still passes**

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS

**Step 5: Run typecheck**

Run: `pnpm run typecheck`
Expected: No errors

**Step 6: Commit**

```bash
git add packages/api/src/db/
git commit -m "perf(F009): listSessionGroups N+1 治理 — JOIN 重写，21 次查询→1 次 [黄仁勋/Opus-46 🐾]"
```

### Task 6: agent_events 批量写入（AC-07）

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository.ts:336-351`
- Modify: `packages/api/src/server.ts:141-207`

**Step 1: 写测试 — 验证批量写入行为**

```typescript
// packages/api/src/db/__tests__/agent-events-batch.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("agent_events batch insert", () => {
  it("should batch multiple events into a single transaction", () => {
    // 创建临时 DB
    // 准备 10 条 agent_event 记录
    // 调用 batchAppendAgentEvents(records)
    // 验证 10 条全部写入
    // 验证只执行了 1 个事务（非 10 个独立 INSERT）
  })
})
```

**Step 2: 在 session-repository 加 batch 方法**

```typescript
batchAppendAgentEvents(records: AgentEventRecord[]) {
  const insert = this.store.db.prepare(
    `INSERT INTO agent_events (id, invocation_id, thread_id, agent_id, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )

  const insertMany = this.store.db.transaction((items: AgentEventRecord[]) => {
    for (const record of items) {
      insert.run(
        record.id, record.invocationId, record.threadId,
        record.agentId, record.eventType, record.payload, record.createdAt,
      )
    }
  })

  insertMany(records)
}
```

**Step 3: 在 server.ts 加事件缓冲层**

在 `server.ts` 中创建一个简单的事件缓冲器，每 200ms 或累积 20 条时批量写入:

```typescript
class AgentEventBuffer {
  private buffer: AgentEventRecord[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly flushInterval = 200
  private readonly maxBatchSize = 20

  constructor(private readonly repository: SessionRepository) {}

  append(record: AgentEventRecord) {
    this.buffer.push(record)
    if (this.buffer.length >= this.maxBatchSize) {
      this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval)
    }
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0)
    this.repository.batchAppendAgentEvents(batch)
  }
}
```

**Step 4: Run tests**

Run: `pnpm --filter @multi-agent/api test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/db/ packages/api/src/server.ts
git commit -m "perf(F009): agent_events 批量写入 — 缓冲 200ms/20 条批量 INSERT [黄仁勋/Opus-46 🐾]"
```

### Task 7: Phase 1 复测（AC-08）

**Step 1: 启动系统，3 agent 并发交互 5 分钟**

**Step 2: 对比 Phase 0 基准线数据，记录改善百分比**

更新 `docs/features/F009-perf-optimization.md`:

```markdown
## Phase 1 复测数据

| 指标 | Phase 0 P90 | Phase 1 P90 | 改善 |
|------|------------|------------|------|
| emitThreadSnapshot | ?ms | ?ms | ?% |
| getActiveGroup | ?ms | ?ms | ?% |
| listMessages | ?ms | ?ms | ?% |
```

**Step 3: Commit**

```bash
git add docs/features/F009-perf-optimization.md
git commit -m "docs(F009): Phase 1 复测数据 [黄仁勋/Opus-46 🐾]"
```

---

## Phase 2: 架构级改造（AC-09 ~ AC-14）

### Task 8: 增量快照协议 — shared 类型定义

**Files:**
- Modify: `packages/shared/src/realtime.ts`

**Step 1: 在 realtime.ts 中定义增量快照类型**

```typescript
export type ThreadSnapshotDelta = {
  sessionGroupId: string
  newMessages: TimelineMessage[]
  removedMessageIds?: string[]
  providers: Record<string, ProviderView>
  invocationStats: InvocationStat[]
}
```

**Step 2: 在 RealtimeServerEvent 联合类型中追加新事件类型**

```typescript
| { type: "thread_snapshot_delta"; payload: ThreadSnapshotDelta }
```

**Step 3: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/shared/
git commit -m "feat(F009): ThreadSnapshotDelta 类型定义 — 增量快照协议基础 [黄仁勋/Opus-46 🐾]"
```

### Task 9: 后端 Tail Tracking — emitThreadSnapshot 增量化（AC-09）

**Files:**
- Modify: `packages/api/src/services/message-service.ts:1515-1531`
- Modify: `packages/api/src/services/session-service.ts:89-162`

**Step 1: 在 session-service 中维护 lastSentMessageId 状态**

```typescript
private lastSentTimestamps = new Map<string, string>()

getActiveGroupDelta(
  groupId: string,
  runningThreadIds: Set<string>,
  dispatchState?: DispatchState,
): ThreadSnapshotDelta {
  const lastTimestamp = this.lastSentTimestamps.get(groupId)

  // 获取 providers（保持全量，体积小）
  const threads = this.repository.listThreadsByGroup(groupId)
  const providers = /* 同现有逻辑 */

  // 只查询新增消息
  let newMessages: TimelineMessage[]
  if (lastTimestamp) {
    newMessages = threads.flatMap((thread) =>
      this.repository.listMessagesSince(thread.id, lastTimestamp)
        .map((msg) => this.mapTimelineMessage(msg, thread, runningThreadIds))
    )
  } else {
    // 首次推送，走全量
    newMessages = threads.flatMap((thread) =>
      this.repository.listMessages(thread.id)
        .map((msg) => this.mapTimelineMessage(msg, thread, runningThreadIds))
    )
  }

  if (newMessages.length > 0) {
    const latest = newMessages.reduce((a, b) =>
      a.createdAt > b.createdAt ? a : b
    )
    this.lastSentTimestamps.set(groupId, latest.createdAt)
  }

  return { sessionGroupId: groupId, newMessages, providers, invocationStats: [] }
}
```

**Step 2: 在 session-repository 加 listMessagesSince 方法**

```typescript
listMessagesSince(threadId: string, sinceTimestamp: string) {
  return this.store.db
    .prepare(
      `SELECT id, thread_id as threadId, role, content, thinking, message_type as messageType,
              connector_source as connectorSource, group_id as groupId, group_role as groupRole,
              tool_events as toolEvents, content_blocks as contentBlocks, created_at as createdAt
       FROM messages
       WHERE thread_id = ? AND created_at > ?
       ORDER BY created_at ASC`
    )
    .all(threadId, sinceTimestamp) as MessageRow[]
    .map(hydrateMessage)
}
```

**Step 3: 修改 emitThreadSnapshot 优先发 delta**

```typescript
emitThreadSnapshot(sessionGroupId: string, emit: EmitEvent) {
  this.flushActiveStreaming(sessionGroupId)
  const delta = this.sessions.getActiveGroupDelta(
    sessionGroupId,
    new Set(this.invocations.keys()),
    { /* dispatchState */ },
  )

  if (this.sessions.isFirstSnapshot(sessionGroupId)) {
    // 首次仍走全量
    emit({
      type: "thread_snapshot",
      payload: { sessionGroupId, activeGroup: this.sessions.getActiveGroup(/* ... */) },
    })
  } else {
    emit({ type: "thread_snapshot_delta", payload: delta })
  }
}
```

**Step 4: Run typecheck + tests**

Run: `pnpm run typecheck && pnpm --filter @multi-agent/api test`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/ packages/shared/
git commit -m "feat(F009): Tail Tracking 增量快照 — 只推新增消息 [黄仁勋/Opus-46 🐾]"
```

### Task 10: 前端增量 merge（AC-10）

**Files:**
- Modify: `components/stores/thread-store.ts:212-254`
- Modify: `app/page.tsx:116-120`

**Step 1: 优化 mergeTimeline — 跳过不必要的 sort**

```typescript
function mergeTimeline(existing: TimelineMessage[], incoming: TimelineMessage[]): TimelineMessage[] {
  const existingById = new Map(existing.map((msg) => [msg.id, msg]))

  const merged = incoming.map((msg) => {
    const current = existingById.get(msg.id)
    if (!current) return msg
    const content = current.role === msg.role &&
                    current.provider === msg.provider &&
                    current.content.length > msg.content.length
                      ? current.content : msg.content
    const thinking = current.thinking && current.thinking.length > (msg.thinking?.length ?? 0)
      ? current.thinking : msg.thinking
    const toolEvents = (current.toolEvents?.length ?? 0) > (msg.toolEvents?.length ?? 0)
      ? current.toolEvents : msg.toolEvents
    return { ...msg, content, thinking, toolEvents }
  })

  // 检测是否已排序，如果已排序则跳过 sort
  let sorted = true
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].createdAt < merged[i - 1].createdAt) {
      sorted = false
      break
    }
  }
  return sorted ? merged : merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
```

**Step 2: 在 page.tsx 加 thread_snapshot_delta 事件处理**

```typescript
if (event.type === "thread_snapshot_delta") {
  applySnapshotDelta(event.payload)
}
```

**Step 3: 在 thread-store 加 applySnapshotDelta action**

```typescript
applySnapshotDelta: (delta: ThreadSnapshotDelta) => {
  set((state) => {
    const newTimeline = [...state.timeline]
    // 追加新消息（已知排在末尾）
    for (const msg of delta.newMessages) {
      if (!newTimeline.some((m) => m.id === msg.id)) {
        newTimeline.push(msg)
      }
    }
    // 删除移除的消息（如有）
    const removed = new Set(delta.removedMessageIds ?? [])
    const filtered = removed.size > 0
      ? newTimeline.filter((m) => !removed.has(m.id))
      : newTimeline
    return {
      timeline: filtered,
      providers: delta.providers,
    }
  })
},
```

**Step 4: 同样优化 appendTimelineMessage 的排序**

```typescript
appendTimelineMessage: (message) => {
  set((state) => {
    if (state.timeline.some((item) => item.id === message.id)) return state
    // 新消息总是最新的，直接 push 不排序
    return { timeline: [...state.timeline, message] }
  })
},
```

**Step 5: Run typecheck + 手动验证**

Run: `pnpm run typecheck`
Expected: PASS

**Step 6: Commit**

```bash
git add components/stores/ app/page.tsx
git commit -m "feat(F009): 前端增量 merge — 跳过已排序 sort + snapshot_delta 处理 [黄仁勋/Opus-46 🐾]"
```

### Task 11: 前端渲染节流（AC-11）

**Files:**
- Modify: `components/stores/thread-store.ts`

**Step 1: 在 applyAssistantDelta 外层加 rAF 节流**

```typescript
// thread-store.ts 顶层
let pendingDeltas: Map<string, { content?: string; thinking?: string }> = new Map()
let rafId: number | null = null

function scheduleFlush(set: SetState) {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    const deltas = pendingDeltas
    pendingDeltas = new Map()
    set((state) => {
      const timeline = state.timeline.map((msg) => {
        const delta = deltas.get(msg.id)
        if (!delta) return msg
        return {
          ...msg,
          content: delta.content !== undefined ? msg.content + delta.content : msg.content,
          thinking: delta.thinking !== undefined ? (msg.thinking ?? "") + delta.thinking : msg.thinking,
        }
      })
      return { timeline }
    })
  })
}

// 在 store 中：
applyAssistantDelta: (messageId, delta) => {
  const existing = pendingDeltas.get(messageId) ?? {}
  if (delta.content) existing.content = (existing.content ?? "") + delta.content
  if (delta.thinking) existing.thinking = (existing.thinking ?? "") + delta.thinking
  pendingDeltas.set(messageId, existing)
  scheduleFlush(set)
},
```

**Step 2: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 3: 手动验证 — agent 输出流式内容时前端不掉帧**

**Step 4: Commit**

```bash
git add components/stores/
git commit -m "feat(F009): 前端渲染节流 — rAF 合并 assistant delta 更新 [黄仁勋/Opus-46 🐾]"
```

### Task 12: Optimistic UI + client_message_id 对账（AC-12）

**Files:**
- Modify: `components/stores/chat-store.ts:70-110`
- Modify: `components/stores/thread-store.ts`
- Modify: `packages/shared/src/realtime.ts`
- Modify: `app/page.tsx`

**Step 1: 在 shared 层给 SendMessagePayload 加 clientMessageId**

```typescript
// packages/shared/src/realtime.ts
export type SendMessagePayload = {
  // ...existing...
  clientMessageId?: string
}
```

**Step 2: 在 chat-store sendMessage 中生成 clientMessageId 并乐观追加**

```typescript
sendMessage: async (input) => {
  const clientMessageId = crypto.randomUUID()

  // Optimistic: 立即追加到 timeline
  const optimisticMessage: TimelineMessage = {
    id: clientMessageId,
    role: "user",
    provider: threadState.activeProvider,
    content: input,
    thinking: null,
    createdAt: new Date().toISOString(),
    // ...other fields...
  }
  threadState.appendTimelineMessage(optimisticMessage)

  // 上传图片（如有）...

  const payload = threadState.buildSendPayload(input, contentBlocks)
  socketClient.send({
    type: "send_message",
    payload: { ...payload, clientMessageId },
  })
}
```

**Step 3: 在 message.created 事件处理中做对账**

```typescript
// app/page.tsx
if (event.type === "message.created") {
  const serverMsg = event.payload.message
  if (serverMsg.clientMessageId) {
    reconcileOptimisticMessage(serverMsg.clientMessageId, serverMsg)
  } else {
    appendTimelineMessage(serverMsg)
  }
}
```

**Step 4: 在 thread-store 加 reconcileOptimisticMessage**

```typescript
reconcileOptimisticMessage: (clientMessageId: string, serverMessage: TimelineMessage) => {
  set((state) => ({
    timeline: state.timeline.map((msg) =>
      msg.id === clientMessageId ? serverMessage : msg
    ),
  }))
},
```

**Step 5: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 6: 手动验证 — 用户发消息立即显示，不闪烁**

**Step 7: Commit**

```bash
git add components/stores/ packages/shared/ app/page.tsx
git commit -m "feat(F009): Optimistic UI + client_message_id 对账 [黄仁勋/Opus-46 🐾]"
```

### Task 13: status-panel 事件滑窗（AC-13）

**Files:**
- Modify: `components/chat/status-panel.tsx`

**Step 1: 在 sortedInvocationStats 渲染前加滑窗截断**

```typescript
const MAX_VISIBLE_INVOCATIONS = 5
const visibleStats = sortedInvocationStats.slice(0, MAX_VISIBLE_INVOCATIONS)
```

**Step 2: 渲染中使用 visibleStats 替代 sortedInvocationStats**

**Step 3: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS

**Step 4: 手动验证 — status-panel 最多显示 5 条**

**Step 5: Commit**

```bash
git add components/chat/
git commit -m "feat(F009): status-panel 事件滑窗 — 只保留最近 5 条 [黄仁勋/Opus-46 🐾]"
```

### Task 14: Phase 2 复测（AC-14）

**Step 1: 启动系统，3 agent 并发交互 5 分钟**

**Step 2: 对比 Phase 1 数据，记录累计改善**

更新 `docs/features/F009-perf-optimization.md`:

```markdown
## Phase 2 复测数据

| 指标 | Phase 0 P90 | Phase 1 P90 | Phase 2 P90 | 累计改善 |
|------|------------|------------|------------|---------|
| emitThreadSnapshot | ?ms | ?ms | ?ms | ?% |
| 前端帧率 | ? fps | ? fps | ? fps | — |
| 用户发消息→显示 | ?ms | ?ms | ?ms | ?% |
```

**Step 3: Commit**

```bash
git add docs/features/F009-perf-optimization.md
git commit -m "docs(F009): Phase 2 复测数据 [黄仁勋/Opus-46 🐾]"
```

---

## Phase 3: 待 Phase 2 复测后决定（AC-15 ~ AC-16）

> **Gate:** 仅在 Phase 2 复测后 P90 仍 > 200ms 时才进入 Phase 3。
> AC-15（骨架缓存）和 AC-16（Redis 缓存层）暂不拆 task，待数据驱动决策。

---

## 检查点

| Phase | AC 覆盖 | 预期耗时 | Gate |
|-------|---------|---------|------|
| 0 | AC-01~03 | 半天 | 基准线数据产出 |
| 1 | AC-04~08 | 1-2 天 | 复测改善 > 0 |
| 2 | AC-09~14 | 2-3 天 | P90 < 200ms |
| 3 | AC-15~16 | TBD | Phase 2 未达标时 |

**下一步:** Plan 确认后 → `worktree`（创建隔离开发环境）→ `tdd`（Phase 0 开始）
