/**
 * F027 P3 [范-r1 P1] · wiki path containment guard —— security 边界
 * 真相源：docs/plans/V16.5-final.md chap 6 + 4（wikiRoot 是边界，path 必须在内）
 *
 * 攻击向量：caller 传 'wiki/concepts/../../../etc/passwd'，ACL 命中
 * 'wiki/concepts/**' 通过，path.join(wikiRoot, relPath) 后实际写到 wikiRoot
 * 之外（passwd / 任意系统文件）。
 *
 * 防御：
 *   1. relPath 必须以 'wiki/' 开头（namespace 边界）
 *   2. path.resolve(wikiRoot, relPath) 必须 startsWith path.resolve(wikiRoot)
 *      (不允许 ../ 逃出，不允许绝对路径覆盖 wikiRoot)
 *   3. 不允许 NUL byte / 控制字符（fs API 边界硬约束）
 */

import path from "node:path"

export class WikiPathInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WikiPathInvalidError"
  }
}

/**
 * 校验 relPath 在 wikiRoot 内。返回 absolute path（caller 直接拿去 fs IO）。
 * 失败抛 WikiPathInvalidError。
 *
 * relPath 必须：
 *   - 字符串、非空、不含 NUL
 *   - 以 'wiki/' 开头（chap 4 namespace）
 *   - resolve 后必须 startsWith(resolve(wikiRoot) + sep)
 */
export function safeWikiPath(wikiRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new WikiPathInvalidError("path must be non-empty string")
  }
  if (relPath.includes("\0")) {
    throw new WikiPathInvalidError("path must not contain NUL byte")
  }
  // chap 4 namespace：wiki entity 全部在 'wiki/' 下
  if (!relPath.startsWith("wiki/")) {
    throw new WikiPathInvalidError(`path must start with 'wiki/': got '${relPath}'`)
  }
  // 防 'wiki/concepts/../../../etc/passwd' 之类逃逸
  const rootAbs = path.resolve(wikiRoot)
  const targetAbs = path.resolve(wikiRoot, relPath)
  const rootWithSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep
  if (targetAbs !== rootAbs && !targetAbs.startsWith(rootWithSep)) {
    throw new WikiPathInvalidError(
      `path resolves outside wikiRoot: ${relPath} → ${targetAbs} (root=${rootAbs})`,
    )
  }
  return targetAbs
}
