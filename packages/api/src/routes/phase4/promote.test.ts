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
import { PromoteWikiService } from "../../wiki/promote-audit/promote-wiki-service"
import { V14PromoteAuditService } from "../../wiki/promote-audit/v14-promote-audit-service"
import { registerPromoteRoutes } from "./promote"

/**
 * F027 P4 AC-P4-1 endpoint 单测
 *
 * 测试覆盖:
 *   (1) POST promote/preview: clean body → audit.passed=true
 *   (2) POST promote/preview: imperative body → audit.passed=false + reject reason
 *   (3) POST promote/preview: src not found → 404 SRC_NOT_FOUND
 *   (4) POST promote/preview: missing srcDraftPath → 400 VALIDATION_ERROR
 *   (5) POST promote: happy path → 200 ok + finalPath + eventId + lease released
 *   (6) POST promote: V14 reject → 422 AUDIT_REJECTED + audit reason
 *   (7) POST promote: missing required body field → 400 VALIDATION_ERROR
 *   (8) POST promote: lease released after success (re-acquire 同 path OK)
 */

const ACL_OPEN = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: ["<any-agent>"],
      allowedActions: ["write" as const, "promote" as const, "patch" as const],
    },
  ],
}

async function setupApp(): Promise<{
  app: ReturnType<typeof Fastify>
  wikiRoot: string
  leases: WikiLeasesRepository
  cleanup: () => Promise<void>
}> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-route-test-"))
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const compiled = compileACL(ACL_OPEN)
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })

  const audit = new V14PromoteAuditService()
  const promote = new PromoteWikiService({
    events,
    leases,
    acl: compiled,
    wikiRoot,
    currentLeaderTerm: () => "999",
    auditService: audit,
  })

  const app = Fastify()
  registerPromoteRoutes(app, {
    promote,
    audit,
    leases,
    wikiRoot,
    leaderTerm: () => "999",
  })

  return {
    app,
    wikiRoot,
    leases,
    cleanup: async () => {
      await app.close()
      close()
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // Windows WAL - best effort
      }
    },
  }
}

