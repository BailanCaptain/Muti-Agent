/**
 * F027 v3 G11 · 生产 EntityExistenceChecker 单测（node:test, temp 真目录）
 * 覆盖：4 类目录命中 / 不存在 / draft 不算 / [[]]+目录+.md 剥离 / 路径穿越防御。
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createProductionEntityExistenceChecker } from "./entity-existence-checker"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "g11-entity-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function writeMd(rel: string): Promise<void> {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, "x", "utf-8")
}

describe("createProductionEntityExistenceChecker", () => {
  it("命中 concepts/rules/methods/people 任一目录 → true", async () => {
    await writeMd("concepts/c1.md")
    await writeMd("rules/r1.md")
    await writeMd("methods/m1.md")
    await writeMd("people/p1.md")
    const c = createProductionEntityExistenceChecker({ wikiRoot: root })
    assert.equal(await c.exists("c1"), true)
    assert.equal(await c.exists("r1"), true)
    assert.equal(await c.exists("m1"), true)
    assert.equal(await c.exists("p1"), true)
  })

  it("不存在 → false", async () => {
    const c = createProductionEntityExistenceChecker({ wikiRoot: root })
    assert.equal(await c.exists("nope"), false)
  })

  it("draft 子目录不算已发布 entity → false", async () => {
    await writeMd("concepts/draft/_auto/wip.md")
    const c = createProductionEntityExistenceChecker({ wikiRoot: root })
    assert.equal(await c.exists("wip"), false)
  })

  it("剥 [[wikilink]] / 目录前缀 / .md 后缀后命中", async () => {
    await writeMd("concepts/foo.md")
    const c = createProductionEntityExistenceChecker({ wikiRoot: root })
    assert.equal(await c.exists("[[foo]]"), true)
    assert.equal(await c.exists("concepts/foo"), true)
    assert.equal(await c.exists("foo.md"), true)
  })

  it("路径穿越 → false（不拼进 path）", async () => {
    await writeMd("secret.md")
    const c = createProductionEntityExistenceChecker({ wikiRoot: root })
    assert.equal(await c.exists("../secret"), false)
    assert.equal(await c.exists("../../etc/passwd"), false)
    assert.equal(await c.exists(".."), false)
    assert.equal(await c.exists(""), false)
  })

  it("codex P2-1 回归：concepts/foo.md 存在时 ../foo 仍判 false（split 前拒 ..）", async () => {
    // bug: normalizeEntityName 若先 split().pop() 再查 ..，会把 ../foo 归一成 foo
    // → concepts/foo.md 存在则误判 live。修后必须 false。
    await writeMd("concepts/foo.md")
    const c = createProductionEntityExistenceChecker({ wikiRoot: root })
    assert.equal(await c.exists("foo"), true, "sanity: foo 应存在")
    assert.equal(await c.exists("../foo"), false, "../foo 不得因 split 归一成 foo 而误判 live")
    assert.equal(await c.exists("../concepts/foo"), false)
    assert.equal(await c.exists("[[../foo]]"), false)
  })
})
