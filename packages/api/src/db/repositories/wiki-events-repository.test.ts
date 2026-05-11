/**
 * F027 P1 · WikiEventsRepository 状态机单测
 * 真相源：docs/plans/V16.5-final.md chap 5
 *
 * 覆盖：
 *   - PREPARE → COMMIT happy path
 *   - PREPARE → ABORT happy path
 *   - 重复 commit / abort = noop（idempotent retry safe）
 *   - commit-after-abort / abort-after-commit = noop（CAS 防转）
 *   - getPending 只返回 state='pending'
 *   - getByPath / getByAlias 按 ts DESC + limit 截断
 *   - source_message_ids JSON roundtrip
 *   - getByState committed/aborted 分类
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}

function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows WAL locks — best effort
  }
}

async function buildRepo() {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { WikiEventsRepository } = await import("./wiki-events-repository")
  const tempDir = safeTempDir("wiki-events-repo-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const repo = new WikiEventsRepository(db)
  return {
    repo,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

const baseInput = {
  ts: "2026-05-11T10:00:00Z",
  alias: "黄仁勋",
  action: "write" as const,
  path: "wiki/project/F027.md",
  attemptedHash: "sha256:attempt-1",
  fencingToken: "9999",
  leaderTerm: "term-1",
  result: "ok" as const,
}

test("F027 P1: appendPending → commit happy path（contentHash + manifest 落库 + state=committed）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({ ...baseInput, baseHash: null })
    assert.equal(evt.state, "pending")
    assert.equal(evt.contentHash, null)
    assert.equal(typeof evt.id, "number")

    const committed = repo.commit(evt.id, {
      contentHash: "sha256:final-1",
      resultManifestVersion: "manifest-v42",
    })
    assert.equal(committed, true)

    const after = repo.get(evt.id)
    assert.ok(after)
    assert.equal(after.state, "committed")
    assert.equal(after.contentHash, "sha256:final-1")
    assert.equal(after.resultManifestVersion, "manifest-v42")
    assert.equal(after.attemptedHash, "sha256:attempt-1") // 不变
  } finally {
    cleanup()
  }
})

test("F027 P1: appendPending → abort happy path（error/reason 落库 + state=aborted）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({ ...baseInput })
    const aborted = repo.abort(evt.id, {
      error: "compiler crashed mid-write",
      reason: "timeout",
    })
    assert.equal(aborted, true)

    const after = repo.get(evt.id)
    assert.ok(after)
    assert.equal(after.state, "aborted")
    assert.equal(after.error, "compiler crashed mid-write")
    assert.equal(after.reason, "timeout")
    assert.equal(after.contentHash, null) // 事件未生效
  } finally {
    cleanup()
  }
})

test("F027 P1: 重复 commit 是 noop（CAS 第二次返回 false，row 不变）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({ ...baseInput })
    assert.equal(repo.commit(evt.id, { contentHash: "sha256:first" }), true)
    // 重复 commit 不同 hash —— 第二次必须 noop，row 保留第一次的 hash
    assert.equal(repo.commit(evt.id, { contentHash: "sha256:second" }), false)
    const after = repo.get(evt.id)
    assert.equal(after?.contentHash, "sha256:first")
  } finally {
    cleanup()
  }
})

test("F027 P1: 重复 abort 是 noop（CAS 第二次返回 false）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({ ...baseInput })
    assert.equal(repo.abort(evt.id, { reason: "first" }), true)
    assert.equal(repo.abort(evt.id, { reason: "second" }), false)
    const after = repo.get(evt.id)
    assert.equal(after?.reason, "first")
  } finally {
    cleanup()
  }
})

test("F027 P1: commit-after-abort = noop（aborted 行不能被 commit 覆盖）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({ ...baseInput })
    repo.abort(evt.id, { reason: "skipped" })
    const ok = repo.commit(evt.id, { contentHash: "sha256:should-not-apply" })
    assert.equal(ok, false)
    const after = repo.get(evt.id)
    assert.equal(after?.state, "aborted")
    assert.equal(after?.contentHash, null)
  } finally {
    cleanup()
  }
})

test("F027 P1: abort-after-commit = noop（committed 行不能被 abort 反悔）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({ ...baseInput })
    repo.commit(evt.id, { contentHash: "sha256:final" })
    const ok = repo.abort(evt.id, { reason: "too-late" })
    assert.equal(ok, false)
    const after = repo.get(evt.id)
    assert.equal(after?.state, "committed")
  } finally {
    cleanup()
  }
})

test("F027 P1: getPending 只返回 state='pending' + 按 ts ASC（reconciler 顺序处理）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const e1 = repo.appendPending({ ...baseInput, ts: "2026-05-11T10:00:00Z" })
    const e2 = repo.appendPending({ ...baseInput, ts: "2026-05-11T10:01:00Z" })
    const e3 = repo.appendPending({ ...baseInput, ts: "2026-05-11T10:02:00Z" })
    repo.commit(e2.id, { contentHash: "sha256:done" })

    const pending = repo.getPending()
    assert.equal(pending.length, 2)
    assert.equal(pending[0].id, e1.id) // ASC：先 e1 再 e3
    assert.equal(pending[1].id, e3.id)
    for (const p of pending) assert.equal(p.state, "pending")
  } finally {
    cleanup()
  }
})

test("F027 P1: getByPath 按 ts DESC + limit 截断", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const targetPath = "wiki/project/F027.md"
    repo.appendPending({ ...baseInput, ts: "2026-05-11T09:00:00Z", path: targetPath })
    repo.appendPending({ ...baseInput, ts: "2026-05-11T10:00:00Z", path: targetPath })
    repo.appendPending({ ...baseInput, ts: "2026-05-11T11:00:00Z", path: targetPath })
    repo.appendPending({ ...baseInput, ts: "2026-05-11T12:00:00Z", path: "wiki/other.md" })

    const recent = repo.getByPath(targetPath, 2)
    assert.equal(recent.length, 2)
    assert.equal(recent[0].ts, "2026-05-11T11:00:00Z") // DESC
    assert.equal(recent[1].ts, "2026-05-11T10:00:00Z")
  } finally {
    cleanup()
  }
})

test("F027 P1: getByAlias 按 alias 过滤 + ts DESC", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.appendPending({ ...baseInput, alias: "黄仁勋", ts: "2026-05-11T10:00:00Z" })
    repo.appendPending({ ...baseInput, alias: "范德彪", ts: "2026-05-11T10:01:00Z" })
    repo.appendPending({ ...baseInput, alias: "黄仁勋", ts: "2026-05-11T10:02:00Z" })

    const huang = repo.getByAlias("黄仁勋")
    assert.equal(huang.length, 2)
    assert.equal(huang[0].ts, "2026-05-11T10:02:00Z")
    assert.equal(huang[1].ts, "2026-05-11T10:00:00Z")
    for (const e of huang) assert.equal(e.alias, "黄仁勋")
  } finally {
    cleanup()
  }
})

test("F027 P1: source_message_ids JSON roundtrip（写 array → 读回 array）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({
      ...baseInput,
      sourceMessageIds: ["msg-1", "msg-2", "msg-3"],
    })
    const back = repo.get(evt.id)
    assert.deepEqual(back?.sourceMessageIds, ["msg-1", "msg-2", "msg-3"])

    // null 也合法
    const evt2 = repo.appendPending({ ...baseInput, sourceMessageIds: null })
    const back2 = repo.get(evt2.id)
    assert.equal(back2?.sourceMessageIds, null)

    // 缺省同 null
    const evt3 = repo.appendPending({ ...baseInput })
    const back3 = repo.get(evt3.id)
    assert.equal(back3?.sourceMessageIds, null)
  } finally {
    cleanup()
  }
})

test("F027 P1: getByState 分类查（committed / aborted observability）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const e1 = repo.appendPending({ ...baseInput, ts: "2026-05-11T10:00:00Z" })
    const e2 = repo.appendPending({ ...baseInput, ts: "2026-05-11T10:01:00Z" })
    const e3 = repo.appendPending({ ...baseInput, ts: "2026-05-11T10:02:00Z" })
    repo.commit(e1.id, { contentHash: "sha256:c1" })
    repo.commit(e2.id, { contentHash: "sha256:c2" })
    repo.abort(e3.id, { reason: "denied" })

    const committed = repo.getByState("committed")
    assert.equal(committed.length, 2)
    for (const e of committed) assert.equal(e.state, "committed")

    const aborted = repo.getByState("aborted")
    assert.equal(aborted.length, 1)
    assert.equal(aborted[0].state, "aborted")
    assert.equal(aborted[0].reason, "denied")

    const pending = repo.getByState("pending")
    assert.equal(pending.length, 0)
  } finally {
    cleanup()
  }
})

test("F027 P1: appendPending 不带 baseHash（首次写新 path 合法）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const evt = repo.appendPending({ ...baseInput, baseHash: null })
    assert.equal(evt.baseHash, null)
    assert.equal(evt.state, "pending")
    // 缺省同 null
    const evt2 = repo.appendPending({ ...baseInput })
    assert.equal(evt2.baseHash, null)
  } finally {
    cleanup()
  }
})

test("F027 P1: 不存在的 eventId commit/abort 返回 false（不抛）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    assert.equal(repo.commit(99999, { contentHash: "x" }), false)
    assert.equal(repo.abort(99999, { reason: "y" }), false)
    assert.equal(repo.get(99999), null)
  } finally {
    cleanup()
  }
})
