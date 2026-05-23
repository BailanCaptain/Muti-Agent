import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import { applyWorktreePreviewWikiFixtures } from "./worktree-preview-wiki-fixtures"

/**
 * F027 P4 AC-P4-9 a/b · wiki fixture copier 单测
 *
 * 测试覆盖:
 *   (1) WORKTREE_PREVIEW != 1 → gateClosed (primary)
 *   (2) destWikiRoot 不含 .runtime/worktree-preview/ → gateClosed (secondary)
 *   (3) gate pass + 空 dest → 拷 warnings + index 全部 fixture md
 *   (4) dest warnings/ 已有文件 → skip warnings bucket，但 index bucket 仍可 copy
 *   (5) src fixture dir 不存在 → bucket skipped (不报错)
 *   (6) src fixture 含非 .md 文件 → 仅 copy .md
 *   (7) Windows backslash sqlitePath normalize 正确
 */

function setupTempRepo(): {
  repoRoot: string
  destWikiRoot: string
  cleanup: () => void
} {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-fixtures-test-"))
  const repoRoot = path.join(tempBase, "repo")
  const destWikiRoot = path.join(repoRoot, ".runtime/worktree-preview/data/wiki")
  fs.mkdirSync(repoRoot, { recursive: true })
  // 在 repoRoot 下造 fixture
  const fixtureRoot = path.join(repoRoot, "tests/fixtures/wiki")
  fs.mkdirSync(path.join(fixtureRoot, "warnings"), { recursive: true })
  fs.mkdirSync(path.join(fixtureRoot, "index"), { recursive: true })
  // 写 2 份 warnings 1 份 index 测试 fixture
  fs.writeFileSync(path.join(fixtureRoot, "warnings/a.md"), "warning A body")
  fs.writeFileSync(path.join(fixtureRoot, "warnings/b.md"), "warning B body")
  fs.writeFileSync(path.join(fixtureRoot, "index/concepts.md"), "concepts view")
  return {
    repoRoot,
    destWikiRoot,
    cleanup: () => fs.rmSync(tempBase, { recursive: true, force: true }),
  }
}

