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

test("AC-W2 · DraftScanner · _superseded 子目录不进审批列表（同源收敛归档区）", async () => {
  const tmp = safeTempDir("F027-ACW2-drafts-superseded-")
  try {
    await writeDraft(tmp, "_auto/F029-pipeline-1781201669303.md", { title: "Newest" }, "body new")
    await writeDraft(
      tmp,
      "_superseded/F029-pipeline-1781200633785.md",
      { title: "Superseded" },
      "body old",
    )
    await writeDraft(tmp, "_expired/old.md", { title: "Expired" }, "body expired")

    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.equal(r.total, 2, "_superseded 不应计入（_auto + _expired 各 1）")
    const titles = r.drafts.map((d) => d.title).sort()
    assert.deepEqual(titles, ["Expired", "Newest"])
  } finally {
    safeCleanup(tmp)
  }
})

test("补丁#3 · DraftScanner · summarize 并行（非串行逐篇，峰值并发>1）", async () => {
  // 小孙反馈「点审批迟迟没东西出来」根因：62 篇 draft 后端逐篇串行 readFile+stat。
  // 改并行后，多篇 summarize 应同时 in-flight。用 hang 住的 readFile 量并发峰值：
  // 串行实现峰值恒=1；并行实现应≥2（带并发上限）。
  const N = 8
  let inFlight = 0
  let peak = 0
  const fsAdapter = {
    // 只一层、全 .md 文件（无目录递归）→ readdir 只调一次
    readdir: async () =>
      Array.from({ length: N }, (_, i) => ({
        name: `d${i}.md`,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      })),
    readFile: () =>
      new Promise<string>((resolve) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        setTimeout(() => {
          inFlight--
          resolve("---\ntitle: X\ntype: concept\n---\nbody")
        }, 5)
      }),
    stat: async () => ({ mtime: new Date() }),
  }
  const scanner = new DraftScanner({ wikiRoot: "/fake-parallel", fsAdapter })
  const r = await scanner.list({})
  assert.equal(r.total, N, "全部 summarize 成功")
  assert.ok(peak > 1, `summarize 应并行，实测峰值并发=${peak}（串行恒=1）`)
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
    if (trySkipLink(() => fs.symlinkSync(secret, link, "file"), "symlink")) return
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

// 德彪 codex r2 P2：只在明确"不支持建链"时跳过，别拿 catch{} 吞掉真失败。返回 true=跳过。
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

test("F027 readContent · NTFS ADS（路径含 ':'）→ 抛 WikiPathInvalidError（德彪 r2 P2）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-ads-")
  try {
    const scanner = new DraftScanner({ wikiRoot: tmp })
    await assert.rejects(
      () => scanner.readContent("wiki/concepts/draft/_auto/x.txt:stream.md"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · hardlink 指向 draft 树外 → 抛 WikiPathInvalidError（德彪 r2 P1 nlink）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-hardlink-")
  try {
    const secret = path.join(tmp, "secret.txt")
    await fsp.writeFile(secret, "TOP SECRET via hardlink", "utf-8")
    const autoDir = path.join(tmp, "wiki", "concepts", "draft", "_auto")
    await fsp.mkdir(autoDir, { recursive: true })
    const hard = path.join(autoDir, "hard.md")
    if (trySkipLink(() => fs.linkSync(secret, hard), "hardlink")) return
    const scanner = new DraftScanner({ wikiRoot: tmp })
    await assert.rejects(
      () => scanner.readContent("wiki/concepts/draft/_auto/hard.md"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})

test("F027 readContent · junction 指向 draft 树外目录 → 抛 WikiPathInvalidError（德彪 r2 P1）", async () => {
  const tmp = safeTempDir("F027-drafts-readcontent-junction-")
  try {
    const outsideDir = path.join(tmp, "outside")
    await fsp.mkdir(outsideDir, { recursive: true })
    await fsp.writeFile(path.join(outsideDir, "secret.md"), "SECRET via junction", "utf-8")
    const autoDir = path.join(tmp, "wiki", "concepts", "draft", "_auto")
    await fsp.mkdir(autoDir, { recursive: true })
    const jdir = path.join(autoDir, "jdir")
    if (trySkipLink(() => fs.symlinkSync(outsideDir, jdir, "junction"), "junction")) return
    const scanner = new DraftScanner({ wikiRoot: tmp })
    await assert.rejects(
      () => scanner.readContent("wiki/concepts/draft/_auto/jdir/secret.md"),
      (e: Error) => e.name === "WikiPathInvalidError",
    )
  } finally {
    safeCleanup(tmp)
  }
})

// ─── F027 bucket-routing 补丁 · suggestedDestPath（LLM canonical_owner_suggestion 透出） ──

test("bucket routing · canonical_owner_suggestion 合法桶 → suggestedDestPath 按桶分流", async () => {
  const tmp = safeTempDir("F027-bucket-suggest-")
  try {
    await writeDraft(
      tmp,
      "_auto/foo.md",
      { title: "foo", canonical_owner_suggestion: "wiki/methods/" },
      "body",
    )
    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.equal(r.drafts.length, 1)
    assert.equal(r.drafts[0].suggestedDestPath, "wiki/methods/foo.md")
  } finally {
    safeCleanup(tmp)
  }
})

test("bucket routing · 无 suggestion / 非法桶 → fallback wiki/concepts/", async () => {
  const tmp = safeTempDir("F027-bucket-fallback-")
  try {
    await writeDraft(tmp, "_auto/nosug.md", { title: "nosug" }, "body")
    await writeDraft(
      tmp,
      "_auto/evil.md",
      { title: "evil", canonical_owner_suggestion: "wiki/../../etc/" },
      "body",
    )
    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    const nosug = r.drafts.find((d) => d.path.endsWith("nosug.md"))
    const evil = r.drafts.find((d) => d.path.endsWith("evil.md"))
    assert.equal(nosug?.suggestedDestPath, "wiki/concepts/nosug.md")
    assert.equal(evil?.suggestedDestPath, "wiki/concepts/evil.md")
  } finally {
    safeCleanup(tmp)
  }
})

test("bucket routing · versioned 文件名去 -<13位时间戳> 后缀", async () => {
  const tmp = safeTempDir("F027-bucket-version-")
  try {
    await writeDraft(
      tmp,
      "_auto/notes-1749629000000.md",
      { title: "notes", canonical_owner_suggestion: "wiki/rules/" },
      "body",
    )
    const scanner = new DraftScanner({ wikiRoot: tmp })
    const r = await scanner.list({})
    assert.equal(r.drafts[0].suggestedDestPath, "wiki/rules/notes.md")
  } finally {
    safeCleanup(tmp)
  }
})
