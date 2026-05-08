import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { SessionRepository } from "../db/repositories/session-repository"
import { SqliteStore } from "../db/sqlite"
import {
  DISPATCH_VALIDATION_RETRY_EVENT_TYPE,
  buildDispatchRetryAgentEventRow,
  buildDispatchRetryEventId,
  buildDispatchRetryRealtimeEvent,
  isDispatchValidationRetryPayload,
  parseDispatchValidationRetryPayload,
} from "./dispatch-retry-event"

/**
 * F026 P3.1 Task3 · agent_events.dispatch_validation_retry schema + WS broadcast helpers
 *
 * AC-12: payload 结构必须严格 — 缺字段 / 类型错误一律拒绝
 * AC-13: 每次 retry 触发 → 写一行 agent_events + 推一条 WS event；事件按 attemptIndex 单调递增
 */

const validPayload = {
  sessionGroupId: "sg-001",
  threadId: "t-001",
  invocationId: "inv-001",
  agentId: "claude",
  messageId: "msg-placeholder-001",
  attemptIndex: 1,
  maxAttempts: 3,
  reason: "nested_call_tag" as const,
  originalText: "[Call: @A 描述 [Call: @B] 接力]",
  status: "retrying" as const,
  occurredAt: "2026-04-27T10:00:00.000Z",
}

test("AC-12 schema · 完整合法 payload → guard true / parse 返回原 payload", () => {
  assert.equal(isDispatchValidationRetryPayload(validPayload), true)
  const parsed = parseDispatchValidationRetryPayload(validPayload)
  assert.deepEqual(parsed, validPayload)
})

test("AC-12 schema · reason 不在枚举内 → guard false / parse throws", () => {
  const bad = { ...validPayload, reason: "totally_bogus_reason" }
  assert.equal(isDispatchValidationRetryPayload(bad), false)
  assert.throws(() => parseDispatchValidationRetryPayload(bad), /reason/i)
})

test("AC-19/R-057 schema · reason='naked_at_with_real_teammate' → guard true / parse 透传", () => {
  // R-057 兜底层重启后（commit 16e8a72），裸 @ 真实队友会触发 retry，
  // mention-router/dispatch-retry-coordinator/message-service 都会用此 reason 写事件。
  // schema 必须接纳，否则一旦有人把 guard 接到生产路径，R-057 链路立刻炸。
  const naked = { ...validPayload, reason: "naked_at_with_real_teammate" as const }
  assert.equal(isDispatchValidationRetryPayload(naked), true)
  const parsed = parseDispatchValidationRetryPayload(naked)
  assert.equal(parsed.reason, "naked_at_with_real_teammate")
})

test("AC-12 schema · status 不在枚举内 → guard false / parse throws", () => {
  const bad = { ...validPayload, status: "in_progress" }
  assert.equal(isDispatchValidationRetryPayload(bad), false)
  assert.throws(() => parseDispatchValidationRetryPayload(bad), /status/i)
})

test("AC-21 schema · status='settled' → guard true / parse 透传", () => {
  const settled = { ...validPayload, status: "settled" as const }
  assert.equal(isDispatchValidationRetryPayload(settled), true)
  const parsed = parseDispatchValidationRetryPayload(settled)
  assert.equal(parsed.status, "settled")
})

test("AC-12 schema · attemptIndex 必须正整数（NaN/0/-1/小数 拒绝）", () => {
  for (const bad of [NaN, 0, -1, 1.5, "1" as unknown as number]) {
    assert.equal(
      isDispatchValidationRetryPayload({ ...validPayload, attemptIndex: bad }),
      false,
      `attemptIndex=${String(bad)} should be rejected`,
    )
  }
})

