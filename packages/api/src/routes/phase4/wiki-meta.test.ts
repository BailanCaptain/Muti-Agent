import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import Fastify from "fastify"

import { createDrizzleDb } from "../../db/drizzle-instance"
import { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import { registerWikiMetaRoutes, WikiMetaScanner } from "./wiki-meta"

/**
 * F027 P4 AC-P4-9 a/b · WikiMetaScanner + endpoints 单测
 *
 * 测试覆盖:
 *   warnings:
 *     (W1) wikiRoot 无 warnings/ → 空 list
 *     (W2) 2 份 warning md → 解析 frontmatter + 按 detectedAt DESC sort
 *     (W3) severity 非 enum → null fallback
 *     (W4) frontmatter parse 失败的文件 → 跳过不阻塞其他
 *     (W5) endpoint Fastify.inject → 200 + warnings/total shape
 *   index:
 *     (I1) wikiRoot 无 index/ → 空 list
 *     (I2) 3 份 index md → 解析 bucket + sort asc by bucket
 *     (I3) frontmatter 无 bucket → fallback 用文件名
 *     (I4) endpoint Fastify.inject → 200 + views/total shape
 */

function setup(): {
  wikiRoot: string
  writeWarning: (name: string, frontmatter: string, body: string) => void
  writeIndex: (name: string, frontmatter: string, body: string) => void
  cleanup: () => void
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-meta-test-"))
  return {
    wikiRoot: tmp,
    writeWarning: (name, frontmatter, body) => {
      const dir = path.join(tmp, "warnings")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`)
    },
    writeIndex: (name, frontmatter, body) => {
      const dir = path.join(tmp, "index")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`)
    },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}

describe("WikiMetaScanner · listWarnings", () => {
  it("(W1) wikiRoot 无 warnings/ → 空 list", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listWarnings()
      assert.equal(result.total, 0)
      assert.deepEqual(result.warnings, [])
    } finally {
      t.cleanup()
    }
  })

  it("(W2) 2 份 warning → 解析 frontmatter + 按 detectedAt DESC sort", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "a.md",
        "type: warning\nsubtype: chained_suspect\nseverity: warn\nsource: ingest\ndetected_at: 2026-04-01T10:00:00Z\nraised_by: 黄仁勋",
        "body A",
      )
      t.writeWarning(
        "b.md",
        "type: warning\nsubtype: tainted_source\nseverity: high\nsource: v14\ndetected_at: 2026-04-15T11:00:00Z\nraised_by: V14",
        "body B",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listWarnings()
      assert.equal(result.total, 2)
      // sort DESC: b (newer) first
      assert.equal(result.warnings[0].path, "wiki/warnings/b.md")
      assert.equal(result.warnings[0].subtype, "tainted_source")
      assert.equal(result.warnings[0].severity, "high")
      assert.equal(result.warnings[1].subtype, "chained_suspect")
    } finally {
      t.cleanup()
    }
  })

  it("(W3) severity 非 enum → null fallback", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "x.md",
        "type: warning\nsubtype: bogus\nseverity: super-critical\ndetected_at: 2026-04-01T00:00:00Z",
        "body",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listWarnings()
      assert.equal(result.warnings[0].severity, null)
    } finally {
      t.cleanup()
    }
  })

  it("(W4) YAML parse 失败的文件 → 跳过不阻塞其他", async () => {
    const t = setup()
    try {
      const dir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(dir, { recursive: true })
      // 写 YAML 真 invalid 的 frontmatter (含闭合 --- 但 YAML 语法错)
      fs.writeFileSync(
        path.join(dir, "broken.md"),
        "---\nbroken: [unclosed\n---\n\nbody",
      )
      t.writeWarning(
        "good.md",
        "type: warning\nsubtype: drift\nseverity: warn\ndetected_at: 2026-04-10T00:00:00Z",
        "body",
      )
      const warnings: string[] = []
      const scanner = new WikiMetaScanner({
        wikiRoot: t.wikiRoot,
        logWarn: (_, msg) => warnings.push(msg),
      })
      const result = await scanner.listWarnings()
      // good.md 仍解析成功，broken.md 被跳过
      assert.equal(result.warnings.length, 1)
      assert.equal(result.warnings[0].path, "wiki/warnings/good.md")
      assert.ok(warnings.some((m) => m.includes("frontmatter parse failed")))
    } finally {
      t.cleanup()
    }
  })

  it("(W6) codex Week 4 mid-r1 P2: events 注入 → merge warning_raised rows (fs 缺时)", async () => {
    const t = setup()
    const dbPath = path.join(t.wikiRoot, "test.sqlite")
    const { db, close } = createDrizzleDb(dbPath)
    try {
      const events = new WikiEventsRepository(db)
      // 1 份 fs warning + 1 份 wiki_events row (fs 没对应文件)
      t.writeWarning(
        "fs-only.md",
        "type: warning\nsubtype: drift\nseverity: warn\ndetected_at: 2026-04-10T00:00:00Z\nraised_by: alice",
        "fs body",
      )
      const pendingEvent = events.appendPending({
        ts: "2026-04-15T11:00:00Z",
        alias: "桂芬",
        action: "warning_raised",
        path: "wiki/warnings/events-only.md",
        baseHash: null,
        attemptedHash: "abc123",
        diffSummary: "tainted_source detected",
        reason: "V14 layer 3 fired",
        fencingToken: "ft-1",
        leaderTerm: "999",
        result: "ok",
      })
      events.commit(pendingEvent.id, { contentHash: "abc123" })

      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot, events })
      const result = await scanner.listWarnings()
      // fs + events 合并: 2 行
      assert.equal(result.warnings.length, 2)
      const eventsOnly = result.warnings.find(
        (w) => w.path === "wiki/warnings/events-only.md",
      )
      assert.ok(eventsOnly, "events-only row should be merged")
      assert.equal(eventsOnly?.subtype, "warning_raised")
      assert.equal(eventsOnly?.source, "wiki_events")
      assert.equal(eventsOnly?.raisedBy, "桂芬")
    } finally {
      close()
      t.cleanup()
    }
  })

  it("(W7) codex Week 4 mid-r1 P2: events 注入 + fs 文件存在 → fs 优先 (不 dup)", async () => {
    const t = setup()
    const dbPath = path.join(t.wikiRoot, "test.sqlite")
    const { db, close } = createDrizzleDb(dbPath)
    try {
      const events = new WikiEventsRepository(db)
      t.writeWarning(
        "same.md",
        "type: warning\nsubtype: drift\nseverity: warn\ndetected_at: 2026-04-10T00:00:00Z\nraised_by: fs-author",
        "fs body",
      )
      const pendingEvent = events.appendPending({
        ts: "2026-04-15T00:00:00Z",
        alias: "events-author",
        action: "warning_raised",
        path: "wiki/warnings/same.md",
        baseHash: null,
        attemptedHash: "abc",
        diffSummary: "events row for same path",
        fencingToken: "ft-2",
        leaderTerm: "999",
        result: "ok",
      })
      events.commit(pendingEvent.id, { contentHash: "abc" })

      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot, events })
      const result = await scanner.listWarnings()
      // 仅 1 行 (fs 优先去重)
      assert.equal(result.warnings.length, 1)
      assert.equal(result.warnings[0].raisedBy, "fs-author") // fs 优先 (not events-author)
      assert.equal(result.warnings[0].subtype, "drift") // fs subtype, 不是 events 的 warning_raised
    } finally {
      close()
      t.cleanup()
    }
  })

  it("(W5) endpoint Fastify.inject → 200 + warnings/total shape", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "a.md",
        "type: warning\nsubtype: foo\nseverity: high\ndetected_at: 2026-04-01T00:00:00Z",
        "body",
      )
      const app = Fastify()
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      registerWikiMetaRoutes(app, { scanner })
      const resp = await app.inject({ method: "GET", url: "/api/wiki/warnings" })
      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.total, 1)
      assert.equal(body.warnings[0].subtype, "foo")
      await app.close()
    } finally {
      t.cleanup()
    }
  })
})

