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
      // F027 修：file-scanned warning → hasContent true（前端据此渲染「展开看全文」）
      assert.equal(result.warnings[0].hasContent, true)
      assert.equal(result.warnings[1].hasContent, true)
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
      // F027 修：event-only warning 无 .md 文件 → hasContent false（前端不渲染「展开看全文」→ 防 404）
      assert.equal(eventsOnly?.hasContent, false)
      // 同 list 里 fs warning → hasContent true（对照：合成 path 也以 wiki/warnings/ 开头，靠 hasContent 区分）
      const fsOnly = result.warnings.find((w) => w.path === "wiki/warnings/fs-only.md")
      assert.equal(fsOnly?.hasContent, true)
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

describe("WikiMetaScanner · hasContent ⟺ content 端点 契约一致 (德彪 codex r-warn P2)", () => {
  it("正常文件 → hasContent=true 且 content 端点返回内容", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "ok.md",
        "type: warning\nsubtype: drift\nseverity: warn\ndetected_at: 2026-04-10T00:00:00Z",
        "full body text",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const list = await scanner.listWarnings()
      const w = list.warnings.find((x) => x.path === "wiki/warnings/ok.md")
      assert.equal(w?.hasContent, true)
      const content = await scanner.readWarningContent("wiki/warnings/ok.md")
      assert.ok(content, "content 端点应返回内容")
      assert.match(content?.content ?? "", /full body text/)
    } finally {
      t.cleanup()
    }
  })

  it("event-only（无文件）→ hasContent=false 且 content 端点返回 null", async () => {
    const t = setup()
    const dbPath = path.join(t.wikiRoot, "test.sqlite")
    const { db, close } = createDrizzleDb(dbPath)
    try {
      const events = new WikiEventsRepository(db)
      const ev = events.appendPending({
        ts: "2026-04-15T11:00:00Z",
        alias: "桂芬",
        action: "warning_raised",
        path: "wiki/warnings/event-only.md",
        baseHash: null,
        attemptedHash: "h",
        diffSummary: "drift",
        reason: "fired",
        fencingToken: "ft",
        leaderTerm: "999",
        result: "ok",
      })
      events.commit(ev.id, { contentHash: "h" })
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot, events })
      const list = await scanner.listWarnings()
      const w = list.warnings.find((x) => x.path === "wiki/warnings/event-only.md")
      assert.equal(w?.hasContent, false)
      const content = await scanner.readWarningContent("wiki/warnings/event-only.md")
      assert.equal(content, null)
    } finally {
      close()
      t.cleanup()
    }
  })

  it("解析失败文件 + 同 path event → hasContent=true 且裸读返回内容（修 mismatch#1：有内容却藏按钮）", async () => {
    const t = setup()
    const dbPath = path.join(t.wikiRoot, "test.sqlite")
    const { db, close } = createDrizzleDb(dbPath)
    try {
      // 真文件存在但 frontmatter 坏 → summarizeWarning 返 null（不进 list）；event 同 path 兜底进 list。
      // content 端点裸读不解析 frontmatter → 能读出 → hasContent 必须 true（旧"按 producer 猜"会误判 false）。
      const dir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, "broken.md"),
        "---\nbroken: [unclosed\n---\n\nreadable raw body",
      )
      const events = new WikiEventsRepository(db)
      const ev = events.appendPending({
        ts: "2026-04-16T00:00:00Z",
        alias: "system",
        action: "warning_raised",
        path: "wiki/warnings/broken.md",
        baseHash: null,
        attemptedHash: "h",
        diffSummary: "broken fm",
        reason: "x",
        fencingToken: "ft",
        leaderTerm: "999",
        result: "ok",
      })
      events.commit(ev.id, { contentHash: "h" })
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot, events })
      const list = await scanner.listWarnings()
      const w = list.warnings.find((x) => x.path === "wiki/warnings/broken.md")
      assert.ok(w, "event 兜底应让 broken.md 进 list")
      assert.equal(w?.hasContent, true)
      const content = await scanner.readWarningContent("wiki/warnings/broken.md")
      assert.ok(content, "content 端点裸读应成功（不解析 frontmatter）")
      assert.match(content?.content ?? "", /readable raw body/)
    } finally {
      close()
      t.cleanup()
    }
  })

  it("hardlink 文件 → 不进 list（summary 不泄露树外内容）+ content 端点抛（修 mismatch#2 + 德彪 r2 P1 泄露）", async () => {
    const t = setup()
    try {
      const secret = path.join(t.wikiRoot, "secret.txt")
      const secretBody = "TOP-SECRET-EXFIL-MARKER body outside warnings"
      fs.writeFileSync(
        secret,
        `---\ntype: warning\nsubtype: x\ndetected_at: 2026-04-01T00:00:00Z\n---\n\n${secretBody}`,
      )
      const dir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(dir, { recursive: true })
      const hard = path.join(dir, "hard.md")
      if (trySkipLink(() => fs.linkSync(secret, hard), "hardlink")) return
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const list = await scanner.listWarnings()
      // 德彪 r2 P1：hardlink 在 summarizeWarning 的 readContainedFile 处即被 nlink>1 拒 → 不进 list。
      const w = list.warnings.find((x) => x.path === "wiki/warnings/hard.md")
      assert.equal(w, undefined, "hardlink 文件应被 containment 拒于扫描阶段 → 不进 list")
      // 关键回归：树外内容不得通过任何 warning 的 summary 泄露
      for (const x of list.warnings) {
        assert.ok(!x.summary.includes("TOP-SECRET-EXFIL-MARKER"), "summary 不得泄露树外文件内容")
      }
      // content 端点同样拒（400）
      await assert.rejects(
        () => scanner.readWarningContent("wiki/warnings/hard.md"),
        (e: Error) => e.name === "WikiPathInvalidError",
      )
    } finally {
      t.cleanup()
    }
  })

  it("event 兜底 path 指向目录 → hasContent=false（event 探测全量 read 拒非普通文件）", async () => {
    const t = setup()
    const dbPath = path.join(t.wikiRoot, "test.sqlite")
    const { db, close } = createDrizzleDb(dbPath)
    try {
      // warnings/ 下建名为 adir.md 的**目录**（listMdFiles 过滤目录 → 不进 fs 扫描）；event 同 path 兜底进 list
      const dir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(path.join(dir, "adir.md"), { recursive: true })
      const events = new WikiEventsRepository(db)
      const ev = events.appendPending({
        ts: "2026-04-17T00:00:00Z",
        alias: "system",
        action: "warning_raised",
        path: "wiki/warnings/adir.md",
        baseHash: null,
        attemptedHash: "h",
        diffSummary: "d",
        reason: "r",
        fencingToken: "ft",
        leaderTerm: "999",
        result: "ok",
      })
      events.commit(ev.id, { contentHash: "h" })
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot, events })
      const list = await scanner.listWarnings()
      const w = list.warnings.find((x) => x.path === "wiki/warnings/adir.md")
      assert.ok(w, "event 兜底应让 adir.md 进 list")
      assert.equal(w?.hasContent, false) // 目录非普通文件 → content 端点 404 → 不显按钮
      assert.equal(await scanner.readWarningContent("wiki/warnings/adir.md"), null)
    } finally {
      close()
      t.cleanup()
    }
  })

  it("文件名含 '..'（foo..bar.md）→ 扫描拒（不进 list）+ content 端点抛，与白名单一致（德彪 r3 P2）", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "foo..bar.md",
        "type: warning\nsubtype: x\ndetected_at: 2026-04-01T00:00:00Z",
        "body",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const list = await scanner.listWarnings()
      assert.equal(
        list.warnings.find((x) => x.path === "wiki/warnings/foo..bar.md"),
        undefined,
        "含 '..' 的文件名应被白名单拒于扫描阶段（content 端点同样拒 → 400）",
      )
      await assert.rejects(
        () => scanner.readWarningContent("wiki/warnings/foo..bar.md"),
        (e: Error) => e.name === "WikiPathInvalidError",
      )
    } finally {
      t.cleanup()
    }
  })

  it("整个 warnings/ 是指向树外的 junction → list 空（不泄露）+ content 返 null，根逃逸被拒（德彪 r3 P1）", async () => {
    const t = setup()
    const outside = path.join(os.tmpdir(), `wiki-meta-outside-${path.basename(t.wikiRoot)}`)
    try {
      fs.mkdirSync(outside, { recursive: true })
      fs.writeFileSync(
        path.join(outside, "leak.md"),
        "---\ntype: warning\nsubtype: x\ndetected_at: 2026-04-01T00:00:00Z\n---\n\nROOT-JUNCTION-EXFIL secret body",
      )
      // 把 <wikiRoot>/warnings 整个做成指向树外 outside 的 junction（setup 未建 warnings/ → 可建链）
      const warningsDir = path.join(t.wikiRoot, "warnings")
      if (trySkipLink(() => fs.symlinkSync(outside, warningsDir, "junction"), "junction")) return
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const list = await scanner.listWarnings()
      // 根 realpath 落在 wikiRoot 外 → containedWarningsRoot 拒 → 不扫树外文件、summary 不泄露
      assert.equal(list.warnings.length, 0, "warnings 根逃逸 wikiRoot 应被拒 → 空 list")
      assert.equal(await scanner.readWarningContent("wiki/warnings/leak.md"), null)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
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
