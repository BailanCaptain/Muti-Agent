/**
 * F027 收尾补丁 AC-W2 · 同源 _auto draft 自动收敛
 *
 * 真相源：
 *   - docs/features/F027-unified-memory-architecture.md「收尾补丁 · 收录体验」AC-W2
 *   - docs/plans/V16.5-final.md line 2662（supersedes 留白 future feature，本补丁落地搬运形态）
 *
 * 背景：DocsWatcher 对同一源文档每次 change 都落一篇新的版本化 `_auto/<stem>-<unixMs>.md`
 * （docs-ingest-runner versionedTargetPath，防 CAS conflict），审批列表随之堆积同源多版本，
 * 小孙被迫重复人工审（2026-06-12 F029 一夜三篇实证）。
 *
 * 职责：watcher ingest commit 成功后，把同源旧 `_auto` draft 搬到同级 `draft/_superseded/`：
 *   - 仍在 `/draft/` 子树下 → 三召回源闸门（BM25 / 语义 / L4 read_wiki）天然继续排除
 *   - 搬运不是删除（数据神圣）——同名冲突加 `-dupN` 后缀，绝不覆盖既有归档
 *   - 全程 fail-soft：单文件失败记录 failed 继续，整体异常返空结果，不影响 ingest 主链
 *
 * 同源 key 推导（两形态互通，实测依据 2026-06-12 主库）：
 *   - 编译产物有 `sources[0].path`（真源 docs 路径）→ basename 去 .md 小写
 *   - stub（sanitize 原文搬运）无 sources → 文件名去 .md + 去 `-<13位unixMs>` 后缀小写
 *   - 已知边界：不同目录同名源文档会撞 key（现 docs 命名 Fxxx-/Bxxx- 前缀天然唯一）；
 *     sources[].path 存在时优先，键空间以真源路径 basename 为准。
 */

import type { Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { parseFrontmatter } from "../../routes/phase3/frontmatter"

const SUPERSEDED_DIR_NAME = "_superseded"
/** watcher 版本化后缀 `-<unixMs>`：13 位毫秒时间戳（2001-2286 年间恒 13 位）。 */
const VERSION_SUFFIX_RE = /-\d{13}$/
/** 同名归档冲突最多尝试 -dup1..-dup3，再冲突记 failed（不覆盖既有文件）。 */
const MAX_DUP_ATTEMPTS = 3

export interface SupersedeResult {
  /** 成功搬入 _superseded 的源文件名（_auto 下的 basename）。 */
  moved: string[]
  /** 搬运失败的文件名 + 原因（fail-soft 不抛）。 */
  failed: { name: string; error: string }[]
}

export interface SupersedeOlderAutoDraftsOptions {
  /** `_auto` 目录绝对路径。 */
  autoDir: string
  /** 刚 commit 成功的 draft 文件名（basename；自身永不被搬）。 */
  committedFileName: string
  /** 可选 warn logger（默认 noop）。 */
  logWarn?: (obj: Record<string, unknown>, msg: string) => void
}

/**
 * 同源 key：sources[0].path basename 优先（编译产物），否则文件名去版本化后缀（stub）。
 * 大小写不敏感（Windows fs + WIKI_PATH_PREFIX /i 同款约定，见 isDraftRelativePath 教训）。
 */
export function deriveAutoDraftSourceKey(
  fileName: string,
  frontmatter: Record<string, unknown> | null | undefined,
): string {
  const fromSources = sources0Path(frontmatter)
  if (fromSources !== null) {
    return stripMdExt(posixBasename(fromSources)).toLowerCase()
  }
  return stripMdExt(fileName).replace(VERSION_SUFFIX_RE, "").toLowerCase()
}

/**
 * watcher commit 成功后调用：同 key 旧 `_auto` draft → `draft/_superseded/`。
 * 永不抛——任何整体失败（目录不存在 / committed 文件已被删）返回空结果。
 */
export async function supersedeOlderAutoDrafts(
  opts: SupersedeOlderAutoDraftsOptions,
): Promise<SupersedeResult> {
  const logWarn = opts.logWarn ?? (() => {})
  const result: SupersedeResult = { moved: [], failed: [] }

  const committedKey = await readKey(
    path.join(opts.autoDir, opts.committedFileName),
    opts.committedFileName,
  )
  if (committedKey === null) {
    // committed 文件读不到（race 被删 / autoDir 不存在）→ 无收敛依据，空结果
    return result
  }
  // 德彪 r1 P1 · 时间戳守卫：watcher 并行派发 + 编译分钟级，慢 ingest 可能后完成。
  // 只搬"严格更旧"的版本（candidate ts < committed ts；无戳 legacy 视为最旧）；
  // committed 自身无戳（非 watcher 产物）→ 无序可比，保守不搬。
  const committedVersion = parseVersionTs(opts.committedFileName)
  if (committedVersion === null) {
    return result
  }

  let entries: Dirent[]
  try {
    entries = await fs.readdir(opts.autoDir, { withFileTypes: true })
  } catch {
    return result
  }

  let supersededDirEnsured = false
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (!ent.name.endsWith(".md")) continue
    if (ent.name === opts.committedFileName) continue

    // 德彪 r1 P1：版本守卫先于 key 比对——candidate ts ≥ committed ts 的（含相等）一律不动，
    // 它们是更新（或并发同刻）的版本，搬走会破坏"只留最新"语义。
    const candidateVersion = parseVersionTs(ent.name)
    if (candidateVersion !== null && candidateVersion >= committedVersion) continue

    const full = path.join(opts.autoDir, ent.name)
    const key = await readKey(full, ent.name)
    if (key === null) {
      result.failed.push({ name: ent.name, error: "read_failed" })
      continue
    }
    if (key !== committedKey) continue

    const supersededDir = path.join(path.dirname(opts.autoDir), SUPERSEDED_DIR_NAME)
    try {
      if (!supersededDirEnsured) {
        await fs.mkdir(supersededDir, { recursive: true })
        supersededDirEnsured = true
      }
      const dest = await pickNonClobberingDest(supersededDir, ent.name)
      if (dest === null) {
        result.failed.push({ name: ent.name, error: "dest_conflict_exhausted" })
        logWarn({ name: ent.name }, "auto-draft-supersede: dest conflict exhausted, kept in _auto")
        continue
      }
      await fs.rename(full, dest)
      result.moved.push(ent.name)
    } catch (err) {
      result.failed.push({ name: ent.name, error: (err as Error).message })
      logWarn({ err, name: ent.name }, "auto-draft-supersede: move failed (kept in _auto)")
    }
  }

  return result
}

