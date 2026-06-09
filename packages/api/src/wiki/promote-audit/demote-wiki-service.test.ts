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
import {
  DemoteWikiService,
  buildRejectedPath,
  isInRejectedBin,
} from "./demote-wiki-service"

/**
 * F027 P4 AC-P4-3 (a)(d) · DemoteWikiService 单测
 *
 * 测试覆盖:
 *   (1) happy path: src 正式 entity → mv 到 _rejected/ + wiki_events action='demote' state='committed'
 *   (2) src 是 draft → 同样能 demote
 *   (3) ACL deny → denied_acl
 *   (4) lease expired → lease_expired
 *   (5) src 不存在 → src_not_found
 *   (6) src 已经在 _rejected/ → path_invalid
 *   (7) dest _rejected/ 已存在 → dest_exists
 *   (8) buildRejectedPath flatten 正确
 *   (9) isInRejectedBin 识别
 */

const ACL_OPEN: ACLConfig = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: ["<any-agent>"],
      allowedActions: ["write", "promote", "demote", "delete", "append", "patch"],
    },
  ],
}

const ACL_DENY_DEMOTE: ACLConfig = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: ["<any-agent>"],
      allowedActions: ["write", "promote", "append", "patch"], // 无 demote
    },
  ],
}

function setupTest(opts: { acl?: ACLConfig } = {}): {
  service: DemoteWikiService
  wikiRoot: string
  events: WikiEventsRepository
  leases: WikiLeasesRepository
  acquireLease: (relPath: string, owner: string) => string
  cleanup: () => void
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demote-test-"))
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const compiled = compileACL(opts.acl ?? ACL_OPEN)
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })

  const service = new DemoteWikiService({
    events,
    leases,
    acl: compiled,
    wikiRoot,
    currentLeaderTerm: () => "999",
  })

  const acquireLease = (relPath: string, owner: string): string => {
    const result = leases.acquireLease({
      path: relPath,
      ownerAlias: owner,
      ttlSeconds: 60,
      leaderTerm: "999",
    })
    if (!result) {
      throw new Error("acquireLease returned null (lease held)")
    }
    return result.fencingToken
  }

  const cleanup = () => {
    close()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows WAL — best effort
    }
  }

  return { service, wikiRoot, events, leases, acquireLease, cleanup }
}