test("review#2 schema · status='exhausted' 携带 finalContent (string) → guard true / parse 透传", () => {
  const exhaustedWithContent = {
    ...validPayload,
    status: "exhausted" as const,
    finalContent: "完整的 final 文本，包含 [Call: @范德彪 review F026]，前端用这个填回气泡",
  }
  assert.equal(isDispatchValidationRetryPayload(exhaustedWithContent), true)
  const parsed = parseDispatchValidationRetryPayload(exhaustedWithContent)
  assert.equal(parsed.finalContent, exhaustedWithContent.finalContent)
})

test("review#2 schema · finalContent 缺省（retrying / settled）仍然合法", () => {
  const retrying = { ...validPayload }
  assert.equal(isDispatchValidationRetryPayload(retrying), true)
  const settled = { ...validPayload, status: "settled" as const }
  assert.equal(isDispatchValidationRetryPayload(settled), true)
})

test("review#2 schema · finalContent 类型错误（number）→ guard false / parse throws", () => {
  const bad = { ...validPayload, status: "exhausted" as const, finalContent: 42 }
  assert.equal(isDispatchValidationRetryPayload(bad), false)
  assert.throws(() => parseDispatchValidationRetryPayload(bad), /finalContent/i)
})

/**
 * F026 P4 follow-up · retry-badge-realtime fix:
 * settled / exhausted payload 必须能携带 retryCount + retryReasons，
 * 让前端 thread store 不刷新就能把这两个字段同步到对应 message。
 * retrying 阶段不带（attemptIndex 已表达进度）。
 */
test("retry-realtime schema · settled payload 携带 retryCount + retryReasons → guard true / parse 透传", () => {
  const settled = {
    ...validPayload,
    status: "settled" as const,
    retryCount: 1,
    retryReasons: ["nested_call_tag" as const],
  }
  assert.equal(isDispatchValidationRetryPayload(settled), true)
  const parsed = parseDispatchValidationRetryPayload(settled)
  assert.equal(parsed.retryCount, 1)
  assert.deepEqual(parsed.retryReasons, ["nested_call_tag"])
})

test("retry-realtime schema · exhausted payload 携带 retryCount + retryReasons → guard true / parse 透传", () => {
  const exhausted = {
    ...validPayload,
    status: "exhausted" as const,
    finalContent: "兜底内容",
    retryCount: 3,
    retryReasons: ["nested_call_tag" as const, "naked_at_with_real_teammate" as const],
  }
  assert.equal(isDispatchValidationRetryPayload(exhausted), true)
  const parsed = parseDispatchValidationRetryPayload(exhausted)
  assert.equal(parsed.retryCount, 3)
  assert.deepEqual(parsed.retryReasons, ["nested_call_tag", "naked_at_with_real_teammate"])
})

test("retry-realtime schema · retryCount/retryReasons 缺省（retrying 旧形态）仍然合法", () => {
  const retrying = { ...validPayload }
  assert.equal(isDispatchValidationRetryPayload(retrying), true)
  // 兼容历史 settled / exhausted（不带新字段）
  const settledLegacy = { ...validPayload, status: "settled" as const }
  assert.equal(isDispatchValidationRetryPayload(settledLegacy), true)
})

test("retry-realtime schema · retryCount 类型错误（string）→ guard false / parse throws", () => {
  const bad = { ...validPayload, status: "settled" as const, retryCount: "1" as unknown as number }
  assert.equal(isDispatchValidationRetryPayload(bad), false)
  assert.throws(() => parseDispatchValidationRetryPayload(bad), /retryCount/i)
})

test("retry-realtime schema · retryCount 负数 → guard false / parse throws", () => {
  const bad = { ...validPayload, status: "settled" as const, retryCount: -1 }
  assert.equal(isDispatchValidationRetryPayload(bad), false)
  assert.throws(() => parseDispatchValidationRetryPayload(bad), /retryCount/i)
})

test("retry-realtime schema · retryReasons 含非法 reason → guard false / parse throws", () => {
  const bad = {
    ...validPayload,
    status: "settled" as const,
    retryCount: 1,
    retryReasons: ["totally_bogus" as unknown as "nested_call_tag"],
  }
  assert.equal(isDispatchValidationRetryPayload(bad), false)
  assert.throws(() => parseDispatchValidationRetryPayload(bad), /retryReasons/i)
})

