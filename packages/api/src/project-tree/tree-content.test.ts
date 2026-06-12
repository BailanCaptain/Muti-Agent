import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { PreviewGuardError } from "../worktrees/preview-guards"
import { WikiPathInvalidError } from "../wiki/path-containment"
import { BinaryFileError, readTreeContent } from "./tree-content"

/** F028 Task 13 · content 策略层（plan v5：denylist 404 同源/ADS/maxBytes 透传/NUL 拒/越界透传） */

async function makeRoot() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f028-content-"))
  const root = path.join(base, "repo")
  await fs.mkdir(path.join(root, "src"), { recursive: true })
  await fs.mkdir(path.join(root, "data"), { recursive: true })
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const x = 1\n", "utf8")
  await fs.writeFile(path.join(root, ".env"), "SECRET=1", "utf8")
  await fs.writeFile(path.join(root, "data", "prod.sqlite"), "DBDATA", "utf8")
  await fs.writeFile(path.join(root, "src", "bin.dat"), Buffer.from([0x68, 0x69, 0x00, 0x21]))
  await fs.writeFile(path.join(root, "src", "big.txt"), "b".repeat(700 * 1024), "utf8")
  return { root, resolved: { lexicalRoot: root, expectedRealRoot: await fs.realpath(root) } }
}

// 德彪 r1 P1-2：大小写变体 denied 路径在大小写不敏感 fs 上必须同样 404（list/content 对称）
test("F028 r1-P1-2 · case-variant denied paths return null", async () => {
  const { resolved } = await makeRoot()
  assert.equal(await readTreeContent("DATA/prod.sqlite", resolved), null)
  assert.equal(await readTreeContent(".ENV", resolved), null)
})

// 德彪 r2 P2：realpath 后落入 denied 目录（8.3 短名/别名/junction 同构）→ null。
// 词法段 "aliasdata" 不命中，realpath 规范化后 = data → 复查必拦（list/content 对称）。
test("F028 r2-P2 · junction resolving into denied path → null (post-realpath denylist)", async () => {
  const { root, resolved } = await makeRoot()
  await fs.symlink(path.join(root, "data"), path.join(root, "aliasdata"), "junction")
  assert.equal(await readTreeContent("aliasdata/prod.sqlite", resolved), null)
})

test("F028 T13 · normal file returns content and mtime", async () => {
  const { resolved } = await makeRoot()
  const res = await readTreeContent("src/a.ts", resolved)
  assert.ok(res)
  assert.equal(res.content, "export const x = 1\n")
  assert.equal(res.truncated, false)
  assert.ok(res.mtime.length > 0)
})

test("F028 T13 · denylist path returns null (404 semantics, same source as hiding)", async () => {
  const { resolved } = await makeRoot()
  assert.equal(await readTreeContent(".env", resolved), null)
})

test("F028 T13 · ADS colon path rejected", async () => {
  const { resolved } = await makeRoot()
  await assert.rejects(() => readTreeContent("src/a.ts:hidden", resolved), PreviewGuardError)
})

test("F028 T13 · oversized file truncated via primitive maxBytes", async () => {
  const { resolved } = await makeRoot()
  const res = await readTreeContent("src/big.txt", resolved)
  assert.ok(res)
  assert.equal(res.truncated, true)
  assert.equal(res.content.length, 512 * 1024)
})

test("F028 T13 · NUL byte sniff → BinaryFileError", async () => {
  const { resolved } = await makeRoot()
  await assert.rejects(() => readTreeContent("src/bin.dat", resolved), BinaryFileError)
})

test("F028 T13 · traversal passes through WikiPathInvalidError from primitive layer", async () => {
  const { resolved } = await makeRoot()
  await assert.rejects(() => readTreeContent("../outside.txt", resolved), WikiPathInvalidError)
})