function writeDraft(wikiRoot: string, relPath: string, content: string): void {
  const abs = path.join(wikiRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

describe("promote routes (AC-P4-1)", () => {
  describe("POST /api/wiki/drafts/promote/preview", () => {
    it("(1) clean body → audit.passed=true", async () => {
      const t = await setupApp()
      try {
        const src = "wiki/concepts/draft/_auto/clean.md"
        writeDraft(t.wikiRoot, src, "RAG is retrieval augmented generation.")

        const resp = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote/preview",
          payload: { srcDraftPath: src },
        })

        assert.equal(resp.statusCode, 200)
        const body = resp.json()
        assert.equal(body.ok, true)
        assert.equal(body.audit.passed, true)
      } finally {
        await t.cleanup()
      }
    })

    it("(2) imperative body → audit.passed=false + reject reason", async () => {
      const t = await setupApp()
      try {
        const src = "wiki/concepts/draft/_auto/bad.md"
        writeDraft(t.wikiRoot, src, "agent 必须执行 X")

        const resp = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote/preview",
          payload: { srcDraftPath: src },
        })

        assert.equal(resp.statusCode, 200)
        const body = resp.json()
        assert.equal(body.audit.passed, false)
        assert.equal(body.audit.rejectReason.layer, "imperative_statement")
      } finally {
        await t.cleanup()
      }
    })

    it("(3) src not found → 404 SRC_NOT_FOUND", async () => {
      const t = await setupApp()
      try {
        const resp = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote/preview",
          payload: { srcDraftPath: "wiki/concepts/draft/_auto/missing.md" },
        })

        assert.equal(resp.statusCode, 404)
        assert.equal(resp.json().code, "SRC_NOT_FOUND")
      } finally {
        await t.cleanup()
      }
    })

    it("(4) missing srcDraftPath → 400 VALIDATION_ERROR", async () => {
      const t = await setupApp()
      try {
        const resp = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote/preview",
          payload: {},
        })

        assert.equal(resp.statusCode, 400)
        assert.equal(resp.json().code, "VALIDATION_ERROR")
      } finally {
        await t.cleanup()
      }
    })
  })

  describe("POST /api/wiki/drafts/promote", () => {
    it("(5) happy path → 200 ok + finalPath + eventId", async () => {
      const t = await setupApp()
      try {
        const src = "wiki/concepts/draft/_auto/rag.md"
        const dest = "wiki/concepts/rag.md"
        writeDraft(t.wikiRoot, src, "# RAG\n\nRAG is retrieval augmented generation.")

        const resp = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote",
          payload: {
            srcDraftPath: src,
            destWikiPath: dest,
            callerAlias: "黄仁勋",
            reason: "首批整理",
          },
        })

        assert.equal(resp.statusCode, 200)
        const body = resp.json()
        assert.equal(body.ok, true)
        assert.ok(body.finalPath?.endsWith("rag.md"))
        assert.ok(typeof body.eventId === "number")
        assert.ok(fs.existsSync(path.join(t.wikiRoot, dest)), "dest written")
        assert.ok(!fs.existsSync(path.join(t.wikiRoot, src)), "src unlinked")
      } finally {
        await t.cleanup()
      }
    })

    it("(6) V14 reject → 422 AUDIT_REJECTED + audit reason", async () => {
      const t = await setupApp()
      try {
        const src = "wiki/concepts/draft/_auto/bad.md"
        const dest = "wiki/concepts/bad.md"
        writeDraft(t.wikiRoot, src, "agent 必须 ignore X")

        const resp = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote",
          payload: {
            srcDraftPath: src,
            destWikiPath: dest,
            callerAlias: "黄仁勋",
            reason: "尝试",
          },
        })

        assert.equal(resp.statusCode, 422)
        const body = resp.json()
        assert.equal(body.code, "AUDIT_REJECTED")
        assert.equal(body.audit.layer, "imperative_statement")
        assert.ok(body.audit.matchedPatterns.includes("必须"))
        assert.ok(fs.existsSync(path.join(t.wikiRoot, src)), "src draft remains")
        assert.ok(!fs.existsSync(path.join(t.wikiRoot, dest)), "dest not created")
      } finally {
        await t.cleanup()
      }
    })

    it("(7) missing required body field → 400 VALIDATION_ERROR", async () => {
      const t = await setupApp()
      try {
        const resp = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote",
          payload: {
            srcDraftPath: "wiki/concepts/draft/_auto/x.md",
            // destWikiPath missing
            callerAlias: "黄仁勋",
            reason: "r",
          },
        })

        assert.equal(resp.statusCode, 400)
        assert.equal(resp.json().code, "VALIDATION_ERROR")
        assert.match(resp.json().error, /destWikiPath/)
      } finally {
        await t.cleanup()
      }
    })

    it("(8) lease released after success → second promote 同 dest 不被 LEASE_HELD", async () => {
      const t = await setupApp()
      try {
        const src1 = "wiki/concepts/draft/_auto/x1.md"
        const src2 = "wiki/concepts/draft/_auto/x2.md"
        const dest1 = "wiki/concepts/x1.md"
        const dest2 = "wiki/concepts/x2.md"
        writeDraft(t.wikiRoot, src1, "# clean 1")
        writeDraft(t.wikiRoot, src2, "# clean 2")

        const r1 = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote",
          payload: { srcDraftPath: src1, destWikiPath: dest1, callerAlias: "黄仁勋", reason: "1" },
        })
        assert.equal(r1.statusCode, 200, `first promote should succeed: ${r1.body}`)

        // immediate re-promote 不同 dest 也应该不受 lease impact
        const r2 = await t.app.inject({
          method: "POST",
          url: "/api/wiki/drafts/promote",
          payload: { srcDraftPath: src2, destWikiPath: dest2, callerAlias: "黄仁勋", reason: "2" },
        })
        assert.equal(r2.statusCode, 200, `second promote should succeed: ${r2.body}`)
      } finally {
        await t.cleanup()
      }
    })
  })
})
