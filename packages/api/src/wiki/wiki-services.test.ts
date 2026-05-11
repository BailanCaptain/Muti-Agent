/**
 * F027 P3.e · Wiki services factory smoke
 * 真相源：docs/plans/V16.5-final.md chap 6
 *
 * 覆盖：
 *   - createWikiServices 构造无错（DB seed 后 events/leases 表可用）
 *   - DEFAULT_ACL_YAML 解析通过 + concepts/draft 有 specificity 优先
 *   - 端到端 happy path：acquire → updateWiki → commit
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
  const { createDrizzleDb } = await import("../db/drizzle-instance")
  const { createWikiServices } = await import("./wiki-services")
  const tempDir = safeTempDir("wiki-services-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })
  const { db, close } = createDrizzleDb(dbPath)
  const services = createWikiServices({ db, wikiRoot })
  return {
    services,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

test("F027 P3.e factory: createWikiServices 装配无错 + DB 表可用", async () => {
  const { services, cleanup } = await build()
  try {
    // 调一下 events / leases 验 DB 已 init
    const lease = services.leases.acquireLease({
      path: "wiki/concepts/foo.md",
      ownerAlias: "范德彪",
      ttlSeconds: 30,
      leaderTerm: "term-1",
    })
    assert.ok(lease)
    assert.equal(lease.fencingToken, "1")
  } finally {
    cleanup()
  }
})

test("F027 P3.e factory: DEFAULT_ACL_YAML 端到端 happy path（concepts agent 写）", async () => {
  const { services, cleanup } = await build()
  try {
    const a = services.leases.acquireLease({
      path: "wiki/concepts/draft/test.md",
      ownerAlias: "范德彪",
      ttlSeconds: 30,
      leaderTerm: "term-1",
    })
    const r = services.updateWiki.updateWiki(
      {
        path: "wiki/concepts/draft/test.md",
        action: "write",
        baseHash: null,
        content: "test content",
        fencingToken: a!.fencingToken,
      },
      { alias: "范德彪", isServiceIdentity: false },
    )
    assert.equal(r.status, "ok")
    const written = fs.readFileSync(
      path.join(services.wikiRoot, "wiki/concepts/draft/test.md"),
      "utf8",
    )
    assert.equal(written, "test content")
  } finally {
    cleanup()
  }
})

test("F027 P3.e factory: ACL — agent 不能写 wiki/rules/", async () => {
  const { services, cleanup } = await build()
  try {
    const a = services.leases.acquireLease({
      path: "wiki/rules/iron-laws.md",
      ownerAlias: "范德彪",
      ttlSeconds: 30,
      leaderTerm: "term-1",
    })
    const r = services.updateWiki.updateWiki(
      {
        path: "wiki/rules/iron-laws.md",
        action: "write",
        baseHash: null,
        content: "fake",
        fencingToken: a!.fencingToken,
      },
      { alias: "范德彪", isServiceIdentity: false },
    )
    assert.equal(r.status, "denied_acl")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 factory: leader 默认 wiring —— 无 leader 行时 leaderTerm()='0'", async () => {
  const { services, cleanup } = await build()
  try {
    // 无 acquireLeader → getCurrent() null → leaderTerm() = '0'
    const a = services.leases.acquireLease({
      path: "wiki/concepts/no-leader.md",
      ownerAlias: "范德彪",
      ttlSeconds: 30,
      leaderTerm: "0",
    })
    const r = services.updateWiki.updateWiki(
      {
        path: "wiki/concepts/no-leader.md",
        action: "write",
        baseHash: null,
        content: "x",
        fencingToken: a!.fencingToken,
      },
      { alias: "范德彪", isServiceIdentity: false },
    )
    assert.equal(r.status, "ok")
    const ev = services.events.get(r.eventId!)
    assert.equal(ev?.leaderTerm, "0", "无 leader 期 fallback term=0")
  } finally {
    cleanup()
  }
})

test("F027 P3.5 factory: leader 接 compiler_leader 后 leaderTerm() 跟 row 走", async () => {
  const { services, cleanup } = await build()
  try {
    services.leader.acquireLeader({ leaderAlias: "instance-A", ttlSeconds: 30 })
    const a = services.leases.acquireLease({
      path: "wiki/concepts/with-leader.md",
      ownerAlias: "范德彪",
      ttlSeconds: 30,
      leaderTerm: "1",
    })
    const r = services.updateWiki.updateWiki(
      {
        path: "wiki/concepts/with-leader.md",
        action: "write",
        baseHash: null,
        content: "x",
        fencingToken: a!.fencingToken,
      },
      { alias: "范德彪", isServiceIdentity: false },
    )
    assert.equal(r.status, "ok")
    const ev = services.events.get(r.eventId!)
    assert.equal(ev?.leaderTerm, "1", "leader row 在 → leaderTerm() = current_term")
  } finally {
    cleanup()
  }
})

test("F027 P3.e factory: ACL — wiki/index.md 任何人都不能写（派生视图保护）", async () => {
  const { services, cleanup } = await build()
  try {
    const a = services.leases.acquireLease({
      path: "wiki/index.md",
      ownerAlias: "小孙",
      ttlSeconds: 30,
      leaderTerm: "term-1",
    })
    const r = services.updateWiki.updateWiki(
      {
        path: "wiki/index.md",
        action: "write",
        baseHash: null,
        content: "fake index",
        fencingToken: a!.fencingToken,
      },
      { alias: "小孙", isServiceIdentity: false },
    )
    assert.equal(r.status, "denied_acl")
  } finally {
    cleanup()
  }
})
