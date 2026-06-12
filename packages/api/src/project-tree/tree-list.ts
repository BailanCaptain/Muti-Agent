import fsp from "node:fs/promises"
import path from "node:path"

import { WikiPathInvalidError } from "../wiki/path-containment"
import { assertPathNoAds } from "../worktrees/preview-guards"
import type { ResolvedTreeRoot } from "./tree-roots"

/**
 * F028 Task 12 · 项目目录单层 list（AC1/AC2）
 *
 * containment 纪律（与 content 端点同源）：
 *   1. ADS 拒（含 `:` 相对路径，r6 P2-3）
 *   2. 词法 resolve 必须留在 lexicalRoot 内（`..` 逃逸抛）
 *   3. root 身份复核：realpath(lexicalRoot) === expectedRealRoot（目录 swap 拒）
 *   4. 目标 dir realpath 必须在 expectedRealRoot 内且等于词法 resolve 的 real 形态
 *      （树内 junction 指向树外 → 失配 → 拒）
 *   5. entry 级 lstat 不跟随：symlink/junction 不出现在结果
 *   6. D8 denylist：目录与 secrets 文件**隐藏**（不出现，content 侧同源判定 404）
 *   7. 单目录上限 1000 + truncated 标记（r2 P2-7 资源上限）
 */

export const TREE_DENY_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".next",
  ".npm-cache",
  ".worktrees",
  ".runtime",
  ".agents",
  "data",
  ".codex",
  ".gemini",
  ".obsidian",
])

const DENY_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\..*)?$/i,
  /^auth\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /\.token$/i,
  /^\.npmrc$/i,
]

/** 德彪 r1 P1-2：Windows fs 大小写不敏感，`DATA`/`.Git` 会折叠到真实被禁目录——比较必须小写折叠（denylist 全 ASCII） */
export function isDeniedDirName(name: string): boolean {
  return TREE_DENY_DIRS.has(name.toLowerCase())
}

export function isDeniedFileName(name: string): boolean {
  return DENY_FILE_PATTERNS.some((re) => re.test(name))
}

/**
 * 守护 BLOCKED 修复（AC2 list/content 对称）：dir 参数**任一段**命中 denied 目录 →
 * 整个 list 拒绝（404 隐藏语义）。原实现只过滤 readdir 出的子项名，漏了 dir 参数
 * 本身，导致 `list?dir=data` 直接枚举主库——「List Read Same Containment」教训复发。
 * content 端点早有此判定（tree-content isDeniedPath），list 在此对齐。
 */
export function isDeniedDirPath(relDir: string): boolean {
  return normalizeFs(relDir)
    .split("/")
    .filter(Boolean)
    .some((seg) => isDeniedDirName(seg))
}

export type TreeEntry = { name: string; type: "dir" | "file"; size: number | null }

const MAX_ENTRIES = 1000

function normalizeFs(p: string): string {
  return p.replace(/\\/g, "/")
}

/** 目录级 containment 解析；返回已验证的绝对目录路径，路径段不存在 → null（404） */
export async function resolveContainedDir(
  relDir: string,
  root: ResolvedTreeRoot,
): Promise<string | null> {
  assertPathNoAds(relDir)
  if (relDir.includes("\0")) throw new WikiPathInvalidError("NUL byte in path")

  const lexicalAbs = path.resolve(root.lexicalRoot, relDir)
  const lexicalRootResolved = path.resolve(root.lexicalRoot)
  if (
    normalizeFs(lexicalAbs) !== normalizeFs(lexicalRootResolved) &&
    !normalizeFs(lexicalAbs).startsWith(`${normalizeFs(lexicalRootResolved)}/`)
  ) {
    throw new WikiPathInvalidError(`dir "${relDir}" escapes root lexically`)
  }

  // root 身份复核（德彪 r5 同款：校验后被 rename+junction 顶替 → 拒）
  let realRootNow: string
  try {
    realRootNow = await fsp.realpath(root.lexicalRoot)
  } catch (err) {
    // 德彪 r1 P2-2：root 在 resolve 后被删（worktree remove 竞态）→ 404，与 content 对称
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  if (normalizeFs(realRootNow) !== normalizeFs(root.expectedRealRoot)) {
    throw new WikiPathInvalidError("root identity changed (swap detected)")
  }

  let realDir: string
  try {
    realDir = await fsp.realpath(lexicalAbs)
  } catch {
    return null // 路径段不存在 → caller 转 404（区别于 escape 的 400：不存在非攻击）
  }
  const expected = normalizeFs(root.expectedRealRoot)
  const realNorm = normalizeFs(realDir)
  if (realNorm !== expected && !realNorm.startsWith(`${expected}/`)) {
    throw new WikiPathInvalidError(`dir "${relDir}" resolves outside root (junction/symlink)`)
  }
  // 德彪 r2 P2：词法段 denylist 不够——realpath 把 8.3 短名/别名/junction 规范化后
  // 可能落入 denied 目录（NODE_M~1→node_modules）。对**规范化后的真实相对路径**复查。
  if (isDeniedDirPath(path.relative(root.expectedRealRoot, realDir))) return null
  return lexicalAbs
}

export async function listTreeDir(
  relDir: string,
  root: ResolvedTreeRoot,
): Promise<{ entries: TreeEntry[]; truncated: boolean } | null> {
  assertPathNoAds(relDir) // ADS → 400（优先于 denied 的 404：攻击信号先于隐藏）
  if (isDeniedDirPath(relDir)) return null // denied 段 → 404 隐藏（守护 BLOCKED 修复）

  const absDir = await resolveContainedDir(relDir, root)
  if (absDir === null) return null // 路径不存在 → 404

  let names: string[]
  try {
    names = await fsp.readdir(absDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOTDIR" || code === "ENOENT") return null // dir 指向文件/竞态删 → 404
    throw err
  }
  const entries: TreeEntry[] = []
  let truncated = false
  for (const name of names) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    let st: import("node:fs").Stats
    try {
      st = await fsp.lstat(path.join(absDir, name))
    } catch {
      continue // 竞态删除：跳过
    }
    if (st.isSymbolicLink()) continue // 不跟随不出现
    if (st.isDirectory()) {
      if (isDeniedDirName(name)) continue
      entries.push({ name, type: "dir", size: null })
    } else if (st.isFile()) {
      if (isDeniedFileName(name)) continue
      entries.push({ name, type: "file", size: st.size })
    }
    // 其他特殊类型（FIFO/socket 等）不出现
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name, "en")
  })
  return { entries, truncated }
}