describe("WikiMetaScanner · listIndex", () => {
  it("(I1) wikiRoot 无 index/ → 空 list", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listIndex()
      assert.equal(result.total, 0)
    } finally {
      t.cleanup()
    }
  })

  it("(I2) 3 份 index → 解析 bucket + sort asc by bucket", async () => {
    const t = setup()
    try {
      t.writeIndex(
        "rules.md",
        "type: index_view\nbucket: rules\ngenerated_at: 2026-05-23T00:00:00Z\ncompiler_version: 1.0.0",
        "rules body",
      )
      t.writeIndex(
        "concepts.md",
        "type: index_view\nbucket: concepts\ngenerated_at: 2026-05-23T00:00:00Z\ncompiler_version: 1.0.0",
        "concepts body",
      )
      t.writeIndex(
        "methods.md",
        "type: index_view\nbucket: methods\ngenerated_at: 2026-05-23T00:00:00Z\ncompiler_version: 1.0.0",
        "methods body",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listIndex()
      assert.equal(result.total, 3)
      // sort asc by bucket name
      assert.deepEqual(
        result.views.map((v) => v.bucket),
        ["concepts", "methods", "rules"],
      )
      assert.equal(result.views[0].compilerVersion, "1.0.0")
    } finally {
      t.cleanup()
    }
  })

  it("(I3) frontmatter 无 bucket → fallback 用文件名", async () => {
    const t = setup()
    try {
      t.writeIndex("custom-bucket.md", "type: index_view\ngenerated_at: 2026-05-23T00:00:00Z", "body")
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listIndex()
      assert.equal(result.views[0].bucket, "custom-bucket")
    } finally {
      t.cleanup()
    }
  })

  it("(I4) endpoint Fastify.inject → 200 + views/total shape", async () => {
    const t = setup()
    try {
      t.writeIndex(
        "concepts.md",
        "type: index_view\nbucket: concepts\ngenerated_at: 2026-05-23T00:00:00Z",
        "body",
      )
      const app = Fastify()
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      registerWikiMetaRoutes(app, { scanner })
      const resp = await app.inject({ method: "GET", url: "/api/wiki/index" })
      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.total, 1)
      assert.equal(body.views[0].bucket, "concepts")
      await app.close()
    } finally {
      t.cleanup()
    }
  })
})

