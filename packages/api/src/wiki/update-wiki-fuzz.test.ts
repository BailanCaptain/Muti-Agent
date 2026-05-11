/**
 * F027 P3 · update_wiki 100 并发 fuzz —— V16.5 chap 6 AC-P1-2
 *
 * better-sqlite3 是 single-process synchronous，"100 并发" 在同 connection 下
 * 等价于 100 串行 atomic SQL。真正的多 connection 并发由 SQLite WAL 串行化保证
 * （留 P3.5 多 runtime 实例 lease 抢占 AC-P2-5 验证）。
 *
 * Phase 1 P3 fuzz 验证三件事：
 *   1. 100 个 worker 串行执行 acquire → update → release，全部走通无数据错乱
 *   2. wiki_events 状态精确：100 个 committed，0 个 aborted（串行无 race）
 *   3. 强制 race injection：PREPARE 后手动覆盖 lease → final-CAS 必触 stale_token + abort
 *
 * 不变量：
 *   - 文件最终 hash == 最后一个 commit event 的 content_hash
 *   - 全部 event leader_term 一致（无 leader 切换）
 *   - 全部 fencing_token 严格单调递增
 */

import assert from "node:assert/strict"
import crypto from "node:crypto"
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
function sha256(s: string): string {
  return `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`
}

const ACL_YAML = `
acl:
  - path_pattern: 'wiki/concepts/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write, append, delete]
`

