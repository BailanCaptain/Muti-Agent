import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import { createDrizzleDb } from "../../db/drizzle-instance"
import { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import { compileACL } from "../acl-engine"
import type { ACLConfig } from "../acl-types"
import { BatchPromoteService } from "./batch-promote-service"
import { PromoteWikiService } from "./promote-wiki-service"
import { V14PromoteAuditService } from "./v14-promote-audit-service"

/**
 * F027 P4 AC-P4-4 · BatchPromoteService 单测 (集成 真实 PromoteWikiService + sqlite)
 *
 * 测试覆盖:
 *   (1) 3 份 happy path → success=3 failed=0
 *   (2) 1 份 V14 reject (中间份) → success=2 failed=1，失败份 status='audit_rejected' + auditReject 填
 *   (3) 1 份 dest_exists (中间份) → success=2 failed=1，失败份 status='dest_exists'
 *   (4) 1 份 src_not_found (中间份) → success=2 failed=1
 *   (5) 1 份 lease_held (外部已 acquire 占住该 dest) → success=2 failed=1 status='lease_held'
 *   (6) 全 fail (3 份 audit_reject) → success=0 failed=3，total=3
 *   (7) 空 items → total=0 success=[] failed=[]
 *   (8) lease release: 每份完成后 lease 都释放 (重复 acquire 同 path 不冲突)
 */

const ACL_OPEN: ACLConfig = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: ["<any-agent>"],
      allowedActions: ["write", "promote", "delete", "append", "patch"],
    },
  ],
}

