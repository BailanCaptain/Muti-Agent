/**
 * F027 续 · resolveWikiRootBase 测试 — preview 双根修复
 *
 * 三规则锁定：
 *   1. WIKI_ROOT 显式 → 永远优先（含 preview 模式下）
 *   2. preview 模式（WORKTREE_PREVIEW=1 + sqlitePath 在 worktree-preview/）无 env
 *      → `<dirname(sqlitePath)>/wiki`（与 fixture copier destWikiRoot 同根）
 *   3. 非 preview 无 env → `<cwd>/.runtime/wiki`（生产默认不变）
 */

import assert from "node:assert/strict"
import path from "node:path"
import { describe, it } from "node:test"
import { isWorktreePreviewMode, resolveWikiRootBase } from "./resolve-wiki-root"

const PREVIEW_SQLITE = path.join(
  "C:",
  "repo",
  ".runtime",
  "worktree-preview",
  "data",
  "multi-agent.sqlite",
)

describe("resolveWikiRootBase", () => {
  it("WIKI_ROOT 显式 → 永远优先（preview 模式也不覆盖）", () => {
    const out = resolveWikiRootBase({
      sqlitePath: PREVIEW_SQLITE,
      env: { WIKI_ROOT: "D:/explicit/wiki", WORKTREE_PREVIEW: "1" },
      cwd: "C:/repo",
    })
    assert.equal(out, "D:/explicit/wiki")
  })

  it("preview 模式无 env → dirname(sqlitePath)/wiki（与 destWikiRoot 同根）", () => {
    const out = resolveWikiRootBase({
      sqlitePath: PREVIEW_SQLITE,
      env: { WORKTREE_PREVIEW: "1" },
      cwd: "C:/repo",
    })
    assert.equal(out, path.join(path.dirname(PREVIEW_SQLITE), "wiki"))
  })

  it("非 preview 无 env → cwd/.runtime/wiki（生产默认不变）", () => {
    const out = resolveWikiRootBase({
      sqlitePath: path.join("C:", "repo", "data", "multi-agent.sqlite"),
      env: {},
      cwd: "C:/repo",
    })
    assert.equal(out, path.join("C:/repo", ".runtime", "wiki"))
  })

  it("WORKTREE_PREVIEW=1 但 sqlitePath 不在 worktree-preview/ → 非 preview（gate 双条件）", () => {
    const out = resolveWikiRootBase({
      sqlitePath: path.join("C:", "repo", "data", "multi-agent.sqlite"),
      env: { WORKTREE_PREVIEW: "1" },
      cwd: "C:/repo",
    })
    assert.equal(out, path.join("C:/repo", ".runtime", "wiki"))
    assert.equal(
      isWorktreePreviewMode({
        sqlitePath: path.join("C:", "repo", "data", "multi-agent.sqlite"),
        env: { WORKTREE_PREVIEW: "1" },
      }),
      false,
    )
  })
})
