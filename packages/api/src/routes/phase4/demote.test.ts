import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import Fastify from "fastify"

import { createDrizzleDb } from "../../db/drizzle-instance"
import { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import { compileACL } from "../../wiki/acl-engine"
import { DemoteWikiService } from "../../wiki/promote-audit/demote-wiki-service"
import { registerDemoteRoutes } from "./demote"

/**
 * F027 P4 AC-P4-3 (d) · POST /api/wiki/drafts/demote endpoint 单测
 *
 * 测试覆盖:
 *   (1) happy path: 200 ok + rejectedPath + eventId + lease released
 *   (2) src not found → 404 SRC_NOT_FOUND
 *   (3) missing required body field → 400 VALIDATION_ERROR
 *   (4) ACL deny → 403 DENIED_ACL
 *   (5) src 已在 _rejected/ → 400 PATH_INVALID
 *   (6) lease 已被另一 owner 持有 → 409 LEASE_HELD
 *   (7) lease released after success (re-acquire 同 path OK)
 */

const ACL_OPEN = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: ["<any-agent>"],
      allowedActions: ["write" as const, "promote" as const, "demote" as const],
    },
  ],
}

const ACL_DENY_DEMOTE = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: ["<any-agent>"],
      allowedActions: ["write" as const, "promote" as const], // 无 demote
    },
  ],
}

async function setupApp(opts: { denyDemote?: boolean } = {}): Promise<{
  app: ReturnType<typeof Fastify>
  wikiRoot: string
  leases: WikiLeasesRepository
  events: WikiEventsRepository
  cleanup: () => Promise<void>
}> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demote-route-test-"))
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const compiled = compileACL(opts.denyDemote ? ACL_DENY_DEMOTE : ACL_OPEN)
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })

  const demote = new DemoteWikiService({
    events,
    leases,
    acl: compiled,
    wikiRoot,
    currentLeaderTerm: () => "999",
  })

  const app = Fastify()
  registerDemoteRoutes(app, {
    demote,
    leases,
    leaderTerm: () => "999",
  })

  return {
    app,
    wikiRoot,
    leases,
    events,
    cleanup: async () => {
      await app.close()
      close()
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        // Windows WAL — best effort
      }
    },
  }
}

