/**
 * F027 P3.5 · CompilerLeaderRepository 单测 + 触发器联动 + AC-P2-5 双 instance 抢占
 * 真相源：docs/plans/V16.5-final.md chap 5
 *
 * 覆盖：
 *   - acquireLeader 无 leader → term=1
 *   - acquireLeader 已过期 → 抢占 + term++
 *   - acquireLeader 现任未过期 → null（即使 caller 是现任也拒）
 *   - acquireLeader 防 ABA：term 严格单调递增
 *   - renewLeader 持有 → 延长
 *   - renewLeader term 不匹配 → null
 *   - renewLeader 已过期 → null
 *   - releaseLeader CAS by term
 *   - getCurrent / isLeader
 *   - reject_stale_leader 触发器：旧 leader_term 写 wiki_events → SQL ABORT
 *   - 启动期（无 leader 行）写 wiki_events 不被触发器拒
 *   - AC-P2-5 双 instance 抢占：A 写 → B 抢 → A 用旧 term 再写 → 触发器拒
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
    // best effort
  }
}

async function build() {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { CompilerLeaderRepository } = await import("./compiler-leader-repository")
  const { WikiEventsRepository } = await import("./wiki-events-repository")
  const tempDir = safeTempDir("compiler-leader-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const leader = new CompilerLeaderRepository(db)
  const events = new WikiEventsRepository(db)
  return {
    leader,
    events,
    db,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

const T0 = "2026-05-11T10:00:00.000Z"
const T_PLUS_5 = "2026-05-11T10:00:05.000Z"
const T_PLUS_31 = "2026-05-11T10:00:31.000Z" // 30s ttl 已过期

test("F027 P3.5 acquireLeader 无 leader → term=1 + 当选", async () => {
  const { leader, cleanup } = await build()
  try {
    const r = leader.acquireLeader({ leaderAlias: "instance-A", ttlSeconds: 30, now: T0 })
    assert.ok(r)
    assert.equal(r.currentTerm, "1")
    assert.equal(r.leaseExpiresAt, "2026-05-11T10:00:30.000Z")
    const cur = leader.getCurrent()
    assert.equal(cur?.leaderAlias, "instance-A")
    assert.equal(cur?.currentTerm, "1")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 acquireLeader 现任未过期 → null（即使同 alias 也拒）", async () => {
  const { leader, cleanup } = await build()
  try {
    leader.acquireLeader({ leaderAlias: "instance-A", ttlSeconds: 30, now: T0 })
    // T+5 instance-B 抢
    const r1 = leader.acquireLeader({ leaderAlias: "instance-B", ttlSeconds: 30, now: T_PLUS_5 })
    assert.equal(r1, null)
    // 同 alias 也拒（必须走 renewLeader）
    const r2 = leader.acquireLeader({ leaderAlias: "instance-A", ttlSeconds: 30, now: T_PLUS_5 })
    assert.equal(r2, null)
    const cur = leader.getCurrent()
    assert.equal(cur?.currentTerm, "1", "term 不变")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 acquireLeader 已过期 → 抢占 + term++", async () => {
  const { leader, cleanup } = await build()
  try {
    leader.acquireLeader({ leaderAlias: "instance-A", ttlSeconds: 30, now: T0 })
    const r = leader.acquireLeader({
      leaderAlias: "instance-B",
      ttlSeconds: 30,
      now: T_PLUS_31,
    })
    assert.ok(r)
    assert.equal(r.currentTerm, "2", "term 单调推进")
    const cur = leader.getCurrent()
    assert.equal(cur?.leaderAlias, "instance-B")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 防 ABA：连续抢占 term 严格单调（1 → 2 → 3）", async () => {
  const { leader, cleanup } = await build()
  try {
    leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    const t2 = leader.acquireLeader({ leaderAlias: "B", ttlSeconds: 30, now: T_PLUS_31 })
    const t3 = leader.acquireLeader({
      leaderAlias: "A",
      ttlSeconds: 30,
      now: "2026-05-11T10:01:02.000Z",
    })
    assert.equal(t2?.currentTerm, "2")
    assert.equal(t3?.currentTerm, "3")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 renewLeader 持有 → 延长 expires", async () => {
  const { leader, cleanup } = await build()
  try {
    const a = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    assert.ok(a)
    const r = leader.renewLeader({ currentTerm: a.currentTerm, ttlSeconds: 30, now: T_PLUS_5 })
    assert.ok(r)
    assert.equal(r.currentTerm, a.currentTerm, "renew 不换 term")
    assert.equal(r.leaseExpiresAt, "2026-05-11T10:00:35.000Z")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 renewLeader term 不匹配 → null", async () => {
  const { leader, cleanup } = await build()
  try {
    leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    const r = leader.renewLeader({ currentTerm: "999", ttlSeconds: 30, now: T_PLUS_5 })
    assert.equal(r, null)
  } finally {
    cleanup()
  }
})

test("F027 P3.5 renewLeader 已过期 → null", async () => {
  const { leader, cleanup } = await build()
  try {
    const a = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    const r = leader.renewLeader({ currentTerm: a!.currentTerm, ttlSeconds: 30, now: T_PLUS_31 })
    assert.equal(r, null)
  } finally {
    cleanup()
  }
})

test("F027 P3.5 releaseLeader 持有 → true + lease_expires=epoch（row 保留 + term 保留）", async () => {
  // [范-r1 P1 修正] release 不删 row，避免触发器跳过 + reacquire 重置 term=1
  const { leader, cleanup } = await build()
  try {
    const a = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    const ok = leader.releaseLeader({ currentTerm: a!.currentTerm })
    assert.equal(ok, true)
    const after = leader.getCurrent()
    assert.ok(after, "row 应保留（不删）")
    assert.equal(after?.currentTerm, "1", "term 保留，防 reacquire 重置")
    assert.equal(after?.leaseExpiresAt, "1970-01-01T00:00:00.000Z", "expires 标记 epoch")
    assert.equal(leader.isLeader(a!.currentTerm, T_PLUS_5), false, "release 后 isLeader=false")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 releaseLeader 非持有 → false noop", async () => {
  const { leader, cleanup } = await build()
  try {
    leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    const ok = leader.releaseLeader({ currentTerm: "999" })
    assert.equal(ok, false)
    assert.ok(leader.getCurrent(), "原 leader 仍在")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 isLeader：当前 term 未过期 = true", async () => {
  const { leader, cleanup } = await build()
  try {
    const a = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    assert.equal(leader.isLeader(a!.currentTerm, T_PLUS_5), true)
    assert.equal(leader.isLeader(a!.currentTerm, T_PLUS_31), false)
    assert.equal(leader.isLeader("999", T_PLUS_5), false)
  } finally {
    cleanup()
  }
})

// ─── 触发器测试 ────────────────────────────────────────────────────────────────

test("F027 P3.5 trigger: 启动期（compiler_leader 无行）写 wiki_events 不被拒", async () => {
  const { events, cleanup } = await build()
  try {
    // 没 acquireLeader，table 应该没 row
    const ev = events.appendPending({
      ts: T0,
      alias: "范德彪",
      action: "write",
      path: "wiki/concepts/foo.md",
      attemptedHash: "sha256:x",
      fencingToken: "1",
      leaderTerm: "0",
      result: "ok",
    })
    assert.ok(ev.id)
  } finally {
    cleanup()
  }
})

test("F027 P3.5 trigger: 旧 leader_term 写 wiki_events → SQL ABORT 'stale leader_term'", async () => {
  const { leader, events, cleanup } = await build()
  try {
    leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 }) // term=1
    leader.acquireLeader({ leaderAlias: "B", ttlSeconds: 30, now: T_PLUS_31 }) // term=2
    // 用旧 term=1 写 wiki_events 必须被触发器拒
    assert.throws(
      () =>
        events.appendPending({
          ts: T0,
          alias: "A",
          action: "write",
          path: "wiki/concepts/zombie.md",
          attemptedHash: "sha256:x",
          fencingToken: "1",
          leaderTerm: "1", // 旧 term
          result: "ok",
        }),
      (err: Error) => {
        assert.match(err.message, /stale leader_term/)
        return true
      },
    )
  } finally {
    cleanup()
  }
})

test("F027 P3.5 trigger: 当前 term 写 wiki_events 通过", async () => {
  const { leader, events, cleanup } = await build()
  try {
    const a = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    const ev = events.appendPending({
      ts: T0,
      alias: "A",
      action: "write",
      path: "wiki/concepts/ok.md",
      attemptedHash: "sha256:x",
      fencingToken: "1",
      leaderTerm: a!.currentTerm,
      result: "ok",
    })
    assert.ok(ev.id)
  } finally {
    cleanup()
  }
})

test("F027 P3.5 [范-r1 P1]: release 后 zombie 旧 term 写仍被触发器拒（row 保留 + term 不变）", async () => {
  const { leader, events, cleanup } = await build()
  try {
    const a = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    assert.equal(a?.currentTerm, "1")
    // 假设 A 续约失败，主动 release
    leader.releaseLeader({ currentTerm: a!.currentTerm })
    // 旧 term=1 写 wiki_events，应被触发器拒（row 保留 → WHEN EXISTS 仍为 true）
    // 实际上 release 后 term 不变 = '1'，旧 term=1 == current_term=1，触发器 < 不成立 → 通过
    // 但更现实的场景是 race：release 之后另一个 instance 抢占 term=2，
    // 此时 A 用 term=1 的延迟 insert 才该被拒
    leader.acquireLeader({ leaderAlias: "B", ttlSeconds: 30, now: T_PLUS_5 }) // term=2
    assert.throws(
      () =>
        events.appendPending({
          ts: T_PLUS_5,
          alias: "A",
          action: "write",
          path: "wiki/concepts/zombie-after-release.md",
          attemptedHash: "sha256:zombie",
          fencingToken: "1",
          leaderTerm: "1", // A 的旧 term
          result: "ok",
        }),
      /stale leader_term/,
    )
  } finally {
    cleanup()
  }
})

test("F027 P3.5 [范-r1 P1]: release → reacquire 后 term 单调推进（不重置 1）", async () => {
  const { leader, cleanup } = await build()
  try {
    const a = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T0 })
    leader.releaseLeader({ currentTerm: a!.currentTerm })
    // reacquire 应该 term=2，不是重置为 1
    const b = leader.acquireLeader({ leaderAlias: "A", ttlSeconds: 30, now: T_PLUS_5 })
    assert.ok(b)
    assert.equal(b.currentTerm, "2", "release 后 reacquire term 仍单调推进（防 ABA）")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 AC-P2-5: 双 instance 抢占 — A 写 → B 抢 → A 旧 term 再写被拒", async () => {
  const { leader, events, cleanup } = await build()
  try {
    // Instance A 当选 term=1
    const a1 = leader.acquireLeader({ leaderAlias: "instance-A", ttlSeconds: 30, now: T0 })
    assert.ok(a1)
    assert.equal(a1.currentTerm, "1")

    // A 写一条 wiki_events，应通过
    events.appendPending({
      ts: T0,
      alias: "instance-A",
      action: "write",
      path: "wiki/concepts/by-A.md",
      attemptedHash: "sha256:by-A",
      fencingToken: "1",
      leaderTerm: a1.currentTerm,
      result: "ok",
    })

    // T+31s lease 过期，Instance B 抢占 term=2
    const b = leader.acquireLeader({
      leaderAlias: "instance-B",
      ttlSeconds: 30,
      now: T_PLUS_31,
    })
    assert.ok(b)
    assert.equal(b.currentTerm, "2")

    // B 用 term=2 写一条 → 通过
    events.appendPending({
      ts: T_PLUS_31,
      alias: "instance-B",
      action: "write",
      path: "wiki/concepts/by-B.md",
      attemptedHash: "sha256:by-B",
      fencingToken: "2",
      leaderTerm: b.currentTerm,
      result: "ok",
    })

    // A 用旧 term=1 再写 → 触发器拒
    assert.throws(
      () =>
        events.appendPending({
          ts: T_PLUS_31,
          alias: "instance-A",
          action: "write",
          path: "wiki/concepts/zombie-A.md",
          attemptedHash: "sha256:zombie",
          fencingToken: "1",
          leaderTerm: a1.currentTerm, // 旧 term=1
          result: "ok",
        }),
      /stale leader_term/,
    )

    // 验证只 A-r1 + B-r1 两条 committed-pending；zombie 没落
    const all = events.getByPath("wiki/concepts/by-A.md", 10)
    assert.equal(all.length, 1)
    const allB = events.getByPath("wiki/concepts/by-B.md", 10)
    assert.equal(allB.length, 1)
    const zombie = events.getByPath("wiki/concepts/zombie-A.md", 10)
    assert.equal(zombie.length, 0, "zombie 写不应入表")
  } finally {
    cleanup()
  }
})
