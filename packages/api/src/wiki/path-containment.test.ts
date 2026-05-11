/**
 * F027 P3 [范-r1 P1] · safeWikiPath 单测
 * Red→Green：path traversal 攻击向量必须被拒
 */

import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { WikiPathInvalidError, safeWikiPath } from "./path-containment"

const ROOT = path.resolve(process.cwd(), ".runtime", "test-wiki-root")

test("safeWikiPath: happy path 'wiki/concepts/foo.md'", () => {
  const abs = safeWikiPath(ROOT, "wiki/concepts/foo.md")
  assert.equal(abs, path.join(ROOT, "wiki/concepts/foo.md"))
})

test("safeWikiPath: '../../etc/passwd' 被拒", () => {
  assert.throws(
    () => safeWikiPath(ROOT, "wiki/../../etc/passwd"),
    (err: Error) => {
      assert.ok(err instanceof WikiPathInvalidError)
      assert.match(err.message, /resolves outside wikiRoot/)
      return true
    },
  )
})

test("safeWikiPath: 'wiki/concepts/../../../etc/passwd' 被拒", () => {
  assert.throws(() => safeWikiPath(ROOT, "wiki/concepts/../../../etc/passwd"), WikiPathInvalidError)
})

test("safeWikiPath: 不以 'wiki/' 开头被拒", () => {
  assert.throws(
    () => safeWikiPath(ROOT, "concepts/foo.md"),
    (err: Error) => {
      assert.match(err.message, /must start with 'wiki\//)
      return true
    },
  )
  assert.throws(
    () => safeWikiPath(ROOT, "../sibling/wiki/foo.md"),
    (err: Error) => {
      assert.match(err.message, /must start with 'wiki\//)
      return true
    },
  )
})

test("safeWikiPath: 绝对路径被拒（仍要求 wiki/ 前缀）", () => {
  assert.throws(() => safeWikiPath(ROOT, "/etc/passwd"), WikiPathInvalidError)
})

test("safeWikiPath: NUL byte 被拒", () => {
  assert.throws(
    () => safeWikiPath(ROOT, "wiki/concepts/foo\0.md"),
    (err: Error) => {
      assert.match(err.message, /NUL byte/)
      return true
    },
  )
})

test("safeWikiPath: 空字符串被拒", () => {
  assert.throws(() => safeWikiPath(ROOT, ""), WikiPathInvalidError)
})

test("safeWikiPath: 嵌套深路径合法", () => {
  const abs = safeWikiPath(ROOT, "wiki/rooms/R-001/agent-sessions/范德彪/S-1.md")
  assert.equal(abs.startsWith(ROOT + path.sep), true)
})