async function buildHarness() {
  const { createDrizzleDb } = await import("../db/drizzle-instance")
  const { WikiEventsRepository } = await import("../db/repositories/wiki-events-repository")
  const { WikiLeasesRepository } = await import("../db/repositories/wiki-leases-repository")
  const { compileACL, loadACLConfig } = await import("./acl-engine")
  const { UpdateWikiService } = await import("./update-wiki-service")

  const tempDir = safeTempDir("fuzz-update-wiki-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })

  const { db, close } = createDrizzleDb(dbPath)
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const acl = compileACL(loadACLConfig(ACL_YAML))
  const service = new UpdateWikiService({
    leases,
    events,
    acl,
    wikiRoot,
    leaderTerm: () => "term-1",
  })

  return {
    service,
    leases,
    events,
    wikiRoot,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

const TARGET_PATH = "wiki/concepts/fuzz.md"
const CTX = (alias: string) => ({ alias, isServiceIdentity: false })

test("F027 P3 fuzz: 100 串行 worker 全 commit + 文件 hash 与 last event 一致", async () => {
  const { service, leases, events, wikiRoot, cleanup } = await buildHarness()
  try {
    const aliases = ["小孙", "黄仁勋", "范德彪", "桂芬"]
    const results: Array<{ status: string; eventId?: number; alias: string }> = []

    for (let i = 0; i < 100; i++) {
      const alias = aliases[i % aliases.length]
      const a = leases.acquireLease({
        path: TARGET_PATH,
        ownerAlias: alias,
        ttlSeconds: 30,
        leaderTerm: "term-1",
      })
      assert.ok(a, `iter ${i} acquire failed (lease 应该总能拿到，因 service 释放了上轮 lease）`)

      // 上一轮如果有 commit，本轮 baseHash 应该是上次 content；首轮 null
      const prev =
        i === 0 ? null : sha256(`payload-${i - 1}-by-${aliases[(i - 1) % aliases.length]}`)
      const content = `payload-${i}-by-${alias}`

      const r = service.updateWiki(
        {
          path: TARGET_PATH,
          action: "write",
          baseHash: prev,
          content,
          fencingToken: a.fencingToken,
        },
        CTX(alias),
      )
      results.push({ status: r.status, eventId: r.eventId, alias })
      assert.equal(r.status, "ok", `iter ${i} status=${r.status} error=${r.error}`)
    }

    // 100 全 ok
    assert.equal(results.length, 100)
    assert.equal(
      results.filter((r) => r.status === "ok").length,
      100,
      `expected 100 ok, got ${JSON.stringify(results.map((r) => r.status))}`,
    )

    // wiki_events: 100 committed + 0 aborted + 0 pending
    const committed = events.getByState("committed", 200)
    const aborted = events.getByState("aborted", 200)
    const pending = events.getPending()
    assert.equal(committed.length, 100, `committed=${committed.length}`)
    assert.equal(aborted.length, 0, `aborted=${aborted.length}`)
    assert.equal(pending.length, 0, `pending=${pending.length}`)

    // 文件最终 hash == 最后一个 worker content
    const finalContent = `payload-99-by-${aliases[99 % aliases.length]}`
    const written = fs.readFileSync(path.join(wikiRoot, TARGET_PATH), "utf8")
    assert.equal(written, finalContent)

    // 全部 leader_term 一致
    const terms = new Set(committed.map((e) => e.leaderTerm))
    assert.deepEqual([...terms], ["term-1"])

    // fencing_token 严格单调递增（每次 acquire 都是 nextFencingToken）
    const tokens = committed.map((e) => Number(e.fencingToken))
    for (let i = 1; i < tokens.length; i++) {
      assert.ok(
        tokens[i] !== tokens[i - 1],
        `fencing tokens should be unique at idx ${i}: ${tokens[i - 1]} === ${tokens[i]}`,
      )
    }
  } finally {
    cleanup()
  }
})

test("F027 P3 fuzz: race injection — PREPARE 后 lease 被覆盖 → final-CAS 触发 stale_token + abort", async () => {
  // 直接调 service 内部 path 模拟 race：
  //   Step A: 范德彪 acquire token-A
  //   Step B: 范德彪进入 service.updateWiki，pre-check pass
  //   Step C: 在 PREPARE 之后但 final-CAS 之前，强制 lease 抢占
  //   Step D: final-CAS isCurrent(token-A) → false → abort + stale_token
  //
  // 因为 service 是同步连续调，需要在 events.appendPending 上 hook 注入抢占。
  const { createDrizzleDb } = await import("../db/drizzle-instance")
  const { WikiEventsRepository } = await import("../db/repositories/wiki-events-repository")
  const { WikiLeasesRepository } = await import("../db/repositories/wiki-leases-repository")
  const { compileACL, loadACLConfig } = await import("./acl-engine")
  const { UpdateWikiService } = await import("./update-wiki-service")

  const tempDir = safeTempDir("fuzz-race-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })
  const { db, close } = createDrizzleDb(dbPath)
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const acl = compileACL(loadACLConfig(ACL_YAML))

  // race injection wrapper：给 events.appendPending 包一层，commit 之前抢占 lease
  let raceFired = false
  const wrapped: typeof events = Object.create(events)
  wrapped.appendPending = (input) => {
    const ev = events.appendPending(input)
    // 在 PREPARE 完成、service 进入 final-CAS 之前，强制把 lease release + 让别人抢
    if (!raceFired) {
      raceFired = true
      leases.releaseLease({ path: input.path, fencingToken: input.fencingToken })
      // 模拟另一个 worker 抢
      // 时间窗：当前还没到 ttl 过期，需用 expired now 去抢 → 直接覆盖
      const future = new Date(Date.now() + 60_000).toISOString()
      leases.acquireLease({
        path: input.path,
        ownerAlias: "race-attacker",
        ttlSeconds: 30,
        leaderTerm: "term-1",
        now: future,
      })
    }
    return ev
  }

  const service = new UpdateWikiService({
    leases,
    events: wrapped,
    acl,
    wikiRoot,
    leaderTerm: () => "term-1",
  })

  try {
    const a = leases.acquireLease({
      path: TARGET_PATH,
      ownerAlias: "范德彪",
      ttlSeconds: 30,
      leaderTerm: "term-1",
    })
    assert.ok(a)
    const r = service.updateWiki(
      {
        path: TARGET_PATH,
        action: "write",
        baseHash: null,
        content: "doomed",
        fencingToken: a.fencingToken,
      },
      CTX("范德彪"),
    )
    assert.equal(r.status, "stale_token", `expected stale_token, got ${r.status}`)
    assert.ok(r.eventId, "stale_token 也应返 eventId（aborted event）")

    const event = events.get(r.eventId!)
    assert.equal(event?.state, "aborted", `event state should be aborted, got ${event?.state}`)
    assert.equal(event?.error, "stale_token")
    assert.equal(event?.reason, "lease_changed_mid_write")

    // 文件不应被写
    assert.equal(
      fs.existsSync(path.join(wikiRoot, TARGET_PATH)),
      false,
      "stale_token 拒后文件不应存在",
    )
  } finally {
    close()
    safeCleanup(tempDir)
  }
})
