import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"

import Fastify from "fastify"

import { registerWikiMetaRoutes, WikiMetaScanner } from "./wiki-meta"

/**
 * F027 P4 AC-P4-9 a/b · WikiMetaScanner + endpoints 单测
 *
 * 测试覆盖:
 *   warnings:
 *     (W1) wikiRoot 无 warnings/ → 空 list
 *     (W2) 2 份 warning md → 解析 frontmatter + 按 detectedAt DESC sort
 *     (W3) severity 非 enum → null fallback
 *     (W4) frontmatter parse 失败的文件 → 跳过不阻塞其他
 *     (W5) endpoint Fastify.inject → 200 + warnings/total shape
 *   index:
 *     (I1) wikiRoot 无 index/ → 空 list
 *     (I2) 3 份 index md → 解析 bucket + sort asc by bucket
 *     (I3) frontmatter 无 bucket → fallback 用文件名
 *     (I4) endpoint Fastify.inject → 200 + views/total shape
 */

function setup(): {
  wikiRoot: string
  writeWarning: (name: string, frontmatter: string, body: string) => void
  writeIndex: (name: string, frontmatter: string, body: string) => void
  cleanup: () => void
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-meta-test-"))
  return {
    wikiRoot: tmp,
    writeWarning: (name, frontmatter, body) => {
      const dir = path.join(tmp, "warnings")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`)
    },
    writeIndex: (name, frontmatter, body) => {
      const dir = path.join(tmp, "index")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), `---\n${frontmatter}\n---\n\n${body}\n`)
    },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}

describe("WikiMetaScanner · listWarnings", () => {
  it("(W1) wikiRoot 无 warnings/ → 空 list", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listWarnings()
      assert.equal(result.total, 0)
      assert.deepEqual(result.warnings, [])
    } finally {
      t.cleanup()
    }
  })

  it("(W2) 2 份 warning → 解析 frontmatter + 按 detectedAt DESC sort", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "a.md",
        "type: warning\nsubtype: chained_suspect\nseverity: warn\nsource: ingest\ndetected_at: 2026-04-01T10:00:00Z\nraised_by: 黄仁勋",
        "body A",
      )
      t.writeWarning(
        "b.md",
        "type: warning\nsubtype: tainted_source\nseverity: high\nsource: v14\ndetected_at: 2026-04-15T11:00:00Z\nraised_by: V14",
        "body B",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listWarnings()
      assert.equal(result.total, 2)
      // sort DESC: b (newer) first
      assert.equal(result.warnings[0].path, "wiki/warnings/b.md")
      assert.equal(result.warnings[0].subtype, "tainted_source")
      assert.equal(result.warnings[0].severity, "high")
      assert.equal(result.warnings[1].subtype, "chained_suspect")
    } finally {
      t.cleanup()
    }
  })

  it("(W3) severity 非 enum → null fallback", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "x.md",
        "type: warning\nsubtype: bogus\nseverity: super-critical\ndetected_at: 2026-04-01T00:00:00Z",
        "body",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listWarnings()
      assert.equal(result.warnings[0].severity, null)
    } finally {
      t.cleanup()
    }
  })

  it("(W4) YAML parse 失败的文件 → 跳过不阻塞其他", async () => {
    const t = setup()
    try {
      const dir = path.join(t.wikiRoot, "warnings")
      fs.mkdirSync(dir, { recursive: true })
      // 写 YAML 真 invalid 的 frontmatter (含闭合 --- 但 YAML 语法错)
      fs.writeFileSync(
        path.join(dir, "broken.md"),
        "---\nbroken: [unclosed\n---\n\nbody",
      )
      t.writeWarning(
        "good.md",
        "type: warning\nsubtype: drift\nseverity: warn\ndetected_at: 2026-04-10T00:00:00Z",
        "body",
      )
      const warnings: string[] = []
      const scanner = new WikiMetaScanner({
        wikiRoot: t.wikiRoot,
        logWarn: (_, msg) => warnings.push(msg),
      })
      const result = await scanner.listWarnings()
      // good.md 仍解析成功，broken.md 被跳过
      assert.equal(result.warnings.length, 1)
      assert.equal(result.warnings[0].path, "wiki/warnings/good.md")
      assert.ok(warnings.some((m) => m.includes("frontmatter parse failed")))
    } finally {
      t.cleanup()
    }
  })

  it("(W5) endpoint Fastify.inject → 200 + warnings/total shape", async () => {
    const t = setup()
    try {
      t.writeWarning(
        "a.md",
        "type: warning\nsubtype: foo\nseverity: high\ndetected_at: 2026-04-01T00:00:00Z",
        "body",
      )
      const app = Fastify()
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      registerWikiMetaRoutes(app, { scanner })
      const resp = await app.inject({ method: "GET", url: "/api/wiki/warnings" })
      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.total, 1)
      assert.equal(body.warnings[0].subtype, "foo")
      await app.close()
    } finally {
      t.cleanup()
    }
  })
})

describe("WikiMetaScanner · listIndex", () => {
  it("(I1) wikiRoot 无 index/ → 空 list", async () => {
    const t = setup()
    try {
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listIndex()
      assert.equal(result.total, 0)
    } finally {
      t.cleanup()
    }
  })

  it("(I2) 3 份 index → 解析 bucket + sort asc by bucket", async () => {
    const t = setup()
    try {
      t.writeIndex(
        "rules.md",
        "type: index_view\nbucket: rules\ngenerated_at: 2026-05-23T00:00:00Z\ncompiler_version: 1.0.0",
        "rules body",
      )
      t.writeIndex(
        "concepts.md",
        "type: index_view\nbucket: concepts\ngenerated_at: 2026-05-23T00:00:00Z\ncompiler_version: 1.0.0",
        "concepts body",
      )
      t.writeIndex(
        "methods.md",
        "type: index_view\nbucket: methods\ngenerated_at: 2026-05-23T00:00:00Z\ncompiler_version: 1.0.0",
        "methods body",
      )
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listIndex()
      assert.equal(result.total, 3)
      // sort asc by bucket name
      assert.deepEqual(
        result.views.map((v) => v.bucket),
        ["concepts", "methods", "rules"],
      )
      assert.equal(result.views[0].compilerVersion, "1.0.0")
    } finally {
      t.cleanup()
    }
  })

  it("(I3) frontmatter 无 bucket → fallback 用文件名", async () => {
    const t = setup()
    try {
      t.writeIndex("custom-bucket.md", "type: index_view\ngenerated_at: 2026-05-23T00:00:00Z", "body")
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      const result = await scanner.listIndex()
      assert.equal(result.views[0].bucket, "custom-bucket")
    } finally {
      t.cleanup()
    }
  })

  it("(I4) endpoint Fastify.inject → 200 + views/total shape", async () => {
    const t = setup()
    try {
      t.writeIndex(
        "concepts.md",
        "type: index_view\nbucket: concepts\ngenerated_at: 2026-05-23T00:00:00Z",
        "body",
      )
      const app = Fastify()
      const scanner = new WikiMetaScanner({ wikiRoot: t.wikiRoot })
      registerWikiMetaRoutes(app, { scanner })
      const resp = await app.inject({ method: "GET", url: "/api/wiki/index" })
      assert.equal(resp.statusCode, 200)
      const body = resp.json()
      assert.equal(body.total, 1)
      assert.equal(body.views[0].bucket, "concepts")
      await app.close()
    } finally {
      t.cleanup()
    }
  })
})