function setupTest(): {
  service: BatchPromoteService
  promote: PromoteWikiService
  leases: WikiLeasesRepository
  events: WikiEventsRepository
  wikiRoot: string
  writeSrc: (relPath: string, content: string) => void
  preExistDest: (relPath: string, content: string) => void
  cleanup: () => void
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-promote-test-"))
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const compiled = compileACL(ACL_OPEN)
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })

  const promote = new PromoteWikiService({
    events,
    leases,
    acl: compiled,
    wikiRoot,
    currentLeaderTerm: () => "999",
    auditService: new V14PromoteAuditService(),
  })

  const service = new BatchPromoteService({
    promote,
    leases,
    currentLeaderTerm: () => "999",
    leaseTtlSeconds: 60,
  })

  const writeSrc = (relPath: string, content: string) => {
    const abs = path.join(wikiRoot, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  const preExistDest = (relPath: string, content: string) => {
    const abs = path.join(wikiRoot, relPath)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  const cleanup = () => {
    close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  return { service, promote, leases, events, wikiRoot, writeSrc, preExistDest, cleanup }
}

const CLEAN_BODY = "# RAG\n\n这是一段干净的概念说明，没有命令式语句也没有 prompt 结构标记。\n"
const IMPERATIVE_BODY = "# Bad\n\n你必须执行下面的步骤来完成 wiki 编写。\n"

describe("BatchPromoteService", () => {
  it("(1) 3 份 happy path → success=3 failed=0", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", CLEAN_BODY)

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
        ],
        callerAlias: "小孙",
        reason: "首批整理",
      })

      assert.equal(result.total, 3)
      assert.equal(result.success.length, 3)
      assert.equal(result.failed.length, 0)
      for (const s of result.success) {
        assert.ok(fs.existsSync(s.finalPath), `dest exists: ${s.finalPath}`)
        assert.ok(s.eventId > 0)
      }
      // src 应已 unlink
      assert.equal(fs.existsSync(path.join(t.wikiRoot, "wiki/concepts/draft/_auto/a.md")), false)
    } finally {
      t.cleanup()
    }
  })

  it("(2) 1 份 V14 reject (中间份) → success=2 failed=1 status='audit_rejected'", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", IMPERATIVE_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", CLEAN_BODY)

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
        ],
        callerAlias: "小孙",
        reason: "首批整理",
      })

      assert.equal(result.total, 3)
      assert.equal(result.success.length, 2)
      assert.equal(result.failed.length, 1)
      const failed = result.failed[0]
      assert.equal(failed.srcDraftPath, "wiki/concepts/draft/_auto/b.md")
      assert.equal(failed.status, "audit_rejected")
      assert.ok(failed.auditReject)
      assert.equal(failed.auditReject?.layer, "imperative_statement")

      // 失败份 src 留原位 (per plan line 218)
      assert.ok(fs.existsSync(path.join(t.wikiRoot, "wiki/concepts/draft/_auto/b.md")))
      // 失败份 dest 没写
      assert.equal(fs.existsSync(path.join(t.wikiRoot, "wiki/concepts/b.md")), false)
      // 其他两份正常落地
      assert.ok(fs.existsSync(path.join(t.wikiRoot, "wiki/concepts/a.md")))
      assert.ok(fs.existsSync(path.join(t.wikiRoot, "wiki/concepts/c.md")))
    } finally {
      t.cleanup()
    }
  })

  it("(3) 1 份 dest_exists (中间份) → success=2 failed=1 status='dest_exists'", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", CLEAN_BODY)
      t.preExistDest("wiki/concepts/b.md", "# already here")

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
        ],
        callerAlias: "小孙",
        reason: "首批整理",
      })

      assert.equal(result.success.length, 2)
      assert.equal(result.failed.length, 1)
      assert.equal(result.failed[0].status, "dest_exists")
      // 原 dest 内容保留
      assert.equal(
        fs.readFileSync(path.join(t.wikiRoot, "wiki/concepts/b.md"), "utf-8"),
        "# already here",
      )
    } finally {
      t.cleanup()
    }
  })

  it("(4) 1 份 src_not_found (中间份) → success=2 failed=1", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)
      // b 不写
      t.writeSrc("wiki/concepts/draft/_auto/c.md", CLEAN_BODY)

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
        ],
        callerAlias: "小孙",
        reason: "首批整理",
      })

      assert.equal(result.success.length, 2)
      assert.equal(result.failed.length, 1)
      assert.equal(result.failed[0].status, "src_not_found")
      assert.equal(result.failed[0].srcDraftPath, "wiki/concepts/draft/_auto/b.md")
    } finally {
      t.cleanup()
    }
  })

  it("(5) 1 份 lease_held (外部已 acquire 占住 dest) → success=2 failed=1 status='lease_held'", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", CLEAN_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", CLEAN_BODY)

      // 外部 owner 抢走 wiki/concepts/b.md lease
      const external = t.leases.acquireLease({
        path: "wiki/concepts/b.md",
        ownerAlias: "another-agent",
        ttlSeconds: 60,
        leaderTerm: "999",
      })
      assert.ok(external)

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
        ],
        callerAlias: "小孙",
        reason: "首批整理",
      })

      assert.equal(result.success.length, 2)
      assert.equal(result.failed.length, 1)
      assert.equal(result.failed[0].status, "lease_held")
      // b src 留原位
      assert.ok(fs.existsSync(path.join(t.wikiRoot, "wiki/concepts/draft/_auto/b.md")))
    } finally {
      t.cleanup()
    }
  })

  it("(6) 全 fail (3 份 audit_reject) → success=0 failed=3 total=3", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", IMPERATIVE_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/b.md", IMPERATIVE_BODY)
      t.writeSrc("wiki/concepts/draft/_auto/c.md", IMPERATIVE_BODY)

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/b.md", destWikiPath: "wiki/concepts/b.md" },
          { srcDraftPath: "wiki/concepts/draft/_auto/c.md", destWikiPath: "wiki/concepts/c.md" },
        ],
        callerAlias: "小孙",
        reason: "试试",
      })

      assert.equal(result.total, 3)
      assert.equal(result.success.length, 0)
      assert.equal(result.failed.length, 3)
      for (const f of result.failed) {
        assert.equal(f.status, "audit_rejected")
        assert.ok(f.auditReject)
      }
    } finally {
      t.cleanup()
    }
  })

  it("(7) 空 items → total=0 success=[] failed=[]", () => {
    const t = setupTest()
    try {
      const result = t.service.batchPromote({
        items: [],
        callerAlias: "小孙",
        reason: "试试",
      })

      assert.equal(result.total, 0)
      assert.equal(result.success.length, 0)
      assert.equal(result.failed.length, 0)
    } finally {
      t.cleanup()
    }
  })

  it("(8) lease release: success 后同 dest 可重新 acquire (无 stale lease)", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/a.md", CLEAN_BODY)

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/a.md", destWikiPath: "wiki/concepts/a.md" },
        ],
        callerAlias: "小孙",
        reason: "首批",
      })
      assert.equal(result.success.length, 1)

      // 同 path 重新 acquire 应成功（lease 已 release）
      const reAcquired = t.leases.acquireLease({
        path: "wiki/concepts/a.md",
        ownerAlias: "another-agent",
        ttlSeconds: 60,
        leaderTerm: "999",
      })
      assert.ok(reAcquired, "lease should be released after batch promote")
    } finally {
      t.cleanup()
    }
  })

  it("(9) fail path 也 release lease (audit reject 后同 dest 可被外部 acquire)", () => {
    const t = setupTest()
    try {
      t.writeSrc("wiki/concepts/draft/_auto/bad.md", IMPERATIVE_BODY)

      const result = t.service.batchPromote({
        items: [
          { srcDraftPath: "wiki/concepts/draft/_auto/bad.md", destWikiPath: "wiki/concepts/x.md" },
        ],
        callerAlias: "小孙",
        reason: "试试",
      })
      assert.equal(result.failed.length, 1)
      assert.equal(result.failed[0].status, "audit_rejected")

      // 同 dest 重新 acquire 应成功（fail path 也走了 try/finally release）
      const reAcquired = t.leases.acquireLease({
        path: "wiki/concepts/x.md",
        ownerAlias: "another-agent",
        ttlSeconds: 60,
        leaderTerm: "999",
      })
      assert.ok(reAcquired)
    } finally {
      t.cleanup()
    }
  })
})
