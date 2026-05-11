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
      assert.match(err.message, /escapes wiki\/ namespace|outside wikiRoot/)
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

test("safeWikiPath [范-r2 P1]: 'wiki/concepts/../../admin.md' namespace escape 必须拒", () => {
  // normalize 后 → 'admin.md'，仍在 wikiRoot 内但逃出 wiki/ namespace
  assert.throws(
    () => safeWikiPath(ROOT, "wiki/concepts/../../admin.md"),
    (err: Error) => {
      assert.ok(err instanceof WikiPathInvalidError)
      assert.match(err.message, /escapes wiki\/ namespace|outside wikiRoot\/wiki/)
      return true
    },
  )
})

test("safeWikiPath [范-r2 P1]: 'wiki/../wiki/admin.md' 巧妙绕过被拒（namespace 前缀字面 OK 但 normalize 后逃 namespace）", () => {
  // 字面 'wiki/' 前缀通过，normalize → 'wiki/admin.md' 实际仍在 namespace 内，应允许
  // 但 'wiki/../etc/passwd' 应被拒
  assert.throws(
    () => safeWikiPath(ROOT, "wiki/../etc/passwd"),
    (err: Error) => {
      assert.ok(err instanceof WikiPathInvalidError)
      return true
    },
  )
  // 'wiki/x/../sibling' 是 namespace 内 normalize → 'wiki/sibling'，应通过
  const abs = safeWikiPath(ROOT, "wiki/concepts/../sibling.md")
  assert.equal(abs, path.join(ROOT, "wiki/sibling.md"))
})

test("safeWikiPath [范-r2 P1]: 'wiki/./concepts/foo.md' 含 '.' segment normalize 后合法", () => {
  const abs = safeWikiPath(ROOT, "wiki/./concepts/foo.md")
  assert.equal(abs, path.join(ROOT, "wiki/concepts/foo.md"))
})
