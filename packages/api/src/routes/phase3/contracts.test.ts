/**
 * F027 Phase 3 P20 · Backend Contract tests — Week 1 Day 2
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1 Day 2
 *   + 范-r1 P2-1 mitigation（contract tests）
 *
 * 覆盖：
 *   - 8 endpoint × 每个 ≥ 4 case（happy / invalid path / boundary / empty）
 *   - 错误码路由（INVALID_ROOM_ID / VALIDATION_FAILED / DECISION_INVALID / UNAUTHORIZED）
 *   - HTTP_STATUS_BY_ERROR 完整覆盖
 *   - toErrorResponse helper
 *
 * 不做：
 *   - 不接 fastify / service / repository（Day 3-10 才有真路由 + 真业务）
 *   - 不做 fixture 落盘（contract 层纯 in-memory）
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  ErrorCode,
  HTTP_STATUS_BY_ERROR,
  toErrorResponse,
  validateGetCoverage,
  validateGetPromptInspector,
  validateGetViewfinder,
  validateListDrafts,
  validateListJobTraces,
  validatePostDecision,
  validatePostIngestCommit,
  validatePreviewIngest,
  validateRoomId,
} from "./contracts"

// ── 共享 helpers ────────────────────────────────────────────────────

test("Day 2 · validateRoomId · 合法 R-XXX 格式", () => {
  for (const id of ["R-0", "R-1", "R-42", "R-201", "R-999999"]) {
    const r = validateRoomId(id)
    assert.equal(r.ok, true, `expected ${id} valid`)
    if (r.ok) assert.equal(r.value, id)
  }
})

test("Day 2 · validateRoomId · 拒非法（空 / 缺前缀 / 含字母 / 太长）", () => {
  const cases: unknown[] = [
    "",
    null,
    undefined,
    42,
    "R-",
    "R-abc",
    "r-201",
    "R-1234567",
    "Room-201",
    " R-201",
    "R-201 ",
  ]
  for (const raw of cases) {
    const r = validateRoomId(raw)
    assert.equal(r.ok, false, `expected ${JSON.stringify(raw)} invalid`)
    if (!r.ok) assert.equal(r.error, ErrorCode.INVALID_ROOM_ID)
  }
})

test("Day 2 · HTTP_STATUS_BY_ERROR · 每个 ErrorCode 都有 status code", () => {
  const codes = Object.values(ErrorCode)
  assert.equal(codes.length, 11, "ErrorCode enum should have 11 entries")
  for (const code of codes) {
    const status = HTTP_STATUS_BY_ERROR[code]
    assert.ok(status, `${code} should have HTTP status`)
    assert.ok(status >= 400 && status <= 599, `${code} status ${status} not 4xx/5xx`)
  }
})

test("Day 2 · toErrorResponse · 拷贝 error/message/detail", () => {
  const fail = {
    ok: false as const,
    error: "VALIDATION_FAILED" as const,
    message: "boom",
    detail: { field: "limit", got: 999 },
  }
  const body = toErrorResponse(fail)
  assert.deepEqual(body, {
    error: "VALIDATION_FAILED",
    message: "boom",
    detail: { field: "limit", got: 999 },
  })
})

test("Day 2 · toErrorResponse · detail 缺省不出现在 body 上", () => {
  const fail = {
    ok: false as const,
    error: "INVALID_ROOM_ID" as const,
    message: "bad",
  }
  const body = toErrorResponse(fail)
  assert.deepEqual(body, { error: "INVALID_ROOM_ID", message: "bad" })
  assert.equal(Object.prototype.hasOwnProperty.call(body, "detail"), false)
})

// ── 1. GET /api/rooms/:id/viewfinder ────────────────────────────────

test("Day 2 · GET viewfinder · 合法 path → roomId 透传", () => {
  const r = validateGetViewfinder({ id: "R-201" })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.value, { roomId: "R-201" })
})

test("Day 2 · GET viewfinder · 缺 id / 非法 id → INVALID_ROOM_ID", () => {
  for (const params of [{}, { id: "" }, { id: "not-a-room" }, null]) {
    const r = validateGetViewfinder(params)
    assert.equal(r.ok, false, `${JSON.stringify(params)} should fail`)
    if (!r.ok) assert.equal(r.error, ErrorCode.INVALID_ROOM_ID)
  }
})

// ── 2. GET /api/wiki/drafts ──────────────────────────────────────────

test("Day 2 · GET drafts · 空 query → 默认 (limit/offset 缺省由 service 端 clamp)", () => {
  const r = validateListDrafts({})
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.value, {})
})

test("Day 2 · GET drafts · 全字段合法", () => {
  const r = validateListDrafts({
    type: "feature",
    mtimeFrom: "2026-05-01T00:00:00Z",
    mtimeTo: "2026-05-20T00:00:00Z",
    limit: 100,
    offset: 50,
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.type, "feature")
    assert.equal(r.value.limit, 100)
    assert.equal(r.value.offset, 50)
  }
})

test("Day 2 · GET drafts · type 越界 → VALIDATION_FAILED", () => {
  const r = validateListDrafts({ type: "not-a-type" })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
    assert.match(r.message, /type must be one of/)
  }
})

test("Day 2 · GET drafts · limit 越界 → VALIDATION_FAILED", () => {
  for (const limit of [0, -1, 999, "not-int"]) {
    const r = validateListDrafts({ limit })
    assert.equal(r.ok, false, `limit=${limit} should fail`)
    if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
  }
})

test("Day 2 · GET drafts · mtimeFrom 非 ISO → VALIDATION_FAILED", () => {
  const r = validateListDrafts({ mtimeFrom: "not-iso" })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
    assert.match(r.message, /ISO/)
  }
})

test("Day 2 · GET drafts · mtimeFrom > mtimeTo → VALIDATION_FAILED", () => {
  const r = validateListDrafts({
    mtimeFrom: "2026-05-20T00:00:00Z",
    mtimeTo: "2026-05-01T00:00:00Z",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
    assert.match(r.message, /must be <=/)
  }
})

test("Day 2 · GET drafts · query 字段串 (来自 URL) 也接受", () => {
  // fastify 默认 query 字段都是 string；测 takeOptionalInt 能正确 parse
  const r = validateListDrafts({ limit: "75", offset: "10" })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.limit, 75)
    assert.equal(r.value.offset, 10)
  }
})

// ── 3. GET /api/rooms/:id/prompt-inspector ──────────────────────────

test("Day 2 · GET prompt-inspector · 合法 path + 空 query", () => {
  const r = validateGetPromptInspector({ id: "R-201" }, {})
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.value, { roomId: "R-201", threadId: undefined })
})

test("Day 2 · GET prompt-inspector · threadId 传入", () => {
  const r = validateGetPromptInspector({ id: "R-201" }, { threadId: "t-42" })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value.threadId, "t-42")
})

test("Day 2 · GET prompt-inspector · 非法 roomId → INVALID_ROOM_ID", () => {
  const r = validateGetPromptInspector({ id: "bad" }, {})
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.INVALID_ROOM_ID)
})

// ── 4. POST /api/wiki/ingest/preview ────────────────────────────────

test("Day 2 · POST preview · 合法 markdown 输入", () => {
  const r = validatePreviewIngest({
    sourcePath: "docs/features/F999-test.md",
    content: "# Hello\n\nbody",
    mimeType: "text/markdown",
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.sourcePath, "docs/features/F999-test.md")
    assert.equal(r.value.mimeType, "text/markdown")
  }
})

test("Day 2 · POST preview · 不支持的 mime → VALIDATION_FAILED", () => {
  const r = validatePreviewIngest({
    sourcePath: "a.exe",
    content: "PK",
    mimeType: "application/octet-stream",
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

test("Day 2 · POST preview · content 超 1MB → VALIDATION_FAILED", () => {
  const r = validatePreviewIngest({
    sourcePath: "big.md",
    content: "a".repeat(1_048_577),
    mimeType: "text/markdown",
  })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
    assert.match(r.message, /exceeds/)
  }
})

test("Day 2 · POST preview · 空 content → VALIDATION_FAILED", () => {
  const r = validatePreviewIngest({
    sourcePath: "empty.md",
    content: "",
    mimeType: "text/markdown",
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

test("Day 2 · POST preview · 缺 mimeType → VALIDATION_FAILED", () => {
  const r = validatePreviewIngest({
    sourcePath: "foo.md",
    content: "hi",
  })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

test("Day 2 · POST preview · body 为 null → VALIDATION_FAILED", () => {
  const r = validatePreviewIngest(null)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

// ── 5. POST /api/rooms/:id/decisions （AC-P3-8） ────────────────────

test("Day 2 · POST decision · 合法 commit + 1 evidence + callerAlias（Day 6 锁）", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    {
      kind: "commit",
      content: "F027 Phase 3 plan v3 frozen",
      evidence: [{ kind: "message", ref: "msg-001" }],
      callerAlias: "小孙",
    },
  )
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.roomId, "R-201")
    assert.equal(r.value.body.kind, "commit")
    assert.equal(r.value.body.evidence.length, 1)
    assert.equal(r.value.body.callerAlias, "小孙")
  }
})

test("Day 2 · POST decision · 合法 tombstone + 数字 supersedesDecisionId（Day 6 锁 ROWID）", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    {
      kind: "tombstone",
      content: "撤回 2026-05-19 决策",
      evidence: [{ kind: "decision", ref: "42" }],
      supersedesDecisionId: "42",
      callerAlias: "小孙",
    },
  )
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.body.supersedesDecisionId, "42")
  }
})

test("Day 2 · POST decision · kind 越界 → DECISION_INVALID", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    {
      kind: "approve",
      content: "ok",
      evidence: [{ kind: "message", ref: "msg-001" }],
    },
  )
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error, ErrorCode.DECISION_INVALID)
    assert.match(r.message, /commit\|reject\|tombstone/)
  }
})

test("Day 2 · POST decision · evidence 数组空 → DECISION_INVALID", () => {
  const r = validatePostDecision({ id: "R-201" }, { kind: "commit", content: "ok", evidence: [] })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.DECISION_INVALID)
})

test("Day 2 · POST decision · evidence ref 缺 → DECISION_INVALID", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    { kind: "commit", content: "ok", evidence: [{ kind: "message" }] },
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.DECISION_INVALID)
})

test("Day 2 · POST decision · content > 4000 → DECISION_INVALID", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    {
      kind: "commit",
      content: "a".repeat(4001),
      evidence: [{ kind: "message", ref: "msg-001" }],
    },
  )
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error, ErrorCode.DECISION_INVALID)
    assert.match(r.message, /4000/)
  }
})

test("Day 2 · POST decision · 非法 roomId 优先于 body validation", () => {
  const r = validatePostDecision(
    { id: "bad" },
    { kind: "commit", content: "ok", evidence: [{ kind: "message", ref: "msg-001" }] },
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.INVALID_ROOM_ID)
})

// ── 6. GET /api/rooms/:id/decisions/coverage ────────────────────────

test("Day 2 · GET coverage · 合法 roomId", () => {
  const r = validateGetCoverage({ id: "R-201" })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.value, { roomId: "R-201" })
})

test("Day 2 · GET coverage · 非法 → INVALID_ROOM_ID", () => {
  const r = validateGetCoverage({ id: "" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.INVALID_ROOM_ID)
})

// ── 7. POST /api/wiki/ingest/commit （AC-P3-10） ────────────────────

test("Day 2 · POST commit · 合法 previewId + callerAlias", () => {
  const r = validatePostIngestCommit({
    previewId: "pv-001",
    callerAlias: "黄仁勋",
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.previewId, "pv-001")
    assert.equal(r.value.callerAlias, "黄仁勋")
    assert.equal(r.value.leaseToken, undefined)
  }
})

test("Day 2 · POST commit · 含 leaseToken", () => {
  const r = validatePostIngestCommit({
    previewId: "pv-001",
    callerAlias: "黄仁勋",
    leaseToken: "lease-abc",
  })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value.leaseToken, "lease-abc")
})

test("Day 2 · POST commit · 缺 previewId → VALIDATION_FAILED", () => {
  const r = validatePostIngestCommit({ callerAlias: "黄仁勋" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

test("Day 2 · POST commit · 缺 callerAlias → VALIDATION_FAILED + detail.reason='caller_required'（范-r1 P2-2）", () => {
  const r = validatePostIngestCommit({ previewId: "pv-001" })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
    assert.match(r.message, /callerAlias/)
    assert.equal(r.detail?.reason, "caller_required")
  }
})

test("Day 2 · POST commit · body 为 null → VALIDATION_FAILED", () => {
  const r = validatePostIngestCommit(null)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

// ── 8. GET /api/scheduler/job-traces ────────────────────────────────

test("Day 2 · GET job-traces · 空 query", () => {
  const r = validateListJobTraces({})
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.value, {})
})

test("Day 2 · GET job-traces · 全字段合法", () => {
  const r = validateListJobTraces({
    jobName: "room-compiler-tick",
    status: "failed",
    since: "2026-05-01T00:00:00Z",
    limit: 100,
  })
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.jobName, "room-compiler-tick")
    assert.equal(r.value.status, "failed")
    assert.equal(r.value.limit, 100)
  }
})

test("Day 2 · GET job-traces · jobName 含非法字符 → VALIDATION_FAILED", () => {
  const r = validateListJobTraces({ jobName: "rm -rf /" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

test("Day 2 · GET job-traces · status 越界 → VALIDATION_FAILED", () => {
  const r = validateListJobTraces({ status: "running" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

test("Day 2 · GET job-traces · limit > 500 → VALIDATION_FAILED", () => {
  const r = validateListJobTraces({ limit: 1000 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})

test("Day 2 · GET job-traces · since 非 ISO → VALIDATION_FAILED", () => {
  const r = validateListJobTraces({ since: "yesterday" })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.error, ErrorCode.VALIDATION_FAILED)
})