test("retry-realtime schema · retryReasons 不是数组 → guard false / parse throws", () => {
  const bad = {
    ...validPayload,
    status: "settled" as const,
    retryCount: 1,
    retryReasons: "nested_call_tag" as unknown as never[],
  }
  assert.equal(isDispatchValidationRetryPayload(bad), false)
  assert.throws(() => parseDispatchValidationRetryPayload(bad), /retryReasons/i)
})

test("AC-12 schema · 缺关键字段 → 拒绝", () => {
  const required = [
    "sessionGroupId",
    "threadId",
    "invocationId",
    "agentId",
    "messageId",
    "attemptIndex",
    "maxAttempts",
    "reason",
    "originalText",
    "status",
    "occurredAt",
  ] as const
  for (const k of required) {
    const bad: Record<string, unknown> = { ...validPayload }
    delete bad[k]
    assert.equal(isDispatchValidationRetryPayload(bad), false, `missing '${k}' should be rejected`)
  }
})

test("AC-13 fixture · buildDispatchRetryAgentEventRow → 含正确 eventType + JSON payload", () => {
  const row = buildDispatchRetryAgentEventRow(validPayload, { id: "evt-001" })
  assert.equal(row.id, "evt-001")
  assert.equal(row.invocationId, validPayload.invocationId)
  assert.equal(row.threadId, validPayload.threadId)
  assert.equal(row.agentId, validPayload.agentId)
  assert.equal(row.eventType, DISPATCH_VALIDATION_RETRY_EVENT_TYPE)
  assert.equal(row.eventType, "dispatch_validation_retry")
  assert.equal(row.createdAt, validPayload.occurredAt)
  // payload 是 JSON 字符串 — 反序列化后必须等于原 payload
  const decoded = JSON.parse(row.payload)
  assert.deepEqual(decoded, validPayload)
})

test("AC-13 fixture · buildDispatchRetryRealtimeEvent → discriminator + payload 透传", () => {
  const ev = buildDispatchRetryRealtimeEvent(validPayload)
  assert.equal(ev.type, "dispatch.validation_retry")
  assert.deepEqual(ev.payload, validPayload)
})

test("AC-13 单调 · attemptIndex 1→2→3 顺序构造的事件 attemptIndex 单调递增", () => {
  const events = [1, 2, 3].map((i) =>
    buildDispatchRetryRealtimeEvent({
      ...validPayload,
      attemptIndex: i,
      status: i === 3 ? "exhausted" : "retrying",
    }),
  )
  for (let i = 0; i < events.length - 1; i++) {
    assert.ok(events[i].payload.attemptIndex < events[i + 1].payload.attemptIndex)
  }
  assert.equal(events.at(-1)?.payload.status, "exhausted")
})

/**
 * 复验回归（review-001 · 范德彪 2026-04-28）：
 * 非 Claude 兜底路径在同一 attemptIndex 内先后写 retrying + exhausted；
 * 若 id 不区分 status，两行命中 agent_events.id PRIMARY KEY 冲突，
 * 第二行 INSERT 抛 UNIQUE constraint failed 被 catch 静默吞掉，
 * exhausted 历史在 DB 永久丢失。
 */

