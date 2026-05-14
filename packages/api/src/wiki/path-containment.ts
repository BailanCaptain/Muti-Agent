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
 * 校验 relPath 在 wikiRoot/wiki/ namespace 内。返回 absolute path（caller 直接 fs IO）。
 * 失败抛 WikiPathInvalidError。
 *
 * relPath 必须满足全部以下条件：
 *   1. 字符串、非空、不含 NUL byte
 *   2. 以 'wiki/' 开头（chap 4 namespace）
 *   3. **normalize 后仍 'wiki/' 开头**（防 'wiki/concepts/../../admin.md' 这种
 *      namespace escape：normalize 'wiki/x/../../admin.md' → 'admin.md'，逃出
 *      wiki/ 子树。范-r2 P1 finding）
 *   4. resolve 后必须 startsWith(resolve(wikiRoot/wiki) + sep)（双保险）
 */
export function safeWikiPath(wikiRoot: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new WikiPathInvalidError("path must be non-empty string")
  }
  if (relPath.includes("\0")) {
    throw new WikiPathInvalidError("path must not contain NUL byte")
  }
  // 1. 字面 'wiki/' 前缀
  if (!relPath.startsWith("wiki/")) {
    throw new WikiPathInvalidError(`path must start with 'wiki/': got '${relPath}'`)
  }
  // 2. [范-r2 P1] normalize 后仍必须在 wiki/ namespace 内（POSIX 风格 normalize，
  //    跨平台保持 '/' 分隔，比 path.normalize 更可预期）
  const posixNormalized = posixNormalize(relPath)
  if (!posixNormalized.startsWith("wiki/")) {
    throw new WikiPathInvalidError(
      `path escapes wiki/ namespace after normalize: '${relPath}' → '${posixNormalized}'`,
    )
  }
  // 3. resolve 后必须在 wikiRoot/wiki/ 子目录下
  const namespaceRoot = path.resolve(wikiRoot, "wiki")
  const targetAbs = path.resolve(wikiRoot, relPath)
  const namespaceWithSep = namespaceRoot.endsWith(path.sep)
    ? namespaceRoot
    : namespaceRoot + path.sep
  if (targetAbs !== namespaceRoot && !targetAbs.startsWith(namespaceWithSep)) {
    throw new WikiPathInvalidError(
      `path resolves outside wikiRoot/wiki: ${relPath} → ${targetAbs} (namespace=${namespaceRoot})`,
    )
  }
  return targetAbs
}

/**
 * POSIX-style normalize: 始终 '/' 分隔，处理 '..' / '.' segments。
 * 不依赖 path.normalize 的平台行为差异（Windows 转 '\' 会让 startsWith('wiki/') 失效）。
 */
function posixNormalize(rel: string): string {
  const segments = rel.split("/")
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (stack.length === 0 || stack[stack.length - 1] === "..") {
        stack.push("..") // 已经逃出 root，记录但不阻止 (caller 检测 startsWith 'wiki/')
      } else {
        stack.pop()
      }
    } else {
      stack.push(seg)
    }
  }
  return stack.join("/")
}
