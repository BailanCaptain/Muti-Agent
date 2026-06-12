import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { PreviewGuardError } from "../worktrees/preview-guards"
import { WikiPathInvalidError } from "../wiki/path-containment"
import { listTreeDir } from "./tree-list"

/** F028 Task 12 · 目录 list（plan v5 用例 1-6，真 tmpdir fixture 含 junction/secrets） */

async function makeTree() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f028-list-"))
  const root = path.join(base, "repo")
  const outside = path.join(base, "outside")
  await fs.mkdir(path.join(root, "src"), { recursive: true })
  await fs.mkdir(path.join(root, "node_modules", "x"), { recursive: true })
  await fs.mkdir(path.join(root, ".git"), { recursive: true })
  await fs.mkdir(path.join(root, "data"), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(root, "README.md"), "# hi", "utf8")
  await fs.writeFile(path.join(root, "src", "a.ts"), "export {}", "utf8")
  await fs.writeFile(path.join(root, "data", "prod.sqlite"), "DBDATA", "utf8")
  await fs.writeFile(path.join(root, ".env"), "SECRET=1", "utf8")
  await fs.writeFile(path.join(root, ".env.local"), "SECRET=2", "utf8")
  await fs.writeFile(path.join(root, "auth.json"), "{}", "utf8")
  await fs.writeFile(path.join(root, "x.pem"), "key", "utf8")
  await fs.writeFile(path.join(root, "id_rsa.pub"), "pub", "utf8")
  await fs.writeFile(path.join(root, ".npmrc"), "registry=", "utf8")
  await fs.writeFile(path.join(outside, "leak.txt"), "outside", "utf8")
  // 树内 junction → 树外（list 不出现；作为 dir 参数 → 400 语义）
  await fs.symlink(outside, path.join(root, "jump"), "junction")
  const resolved = { lexicalRoot: root, expectedRealRoot: await fs.realpath(root) }
  return { root, outside, resolved }
}

// (1) 排序 + size 仅 file；(2) denylist 与 secrets 隐藏；(4 前半) junction 不出现
test("F028 T12 · listing sorts dirs first, hides denylist/secrets/junctions", async () => {
  const { resolved } = await makeTree()
  const res = await listTreeDir("", resolved)
  assert.ok(res)
  const names = res.entries.map((e) => e.name)
  assert.deepEqual(names, ["src", "README.md"]) // node_modules/.git/data/secrets/jump 全不出现
  assert.equal(res.truncated, false)
  const dir = res.entries.find((e) => e.name === "src")
  const file = res.entries.find((e) => e.name === "README.md")
  assert.equal(dir?.type, "dir")
  assert.equal(dir?.size, null)
  assert.equal(file?.type, "file")
  assert.ok((file?.size ?? 0) > 0)
})

// (3) ADS：相对路径含 ":" → PreviewGuardError（caller 转 400）
test("F028 T12 · path with colon (NTFS ADS) rejected", async () => {
  const { resolved } = await makeTree()
  await assert.rejects(() => listTreeDir("src:hidden", resolved), PreviewGuardError)
})

// (4) dir="../" 逃逸 → WikiPathInvalidError；dir 为树内 junction → 400 语义错误
test("F028 T12 · traversal and junction-dir params rejected", async () => {
  const { resolved } = await makeTree()
  await assert.rejects(() => listTreeDir("../", resolved), WikiPathInvalidError)
  await assert.rejects(() => listTreeDir("jump", resolved), WikiPathInvalidError) // realpath 跳树外
})

// 德彪 r1 P1-2：Windows fs 大小写不敏感——denylist 必须大小写折叠，否则
// `DATA`/`.Git` 直达真实被禁目录（guardian 修复 836e985 的余洞）
test("F028 r1-P1-2 · case-variant denied dir params hidden (null)", async () => {
  const { resolved } = await makeTree()
  assert.equal(await listTreeDir("DATA", resolved), null)
  assert.equal(await listTreeDir(".Git", resolved), null)
  assert.equal(await listTreeDir("Node_Modules/x", resolved), null) // 中段命中
})

// 德彪 r1 P2-2：root 在 resolve 后被删（worktree remove 竞态）→ null（404），
// 不再让 realpath ENOENT 逃逸成 500（content 端点同场景已是 404）
test("F028 r1-P2-2 · root deleted after resolve → null, not throw", async () => {
  const { resolved } = await makeTree()
  await fs.rm(resolved.lexicalRoot, { recursive: true, force: true })
  assert.equal(await listTreeDir("src", resolved), null)
})

// 德彪 r2 P2：realpath 后落入 denied 目录（8.3 短名/别名/junction 同构）→ null。
// 词法段 "alias" 不命中 denylist，但 realpath 规范化后 = node_modules → 必须复查拦截。
// junction 稳定复现该类（8.3 短名是同类特例，不赌宿主卷 8dot3name 配置）。
test("F028 r2-P2 · junction resolving into denied dir → null (post-realpath denylist)", async () => {
  const { root, resolved } = await makeTree()
  await fs.symlink(path.join(root, "node_modules"), path.join(root, "alias"), "junction")
  assert.equal(await listTreeDir("alias", resolved), null)
})

// (5) root swap：expectedRealRoot 失配 → 400 语义
test("F028 T12 · root swap (expectedRealRoot mismatch) rejected", async () => {
  const { resolved, outside } = await makeTree()
  const swapped = { lexicalRoot: resolved.lexicalRoot, expectedRealRoot: await fs.realpath(outside) }
  await assert.rejects(() => listTreeDir("src", swapped), WikiPathInvalidError)
})

// (6) >1000 条目录 → 截断 + truncated
test("F028 T12 · directory over 1000 entries truncates", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f028-big-"))
  const root = path.join(base, "repo")
  const big = path.join(root, "big")
  await fs.mkdir(big, { recursive: true })
  await Promise.all(
    Array.from({ length: 1005 }, (_, i) => fs.writeFile(path.join(big, `f${String(i).padStart(4, "0")}.txt`), "x")),
  )
  const resolved = { lexicalRoot: root, expectedRealRoot: await fs.realpath(root) }
  const res = await listTreeDir("big", resolved)
  assert.ok(res)
  assert.equal(res.entries.length, 1000)
  assert.equal(res.truncated, true)
})

// (7) 守护 BLOCKED 修复 · denied dir 参数本身 → null（404 隐藏语义，与 content 端点对称）
//     根因：原实现只过滤 readdir 子项名，未校验 dir 参数本身 → list?dir=data 全量枚举主库。
test("F028 T12 · denied dir param itself returns null (list/content denylist symmetric)", async () => {
  const { resolved } = await makeTree()
  assert.equal(await listTreeDir("data", resolved), null) // 主库目录不可枚举
  assert.equal(await listTreeDir("node_modules", resolved), null)
  assert.equal(await listTreeDir(".git", resolved), null)
  assert.equal(await listTreeDir("src/.git", resolved), null) // 中间段命中也拒
})

// (8) P3：dir 指向文件（ENOTDIR）→ null（404）而非裸 500
test("F028 T12 · dir param pointing to a file returns null (not raw 500)", async () => {
  const { resolved } = await makeTree()
  assert.equal(await listTreeDir("README.md", resolved), null)
  assert.equal(await listTreeDir("ghost-dir", resolved), null) // 不存在同样 null
})
