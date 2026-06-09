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
import { BatchPromoteService } from "../../wiki/promote-audit/batch-promote-service"
import { PromoteWikiService } from "../../wiki/promote-audit/promote-wiki-service"
import { V14PromoteAuditService } from "../../wiki/promote-audit/v14-promote-audit-service"
import { registerBatchPromoteRoutes } from "./batch-promote"

/**
 * F027 P4 AC-P4-4 endpoint 单测 (Fastify.inject)
 *
 * 测试覆盖:
 *   (1) happy path: 3 份全 success → 200 ok=true success.length=3 failed=0
 *   (2) 部分失败: 中间份 V14 reject → 200 ok=true success=2 failed=1 (含 auditReject)
 *   (3) 全失败 (3 份 audit_reject) → 200 ok=true success=0 failed=3 (HTTP 仍 200)
 *   (4) 空 items → 400 VALIDATION_ERROR
 *   (5) callerAlias 缺 → 400 VALIDATION_ERROR
 *   (6) reason 缺 → 400 VALIDATION_ERROR
 *   (7) items 重复 srcDraftPath → 400 VALIDATION_ERROR
 *   (8) items 重复 destWikiPath → 400 VALIDATION_ERROR
 *   (9) items > 50 → 400 VALIDATION_ERROR
 *  (10) items 元素缺 srcDraftPath → 400
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

const CLEAN_BODY = "# RAG\n\n这是一段干净的概念说明，没有命令式语句也没有 prompt 结构标记。\n"
const IMPERATIVE_BODY = "# Bad\n\n你必须执行下面的步骤来完成 wiki 编写。\n"

async function setupApp(): Promise<{
  app: ReturnType<typeof Fastify>
  wikiRoot: string
  leases: WikiLeasesRepository
  writeSrc: (relPath: string, content: string) => void
  cleanup: () => Promise<void>
}> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-promote-route-"))
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
  const batch = new BatchPromoteService({
    promote,
    leases,
    currentLeaderTerm: () => "999",
    leaseTtlSeconds: 60,
  })

  const app = Fastify()
  registerBatchPromoteRoutes(app, { batch })

  const writeSrc = (relPath: string, content: string) => {
    const abs = path.join(wikiRoot, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, "utf-8")
  }

  return {
    app,
    wikiRoot,
    leases,
    writeSrc,
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

describe("POST /api/wiki/drafts/batch-promote (AC-P4-4)", () => {
  it("(1) happy path 3 份全 success → 200 ok success=3 failed=0", async () => {
    const t = await setupApp()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", CLEAN_BODY)

      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [
            { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
          ],
          callerAlias: "小孙",
          reason: "首批整理",
        },
      })

      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.ok, true)
      assert.equal(body.total, 3)
      assert.equal(body.success.length, 3)
      assert.equal(body.failed.length, 0)
    } finally {
      await t.cleanup()
    }
  })

  it("(2) 部分失败 中间 V14 reject → 200 ok success=2 failed=1 含 auditReject", async () => {
    const t = await setupApp()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", IMPERATIVE_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", CLEAN_BODY)

      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [
            { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
          ],
          callerAlias: "小孙",
          reason: "首批整理",
        },
      })

      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.ok, true)
      assert.equal(body.success.length, 2)
      assert.equal(body.failed.length, 1)
      assert.equal(body.failed[0].status, "audit_rejected")
      assert.equal(body.failed[0].auditReject.layer, "imperative_statement")
    } finally {
      await t.cleanup()
    }
  })

  it("(3) 全失败 (3 份 audit_reject) → 200 ok success=0 failed=3 (HTTP 仍 200)", async () => {
    const t = await setupApp()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", IMPERATIVE_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", IMPERATIVE_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", IMPERATIVE_BODY)

      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [
            { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
          ],
          callerAlias: "小孙",
          reason: "试试",
        },
      })

      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.ok, true)
      assert.equal(body.success.length, 0)
      assert.equal(body.failed.length, 3)
    } finally {
      await t.cleanup()
    }
  })

  it("(4) 空 items → 400 VALIDATION_ERROR", async () => {
    const t = await setupApp()
    try {
      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: { items: [], callerAlias: "小孙", reason: "试试" },
      })
      assert.equal(resp.statusCode, 400)
      const body = resp.json()
      assert.equal(body.ok, false)
      assert.equal(body.code, "VALIDATION_ERROR")
      assert.match(body.error, /items must not be empty/)
    } finally {
      await t.cleanup()
    }
  })

  it("(5) callerAlias 缺 → 400 VALIDATION_ERROR", async () => {
    const t = await setupApp()
    try {
      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [{ srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" }],
          reason: "试试",
        },
      })
      assert.equal(resp.statusCode, 400)
      assert.match(resp.json().error, /callerAlias required/)
    } finally {
      await t.cleanup()
    }
  })

  it("(6) reason 缺 → 400 VALIDATION_ERROR", async () => {
    const t = await setupApp()
    try {
      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [{ srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" }],
          callerAlias: "小孙",
        },
      })
      assert.equal(resp.statusCode, 400)
      assert.match(resp.json().error, /reason required/)
    } finally {
      await t.cleanup()
    }
  })

  it("(7) items 重复 srcDraftPath → 400 VALIDATION_ERROR", async () => {
    const t = await setupApp()
    try {
      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [
            { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/b.md" },
          ],
          callerAlias: "小孙",
          reason: "试试",
        },
      })
      assert.equal(resp.statusCode, 400)
      assert.match(resp.json().error, /srcDraftPath duplicated/)
    } finally {
      await t.cleanup()
    }
  })

  it("(8) items 重复 destWikiPath → 400 VALIDATION_ERROR", async () => {
    const t = await setupApp()
    try {
      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [
            { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/x.md" },
            { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/x.md" },
          ],
          callerAlias: "小孙",
          reason: "试试",
        },
      })
      assert.equal(resp.statusCode, 400)
      assert.match(resp.json().error, /destWikiPath duplicated/)
    } finally {
      await t.cleanup()
    }
  })

  it("(9) items > 50 → 400 VALIDATION_ERROR", async () => {
    const t = await setupApp()
    try {
      const items = Array.from({ length: 51 }, (_, i) => ({
        srcDraftPath: `wiki/concepts/draft/_auto/${i}.md`,
        destWikiPath: `wiki/concepts/${i}.md`,
      }))
      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: { items, callerAlias: "小孙", reason: "试试" },
      })
      assert.equal(resp.statusCode, 400)
      assert.match(resp.json().error, /MAX_BATCH_ITEMS/)
    } finally {
      await t.cleanup()
    }
  })

  it("(10) items 元素缺 srcDraftPath → 400", async () => {
    const t = await setupApp()
    try {
      const resp = await t.app.inject({
        method: "POST",
        url: "/api/wiki/drafts/batch-promote",
        payload: {
          items: [{ destWikiPath: "wiki/concepts/a.md" }],
          callerAlias: "小孙",
          reason: "试试",
        },
      })
      assert.equal(resp.statusCode, 400)
      assert.match(resp.json().error, /srcDraftPath required/)
    } finally {
      await t.cleanup()
    }
  })
})
