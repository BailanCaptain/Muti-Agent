/**
 * 德彪 r2 P1 · 人审豁免文档 promote 二审加严测试
 *
 * 覆盖(全临时 sqlite + 临时 wikiRoot,Iron Law):
 *   1. hasIngestExemption:frontmatter 键有/无/无 frontmatter 三态
 *   2. deriveExemptionTaintedFields:豁免文档 → sanitize 命中片段;非豁免 → []
 *   3. 集成:豁免 draft body 残留 sanitize 可检片段(base64 块,layer1/2 抓不到)→
 *      promote 被 layer 3 tainted_source_direct_quote 拒 + 不 mv
 *   4. 对照:同 body 无 ingest_exemption 标记 → promote ok(普通 draft 零回归)
 */

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
import { deriveExemptionTaintedFields, hasIngestExemption } from "./exemption-tainted-fields"
import { PromoteWikiService } from "./promote-wiki-service"
import { V14PromoteAuditService } from "./v14-promote-audit-service"

/** ≥40 字符 base64 块:sanitize encoding 层 quarantine,但 V14 layer1/2 模式抓不到——
 *  专门用来证明 layer3 动态注入这条链真通电(而非 layer1 顺手拦下)。 */
const BASE64_BLOB = "QWxhZGRpbjpvcGVuIHNlc2FtZUFsYWRkaW46b3BlbiBzZXNhbWU="

const EXEMPT_FM =
  "---\ntype: lesson\ningest_exemption: sanitize-skipped (human-reviewed by xs @ 2026-06-11T10:00:00.000Z)\n---\n"
const PLAIN_FM = "---\ntype: lesson\n---\n"
/** body 刻意避开 V14 layer1(命令式词)与 layer2(prompt 结构)模式。 */
const BODY_WITH_BLOB = `# 编码样本记录\n\n这一段记录了一个编码样本 ${BASE64_BLOB} 用作回归用例。\n`

describe("hasIngestExemption", () => {
  it("frontmatter 含 ingest_exemption 键 → true", () => {
    assert.equal(hasIngestExemption(EXEMPT_FM + BODY_WITH_BLOB), true)
  })
  it("frontmatter 无该键 → false", () => {
    assert.equal(hasIngestExemption(PLAIN_FM + BODY_WITH_BLOB), false)
  })
  it("无 frontmatter → false(body 里冒充的键不算)", () => {
    assert.equal(hasIngestExemption("# T\ningest_exemption: fake\n"), false)
  })
})

describe("deriveExemptionTaintedFields", () => {
  it("豁免文档 → 返 sanitize 命中片段(片段是原文 substring,layer3 可命中)", () => {
    const content = EXEMPT_FM + BODY_WITH_BLOB
    const fields = deriveExemptionTaintedFields(content)
    assert.ok(fields.length > 0, "base64 块应被 sanitize 检出")
    assert.ok(
      fields.some((f) => f.length >= 15 && content.includes(f)),
      `应有 ≥15 字符且在原文中的片段: ${JSON.stringify(fields)}`,
    )
  })
  it("非豁免文档(同 body)→ [](普通 draft 不受影响)", () => {
    assert.deepEqual(deriveExemptionTaintedFields(PLAIN_FM + BODY_WITH_BLOB), [])
  })
})

// ── 集成:PromoteWikiService 服务端动态注入 layer3 ─────────────────────────

const ACL_OPEN: ACLConfig = {
  acl: [
    {
      pathPattern: "wiki/**",
      allowedAliases: ["<any-agent>"],
      allowedActions: ["write", "promote", "delete", "append", "patch"],
    },
  ],
}

function setupPromote() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "exemption-promote-"))
  const { db, close } = createDrizzleDb(path.join(tempDir, "test.sqlite"))
  const events = new WikiEventsRepository(db)
  const leases = new WikiLeasesRepository(db)
  const wikiRoot = path.join(tempDir, "wiki-root")
  fs.mkdirSync(wikiRoot, { recursive: true })
  const service = new PromoteWikiService({
    events,
    leases,
    acl: compileACL(ACL_OPEN),
    wikiRoot,
    currentLeaderTerm: () => "999",
    auditService: new V14PromoteAuditService(),
  })
  const acquire = (relPath: string): string => {
    const r = leases.acquireLease({
      path: relPath,
      ownerAlias: "小孙",
      ttlSeconds: 60,
      leaderTerm: "999",
    })
    if (!r) throw new Error("lease held")
    return r.fencingToken
  }
  const cleanup = () => {
    close()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows WAL — best effort
    }
  }
  return { service, wikiRoot, acquire, cleanup }
}

function writeDraft(wikiRoot: string, relPath: string, content: string): void {
  const abs = path.join(wikiRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

describe("promote 服务端 exemption 复检注入 layer3(德彪 r2 P1)", () => {
  it("豁免 draft body 残留 base64 片段 → audit_rejected layer3 + 不 mv", () => {
    const t = setupPromote()
    try {
      const src = "wiki/concepts/draft/_auto/b014-exempt.md"
      const dest = "wiki/concepts/b014-exempt.md"
      writeDraft(t.wikiRoot, src, EXEMPT_FM + BODY_WITH_BLOB)
      const token = t.acquire(dest)
      const r = t.service.promote({
        srcDraftPath: src,
        destWikiPath: dest,
        callerAlias: "小孙",
        reason: "豁免文档转正测试",
        fencingToken: token,
        // 刻意不传 taintedSourceFields:证明服务端自取,不依赖 client
      })
      assert.equal(r.status, "audit_rejected", `应被二审拒: ${JSON.stringify(r)}`)
      assert.equal(r.auditReject?.layer, "tainted_source_direct_quote")
      assert.ok(fs.existsSync(path.join(t.wikiRoot, src)), "拒后 src 留原位")
      assert.ok(!fs.existsSync(path.join(t.wikiRoot, dest)), "拒后不得落 dest")
    } finally {
      t.cleanup()
    }
  })

  it("同 body 无 exemption 标记 → promote ok(普通 draft 零回归)", () => {
    const t = setupPromote()
    try {
      const src = "wiki/concepts/draft/_auto/plain.md"
      const dest = "wiki/concepts/plain.md"
      writeDraft(t.wikiRoot, src, PLAIN_FM + BODY_WITH_BLOB)
      const token = t.acquire(dest)
      const r = t.service.promote({
        srcDraftPath: src,
        destWikiPath: dest,
        callerAlias: "小孙",
        reason: "普通 draft 对照",
        fencingToken: token,
      })
      assert.equal(r.status, "ok", `普通 draft 不应受豁免复检影响: ${JSON.stringify(r)}`)
      assert.ok(fs.existsSync(path.join(t.wikiRoot, dest)))
    } finally {
      t.cleanup()
    }
  })
})
