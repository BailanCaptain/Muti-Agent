import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { listTreeRoots, resolveTreeRoot } from "./tree-roots"

/** F028 Task 11 · 根解析器（单源 realpath，list/content 共用同一份解析结果） */

async function makeDirs() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f028-roots-"))
  const main = path.join(base, "repo")
  const wt = path.join(main, ".worktrees", "F028")
  await fs.mkdir(wt, { recursive: true })
  return { main, wt }
}

function deps(main: string, wts: Array<{ name: string; path: string; isMain?: boolean }>) {
  return {
    mainRepoRoot: main,
    inventory: async () =>
      [{ name: "main", path: main, isMain: true }, ...wts.map((w) => ({ isMain: false, ...w }))].map(
        (w) => ({ ...w, branch: "x", head: "y", preview: null, mergeStatus: null }),
      ),
  }
}

test("F028 T11 · listTreeRoots exposes main + worktrees as switchable roots", async () => {
  const { main, wt } = await makeDirs()
  const roots = await listTreeRoots(deps(main, [{ name: "F028", path: wt }]))
  assert.deepEqual(
    roots.map((r) => r.id),
    ["main", "wt:F028"],
  )
  assert.equal(roots[0].label, "主仓")
  assert.equal(roots[1].label, "F028")
})

test("F028 T11 · resolveTreeRoot main → lexical + real root pair", async () => {
  const { main, wt } = await makeDirs()
  const resolved = await resolveTreeRoot("main", deps(main, [{ name: "F028", path: wt }]))
  assert.ok(resolved)
  assert.equal(resolved.lexicalRoot, main)
  assert.equal(resolved.expectedRealRoot, await fs.realpath(main))
})

test("F028 T11 · resolveTreeRoot wt:<name> → worktree root", async () => {
  const { main, wt } = await makeDirs()
  const resolved = await resolveTreeRoot("wt:F028", deps(main, [{ name: "F028", path: wt }]))
  assert.ok(resolved)
  assert.equal(resolved.lexicalRoot, wt)
  assert.equal(resolved.expectedRealRoot, await fs.realpath(wt))
})

test("F028 T11 · unknown id / removed worktree / realpath failure → null", async () => {
  const { main, wt } = await makeDirs()
  const d = deps(main, [{ name: "F028", path: wt }, { name: "ghost", path: path.join(main, ".worktrees", "ghost") }])
  assert.equal(await resolveTreeRoot("wt:nope", d), null)
  assert.equal(await resolveTreeRoot("bogus", d), null)
  assert.equal(await resolveTreeRoot("wt:ghost", d), null) // 目录已删 → realpath 失败 → null
})
