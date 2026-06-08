/**
 * F027 Phase 3 P20 · DraftScanner tests — Week 1 Day 3
 *
 * 覆盖：
 *   - 空 wiki root → drafts=[] + total=0
 *   - 多 origin 子目录扫描（_auto / _backfill / _expired / user-drop）
 *   - frontmatter.type 取 + fallback "concept"
 *   - frontmatter.title 取 + filename fallback
 *   - filter by type / mtimeFrom / mtimeTo
 *   - pagination（limit + offset）+ DESC by mtime
 *   - 损坏 frontmatter 跳过不打断
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { DraftScanner, registerDraftsRoute } from "./drafts"

function safeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, prefix))
}

function safeCleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

async function writeDraft(
  wikiRoot: string,
  relSubpath: string,
  frontmatter: Record<string, string> | null,
  body: string,
  mtime?: Date,
): Promise<void> {
  const abs = path.join(wikiRoot, "wiki", "concepts", "draft", relSubpath)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const fm = frontmatter
    ? `---\n${Object.entries(frontmatter)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}\n---\n`
    : ""
  await fsp.writeFile(abs, fm + body, "utf-8")
  if (mtime) {
    await fsp.utimes(abs, mtime, mtime)
  }
}

test("Day 3 · DraftScanner · wiki root 不存在 → 空列表", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-empty-")
  try {
    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.equal(r.drafts.length, 0)
    assert.equal(r.total, 0)
    assert.equal(r.limit, 50)
    assert.equal(r.offset, 0)
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · 多 origin 子目录扫 + 默认 type=concept", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-origins-")
  try {
    await writeDraft(tmp, "_auto/2026-05-20-foo.md", { title: "Foo" }, "body foo")
    await writeDraft(tmp, "_backfill/historical.md", { title: "Hist" }, "body hist")
    await writeDraft(tmp, "_expired/old.md", { title: "Old" }, "body old")
    await writeDraft(tmp, "manual-drop.md", { title: "User" }, "body user")

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.equal(r.total, 4)
    const byOrigin = new Map(r.drafts.map((d) => [d.origin, d.title]))
    assert.equal(byOrigin.get("auto"), "Foo")
    assert.equal(byOrigin.get("backfill"), "Hist")
    assert.equal(byOrigin.get("expired"), "Old")
    assert.equal(byOrigin.get("user-drop"), "User")
    // 默认 type=concept
    assert.ok(r.drafts.every((d) => d.type === "concept"))
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · frontmatter.type 取 + 越界值 fallback concept", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-type-")
  try {
    await writeDraft(tmp, "f.md", { type: "feature", title: "F" }, "")
    await writeDraft(tmp, "b.md", { type: "bug", title: "B" }, "")
    await writeDraft(tmp, "bogus.md", { type: "not-a-type", title: "X" }, "")

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    const byTitle = new Map(r.drafts.map((d) => [d.title, d.type]))
    assert.equal(byTitle.get("F"), "feature")
    assert.equal(byTitle.get("B"), "bug")
    assert.equal(byTitle.get("X"), "concept", "invalid type should fall back to concept")
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · title 缺时 filename fallback", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-title-")
  try {
    await writeDraft(tmp, "2026-05-20-foo.md", null, "body")
    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.equal(r.drafts[0]?.title, "2026-05-20-foo")
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · filter by type", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-filter-")
  try {
    await writeDraft(tmp, "f1.md", { type: "feature", title: "F1" }, "")
    await writeDraft(tmp, "f2.md", { type: "feature", title: "F2" }, "")
    await writeDraft(tmp, "b1.md", { type: "bug", title: "B1" }, "")

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({ type: "feature" })
    assert.equal(r.total, 2)
    assert.ok(r.drafts.every((d) => d.type === "feature"))
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · filter by mtime range", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-mtime-")
  try {
    const old = new Date("2026-01-01T00:00:00Z")
    const mid = new Date("2026-05-15T00:00:00Z")
    const recent = new Date("2026-05-25T00:00:00Z")
    await writeDraft(tmp, "old.md", { title: "old" }, "", old)
    await writeDraft(tmp, "mid.md", { title: "mid" }, "", mid)
    await writeDraft(tmp, "recent.md", { title: "recent" }, "", recent)

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({
      mtimeFrom: "2026-05-01T00:00:00Z",
      mtimeTo: "2026-05-20T00:00:00Z",
    })
    assert.equal(r.total, 1)
    assert.equal(r.drafts[0]?.title, "mid")
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · pagination + DESC by mtime", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-page-")
  try {
    for (let i = 0; i < 10; i += 1) {
      const mtime = new Date(`2026-05-${10 + i}T00:00:00Z`)
      await writeDraft(tmp, `d${i}.md`, { title: `D${i}` }, "", mtime)
    }

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const page1 = await scanner.list({ limit: 3, offset: 0 })
    assert.equal(page1.total, 10)
    assert.equal(page1.drafts.length, 3)
    // mtime DESC → D9 最新
    assert.equal(page1.drafts[0]?.title, "D9")
    assert.equal(page1.drafts[2]?.title, "D7")

    const page2 = await scanner.list({ limit: 3, offset: 3 })
    assert.equal(page2.drafts[0]?.title, "D6")
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · 损坏 frontmatter 跳过不打断", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-bad-fm-")
  try {
    await writeDraft(tmp, "good.md", { title: "OK" }, "body")
    // 写一个 frontmatter 损坏的文件（: : 多个冒号 yaml）
    const badPath = path.join(tmp, "wiki", "concepts", "draft", "bad.md")
    await fsp.writeFile(badPath, "---\nfoo: : :\n---\nbody", "utf-8")

    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const scanner = new DraftScanner({
      wikiRoot: tmp,
      logWarn: (obj, msg) => warns.push({ obj, msg }),
    })
    const r = await scanner.list({})
    assert.equal(r.total, 1, "good draft should still be returned")
    assert.equal(r.drafts[0]?.title, "OK")
    assert.ok(warns.length > 0, "warn should be logged for bad frontmatter")
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · summary 取 body 前 200 字 trim", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-summary-")
  try {
    const longBody = "lorem ".repeat(100) // ~600 字
    await writeDraft(tmp, "long.md", { title: "L" }, longBody)

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.ok(r.drafts[0])
    assert.ok(r.drafts[0].summary.length <= 200)
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · 拒 symlink entry（范-r1 P1-4 raw drop taint 防御）", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-symlink-")
  try {
    // 写一个真 .md
    await writeDraft(tmp, "real.md", { title: "Real" }, "body")
    // 在 draft 根创建一个 symlink 指向 tmp 外（模拟 V16.5 chap 7 raw drop 攻击）
    const draftRoot = path.join(tmp, "wiki", "concepts", "draft")
    const outsideTarget = path.join(tmp, "outside.md")
    await fsp.writeFile(outsideTarget, "# Outside\n\nleaked", "utf-8")
    const linkPath = path.join(draftRoot, "evil-symlink.md")
    try {
      await fsp.symlink(outsideTarget, linkPath, "file")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Windows 无管理员权限 / FS 不支持 symlink 时 skip 测试
      if (code === "EPERM" || code === "ENOSYS") {
        console.warn("symlink not supported on this FS, skipping test")
        return
      }
      throw err
    }

    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const scanner = new DraftScanner({
      wikiRoot: tmp,
      logWarn: (obj, msg) => warns.push({ obj, msg }),
    })
    const r = await scanner.list({})
    assert.equal(r.total, 1, "only real.md should be scanned, symlink skipped")
    assert.equal(r.drafts[0]?.title, "Real")
    assert.ok(
      warns.some((w) => w.msg.includes("symlink")),
      "should log warn about skipped symlink",
    )
  } finally {
    safeCleanup(tmp)
  }
})

test("Day 3 · DraftScanner · 非 .md 文件忽略", async () => {
  const tmp = safeTempDir("F027-Day3-drafts-non-md-")
  try {
    await writeDraft(tmp, "ok.md", { title: "OK" }, "")
    // 写非 md 文件
    const txtPath = path.join(tmp, "wiki", "concepts", "draft", "ignore.txt")
    await fsp.writeFile(txtPath, "ignore me", "utf-8")

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.equal(r.total, 1)
    assert.equal(r.drafts[0]?.title, "OK")
  } finally {
    safeCleanup(tmp)
  }
})

// ── F027 readContent（KB tab「展开看全文」）─────────────────────────────────
test("F027 readContent · 返回 draft 全文（含 frontmatter + body）+ ISO mtime", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-ok-")
  try {
    await writeDraft(
      tmp,
      "_auto/full.md",
      { title: "Full Doc", type: "lesson" },
      "BODY LINE 1\nBODY LINE 2",
    )
    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.readContent("wiki/concepts/draft/_auto/full.md")
    assert.ok(r, "readContent 应返回非 null")
    assert.ok(r.content.includes("title: Full Doc"), "全文应含 frontmatter")
    assert.ok(r.content.includes("BODY LINE 1"), "全文应含 body")
    assert.ok(r.content.includes("BODY LINE 2"))
    assert.match(r.mtime, /^\d{4}-\d{2}-\d{2}T/, "mtime 应为 ISO 串")
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · 文件不存在 → null（route 转 404）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-404-")
  try {
    const scanner = new DraftScanner({ wikiRoot: tmp })
    assert.equal(await scanner.readContent("wiki/concepts/draft/_auto/nope.md"), null)
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · ../ 逃逸 wiki/ namespace → 抛 WikiPathInvalidError", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-escape-")
  try {
    const scanner = new DraftScanner({ wikiRoot: tmp })
    await assert.rejects(
      () => scanner.readContent("wiki/concepts/draft/../../../../etc/passwd"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · wiki/ 内但不在 draft 子树 → 抛 WikiPathInvalidError（只读 draft）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-nondraft-")
  try {
    const rulesPath = path.join(tmp, "wiki", "concepts", "rules", "secret.md")
    await fsp.mkdir(path.dirname(rulesPath), { recursive: true })
    await fsp.writeFile(rulesPath, "secret", "utf-8")
    const scanner = new DraftScanner({ wikiRoot: tmp })
    await assert.rejects(
      () => scanner.readContent("wiki/concepts/rules/secret.md"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · 无 wiki/ 前缀 → 抛 WikiPathInvalidError", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-noprefix-")
  try {
    const scanner = new DraftScanner({ wikiRoot: tmp })
    await assert.rejects(
      () => scanner.readContent("etc/passwd"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent route · 200 全文 / 404 缺失 / 400 非 draft / 400 缺 path", async () => {
  const tmp = safeTempDir("F027-drafts-content-route-")
  try {
    await writeDraft(tmp, "_auto/rt.md", { title: "RT" }, "ROUTE BODY")
    const app = Fastify()
    const scanner = new DraftScanner({ wikiRoot: tmp })
    registerDraftsRoute(app, scanner)
    const ok = await app.inject({
      method: "GET",
      url: `/api/wiki/drafts/content?path=${encodeURIComponent("wiki/concepts/draft/_auto/rt.md")}`,
    })
    assert.equal(ok.statusCode, 200)
    assert.ok(ok.json().content.includes("ROUTE BODY"))
    const miss = await app.inject({
      method: "GET",
      url: `/api/wiki/drafts/content?path=${encodeURIComponent("wiki/concepts/draft/_auto/none.md")}`,
    })
    assert.equal(miss.statusCode, 404)
    const bad = await app.inject({
      method: "GET",
      url: `/api/wiki/drafts/content?path=${encodeURIComponent("wiki/concepts/rules/x.md")}`,
    })
    assert.equal(bad.statusCode, 400)
    const noparam = await app.inject({ method: "GET", url: "/api/wiki/drafts/content" })
    assert.equal(noparam.statusCode, 400)
    await app.close()
  } finally {
    safeCleanup(tmp)
  }
})

// ── 德彪 codex review fixes（P1 symlink/junction realpath 围栏 + P2 .md/regular-file）──
test("F027 readContent · 非 .md → 抛 WikiPathInvalidError（德彪 P2：只读 .md）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-notmd-")
  try {
    const txt = path.join(tmp, "wiki", "concepts", "draft", "_auto", "x.txt")
    await fsp.mkdir(path.dirname(txt), { recursive: true })
    await fsp.writeFile(txt, "not markdown", "utf-8")
    const scanner = new DraftScanner({ wikiRoot: tmp })
    await assert.rejects(
      () => scanner.readContent("wiki/concepts/draft/_auto/x.txt"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · 目标是目录（非普通文件）→ null（德彪 P2）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-dir-")
  try {
    // 建一个名为 dir.md 的**目录**（.md 后缀但非普通文件）
    const dir = path.join(tmp, "wiki", "concepts", "draft", "_auto", "dir.md")
    await fsp.mkdir(dir, { recursive: true })
    const scanner = new DraftScanner({ wikiRoot: tmp })
    assert.equal(await scanner.readContent("wiki/concepts/draft/_auto/dir.md"), null)
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · symlink 指向 draft 树外 → 抛 WikiPathInvalidError（德彪 P1 realpath 围栏）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-symlink-")
  try {
    const secret = path.join(tmp, "secret.txt")
    await fsp.writeFile(secret, "TOP SECRET outside draft", "utf-8")
    const autoDir = path.join(tmp, "wiki", "concepts", "draft", "_auto")
    await fsp.mkdir(autoDir, { recursive: true })
    const link = path.join(autoDir, "evil.md")
    try {
      fs.symlinkSync(secret, link, "file")
    } catch {
      console.log("symlink not supported on this FS, skipping symlink-escape test")
      return
    }
    const scanner = new DraftScanner({ wikiRoot: tmp })
    // 词法检查放行（.md + 在 draft 子树），但 realpath 解析到树外 → 抛
    await assert.rejects(
      () => scanner.readContent("wiki/concepts/draft/_auto/evil.md"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})
