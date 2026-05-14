/**
 * F027 P19.2 · SchedulerLeader 测试 — 覆盖 AC-P2-2 (a)/(b)/(c)/(d)
 *
 * (a) 双 runtime spawn → 1 leader / 1 follower poll
 * (b) winner crash → follower ≤ 60s 接管（test 用 短 poll + TTL）
 * (c) v2b F1 lease-lost-live: leader 进程未死但 renewLeader() 返 null
 *     → selfDemote() 清 lease + demotedReason='heartbeat_failed'
 *     → shouldSkipJob() 返 'lease_lost'
 *     → onDemote 回调触发
 * (d) lease-expired 兜底: heartbeat 不跑，wall clock 真过期
 *     → shouldSkipJob() 走第三段 guard 返 'lease_expired'
 *     → demotedReason 仍 null（区分 c/d）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { SchedulerLeader, type DemoteReason, type LeaderLease } from "./scheduler-leader"

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
  const { createDrizzleDb } = await import("../../db/drizzle-instance")
  const { CompilerLeaderRepository } = await import(
    "../../db/repositories/compiler-leader-repository"
  )
  const tempDir = safeTempDir("scheduler-leader-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const repo = new CompilerLeaderRepository(db)
  return {
    repo,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("SchedulerLeader · single instance start → leader role + lease in memory", async () => {
  const { repo, cleanup } = await build()
  const leader = new SchedulerLeader({
    leaderAlias: "instance-A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  try {
    leader.start()
    assert.equal(leader.getRole(), "leader")
    const lease = leader.getLease()
    assert.ok(lease)
    assert.equal(lease!.currentTerm, "1")
    assert.equal(leader.shouldSkipJob(), null, "leader with valid lease can run jobs")
  } finally {
    leader.stop()
    cleanup()
  }
})

test("SchedulerLeader · AC-P2-2(a) two instances → 1 leader / 1 follower", async () => {
  const { repo, cleanup } = await build()
  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const b = new SchedulerLeader({
    leaderAlias: "B",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  try {
    a.start()
    b.start()
    assert.equal(a.getRole(), "leader")
    assert.equal(b.getRole(), "follower")
    assert.equal(a.shouldSkipJob(), null)
    assert.equal(b.shouldSkipJob(), "role_not_leader")
  } finally {
    a.stop()
    b.stop()
    cleanup()
  }
})

test("SchedulerLeader · AC-P2-2(b) leader stop (release) → follower poll picks up", async () => {
  const { repo, cleanup } = await build()
  const acquireEvents: LeaderLease[] = []
  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const b = new SchedulerLeader({
    leaderAlias: "B",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 50, // fast poll
    onAcquireAsFollower: (l) => acquireEvents.push(l),
  })
  try {
    a.start()
    b.start()
    assert.equal(b.getRole(), "follower")

    // A 主动 release（stop()）
    a.stop()

    // 等 B 的 poll 抢到（≤ 200ms safety）
    await sleep(200)

    assert.equal(b.getRole(), "leader", "B 应在 poll 后接管")
    assert.equal(b.getLease()?.currentTerm, "2", "term 单调推进")
    assert.equal(acquireEvents.length, 1, "onAcquireAsFollower 应触发 1 次")
    assert.equal(acquireEvents[0].currentTerm, "2")
  } finally {
    b.stop()
    cleanup()
  }
})

test("SchedulerLeader · AC-P2-2(b) leader crash (no release) → follower picks up after TTL", async () => {
  const { repo, cleanup } = await build()
  // 模拟 crash：A 起来但不 stop，TTL 短 → 直接让 B poll 在 TTL 后抢
  // 通过测试时钟前移让 lease 过期
  let now = new Date("2026-05-15T00:00:00.000Z")
  const clock = () => now
  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 1,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    clock,
  })
  const b = new SchedulerLeader({
    leaderAlias: "B",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 50,
    clock,
  })
  try {
    a.start()
    b.start()
    assert.equal(a.getRole(), "leader")
    assert.equal(b.getRole(), "follower")

    // 模拟 A crash + 时间前进 2s（lease 过期）
    // 不调 a.stop() — 模拟进程死了来不及 release
    now = new Date(now.getTime() + 2_000)

    // 等 B 的 poll
    await sleep(200)

    assert.equal(b.getRole(), "leader", "B 应在 lease 过期后接管")
    assert.equal(b.getLease()?.currentTerm, "2")
  } finally {
    a.stop()
    b.stop()
    cleanup()
  }
})

test("SchedulerLeader · AC-P2-2(c) lease-lost-live: heartbeat fails → selfDemote → lease_lost", async () => {
  const { repo, cleanup } = await build()
  const demoteEvents: Array<{ reason: DemoteReason; prevLease: LeaderLease | null }> = []
  let now = new Date("2026-05-15T00:00:00.000Z")
  const clock = () => now

  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 50, // 50ms heartbeat
    followerPollIntervalMs: 9_999_999,
    clock,
    onDemote: (reason, prevLease) => {
      demoteEvents.push({ reason, prevLease })
    },
  })
  try {
    a.start()
    assert.equal(a.getRole(), "leader")
    const term1 = a.getLease()?.currentTerm
    assert.equal(term1, "1")

    // 模拟 B 强抢：把时钟推到 lease 过期 + 让 B 拿走
    now = new Date(now.getTime() + 31_000)
    const stolen = repo.acquireLeader({
      leaderAlias: "B",
      ttlSeconds: 30,
      now: now.toISOString(),
    })
    assert.ok(stolen, "B 应抢成功（A 的 lease 已过期）")
    assert.equal(stolen.currentTerm, "2")

    // 等 A 的 heartbeat 跑（renewLeader 用 term=1 → 拒，因为 current=2）
    await sleep(150)

    assert.equal(a.getRole(), "demoted", "A 应自降级")
    assert.equal(a.getDemotedReason(), "heartbeat_failed")
    assert.equal(a.getLease(), null, "v2b F1: selfDemote 清 lease")
    assert.equal(a.shouldSkipJob(), "lease_lost", "Guard 1 区分 selfDemote → lease_lost")
    assert.equal(demoteEvents.length, 1, "onDemote 应触发 1 次")
    assert.equal(demoteEvents[0].reason, "heartbeat_failed")
    assert.equal(demoteEvents[0].prevLease?.currentTerm, "1")
  } finally {
    a.stop()
    cleanup()
  }
})

test("SchedulerLeader · AC-P2-2(d) lease_expired 兜底: 时钟过期但 heartbeat 没跑", async () => {
  const { repo, cleanup } = await build()
  let now = new Date("2026-05-15T00:00:00.000Z")
  const clock = () => now

  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 5,
    heartbeatIntervalMs: 9_999_999, // 不会跑
    followerPollIntervalMs: 9_999_999,
    clock,
  })
  try {
    a.start()
    assert.equal(a.getRole(), "leader")
    assert.equal(a.shouldSkipJob(), null, "刚获取 lease，时钟未过期")

    // 时钟前进 6s（lease 5s 过期），但 heartbeat 不跑（interval 极大）
    now = new Date(now.getTime() + 6_000)

    // role 仍 'leader'（selfDemote 没跑），lease 对象仍在 (lease!=null)
    assert.equal(a.getRole(), "leader", "role 仍 leader（heartbeat 没跑）")
    assert.equal(a.getDemotedReason(), null, "demotedReason 仍 null（区分 (c)）")
    assert.ok(a.getLease(), "lease 对象仍在内存")
    assert.equal(
      a.shouldSkipJob(),
      "lease_expired",
      "Guard 3 wall clock 兜底 → lease_expired (vs (c) lease_lost)",
    )
  } finally {
    a.stop()
    cleanup()
  }
})

test("SchedulerLeader · stop after start releases + sets demotedReason='manual_release'", async () => {
  const { repo, cleanup } = await build()
  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  try {
    a.start()
    a.stop()
    assert.equal(a.getRole(), "demoted")
    assert.equal(a.getDemotedReason(), "manual_release")
    assert.equal(a.getLease(), null)
    // start 后 stop —— shouldSkipJob 走 demotedReason='manual_release' 分支
    // → 不是 heartbeat_failed 所以返 role_not_leader（不是 lease_lost）
    assert.equal(a.shouldSkipJob(), "role_not_leader")
  } finally {
    cleanup()
  }
})

test("SchedulerLeader · stop is idempotent + cannot start after stop", async () => {
  const { repo, cleanup } = await build()
  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  try {
    a.start()
    a.stop()
    a.stop() // no-op, no throw
    assert.throws(() => a.start(), /cannot start after stop/)
  } finally {
    cleanup()
  }
})

test("SchedulerLeader · start is idempotent (second call noop)", async () => {
  const { repo, cleanup } = await build()
  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  try {
    a.start()
    const term1 = a.getLease()?.currentTerm
    a.start() // noop
    const term2 = a.getLease()?.currentTerm
    assert.equal(term1, term2, "second start() does not re-acquire")
  } finally {
    a.stop()
    cleanup()
  }
})

test("SchedulerLeader · heartbeat renews lease (no demote) when alone", async () => {
  const { repo, cleanup } = await build()
  let now = new Date("2026-05-15T00:00:00.000Z")
  const clock = () => now

  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 50,
    followerPollIntervalMs: 9_999_999,
    clock,
  })
  try {
    a.start()
    const expires1 = a.getLease()?.leaseExpiresAt

    // 时钟前进 5s + 等 heartbeat 跑
    now = new Date(now.getTime() + 5_000)
    await sleep(150) // 几次 heartbeat

    const expires2 = a.getLease()?.leaseExpiresAt
    assert.equal(a.getRole(), "leader", "single leader, no demote")
    assert.notEqual(expires2, expires1, "heartbeat 后 expires 应延长")
  } finally {
    a.stop()
    cleanup()
  }
})

test("SchedulerLeader · follower role → shouldSkipJob='role_not_leader'", async () => {
  const { repo, cleanup } = await build()
  const a = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const b = new SchedulerLeader({
    leaderAlias: "B",
    leaseRepo: repo,
    ttlSeconds: 30,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  try {
    a.start()
    b.start()
    assert.equal(b.getRole(), "follower")
    assert.equal(b.shouldSkipJob(), "role_not_leader")
  } finally {
    a.stop()
    b.stop()
    cleanup()
  }
})
