import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import type { DecisionRecord } from "@multi-agent/shared"

function createTestDb() {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "decision-record-test-"))
  const dbPath = path.join(tempDir, "test.sqlite")
  return { dbPath, tempDir }
}

function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows WAL file locks
  }
}

function pendingFixture(
  overrides: Partial<DecisionRecord> = {},
): Omit<DecisionRecord, "status" | "verdicts" | "userInput" | "resolvedAt"> {
  return {
    requestId: overrides.requestId ?? "req-1",
    sessionGroupId: overrides.sessionGroupId ?? "group-1",
    kind: overrides.kind ?? "multi_choice",
    title: overrides.title ?? "选一个方案",
    description: overrides.description,
    options: overrides.options ?? [
      { id: "a", label: "方案 A" },
      { id: "b", label: "方案 B" },
    ],
    multiSelect: overrides.multiSelect,
    anchorMessageId: overrides.anchorMessageId,
    sourceProvider: overrides.sourceProvider,
    sourceAlias: overrides.sourceAlias,
    createdAt: overrides.createdAt ?? "2026-07-02T10:00:00.000Z",
  }
}

async function setup() {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DecisionRecordRepository } = await import("./decision-record-repository")
  const { dbPath, tempDir } = createTestDb()
  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DecisionRecordRepository(db)
  return { repo, close, tempDir }
}

test("insertPending → listBySessionGroup 返回 pending 行且字段 round-trip", async () => {
  const { repo, close, tempDir } = await setup()
  try {
    repo.insertPending(
      pendingFixture({
        description: "两个都行选一个",
        multiSelect: true,
        anchorMessageId: "msg-9",
        sourceProvider: "claude",
        sourceAlias: "黄仁勋",
      }),
    )
    const rows = repo.listBySessionGroup("group-1")
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.requestId, "req-1")
    assert.equal(row.status, "pending")
    assert.equal(row.kind, "multi_choice")
    assert.equal(row.title, "选一个方案")
    assert.equal(row.description, "两个都行选一个")
    assert.equal(row.multiSelect, true)
    assert.equal(row.anchorMessageId, "msg-9")
    assert.equal(row.sourceProvider, "claude")
    assert.equal(row.sourceAlias, "黄仁勋")
    assert.deepEqual(row.options, [
      { id: "a", label: "方案 A" },
      { id: "b", label: "方案 B" },
    ])
    assert.equal(row.verdicts, undefined)
    assert.equal(row.resolvedAt, undefined)
    // 其他 group 看不到
    assert.equal(repo.listBySessionGroup("group-other").length, 0)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("markResolved 落 verdicts/userInput/status/resolvedAt", async () => {
  const { repo, close, tempDir } = await setup()
  try {
    repo.insertPending(pendingFixture())
    const ok = repo.markResolved("req-1", "resolved", [{ optionId: "a", verdict: "approved" }], "补充说明")
    assert.equal(ok, true)
    const [row] = repo.listBySessionGroup("group-1")
    assert.equal(row.status, "resolved")
    assert.deepEqual(row.verdicts, [{ optionId: "a", verdict: "approved" }])
    assert.equal(row.userInput, "补充说明")
    assert.ok(row.resolvedAt, "resolvedAt should be set")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("markResolved 幂等门：已 resolved 不再覆盖（respond/timeout 竞态）", async () => {
  const { repo, close, tempDir } = await setup()
  try {
    repo.insertPending(pendingFixture())
    assert.equal(repo.markResolved("req-1", "resolved", [{ optionId: "a", verdict: "approved" }], ""), true)
    // timeout 竞态到达：必须被幂等门挡下
    assert.equal(repo.markResolved("req-1", "timeout", [{ optionId: "a", verdict: "rejected" }], ""), false)
    const [row] = repo.listBySessionGroup("group-1")
    assert.equal(row.status, "resolved")
    assert.deepEqual(row.verdicts, [{ optionId: "a", verdict: "approved" }])
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("markResolved 未知 requestId 返回 false", async () => {
  const { repo, close, tempDir } = await setup()
  try {
    assert.equal(repo.markResolved("nope", "resolved", [], ""), false)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("orphanAllPending 只动 pending 行", async () => {
  const { repo, close, tempDir } = await setup()
  try {
    repo.insertPending(pendingFixture({ requestId: "req-1" }))
    repo.insertPending(pendingFixture({ requestId: "req-2" }))
    repo.markResolved("req-2", "resolved", [{ optionId: "a", verdict: "approved" }], "")
    const orphaned = repo.orphanAllPending()
    assert.equal(orphaned, 1)
    const rows = repo.listBySessionGroup("group-1")
    const byId = new Map(rows.map((r) => [r.requestId, r]))
    assert.equal(byId.get("req-1")?.status, "orphaned")
    assert.equal(byId.get("req-2")?.status, "resolved")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("listBySessionGroup excludePending 过滤 + createdAt 升序 + limit", async () => {
  const { repo, close, tempDir } = await setup()
  try {
    repo.insertPending(pendingFixture({ requestId: "req-1", createdAt: "2026-07-02T10:00:00.000Z" }))
    repo.insertPending(pendingFixture({ requestId: "req-2", createdAt: "2026-07-02T09:00:00.000Z" }))
    repo.insertPending(pendingFixture({ requestId: "req-3", createdAt: "2026-07-02T11:00:00.000Z" }))
    repo.markResolved("req-2", "timeout", [], "")

    const nonPending = repo.listBySessionGroup("group-1", { excludePending: true })
    assert.deepEqual(
      nonPending.map((r) => r.requestId),
      ["req-2"],
    )

    const all = repo.listBySessionGroup("group-1")
    assert.deepEqual(
      all.map((r) => r.requestId),
      ["req-2", "req-1", "req-3"],
    )

    const limited = repo.listBySessionGroup("group-1", { limit: 2 })
    assert.equal(limited.length, 2)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})