// ── private ─────────────────────────────────────────────────────────────

/** 读文件 → 解析 frontmatter → key。读失败返 null；解析失败回落文件名 key（fail-soft）。 */
async function readKey(absPath: string, fileName: string): Promise<string | null> {
  let raw: string
  try {
    raw = await fs.readFile(absPath, "utf-8")
  } catch {
    return null
  }
  let fm: Record<string, unknown> | null = null
  try {
    fm = parseFrontmatter(raw).frontmatter
  } catch {
    fm = null // broken YAML → 文件名 key 兜底
  }
  return deriveAutoDraftSourceKey(fileName, fm)
}

function sources0Path(frontmatter: Record<string, unknown> | null | undefined): string | null {
  if (!frontmatter) return null
  const sources = frontmatter.sources
  if (!Array.isArray(sources) || sources.length === 0) return null
  const first = sources[0]
  if (!first || typeof first !== "object") return null
  const p = (first as Record<string, unknown>).path
  return typeof p === "string" && p.length > 0 ? p : null
}

function posixBasename(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  const idx = normalized.lastIndexOf("/")
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

function stripMdExt(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name
}

/** 文件名尾部 `-<13位unixMs>` 版本号；无 → null（legacy backfill 名，视为最旧）。 */
function parseVersionTs(fileName: string): number | null {
  const m = stripMdExt(fileName).match(/-(\d{13})$/)
  return m ? Number(m[1]) : null
}

/** 目标同名冲突 → `-dup1..-dupN` 后缀；全冲突返 null（caller 记 failed，不覆盖）。 */
async function pickNonClobberingDest(dir: string, name: string): Promise<string | null> {
  const plain = path.join(dir, name)
  if (!(await exists(plain))) return plain
  const stem = stripMdExt(name)
  for (let i = 1; i <= MAX_DUP_ATTEMPTS; i++) {
    const candidate = path.join(dir, `${stem}-dup${i}.md`)
    if (!(await exists(candidate))) return candidate
  }
  return null
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
