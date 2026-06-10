/**
 * F027 P13.4 · Level 4 read_wiki backend
 *
 * 严格模式（小孙 2026-05-13 拍 5 个 Open #3）：
 *   - 仅当 critique 给 exact wiki path 时触发
 *   - 文件存在 → 返 RecallHit（score=1.0，excerpt 截前 400 字）
 *   - 文件不存在 → 返 null（executor 升 L5 escalate）
 *
 * 安全：
 *   - path 必须形如 `wiki/...` 前缀 + `.md` 后缀（防 critique 注入 ../../etc/passwd）
 *   - 内部 path.normalize + 拒绝含 `..` 段（双保险）
 */

import { readFile } from "node:fs/promises"
import path from "node:path"
import type { Level4Backend } from "./types"
import type { RecallHit } from "../memory-preflight/types"
import { isDraftRelativePath } from "../promote-audit/promote-wiki-service"

const EXCERPT_TRUNCATE = 400
const WIKI_PATH_PREFIX = /^wiki\/[a-z][\w/-]*\.md$/i

export interface FileSystemLevel4BackendOptions {
  /** wiki 根目录绝对路径（如 packages/api/wiki 或项目根） */
  wikiRoot: string
}

export class FileSystemLevel4Backend implements Level4Backend {
  constructor(private readonly opts: FileSystemLevel4BackendOptions) {}

  async readWiki(requestedPath: string): Promise<RecallHit | null> {
    // 1. path 形式校验（双保险，executor 已校过一次）
    if (!WIKI_PATH_PREFIX.test(requestedPath)) {
      return null
    }
    // 2. 防 path traversal — normalize + 拒绝 ..
    const normalized = path.normalize(requestedPath).replace(/\\/g, "/")
    if (normalized.includes("..") || normalized.startsWith("/")) {
      return null
    }
    // 2.5 draft 召回准入闸门(德彪 r2 P1 + 小孙拍选项 1):L4 是 agent 召回注入路径,
    // critique 给 exact draft 路径也不得把未 promote 内容注入 prompt——否则 BM25/语义
    // 闸门被旁路。口径与 promote/demote 同(/draft/ 或 /_drafts/)。
    if (isDraftRelativePath(normalized)) {
      return null
    }
    // 3. 拼绝对路径 + resolve 验证仍在 wikiRoot 下
    const absRoot = path.resolve(this.opts.wikiRoot)
    const absTarget = path.resolve(absRoot, normalized)
    if (!absTarget.startsWith(absRoot + path.sep) && absTarget !== absRoot) {
      return null
    }

    let content: string
    try {
      content = await readFile(absTarget, "utf8")
    } catch (err) {
      // ENOENT / permission denied 等 → 返 null（executor 升 L5）
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "EACCES" || code === "EISDIR") {
        return null
      }
      throw err
    }

    return {
      path: requestedPath,
      score: 1.0, // L4 严格 specific path → 已知精确
      excerpt: content.slice(0, EXCERPT_TRUNCATE),
    }
  }
}
