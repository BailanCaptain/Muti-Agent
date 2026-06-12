import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { WikiPathInvalidError, readContainedFile } from "./path-containment"

/**
 * F028 Task 12.5 · readContainedFile maxBytes 同 fd 限读扩展（r2 P1-6）
 * 独立测试文件——F027 既有 path-containment 测试与全部调用方测试零改动 = 回归锚。
 */

async function makeRoot() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f028-maxb-"))
  const root = path.join(base, "root")
  await fs.mkdir(root, { recursive: true })
  return { root, real: await fs.realpath(root) }
}

// (1) 超限文件 → 前 maxBytes 字节 + truncated:true（同 fd 限读，不整读）
test("F028 T12.5 · file over maxBytes returns prefix with truncated flag", async () => {
  const { root, real } = await makeRoot()
  const file = path.join(root, "big.txt")
  await fs.writeFile(file, "a".repeat(100), "utf8")
  const res = await readContainedFile(file, root, real, { maxBytes: 64 })
  assert.ok(res)
  assert.equal(res.content, "a".repeat(64))
  assert.equal(res.truncated, true)
})

// (2) ≤maxBytes → 完整内容 + truncated:false
test("F028 T12.5 · file within maxBytes returns full content untruncated", async () => {
  const { root, real } = await makeRoot()
  const file = path.join(root, "small.txt")
  await fs.writeFile(file, "hello 世界", "utf8")
  const res = await readContainedFile(file, root, real, { maxBytes: 1024 })
  assert.ok(res)
  assert.equal(res.content, "hello 世界")
  assert.equal(res.truncated, false)
})

// (3) 不传 maxBytes → 行为与现状逐字节一致（truncated 不出现或 false 语义）
test("F028 T12.5 · without maxBytes behaves byte-identical to legacy", async () => {
  const { root, real } = await makeRoot()
  const file = path.join(root, "legacy.txt")
  const payload = "x".repeat(5000)
  await fs.writeFile(file, payload, "utf8")
  const res = await readContainedFile(file, root, real)
  assert.ok(res)
  assert.equal(res.content, payload)
  assert.ok(!res.truncated) // undefined 或 false 都可，绝不能 true
  assert.ok(typeof res.mtime === "string" && res.mtime.length > 0)
})

// (4) maxBytes 路径下原防御全保留：越界 realpath 抛 / 目录→null
test("F028 T12.5 · containment defenses intact under maxBytes path", async () => {
  const { root, real } = await makeRoot()
  const base = path.dirname(root)
  const outside = path.join(base, "outside.txt")
  await fs.writeFile(outside, "secret", "utf8")
  // 树内 junction → 树外文件的目录
  await fs.symlink(base, path.join(root, "jump"), "junction")
  await assert.rejects(
    () => readContainedFile(path.join(root, "jump", "outside.txt"), root, real, { maxBytes: 8 }),
    WikiPathInvalidError,
  )
  // 目录 → null（当作不存在）
  const sub = path.join(root, "subdir")
  await fs.mkdir(sub)
  assert.equal(await readContainedFile(sub, root, real, { maxBytes: 8 }), null)
})
