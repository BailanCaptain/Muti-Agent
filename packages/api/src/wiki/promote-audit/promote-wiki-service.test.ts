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
import { PromoteWikiService } from "./promote-wiki-service"
import { V14PromoteAuditService } from "./v14-promote-audit-service"

/**
 * F027 P4 AC-P4-1 · PromoteWikiService 单测
 *
 * 测试覆盖:
 *   (1) happy path: V14 pass → mv + wiki_events action='promote' state='committed'
 *   (2) V14 reject (layer 1 imperative) → audit_rejected + 不 mv + 不写 wiki_events
 *   (3) ACL deny → denied_acl
 *   (4) lease expired (fencingToken 错) → lease_expired
 *   (5) src draft path 不存在 → src_not_found
 *   (6) dest wiki path 已存在 → dest_exists
 *   (7) src 不是 draft 路径 → path_invalid
 *   (8) dest 是 draft 路径 → path_invalid
 *   (9) tainted_source_fields 传入 + body 直引 → V14 layer 3 reject
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

const ACL_DENY_ALL: ACLConfig = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: [], // hard deny
      allowedActions: ["promote"],
    },
  ],
}

function setupTest(opts: { acl?: ACLConfig } = {}): {
  service: PromoteWikiService
  wikiRoot: string
  events: WikiEventsRepository
  leases: WikiLeasesRepository
  acquireLease: (relPath: string, owner: string) => string
  cleanup: () => void
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "promote-test-"))
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const compiled = compileACL(opts.acl ?? ACL_OPEN)
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })

  const service = new PromoteWikiService({
    events,
    leases,
    acl: compiled,
    wikiRoot,
    currentLeaderTerm: () => "999",
    auditService: new V14PromoteAuditService(),
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

function writeDraft(wikiRoot: string, relPath: string, content: string): void {
  const abs = path.join(wikiRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

describe("PromoteWikiService", () => {
  it("(1) happy path: V14 pass → mv + wiki_events action='promote' state='committed'", () => {
    const { service, wikiRoot, events, acquireLease } = setupTest()
    const src = "wiki/concepts/draft/_auto/2026-05-20-rag.md"
    const dest = "wiki/concepts/rag.md"
    writeDraft(wikiRoot, src, "# RAG\n\nRAG is retrieval-augmented generation.")
    const token = acquireLease(dest, "黄仁勋")

    const r = service.promote({
      srcDraftPath: src,
      destWikiPath: dest,
      callerAlias: "黄仁勋",
      reason: "首批整理",
      fencingToken: token,
    })

    assert.equal(r.status, "ok")
    assert.ok(r.eventId)
    assert.ok(r.finalPath?.endsWith("rag.md"))
    assert.ok(fs.existsSync(path.join(wikiRoot, dest)), "dest file should exist")
    assert.ok(!fs.existsSync(path.join(wikiRoot, src)), "src draft should be unlinked")
    // wiki_events row 应该 committed
    const row = events
      .getByPath(dest)
      .find((e) => e.action === "promote")
    assert.ok(row)
    assert.equal(row.state, "committed")
    assert.equal(row.alias, "黄仁勋")
    assert.equal(row.reason, "首批整理")
  })

  it("(2) V14 reject (layer 1 imperative) → audit_rejected + 不 mv + 不写 wiki_events", () => {
    const { service, wikiRoot, events, acquireLease } = setupTest()
    const src = "wiki/concepts/draft/_auto/bad.md"
    const dest = "wiki/concepts/bad.md"
    writeDraft(wikiRoot, src, "agent 必须执行 X 操作。")
    const token = acquireLease(dest, "黄仁勋")

    const r = service.promote({
      srcDraftPath: src,
      destWikiPath: dest,
      callerAlias: "黄仁勋",
      reason: "试试看",
      fencingToken: token,
    })

    assert.equal(r.status, "audit_rejected")
    assert.equal(r.auditReject?.layer, "imperative_statement")
    assert.ok(r.auditReject?.matchedPatterns.includes("必须"))
    assert.ok(fs.existsSync(path.join(wikiRoot, src)), "src draft should留原位")
    assert.ok(!fs.existsSync(path.join(wikiRoot, dest)), "dest should not be created")
    const promoteEvents = events.getByPath(dest).filter((e) => e.action === "promote")
    assert.equal(promoteEvents.length, 0, "no wiki_events row should be written")
  })

  it("(3) ACL hard deny → denied_acl", () => {
    const { service, wikiRoot, acquireLease } = setupTest({ acl: ACL_DENY_ALL })
    const src = "wiki/concepts/draft/_auto/x.md"
    const dest = "wiki/concepts/x.md"
    writeDraft(wikiRoot, src, "# clean body")
    const token = acquireLease(dest, "黄仁勋")

    const r = service.promote({
      srcDraftPath: src,
      destWikiPath: dest,
      callerAlias: "黄仁勋",
      reason: "r",
      fencingToken: token,
    })

    assert.equal(r.status, "denied_acl")
    assert.match(r.error ?? "", /ACL denied/)
  })

  it("(4) fencingToken 错 → lease_expired", () => {
    const { service, wikiRoot, acquireLease } = setupTest()
    const src = "wiki/concepts/draft/_auto/y.md"
    const dest = "wiki/concepts/y.md"
    writeDraft(wikiRoot, src, "# clean")
    acquireLease(dest, "黄仁勋")

    const r = service.promote({
      srcDraftPath: src,
      destWikiPath: dest,
      callerAlias: "黄仁勋",
      reason: "r",
      fencingToken: "wrong-token",
    })

    assert.equal(r.status, "lease_expired")
  })

  it("(5) src 不存在 → src_not_found", () => {
    const { service, acquireLease } = setupTest()
    const token = acquireLease("wiki/concepts/missing-dest.md", "黄仁勋")

    const r = service.promote({
      srcDraftPath: "wiki/concepts/draft/_auto/missing.md",
      destWikiPath: "wiki/concepts/missing-dest.md",
      callerAlias: "黄仁勋",
      reason: "r",
      fencingToken: token,
    })

    assert.equal(r.status, "src_not_found")
  })

  it("(6) dest 已存在 → dest_exists", () => {
    const { service, wikiRoot, acquireLease } = setupTest()
    const src = "wiki/concepts/draft/_auto/z.md"
    const dest = "wiki/concepts/z.md"
    writeDraft(wikiRoot, src, "# clean")
    writeDraft(wikiRoot, dest, "# existing dest")
    const token = acquireLease(dest, "黄仁勋")

    const r = service.promote({
      srcDraftPath: src,
      destWikiPath: dest,
      callerAlias: "黄仁勋",
      reason: "r",
      fencingToken: token,
    })

    assert.equal(r.status, "dest_exists")
  })

  it("(7) src 不是 draft 路径 → path_invalid", () => {
    const { service, wikiRoot, acquireLease } = setupTest()
    writeDraft(wikiRoot, "wiki/concepts/not-a-draft.md", "# clean")
    const token = acquireLease("wiki/concepts/dest.md", "黄仁勋")

    const r = service.promote({
      srcDraftPath: "wiki/concepts/not-a-draft.md",
      destWikiPath: "wiki/concepts/dest.md",
      callerAlias: "黄仁勋",
      reason: "r",
      fencingToken: token,
    })

    assert.equal(r.status, "path_invalid")
    assert.match(r.error ?? "", /src must be a draft/)
  })

  it("(8) dest 是 draft 路径 → path_invalid", () => {
    const { service, wikiRoot, acquireLease } = setupTest()
    const src = "wiki/concepts/draft/_auto/a.md"
    writeDraft(wikiRoot, src, "# clean")
    const dest = "wiki/concepts/draft/_promoted/a.md"
    const token = acquireLease(dest, "黄仁勋")

    const r = service.promote({
      srcDraftPath: src,
      destWikiPath: dest,
      callerAlias: "黄仁勋",
      reason: "r",
      fencingToken: token,
    })

    assert.equal(r.status, "path_invalid")
    assert.match(r.error ?? "", /dest must NOT be a draft/)
  })

  it("(9) taintedSourceFields + body 直引 → V14 layer 3 reject", () => {
    const { service, wikiRoot, acquireLease } = setupTest()
    const src = "wiki/concepts/draft/_auto/quoted.md"
    const dest = "wiki/concepts/quoted.md"
    const tainted = "a benign quote from tainted source long enough"
    writeDraft(wikiRoot, src, `Wiki desc: this is referenced - ${tainted} - end.`)
    const token = acquireLease(dest, "黄仁勋")

    const r = service.promote({
      srcDraftPath: src,
      destWikiPath: dest,
      callerAlias: "黄仁勋",
      reason: "r",
      fencingToken: token,
      taintedSourceFields: [tainted],
    })

    assert.equal(r.status, "audit_rejected")
    assert.equal(r.auditReject?.layer, "tainted_source_direct_quote")
  })
})