function writeWikiFile(wikiRoot: string, relPath: string, content: string): void {
  const abs = path.join(wikiRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

describe("DemoteWikiService", () => {
  it("(1) happy path: src 正式 entity → mv 到 _rejected/ + wiki_events action='demote'", () => {
    const { service, wikiRoot, events, acquireLease, cleanup } = setupTest()
    try {
      const src = "wiki/concepts/rag-overview.md"
      writeWikiFile(wikiRoot, src, "# RAG overview\n\nold spec")
      const token = acquireLease(src, "黄仁勋")

      const r = service.demote({
        srcWikiPath: src,
        callerAlias: "黄仁勋",
        reason: "spec 已 supersede 改新版",
        fencingToken: token,
      })

      assert.equal(r.status, "ok")
      assert.ok(r.eventId)
      assert.ok(r.rejectedPath?.includes("_rejected"))
      assert.ok(!fs.existsSync(path.join(wikiRoot, src)), "src 应该 unlink")
      assert.ok(
        fs.existsSync(path.join(wikiRoot, "wiki/_rejected/concepts--rag-overview.md")),
        "wiki/_rejected/ 下 flat 文件应存",
      )
      const row = events.getByPath(src).find((e) => e.action === "demote")
      assert.ok(row, "wiki_events 应有 demote 行")
      assert.equal(row.state, "committed")
      assert.equal(row.reason, "spec 已 supersede 改新版")
    } finally {
      cleanup()
    }
  })

  it("(2) src 是 draft → 同样能 demote", () => {
    const { service, wikiRoot, acquireLease, cleanup } = setupTest()
    try {
      const src = "wiki/concepts/draft/_auto/foo.md"
      writeWikiFile(wikiRoot, src, "draft body")
      const token = acquireLease(src, "范德彪")

      const r = service.demote({
        srcWikiPath: src,
        callerAlias: "范德彪",
        reason: "draft 内容不合规",
        fencingToken: token,
      })

      assert.equal(r.status, "ok")
      assert.ok(!fs.existsSync(path.join(wikiRoot, src)))
    } finally {
      cleanup()
    }
  })

  it("(3) ACL deny demote → denied_acl", () => {
    const { service, wikiRoot, acquireLease, cleanup } = setupTest({ acl: ACL_DENY_DEMOTE })
    try {
      const src = "wiki/concepts/foo.md"
      writeWikiFile(wikiRoot, src, "body")
      const token = acquireLease(src, "桂芬")

      const r = service.demote({
        srcWikiPath: src,
        callerAlias: "桂芬",
        reason: "test",
        fencingToken: token,
      })

      assert.equal(r.status, "denied_acl")
      assert.ok(fs.existsSync(path.join(wikiRoot, src)), "src 应保留")
    } finally {
      cleanup()
    }
  })

  it("(4) lease expired → lease_expired", () => {
    const { service, wikiRoot, cleanup } = setupTest()
    try {
      const src = "wiki/concepts/foo.md"
      writeWikiFile(wikiRoot, src, "body")

      const r = service.demote({
        srcWikiPath: src,
        callerAlias: "黄仁勋",
        reason: "test",
        fencingToken: "bogus-token-not-acquired",
      })

      assert.equal(r.status, "lease_expired")
      assert.ok(fs.existsSync(path.join(wikiRoot, src)))
    } finally {
      cleanup()
    }
  })

  it("(5) src 不存在 → src_not_found", () => {
    const { service, cleanup } = setupTest()
    try {
      const r = service.demote({
        srcWikiPath: "wiki/concepts/nonexistent.md",
        callerAlias: "黄仁勋",
        reason: "test",
        fencingToken: "any",
      })

      assert.equal(r.status, "src_not_found")
    } finally {
      cleanup()
    }
  })

  it("(6) src 已在 wiki/_rejected/ → path_invalid", () => {
    const { service, cleanup } = setupTest()
    try {
      const r = service.demote({
        srcWikiPath: "wiki/_rejected/foo.md",
        callerAlias: "黄仁勋",
        reason: "test",
        fencingToken: "any",
      })

      assert.equal(r.status, "path_invalid")
      assert.ok(r.error?.includes("_rejected"))
    } finally {
      cleanup()
    }
  })

  it("(7) dest wiki/_rejected/ 已存在 → dest_exists", () => {
    const { service, wikiRoot, acquireLease, cleanup } = setupTest()
    try {
      const src = "wiki/concepts/foo.md"
      writeWikiFile(wikiRoot, src, "body")
      writeWikiFile(wikiRoot, "wiki/_rejected/concepts--foo.md", "prior demote")
      const token = acquireLease(src, "黄仁勋")

      const r = service.demote({
        srcWikiPath: src,
        callerAlias: "黄仁勋",
        reason: "second demote attempt",
        fencingToken: token,
      })

      assert.equal(r.status, "dest_exists")
      assert.ok(fs.existsSync(path.join(wikiRoot, src)), "src 应保留")
    } finally {
      cleanup()
    }
  })

  it("(8) buildRejectedPath flatten 正确 (strip leading wiki/)", () => {
    assert.equal(
      buildRejectedPath("wiki/concepts/rag.md"),
      "wiki/_rejected/concepts--rag.md",
    )
    assert.equal(
      buildRejectedPath("wiki/concepts/draft/_auto/foo.md"),
      "wiki/_rejected/concepts--draft--_auto--foo.md",
    )
    // Windows path 兼容
    assert.equal(
      buildRejectedPath("wiki\\concepts\\foo.md"),
      "wiki/_rejected/concepts--foo.md",
    )
  })

  it("(9) isInRejectedBin 识别", () => {
    assert.equal(isInRejectedBin("wiki/_rejected/foo.md"), true)
    assert.equal(isInRejectedBin("wiki/concepts/foo.md"), false)
    assert.equal(isInRejectedBin("wiki/concepts/_rejected/bar.md"), true)
  })
})