describe("WikiMetaScanner · readWarningContent (F027 展开看全文)", () => {
  it("返回 warning 全文（含 frontmatter + body）+ ISO mtime", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "drift-x.md",
        "type: warning\nsubtype: drift-detected\nseverity: high",
        "FULL WARNING BODY about drift",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const r = await scanner.readWarningContent("wiki/warnings/drift-x.md")
      assert.ok(r)
      assert.ok(r.content.includes("subtype: drift-detected"))
      assert.ok(r.content.includes("FULL WARNING BODY about drift"))
      assert.match(r.mtime, /^\d{4}-\d{2}-\d{2}T/)
    } finally {
      t.cleanup()
    }
  })

  it("文件不存在 → null（route 转 404）", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      assert.equal(await scanner.readWarningContent("wiki/warnings/missing.md"), null)
    } finally {
      t.cleanup()
    }
  })

  it("子目录 / .. / 错前缀 → 抛 WikiPathInvalidError（平铺 basename 白名单）", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      for (const bad of [
        "wiki/warnings/../index/concepts.md",
        "wiki/warnings/sub/dir.md",
        "wiki/index/concepts.md",
        "warnings/x.md",
      ]) {
        await assert.rejects(
          () => scanner.readWarningContent(bad),
          (e: Error) => e.name === "WikiPathInvalidError",
          `应拒绝: ${bad}`,
        )
      }
    } finally {
      t.cleanup()
    }
  })

  it("endpoint Fastify.inject → 200 全文 / 404 缺失 / 400 非法 / 400 缺 path", async () => {
    const t = setup()
    try {
      t.writeWarning("acl.md", "type: warning\nsubtype: acl-violation", "ACL BODY")
      const app = Fastify()
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      registerWikiMetaRoutes(app, { scanner })
      const ok = await app.inject({
        method: "GET",
        url: `/api/wiki/warnings/content?path=${encodeURIComponent("wiki/warnings/acl.md")}`,
      })
      assert.equal(ok.statusCode, 200)
      assert.ok(ok.json().content.includes("ACL BODY"))
      const miss = await app.inject({
        method: "GET",
        url: `/api/wiki/warnings/content?path=${encodeURIComponent("wiki/warnings/none.md")}`,
      })
      assert.equal(miss.statusCode, 404)
      const bad = await app.inject({
        method: "GET",
        url: `/api/wiki/warnings/content?path=${encodeURIComponent("wiki/index/x.md")}`,
      })
      assert.equal(bad.statusCode, 400)
      const noparam = await app.inject({ method: "GET", url: "/api/wiki/warnings/content" })
      assert.equal(noparam.statusCode, 400)
      await app.close()
    } finally {
      t.cleanup()
    }
  })

  // ── 德彪 codex review fixes（P1 realpath 围栏 + P2 regular-file）──
  it("非 .md 文件名 → 抛 WikiPathInvalidError（basename 白名单）", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      await assert.rejects(
        () => scanner.readWarningContent("wiki/warnings/x.txt"),
        (e: Error) => e.name === "WikiPathInvalidError",
      )
    } finally {
      t.cleanup()
    }
  })

  it("目标是目录（非普通文件）→ null（德彪 P2）", async () => {
    const t = setup()
    try {
      fs.mkdirSync(path.join(t.wikiRoot, "warnings", "dir.md"), { recursive: true })
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      assert.equal(await scanner.readWarningContent("wiki/warnings/dir.md"), null)
    } finally {
      t.cleanup()
    }
  })

  it("symlink 指向 warnings 外 → 抛 WikiPathInvalidError（德彪 P1 realpath 围栏）", async () => {
    const t = setup()
    try {
      const secret = path.join(t.wikiRoot, "secret.txt")
      fs.writeFileSync(secret, "TOP SECRET outside warnings")
      const warningsDir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(warningsDir, { recursive: true })
      const link = path.join(warningsDir, "evil.md")
      if (trySkipLink(() => fs.symlinkSync(secret, link, "file"), "symlink")) return
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      await assert.rejects(
        () => scanner.readWarningContent("wiki/warnings/evil.md"),
        (e: Error) => e.name === "WikiPathInvalidError",
      )
    } finally {
      t.cleanup()
    }
  })

  it("NTFS ADS（文件名含 ':'）→ 抛 WikiPathInvalidError（德彪 r2 P2）", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      await assert.rejects(
        () => scanner.readWarningContent("wiki/warnings/x.txt:stream.md"),
        (e: Error) => e.name === "WikiPathInvalidError",
      )
    } finally {
      t.cleanup()
    }
  })

  it("hardlink 指向 warnings 外 → 抛 WikiPathInvalidError（德彪 r2 P1 nlink）", async () => {
    const t = setup()
    try {
      const secret = path.join(t.wikiRoot, "secret.txt")
      fs.writeFileSync(secret, "SECRET via hardlink")
      const warningsDir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(warningsDir, { recursive: true })
      const hard = path.join(warningsDir, "hard.md")
      if (trySkipLink(() => fs.linkSync(secret, hard), "hardlink")) return
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      await assert.rejects(
        () => scanner.readWarningContent("wiki/warnings/hard.md"),
        (e: Error) => e.name === "WikiPathInvalidError",
      )
    } finally {
      t.cleanup()
    }
  })

  it("junction 指向 warnings 外目录 → 抛 WikiPathInvalidError（德彪 r2 P1）", async () => {
    const t = setup()
    try {
      const outsideDir = path.join(t.wikiRoot, "outside")
      fs.mkdirSync(outsideDir, { recursive: true })
      const warningsDir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(warningsDir, { recursive: true })
      const jlink = path.join(warningsDir, "evil.md")
      if (trySkipLink(() => fs.symlinkSync(outsideDir, jlink, "junction"), "junction")) return
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      // junction(目录) realpath 解析到 warnings 外 → 越界抛（即便不越界，目录也非 regular file）
      await assert.rejects(
        () => scanner.readWarningContent("wiki/warnings/evil.md"),
        (e: Error) => e.name === "WikiPathInvalidError",
      )
    } finally {
      t.cleanup()
    }
  })
})

// 德彪 codex r2 P2：只在明确"不支持建链"时跳过，别拿 catch{} 吞真失败。返回 true=跳过。
function trySkipLink(make: () => void, kind: string): boolean {
  try {
    make()
    return false
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 德彪 r3：EEXIST=目标已存在（测试 bug），不是"建链不支持"，不该跳过 → 移除，让它 throw 暴露。
    if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV" || code === "EACCES") {
      console.log(`${kind} unsupported (${code}), skipping`)
      return true
    }
    throw err
  }
}
