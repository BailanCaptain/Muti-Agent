import fs from "node:fs"
import path from "node:path"

/**
 * F027 P4 AC-P4-9 a/b · worktree-preview-only wiki/{warnings,index}/*.md fixture copier.
 *
 * 跟 worktree-preview-seed.ts (DB rows seed) 区分:
 *   - seed loader = DB rows INSERT (room_decisions / wiki_events / wiki_leases)
 *   - 本 copier = 文件系统 wiki/{warnings,index}/*.md md 文件拷贝
 *
 * 同 gate 模式 (per plan v5 line 176 "复用 Week 1 Day 1 已建的 seed loader 走相同 gate"):
 *   - primary: WORKTREE_PREVIEW=1 (scripts/worktree-preview.ts 注入)
 *   - secondary: destWikiRoot 路径包含 ".runtime/worktree-preview/"
 *   - 两道全过才 copy; 任一不满足 → no-op {gateClosed: ...}
 *
 * Per-bucket idempotent (跟 DB seed 表级 idempotent 类似):
 *   - 每 bucket (warnings / index) 独立检查 dest 目录
 *   - dest bucket 目录非空 → 跳过该 bucket (尊重已有真数据，不覆盖)
 *   - 任一 bucket 已有文件不阻塞其他 bucket
 *
 * 不做:
 *   - 不删 dest 文件 (idempotent + 数据神圣)
 *   - 不修改文件内容 (literal byte copy)
 *   - 不递归子目录 (warnings/sub/... 不 copy — 当前 fixture 都是平铺)
 */

const FIXTURE_DIR_DEFAULT = "tests/fixtures/wiki"
const BUCKETS = ["warnings", "index"] as const

type Bucket = (typeof BUCKETS)[number]

export type WikiFixturesReport = {
  gateClosed?: { reason: string }
  /** 每 bucket 的结果：copied=新拷数 / skipped=已存在跳过 / failed=copy 失败 */
  buckets: Partial<
    Record<
      Bucket,
      | { copied: number; files: string[] }
      | { skipped: true; existingFiles: number }
      | { failed: string }
    >
  >
}

export type WikiFixturesOpts = {
  /** 目标 wiki root (如 .runtime/worktree-preview/data/wiki/) */
  destWikiRoot: string
  /** primary gate. defaults to process.env.WORKTREE_PREVIEW */
  worktreePreview?: string | undefined
  /** fixture root, relative to repoRoot. defaults to tests/fixtures/wiki */
  fixtureDir?: string
  /** repoRoot for resolving fixtureDir. defaults to process.cwd() */
  repoRoot?: string
}

export function applyWorktreePreviewWikiFixtures(
  opts: WikiFixturesOpts,
): WikiFixturesReport {
  // ─── Double gate (复用 worktree-preview-seed 同款) ────────────────────────
  const gate = opts.worktreePreview ?? process.env.WORKTREE_PREVIEW
  if (gate !== "1") {
    return {
      gateClosed: { reason: "WORKTREE_PREVIEW gate not set to 1 (primary)" },
      buckets: {},
    }
  }
  const normalizedDest = opts.destWikiRoot.replace(/\\/g, "/")
  if (!normalizedDest.includes(".runtime/worktree-preview/")) {
    return {
      gateClosed: {
        reason: "destWikiRoot does not contain .runtime/worktree-preview/ (secondary)",
      },
      buckets: {},
    }
  }

  const fixtureRoot = path.resolve(
    opts.repoRoot ?? process.cwd(),
    opts.fixtureDir ?? FIXTURE_DIR_DEFAULT,
  )

  const result: WikiFixturesReport = { buckets: {} }
  for (const bucket of BUCKETS) {
    result.buckets[bucket] = copyBucket(fixtureRoot, opts.destWikiRoot, bucket)
  }
  return result
}

function copyBucket(
  fixtureRoot: string,
  destWikiRoot: string,
  bucket: Bucket,
): WikiFixturesReport["buckets"][Bucket] {
  const srcDir = path.join(fixtureRoot, bucket)
  const destDir = path.join(destWikiRoot, bucket)

  // src 不存在 → skip 该 bucket（不是错，可能 fixture 暂未 seed）
  if (!fs.existsSync(srcDir)) {
    return { skipped: true, existingFiles: 0 }
  }

  // dest 已有 .md 文件 → skip (idempotent + 不覆盖真数据)
  if (fs.existsSync(destDir)) {
    const existing = listMdFiles(destDir)
    if (existing.length > 0) {
      return { skipped: true, existingFiles: existing.length }
    }
  }

  // src 拿所有 .md 文件
  const srcFiles = listMdFiles(srcDir)
  if (srcFiles.length === 0) {
    return { copied: 0, files: [] }
  }

  // 创建 dest dir + 拷贝
  try {
    fs.mkdirSync(destDir, { recursive: true })
    const copiedFiles: string[] = []
    for (const fileName of srcFiles) {
      const srcAbs = path.join(srcDir, fileName)
      const destAbs = path.join(destDir, fileName)
      fs.copyFileSync(srcAbs, destAbs)
      copiedFiles.push(fileName)
    }
    return { copied: copiedFiles.length, files: copiedFiles }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { failed: msg }
  }
}

function listMdFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}