describe("applyWorktreePreviewWikiFixtures", () => {
  let originalEnv: string | undefined
  beforeEach(() => {
    originalEnv = process.env.WORKTREE_PREVIEW
    process.env.WORKTREE_PREVIEW = "1"
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.WORKTREE_PREVIEW
    else process.env.WORKTREE_PREVIEW = originalEnv
  })

  it("(1) WORKTREE_PREVIEW != 1 → gateClosed (primary)", () => {
    const t = setupTempRepo()
    try {
      const result = applyWorktreePreviewWikiFixtures({
        destWikiRoot: t.destWikiRoot,
        worktreePreview: "0",
        repoRoot: t.repoRoot,
      })
      assert.ok(result.gateClosed)
      assert.match(result.gateClosed!.reason, /primary/)
      // dest 应未创建
      assert.equal(fs.existsSync(t.destWikiRoot), false)
    } finally {
      t.cleanup()
    }
  })

  it("(2) destWikiRoot 不含 .runtime/worktree-preview/ → gateClosed (secondary)", () => {
    const t = setupTempRepo()
    try {
      const wrongDest = path.join(t.repoRoot, "prod/wiki")
      const result = applyWorktreePreviewWikiFixtures({
        destWikiRoot: wrongDest,
        repoRoot: t.repoRoot,
      })
      assert.ok(result.gateClosed)
      assert.match(result.gateClosed!.reason, /secondary/)
      assert.equal(fs.existsSync(wrongDest), false)
    } finally {
      t.cleanup()
    }
  })

  it("(3) gate pass + 空 dest → 拷 warnings 2 份 + index 1 份", () => {
    const t = setupTempRepo()
    try {
      const result = applyWorktreePreviewWikiFixtures({
        destWikiRoot: t.destWikiRoot,
        repoRoot: t.repoRoot,
      })
      assert.equal(result.gateClosed, undefined)

      const warnings = result.buckets.warnings as { copied: number; files: string[] }
      assert.equal(warnings.copied, 2)
      assert.deepEqual(warnings.files.sort(), ["a.md", "b.md"])

      const index = result.buckets.index as { copied: number; files: string[] }
      assert.equal(index.copied, 1)
      assert.deepEqual(index.files, ["concepts.md"])

      // dest 文件实际存在
      assert.ok(fs.existsSync(path.join(t.destWikiRoot, "warnings/a.md")))
      assert.ok(fs.existsSync(path.join(t.destWikiRoot, "index/concepts.md")))
      // 内容相符
      assert.equal(
        fs.readFileSync(path.join(t.destWikiRoot, "warnings/a.md"), "utf-8"),
        "warning A body",
      )
    } finally {
      t.cleanup()
    }
  })

  it("(4) dest warnings/ 已有文件 → skip warnings 但 index 仍 copy", () => {
    const t = setupTempRepo()
    try {
      // 预先在 dest warnings/ 写文件
      fs.mkdirSync(path.join(t.destWikiRoot, "warnings"), { recursive: true })
      fs.writeFileSync(path.join(t.destWikiRoot, "warnings/existing.md"), "old data")

      const result = applyWorktreePreviewWikiFixtures({
        destWikiRoot: t.destWikiRoot,
        repoRoot: t.repoRoot,
      })

      const warnings = result.buckets.warnings as { skipped: true; existingFiles: number }
      assert.equal(warnings.skipped, true)
      assert.equal(warnings.existingFiles, 1)

      const index = result.buckets.index as { copied: number; files: string[] }
      assert.equal(index.copied, 1)

      // existing 文件未被覆盖
      assert.equal(
        fs.readFileSync(path.join(t.destWikiRoot, "warnings/existing.md"), "utf-8"),
        "old data",
      )
      // fixture a.md 没被 copy 进去
      assert.equal(fs.existsSync(path.join(t.destWikiRoot, "warnings/a.md")), false)
    } finally {
      t.cleanup()
    }
  })

  it("(5) src fixture dir 不存在 → bucket skipped (不报错)", () => {
    const t = setupTempRepo()
    try {
      // 删 warnings fixture dir
      fs.rmSync(path.join(t.repoRoot, "tests/fixtures/wiki/warnings"), {
        recursive: true,
        force: true,
      })
      const result = applyWorktreePreviewWikiFixtures({
        destWikiRoot: t.destWikiRoot,
        repoRoot: t.repoRoot,
      })
      const warnings = result.buckets.warnings as { skipped: true; existingFiles: number }
      assert.equal(warnings.skipped, true)
      assert.equal(warnings.existingFiles, 0)
      // index 仍正常 copy
      const index = result.buckets.index as { copied: number; files: string[] }
      assert.equal(index.copied, 1)
    } finally {
      t.cleanup()
    }
  })

  it("(6) src fixture 含非 .md 文件 → 仅 copy .md", () => {
    const t = setupTempRepo()
    try {
      // 在 warnings/ 加 .txt 文件
      fs.writeFileSync(
        path.join(t.repoRoot, "tests/fixtures/wiki/warnings/notes.txt"),
        "not markdown",
      )
      const result = applyWorktreePreviewWikiFixtures({
        destWikiRoot: t.destWikiRoot,
        repoRoot: t.repoRoot,
      })
      const warnings = result.buckets.warnings as { copied: number; files: string[] }
      assert.equal(warnings.copied, 2) // 仅 a.md + b.md，不含 notes.txt
      assert.ok(!warnings.files.includes("notes.txt"))
    } finally {
      t.cleanup()
    }
  })

  it("(7) Windows backslash dest path normalize 正确 (含 .runtime/worktree-preview/)", () => {
    const t = setupTempRepo()
    try {
      // 模拟 Windows backslash path
      const winStyleDest = t.destWikiRoot.replace(/\//g, "\\")
      const result = applyWorktreePreviewWikiFixtures({
        destWikiRoot: winStyleDest,
        repoRoot: t.repoRoot,
      })
      // 应该 pass gate (normalize 后含 .runtime/worktree-preview/)
      assert.equal(result.gateClosed, undefined)
      const warnings = result.buckets.warnings as { copied: number; files: string[] }
      assert.ok(warnings.copied >= 1)
    } finally {
      t.cleanup()
    }
  })
})
