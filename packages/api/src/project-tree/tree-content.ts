import fsp from "node:fs/promises"
import path from "node:path"

import { WikiPathInvalidError, readContainedFile } from "../wiki/path-containment"
import { assertPathNoAds } from "../worktrees/preview-guards"
import { isDeniedDirName, isDeniedFileName } from "./tree-list"
import type { ResolvedTreeRoot } from "./tree-roots"

/**
 * F028 Task 13 · 文件 content 策略层（AC2）
 * 薄包装 readContainedFile（realpath containment/单 fd/nlink 防御 + maxBytes 同 fd
 * 限读全在原语层）；本层只做：ADS 拒、denylist 同源判定（404 = 隐藏语义，不暴露
 * 存在性）、词法越界预判、NUL 二进制嗅探。
 */

export class BinaryFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BinaryFileError"
  }
}

const MAX_CONTENT_BYTES = 512 * 1024

function normalizeFs(p: string): string {
  return p.replace(/\\/g, "/")
}

/** 路径任一段命中 denylist（目录名或文件名模式）→ 与 list 隐藏同源的 404 判定 */
function isDeniedPath(relPath: string): boolean {
  const segments = normalizeFs(relPath).split("/").filter(Boolean)
  if (segments.length === 0) return false
  const fileName = segments[segments.length - 1]
  if (isDeniedFileName(fileName)) return true
  return segments.slice(0, -1).some((seg) => isDeniedDirName(seg))
}

export async function readTreeContent(
  relPath: string,
  root: ResolvedTreeRoot,
): Promise<{ content: string; mtime: string; truncated: boolean } | null> {
  assertPathNoAds(relPath)
  if (relPath.includes("\0")) throw new WikiPathInvalidError("NUL byte in path")
  if (isDeniedPath(relPath)) return null // 隐藏 ⟺ content 404（AC2 不暴露存在性）

  const lexicalAbs = path.resolve(root.lexicalRoot, relPath)
  const rootResolved = normalizeFs(path.resolve(root.lexicalRoot))
  const absNorm = normalizeFs(lexicalAbs)
  if (absNorm !== rootResolved && !absNorm.startsWith(`${rootResolved}/`)) {
    throw new WikiPathInvalidError(`path "${relPath}" escapes root lexically`)
  }

  // 德彪 r2 P2：词法 denylist 不够——realpath 把 8.3 短名/别名/junction 规范化后
  // 可能落入 denied 目录/文件（NODE_M~1→node_modules）。对真实相对路径复查（list/content 对称）。
  let realAbs: string
  try {
    realAbs = await fsp.realpath(lexicalAbs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null // 不存在 → 404
    throw err
  }
  if (isDeniedPath(path.relative(root.expectedRealRoot, realAbs))) return null

  const res = await readContainedFile(lexicalAbs, root.lexicalRoot, root.expectedRealRoot, {
    maxBytes: MAX_CONTENT_BYTES,
  })
  if (res === null) return null
  if (res.content.includes("\0")) {
    throw new BinaryFileError(`"${relPath}" is a binary file (NUL byte detected)`)
  }
  return { content: res.content, mtime: res.mtime, truncated: res.truncated === true }
}
