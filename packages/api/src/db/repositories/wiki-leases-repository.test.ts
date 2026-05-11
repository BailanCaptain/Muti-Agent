/**
 * F027 P3 · WikiLeasesRepository lease 状态机 + fencing 单调性单测
 * 真相源：docs/plans/V16.5-final.md chap 6
 *
 * 覆盖：
 *   - nextFencingToken 严格单调递增
 *   - acquireLease happy path（path 无 lease 时拿到）
 *   - acquireLease 在已有未过期 lease 时返回 null（防并发抢占）
 *   - acquireLease 抢占已过期 lease（覆盖 + 换 token + 换 owner）
 *   - acquireLease 每次抢占都换新 token（防 ABA）
 *   - renewLease happy path（持有者延长）
 *   - renewLease 不持有 token 时返回 null
 *   - renewLease 已过期时返回 null（要求 reacquire）
 *   - releaseLease 持有者删除 + isCurrent false
 *   - releaseLease 非持有者 = false（noop）
 *   - isCurrent 当前 token + 未过期 = true
 *   - isCurrent 已过期 = false
 *   - get 返回 hydrated row / null
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
  const { WikiLeasesRepository } = await import("./wiki-leases-repository")
  const tempDir = safeTempDir("wiki-leases-repo-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const repo = new WikiLeasesRepository(db)
  return {
    repo,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

const T0 = "2026-05-11T10:00:00.000Z"
const T_PLUS_10 = "2026-05-11T10:00:10.000Z"
const T_PLUS_31 = "2026-05-11T10:00:31.000Z" // 过 30s ttl

const baseAcquire = {
  path: "wiki/project/F027.md",
  ownerAlias: "黄仁勋",
  ttlSeconds: 30,
  leaderTerm: "term-1",
}

test("F027 P3 nextFencingToken 严格单调递增", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const t1 = repo.nextFencingToken()
    const t2 = repo.nextFencingToken()
    const t3 = repo.nextFencingToken()
    assert.equal(t1, "1")
    assert.equal(t2, "2")
    assert.equal(t3, "3")
  } finally {
    cleanup()
  }
})

test("F027 P3 acquireLease happy path：无 lease 时拿到", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const result = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(result, "expected lease success")
    assert.equal(result.fencingToken, "1")
    assert.equal(result.expiresAt, "2026-05-11T10:00:30.000Z")
    const lease = repo.get(baseAcquire.path)
    assert.ok(lease)
    assert.equal(lease.ownerAlias, "黄仁勋")
    assert.equal(lease.leaderTerm, "term-1")
  } finally {
    cleanup()
  }
})

test("F027 P3 acquireLease 已有未过期 lease 时返回 null", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(first)
    // T+10s 时另一个 owner 来抢，原 lease 30s 还没过期 → null
    const second = repo.acquireLease({
      ...baseAcquire,
      ownerAlias: "范德彪",
      now: T_PLUS_10,
    })
    assert.equal(second, null)
    const lease = repo.get(baseAcquire.path)
    assert.equal(lease?.ownerAlias, "黄仁勋", "原 lease owner 不变")
    assert.equal(lease?.fencingToken, "1", "原 token 不变")
  } finally {
    cleanup()
  }
})

test("F027 P3 acquireLease 抢占已过期 lease：换 owner + 换 token", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(first)
    assert.equal(first.fencingToken, "1")
    // T+31s lease 已过期，范德彪抢
    const second = repo.acquireLease({
      ...baseAcquire,
      ownerAlias: "范德彪",
      now: T_PLUS_31,
    })
    assert.ok(second, "expected preempt success")
    assert.equal(second.fencingToken, "2", "新 owner 拿新 token")
    const lease = repo.get(baseAcquire.path)
    assert.equal(lease?.ownerAlias, "范德彪")
    assert.equal(lease?.fencingToken, "2")
  } finally {
    cleanup()
  }
})

test("F027 P3 acquireLease 防 ABA：每次抢占换新 token，旧 token 不可复用", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    // 第一次拿 token=1 后过期、抢占拿 token=2、再过期、再拿 token=3
    repo.acquireLease({ ...baseAcquire, now: T0 })
    const t31 = repo.acquireLease({ ...baseAcquire, ownerAlias: "范德彪", now: T_PLUS_31 })
    const t62 = repo.acquireLease({
      ...baseAcquire,
      ownerAlias: "桂芬",
      now: "2026-05-11T10:01:02.000Z",
    })
    assert.equal(t31?.fencingToken, "2")
    assert.equal(t62?.fencingToken, "3")
    assert.notEqual(t31?.fencingToken, t62?.fencingToken)
  } finally {
    cleanup()
  }
})

test("F027 P3 renewLease 持有者延长 expires_at", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(first)
    const renewed = repo.renewLease({
      path: baseAcquire.path,
      fencingToken: first.fencingToken,
      ttlSeconds: 30,
      now: T_PLUS_10,
    })
    assert.ok(renewed, "expected renew success")
    assert.equal(renewed.fencingToken, first.fencingToken, "renew 不换 token")
    assert.equal(renewed.expiresAt, "2026-05-11T10:00:40.000Z")
  } finally {
    cleanup()
  }
})

test("F027 P3 renewLease 非持有者 token = null", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.acquireLease({ ...baseAcquire, now: T0 })
    const renewed = repo.renewLease({
      path: baseAcquire.path,
      fencingToken: "999",
      ttlSeconds: 30,
      now: T_PLUS_10,
    })
    assert.equal(renewed, null)
  } finally {
    cleanup()
  }
})

test("F027 P3 renewLease 已过期 = null（要求 reacquire）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(first)
    const renewed = repo.renewLease({
      path: baseAcquire.path,
      fencingToken: first.fencingToken,
      ttlSeconds: 30,
      now: T_PLUS_31,
    })
    assert.equal(renewed, null, "过期 lease 不可 renew")
  } finally {
    cleanup()
  }
})

test("F027 P3 releaseLease 持有者删除 + isCurrent false", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(first)
    const released = repo.releaseLease({
      path: baseAcquire.path,
      fencingToken: first.fencingToken,
    })
    assert.equal(released, true)
    assert.equal(repo.get(baseAcquire.path), null)
    assert.equal(repo.isCurrent(baseAcquire.path, first.fencingToken, T_PLUS_10), false)
  } finally {
    cleanup()
  }
})

test("F027 P3 releaseLease 非持有者 = false noop", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    repo.acquireLease({ ...baseAcquire, now: T0 })
    const released = repo.releaseLease({
      path: baseAcquire.path,
      fencingToken: "999",
    })
    assert.equal(released, false)
    assert.ok(repo.get(baseAcquire.path), "原 lease 未受影响")
  } finally {
    cleanup()
  }
})

test("F027 P3 isCurrent：当前 token 未过期 = true", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(first)
    assert.equal(repo.isCurrent(baseAcquire.path, first.fencingToken, T_PLUS_10), true)
  } finally {
    cleanup()
  }
})

test("F027 P3 isCurrent：已过期 = false", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const first = repo.acquireLease({ ...baseAcquire, now: T0 })
    assert.ok(first)
    assert.equal(repo.isCurrent(baseAcquire.path, first.fencingToken, T_PLUS_31), false)
  } finally {
    cleanup()
  }
})

test("F027 P3 get 返回 hydrated row / null", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    assert.equal(repo.get("wiki/never-existed.md"), null)
    repo.acquireLease({ ...baseAcquire, now: T0 })
    const lease = repo.get(baseAcquire.path)
    assert.ok(lease)
    assert.equal(lease.path, baseAcquire.path)
    assert.equal(lease.ownerAlias, "黄仁勋")
    assert.equal(lease.acquiredAt, T0)
  } finally {
    cleanup()
  }
})
