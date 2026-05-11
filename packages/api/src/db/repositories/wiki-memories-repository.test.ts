/**
 * F027 P10 · WikiMemoriesRepository 单测
 * 真相源：docs/plans/V16.5-final.md chap 14
 *
 * 覆盖：
 *   - insert 5 type roundtrip + JSON boundary（contributedBy/supersedes/cross_refs/dedup_decision）
 *   - type-routed 写时校验：canonical_owner_path 路由 / room 桶禁 promote / feedback 默认 ttl=30
 *   - state CAS：draft→canonical / draft→deprecated / canonical→deprecated 全路径
 *   - 重复 settle = noop（CAS 防转）
 *   - getByType / getByCanonicalOwnerPath / getByState / listAll 查询
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
    // Windows WAL — best effort
  }
}

async function buildRepo() {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { WikiMemoriesRepository } = await import("./wiki-memories-repository")
  const tempDir = safeTempDir("wiki-memories-repo-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const repo = new WikiMemoriesRepository(db)
  return {
    repo,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

test("F027 P10: 5 type insert roundtrip + JSON boundary（contributedBy/supersedes/dedup_decision）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const types = ["room", "project", "user", "feedback", "work"] as const
    for (const t of types) {
      const m = repo.insert({
        type: t,
        name: `n-${t}`,
        canonicalOwnerPath: `wiki/${t}/x.md`,
        contributedBy: ["黄仁勋", "桂芬"],
        supersedes: t === "feedback" ? ["wiki/feedback/old.md"] : null,
        dedupDecision: t === "project" ? { winner: "n-project", reason: "newer" } : null,
        body: `body-${t}`,
      })
      assert.equal(m.type, t)
      assert.deepEqual(m.contributedBy, ["黄仁勋", "桂芬"])
      if (t === "feedback") assert.deepEqual(m.supersedes, ["wiki/feedback/old.md"])
      if (t === "project") assert.deepEqual(m.dedupDecision, { winner: "n-project", reason: "newer" })

      const back = repo.get(m.id)
      assert.deepEqual(back, m)
    }
  } finally {
    cleanup()
  }
})

test("F027 P10: canonical_owner_path 路由校验 — type 与 prefix 必须匹配", async () => {
  const { repo, cleanup } = await buildRepo()
  const { InvalidBucketPathError } = await import("./wiki-memories-types")
  try {
    assert.throws(
      () =>
        repo.insert({
          type: "project",
          name: "x",
          canonicalOwnerPath: "wiki/user/x.md", // 错路由
          contributedBy: ["a"],
          body: "b",
        }),
      InvalidBucketPathError,
    )
    assert.throws(
      () =>
        repo.insert({
          type: "feedback",
          name: "x",
          canonicalOwnerPath: "/abs/path/x.md", // 完全不在 wiki/ 下
          contributedBy: ["a"],
          body: "b",
        }),
      InvalidBucketPathError,
    )
  } finally {
    cleanup()
  }
})

test("F027 P10: room 桶 promotion_target 必须 null（派生视图终点不可 promote）", async () => {
  const { repo, cleanup } = await buildRepo()
  const { RoomBucketCannotPromoteError } = await import("./wiki-memories-types")
  try {
    assert.throws(
      () =>
        repo.insert({
          type: "room",
          name: "x",
          canonicalOwnerPath: "wiki/room/r-001.md",
          promotionTarget: "wiki/project/x.md",
          contributedBy: ["a"],
          body: "b",
        }),
      RoomBucketCannotPromoteError,
    )
    // 不给 promotion_target 合法
    const ok = repo.insert({
      type: "room",
      name: "x",
      canonicalOwnerPath: "wiki/room/r-001.md",
      contributedBy: ["a"],
      body: "b",
    })
    assert.equal(ok.promotionTarget, null)
  } finally {
    cleanup()
  }
})

test("F027 P10: feedback 桶 ttl_days 默认 30（不显式给值时填入）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const m = repo.insert({
      type: "feedback",
      name: "x",
      canonicalOwnerPath: "wiki/feedback/x.md",
      contributedBy: ["a"],
      body: "b",
    })
    assert.equal(m.ttlDays, 30)

    // 显式给 0 也接受（表示永久？由 caller 明示）
    const explicit = repo.insert({
      type: "feedback",
      name: "y",
      canonicalOwnerPath: "wiki/feedback/y.md",
      ttlDays: 7,
      contributedBy: ["a"],
      body: "b",
    })
    assert.equal(explicit.ttlDays, 7)

    // 其他桶不给默认 ttl（永久）
    const project = repo.insert({
      type: "project",
      name: "p",
      canonicalOwnerPath: "wiki/project/p.md",
      contributedBy: ["a"],
      body: "b",
    })
    assert.equal(project.ttlDays, null)
  } finally {
    cleanup()
  }
})

test("F027 P10: 状态机 CAS — draft→canonical / draft→deprecated / canonical→deprecated 全路径", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    // draft → canonical
    const a = repo.insert({
      type: "project",
      name: "a",
      canonicalOwnerPath: "wiki/project/a.md",
      contributedBy: ["x"],
      body: "b",
    })
    assert.equal(a.state, "draft")
    assert.equal(repo.updateState(a.id, "draft", "canonical"), true)
    assert.equal(repo.get(a.id)?.state, "canonical")

    // canonical → deprecated
    assert.equal(repo.updateState(a.id, "canonical", "deprecated"), true)
    assert.equal(repo.get(a.id)?.state, "deprecated")

    // draft → deprecated（小孙 reject）
    const b = repo.insert({
      type: "user",
      name: "b",
      canonicalOwnerPath: "wiki/user/b.md",
      contributedBy: ["x"],
      body: "b",
    })
    assert.equal(repo.updateState(b.id, "draft", "deprecated"), true)
    assert.equal(repo.get(b.id)?.state, "deprecated")
  } finally {
    cleanup()
  }
})

test("F027 P10: updateState 重复 settle = noop（CAS 第二次 false，state 不变）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const m = repo.insert({
      type: "work",
      name: "x",
      canonicalOwnerPath: "wiki/work/x.md",
      contributedBy: ["a"],
      body: "b",
    })
    assert.equal(repo.updateState(m.id, "draft", "canonical"), true)
    // 再促 draft→canonical 是 noop（已经 canonical 了）
    assert.equal(repo.updateState(m.id, "draft", "canonical"), false)
    // 倒退也是 noop（CAS WHERE state='canonical' 拦不住但 from='deprecated' 不匹配）
    assert.equal(repo.updateState(m.id, "deprecated", "canonical"), false)
    assert.equal(repo.get(m.id)?.state, "canonical")
  } finally {
    cleanup()
  }
})

test("F027 P10: 不存在 id updateState 返回 false 不抛", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    assert.equal(repo.updateState(99999, "draft", "canonical"), false)
  } finally {
    cleanup()
  }
})

test("F027 P10: getByType / getByCanonicalOwnerPath / getByState 查询 + updatedAt DESC", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const m1 = repo.insert({
      type: "project",
      name: "a",
      canonicalOwnerPath: "wiki/project/a.md",
      contributedBy: ["x"],
      body: "b",
      createdAt: "2026-01-01T00:00:00Z",
    })
    const m2 = repo.insert({
      type: "project",
      name: "b",
      canonicalOwnerPath: "wiki/project/b.md",
      contributedBy: ["x"],
      body: "b",
      createdAt: "2026-01-02T00:00:00Z",
    })
    repo.insert({
      type: "user",
      name: "c",
      canonicalOwnerPath: "wiki/user/c.md",
      contributedBy: ["x"],
      body: "b",
      createdAt: "2026-01-03T00:00:00Z",
    })

    const projects = repo.getByType("project")
    assert.equal(projects.length, 2)
    // updatedAt = createdAt 时入库；m2 createdAt 较晚 → DESC 排第一
    assert.equal(projects[0].id, m2.id)
    assert.equal(projects[1].id, m1.id)

    const byPath = repo.getByCanonicalOwnerPath("wiki/project/a.md")
    assert.equal(byPath.length, 1)
    assert.equal(byPath[0].id, m1.id)

    repo.updateState(m1.id, "draft", "canonical")
    const drafts = repo.getByState("draft")
    assert.equal(drafts.length, 2) // m2 + user.c
    const canon = repo.getByState("canonical")
    assert.equal(canon.length, 1)
    assert.equal(canon[0].id, m1.id)

    const all = repo.listAll()
    assert.equal(all.length, 3)
  } finally {
    cleanup()
  }
})

test("F027 P10: contributedBy 必须是 array — 空 array 也合法（系统写入场景）", async () => {
  const { repo, cleanup } = await buildRepo()
  try {
    const m = repo.insert({
      type: "work",
      name: "system-write",
      canonicalOwnerPath: "wiki/work/sys.md",
      contributedBy: [],
      body: "b",
    })
    assert.deepEqual(m.contributedBy, [])
  } finally {
    cleanup()
  }
})
