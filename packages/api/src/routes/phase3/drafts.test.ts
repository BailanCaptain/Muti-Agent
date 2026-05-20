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
import { DraftScanner } from "./drafts"

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