function writeWikiFile(wikiRoot: string, relPath: string, content: string): void {
  const abs = path.join(wikiRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

describe("POST /api/wiki/drafts/demote", () => {
  it("(1) happy path → 200 ok + rejectedPath + eventId + lease released", async () => {
    const { app, wikiRoot, leases, events, cleanup } = await setupApp()
    try {
      const src = "wiki/concepts/rag-overview.md"
      writeWikiFile(wikiRoot, src, "# RAG overview\n\nold spec")

      const resp = await app.inject({
        method: "POST",
        url: "/api/wiki/drafts/demote",
        payload: {
          srcWikiPath: src,
          callerAlias: "黄仁勋",
          reason: "supersede 旧 spec",
        },
      })

      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.ok, true)
      assert.ok(body.rejectedPath?.includes("_rejected"))
      assert.ok(body.eventId)
      assert.ok(!fs.existsSync(path.join(wikiRoot, src)), "src 应 unlink")
      assert.ok(
        fs.existsSync(path.join(wikiRoot, "wiki/_rejected/concepts--rag-overview.md")),
        "_rejected/ 下 flat 文件应存",
      )
      // lease 应已 release
      const reAcquire = leases.acquireLease({
        path: src,
        ownerAlias: "别人",
        ttlSeconds: 60,
        leaderTerm: "999",
      })
      assert.ok(reAcquire, "lease 释放后应能 re-acquire")
      // wiki_events 应有 demote 行
      const row = events.getByPath(src).find((e) => e.action === "demote")
      assert.ok(row)
      assert.equal(row.state, "committed")
    } finally {
      await cleanup()
    }
  })

  it("(2) src not found → 404 SRC_NOT_FOUND", async () => {
    const { app, cleanup } = await setupApp()
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/wiki/drafts/demote",
        payload: {
          srcWikiPath: "wiki/concepts/nonexistent.md",
          callerAlias: "黄仁勋",
          reason: "test",
        },
      })

      assert.equal(resp.statusCode, 404)
      const body = resp.json()
      assert.equal(body.ok, false)
      assert.equal(body.code, "SRC_NOT_FOUND")
    } finally {
      await cleanup()
    }
  })

  it("(3) missing srcWikiPath → 400 VALIDATION_ERROR", async () => {
    const { app, cleanup } = await setupApp()
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/wiki/drafts/demote",
        payload: { callerAlias: "黄仁勋", reason: "test" },
      })

      assert.equal(resp.statusCode, 400)
      const body = resp.json()
      assert.equal(body.ok, false)
      assert.equal(body.code, "VALIDATION_ERROR")
    } finally {
      await cleanup()
    }
  })

  it("(4) ACL deny demote → 403 DENIED_ACL", async () => {
    const { app, wikiRoot, cleanup } = await setupApp({ denyDemote: true })
    try {
      const src = "wiki/concepts/foo.md"
      writeWikiFile(wikiRoot, src, "body")

      const resp = await app.inject({
        method: "POST",
        url: "/api/wiki/drafts/demote",
        payload: {
          srcWikiPath: src,
          callerAlias: "桂芬",
          reason: "test",
        },
      })

      assert.equal(resp.statusCode, 403)
      const body = resp.json()
      assert.equal(body.code, "DENIED_ACL")
      assert.ok(fs.existsSync(path.join(wikiRoot, src)), "src 应保留")
    } finally {
      await cleanup()
    }
  })

  it("(5) src 已在 wiki/_rejected/ → 400 PATH_INVALID", async () => {
    const { app, cleanup } = await setupApp()
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/wiki/drafts/demote",
        payload: {
          srcWikiPath: "wiki/_rejected/foo.md",
          callerAlias: "黄仁勋",
          reason: "test",
        },
      })

      assert.equal(resp.statusCode, 400)
      const body = resp.json()
      assert.equal(body.code, "PATH_INVALID")
    } finally {
      await cleanup()
    }
  })

  it("(6) lease 已被另一 owner 持有 → 409 LEASE_HELD", async () => {
    const { app, wikiRoot, leases, cleanup } = await setupApp()
    try {
      const src = "wiki/concepts/foo.md"
      writeWikiFile(wikiRoot, src, "body")
      // 别人先 acquire
      const held = leases.acquireLease({
        path: src,
        ownerAlias: "别人",
        ttlSeconds: 60,
        leaderTerm: "999",
      })
      assert.ok(held)

      const resp = await app.inject({
        method: "POST",
        url: "/api/wiki/drafts/demote",
        payload: {
          srcWikiPath: src,
          callerAlias: "黄仁勋",
          reason: "test",
        },
      })

      assert.equal(resp.statusCode, 409)
      const body = resp.json()
      assert.equal(body.code, "LEASE_HELD")
    } finally {
      await cleanup()
    }
  })

  it("(7) lease released after success (re-acquire 同 path OK)", async () => {
    const { app, wikiRoot, leases, cleanup } = await setupApp()
    try {
      const src = "wiki/concepts/foo.md"
      writeWikiFile(wikiRoot, src, "body")

      const resp = await app.inject({
        method: "POST",
        url: "/api/wiki/drafts/demote",
        payload: { srcWikiPath: src, callerAlias: "黄仁勋", reason: "test" },
      })

      assert.equal(resp.statusCode, 200)

      const reAcquire = leases.acquireLease({
        path: src,
        ownerAlias: "另一人",
        ttlSeconds: 60,
        leaderTerm: "999",
      })
      assert.ok(reAcquire)
    } finally {
      await cleanup()
    }
  })
})