test("id helper · 同 attemptIndex 不同 status → id 互异（防主键冲突）", () => {
  const retryingId = buildDispatchRetryEventId({
    invocationId: "inv-XYZ",
    attemptIndex: 1,
    status: "retrying",
  })
  const settledId = buildDispatchRetryEventId({
    invocationId: "inv-XYZ",
    attemptIndex: 1,
    status: "settled",
  })
  const exhaustedId = buildDispatchRetryEventId({
    invocationId: "inv-XYZ",
    attemptIndex: 1,
    status: "exhausted",
  })
  // 三个状态必须落在不同 id 命名空间，retrying + settled / retrying + exhausted 同 attemptIndex 共存不冲突
  assert.notEqual(retryingId, settledId, "retrying / settled 必须落在不同 id 命名空间")
  assert.notEqual(retryingId, exhaustedId, "retrying / exhausted 必须落在不同 id 命名空间")
  assert.notEqual(settledId, exhaustedId, "settled / exhausted 必须落在不同 id 命名空间")
  assert.equal(retryingId, "dispatch-retry-inv-XYZ-1")
  assert.equal(settledId, "dispatch-retry-inv-XYZ-1-settled")
  assert.equal(exhaustedId, "dispatch-retry-inv-XYZ-1-exhausted")
})

test("id helper · 不同 invocationId 或 attemptIndex 也保持稳定", () => {
  // 跨 attemptIndex 单调
  assert.notEqual(
    buildDispatchRetryEventId({ invocationId: "inv-A", attemptIndex: 1, status: "retrying" }),
    buildDispatchRetryEventId({ invocationId: "inv-A", attemptIndex: 2, status: "retrying" }),
  )
  // 跨 invocationId 隔离
  assert.notEqual(
    buildDispatchRetryEventId({ invocationId: "inv-A", attemptIndex: 1, status: "retrying" }),
    buildDispatchRetryEventId({ invocationId: "inv-B", attemptIndex: 1, status: "retrying" }),
  )
})

test("persistence · 同 attemptIndex 的 retrying + exhausted 双事件均成功写入 agent_events", () => {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "dispatch-retry-event-"))
  const sqlitePath = path.join(tempDir, "multi-agent.sqlite")
  const store = new SqliteStore(sqlitePath)
  const repo = new SessionRepository(store)

  try {
    const groupId = repo.createSessionGroup("Test Room")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((item) => item.provider === "codex")
    assert.ok(thread)

    const invocationId = "inv-persistence-001"
    repo.createInvocation({
      id: invocationId,
      threadId: thread.id,
      agentId: thread.alias,
      callbackToken: "tok-persistence-001",
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      lastActivityAt: null,
    })

    const attemptIndex = 1
    const basePayload = {
      sessionGroupId: groupId,
      threadId: thread.id,
      invocationId,
      agentId: thread.alias,
      messageId: "msg-persistence-001",
      attemptIndex,
      maxAttempts: 3,
      reason: "nested_call_tag" as const,
      originalText: "[Call: @A 描述 [Call: @B] 接力]",
      occurredAt: "2026-04-28T10:00:00.000Z",
    }

    // 模拟非 Claude 兜底路径：同一 attemptIndex 先 retrying、再 exhausted。
    repo.appendAgentEvent(
      buildDispatchRetryAgentEventRow(
        { ...basePayload, status: "retrying" },
        {
          id: buildDispatchRetryEventId({ invocationId, attemptIndex, status: "retrying" }),
        },
      ),
    )
    repo.appendAgentEvent(
      buildDispatchRetryAgentEventRow(
        { ...basePayload, status: "exhausted" },
        {
          id: buildDispatchRetryEventId({ invocationId, attemptIndex, status: "exhausted" }),
        },
      ),
    )

    const rows = store.db
      .prepare(
        `SELECT id, event_type as eventType, payload
         FROM agent_events
         WHERE invocation_id = ?
         ORDER BY id ASC`,
      )
      .all(invocationId) as Array<{ id: string; eventType: string; payload: string }>

    assert.equal(rows.length, 2, "retrying + exhausted 两行均必须落库")
    const statuses = rows.map((r) => (JSON.parse(r.payload) as { status: string }).status).sort()
    assert.deepEqual(statuses, ["exhausted", "retrying"])
    for (const r of rows) {
      assert.equal(r.eventType, DISPATCH_VALIDATION_RETRY_EVENT_TYPE)
    }
  } finally {
    store.db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
