import fsp from "node:fs/promises"

import type { WorktreeInventoryEntry } from "../worktrees/worktree-inventory"

/**
 * F028 Task 11 · 项目目录根解析器（AC1 根可切 + AC2 单源 containment 起点）
 * list/content 必须共用同一份 {lexicalRoot, expectedRealRoot}（德彪 6 轮 review 的
 * list/read 同源教训）——root 只在这里 realpath 一次。
 */

export type TreeRootDeps = {
  mainRepoRoot: string
  inventory: () => Promise<WorktreeInventoryEntry[]>
}

export type TreeRoot = { id: string; label: string }

export type ResolvedTreeRoot = { lexicalRoot: string; expectedRealRoot: string }

export async function listTreeRoots(deps: TreeRootDeps): Promise<TreeRoot[]> {
  const entries = await deps.inventory()
  const roots: TreeRoot[] = [{ id: "main", label: "主仓" }]
  for (const entry of entries) {
    if (entry.isMain) continue
    roots.push({ id: `wt:${entry.name}`, label: entry.name })
  }
  return roots
}

export async function resolveTreeRoot(
  id: string,
  deps: TreeRootDeps,
): Promise<ResolvedTreeRoot | null> {
  let lexicalRoot: string | null = null
  if (id === "main") {
    lexicalRoot = deps.mainRepoRoot
  } else if (id.startsWith("wt:")) {
    const name = id.slice(3)
    const entries = await deps.inventory()
    const entry = entries.find((e) => !e.isMain && e.name === name)
    lexicalRoot = entry?.path ?? null
  }
  if (!lexicalRoot) return null
  try {
    return { lexicalRoot, expectedRealRoot: await fsp.realpath(lexicalRoot) }
  } catch {
    return null // 已删/不可达 worktree
  }
}
