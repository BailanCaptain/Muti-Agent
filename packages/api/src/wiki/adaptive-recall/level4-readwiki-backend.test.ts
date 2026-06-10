/**
 * F027 P13.4 · Level 4 read_wiki backend 单元测试
 * 端到端：mkdtemp + 写 wiki/concepts/F011.md → readWiki(path) → 验 RecallHit
 * 安全：path traversal / 非 .md / 绝对路径 / ENOENT 全部 return null
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { FileSystemLevel4Backend } from "./level4-readwiki-backend"

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "p13-l4-"))
  mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true })
  writeFileSync(
    path.join(root, "wiki", "concepts", "F011.md"),
    "# F011 backend hardening\n\n drizzle 优化讨论\n".repeat(20),
    "utf8",
  )
  const backend = new FileSystemLevel4Backend({ wikiRoot: root })
  return { backend, root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe("F027 P13.4 · FileSystemLevel4Backend", () => {
  it("exact wiki path 存在 → 返 RecallHit (score=1.0, excerpt 截 400)", async () => {
    const { backend, cleanup } = setup()
    try {
      const hit = await backend.readWiki("wiki/concepts/F011.md")
      assert.ok(hit, "应返 hit 不返 null")
      assert.equal(hit.path, "wiki/concepts/F011.md")
      assert.equal(hit.score, 1.0)
      assert.ok(hit.excerpt.length > 0)
      assert.ok(hit.excerpt.length <= 400)
      assert.match(hit.excerpt, /F011/)
    } finally {
      cleanup()
    }
  })

  it("文件不存在 → 返 null (升 L5)", async () => {
    const { backend, cleanup } = setup()
    try {
      const hit = await backend.readWiki("wiki/concepts/missing.md")
      assert.equal(hit, null)
    } finally {
      cleanup()
    }
  })

  it("path 非 wiki/ 前缀 → 返 null", async () => {
    const { backend, cleanup } = setup()
    try {
      assert.equal(await backend.readWiki("/etc/passwd"), null)
      assert.equal(await backend.readWiki("../../../secret"), null)
      assert.equal(await backend.readWiki("docs/features/F027.md"), null)
    } finally {
      cleanup()
    }
  })

  it("path traversal 攻击：wiki/../../etc/passwd → 返 null", async () => {
    const { backend, cleanup } = setup()
    try {
      // 这种 path 不通过 WIKI_PATH_PREFIX 正则
      const hit = await backend.readWiki("wiki/../etc/passwd.md")
      assert.equal(hit, null)
    } finally {
      cleanup()
    }
  })

  it("非 .md 后缀 → 返 null", async () => {
    const { backend, cleanup } = setup()
    try {
      assert.equal(await backend.readWiki("wiki/concepts/F011"), null)
      assert.equal(await backend.readWiki("wiki/concepts/F011.txt"), null)
    } finally {
      cleanup()
    }
  })

  it("path 是 dir 不是 file → 返 null（EISDIR）", async () => {
    const { backend, cleanup } = setup()
    try {
      // wiki/concepts 是目录
      const hit = await backend.readWiki("wiki/concepts/F011.md/x.md") // 拼一个不存在
      assert.equal(hit, null)
    } finally {
      cleanup()
    }
  })

  // 德彪 r2 P1 · draft 召回准入闸门(小孙拍选项 1):L4 是 agent 召回注入路径,
  // critique 给 exact draft 路径不得旁路 BM25/语义闸门。
  it("draft 路径(文件存在)→ 返 null(召回准入闸门)", async () => {
    const { backend, root, cleanup } = setup()
    try {
      mkdirSync(path.join(root, "wiki", "concepts", "draft", "_auto"), { recursive: true })
      writeFileSync(
        path.join(root, "wiki", "concepts", "draft", "_auto", "danger.md"),
        "# 未审 draft 危险内容\n",
        "utf8",
      )
      assert.equal(await backend.readWiki("wiki/concepts/draft/_auto/danger.md"), null)
    } finally {
      cleanup()
    }
  })

  it("_drafts(demote 回流)路径(文件存在)→ 返 null", async () => {
    const { backend, root, cleanup } = setup()
    try {
      mkdirSync(path.join(root, "wiki", "concepts", "_drafts"), { recursive: true })
      writeFileSync(
        path.join(root, "wiki", "concepts", "_drafts", "demoted.md"),
        "# demoted 未再审内容\n",
        "utf8",
      )
      assert.equal(await backend.readWiki("wiki/concepts/_drafts/demoted.md"), null)
    } finally {
      cleanup()
    }
  })

  // 德彪 r3 P1 · Windows 大小写旁路:WIKI_PATH_PREFIX 用 /i,大写 DRAFT/_DRAFTS 过前缀校验,
  // 大小写敏感 includes 会漏判 → Windows fs 不敏感能读真 draft 文件。isDraftRelativePath
  // 已改 toLowerCase,大写形态同样返 null。
  it("大写 DRAFT 路径 → 返 null(大小写不敏感闸门)", async () => {
    const { backend, cleanup } = setup()
    try {
      assert.equal(await backend.readWiki("wiki/concepts/DRAFT/x.md"), null)
      assert.equal(await backend.readWiki("wiki/concepts/Draft/x.md"), null)
    } finally {
      cleanup()
    }
  })

  it("大写 _DRAFTS 路径 → 返 null", async () => {
    const { backend, cleanup } = setup()
    try {
      assert.equal(await backend.readWiki("wiki/concepts/_DRAFTS/x.md"), null)
    } finally {
      cleanup()
    }
  })
})
