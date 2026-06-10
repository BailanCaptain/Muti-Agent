/**
 * F027 续 · preview 双根修复 —— wiki 根单一解析入口
 *
 * 背景（server.ts 原 line 175-176 自标 "Week 5 follow-up"）：worktree-preview 模式下
 * fixture copier / Phase4 meta routes（warnings/index reader）用 destWikiRoot =
 * `<dirname(sqlitePath)>/wiki`（.runtime/worktree-preview/data/wiki/），而
 * wikiServices.wikiRoot 等 **7 处写/索引根**仍用 `WIKI_ROOT || cwd/.runtime/wiki` ——
 * 双根：preview 里写的 wiki 内容（update_wiki/ingest/session-summary/compileWiki）
 * 落 env 根，reader 读 fixtures 根，UI 永远看不到新写的内容。
 *
 * 规则（单一真相源，server.ts 全部 wiki 根从这里解析）：
 *   1. WIKI_ROOT 显式设置 → 永远优先（F024 worktree preview 启动脚本注入的场景，
 *      Iron Law 3：配置即约定，代码不二猜）。
 *   2. 否则 worktree-preview 模式（WORKTREE_PREVIEW=1 且 sqlitePath 在
 *      .runtime/worktree-preview/ 下）→ `<dirname(sqlitePath)>/wiki`
 *      （与 fixture copier / metaWikiRoot 同根，preview 自包含读写一致）。
 *   3. 否则 → `<cwd>/.runtime/wiki`（生产默认，行为不变）。
 */

import path from "node:path"

export interface ResolveWikiRootOptions {
  sqlitePath: string
  /** 注入便于测试；默认 process.env。 */
  env?: { WIKI_ROOT?: string; WORKTREE_PREVIEW?: string }
  /** 注入便于测试；默认 process.cwd()。 */
  cwd?: string
}

export function isWorktreePreviewMode(opts: ResolveWikiRootOptions): boolean {
  const env = opts.env ?? process.env
  return (
    env.WORKTREE_PREVIEW === "1" &&
    opts.sqlitePath.replace(/\\/g, "/").includes(".runtime/worktree-preview/")
  )
}

export function resolveWikiRootBase(opts: ResolveWikiRootOptions): string {
  const env = opts.env ?? process.env
  if (env.WIKI_ROOT) return env.WIKI_ROOT
  if (isWorktreePreviewMode(opts)) {
    return path.join(path.dirname(opts.sqlitePath), "wiki")
  }
  return path.join(opts.cwd ?? process.cwd(), ".runtime", "wiki")
}
