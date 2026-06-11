/**
 * F027 收尾补丁 AC-W2 · auto-draft-supersede 单测
 *
 * 真相源：docs/features/F027-unified-memory-architecture.md
 *   「收尾补丁 · 收录体验」AC-W2 — 同源 _auto draft 自动收敛（只审最新）
 *
 * 同源 key 推导契约（两形态互通）：
 *   - 编译产物：frontmatter sources[0].path 的 basename（去 .md，小写）
 *   - stub / watcher 版本化名：文件名去 .md + 去 `-<13位unixMs>` 后缀（小写）
 *   - 实测依据（2026-06-12 主库）：stub draft 无 sources frontmatter（只有原文档自身
 *     frontmatter），编译产物有 sources[].path；同一源文档两形态 key 必须相等。
 */

import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  deriveAutoDraftSourceKey,
  supersedeOlderAutoDrafts,
} from "./auto-draft-supersede"

// ── deriveAutoDraftSourceKey ────────────────────────────────────────────

describe("deriveAutoDraftSourceKey", () => {
  it("sources[0].path 优先：取 basename 去 .md 小写", () => {
    const key = deriveAutoDraftSourceKey("anything-1781200633785.md", {
      sources: [{ path: "docs/features/F029-Research-Verification-Pipeline.md" }],
    })
    assert.equal(key, "f029-research-verification-pipeline")
  })

  it("无 sources → 文件名去 .md + 去 13 位时间戳后缀", () => {
    const key = deriveAutoDraftSourceKey(
      "F029-research-verification-pipeline-1781201669303.md",
      null,
    )
    assert.equal(key, "f029-research-verification-pipeline")
  })

  it("backfill 风格无时间戳后缀的文件名原样作 key", () => {
    const key = deriveAutoDraftSourceKey("F026-a2a-reliability-layer.md", {})
    assert.equal(key, "f026-a2a-reliability-layer")
  })

  it("同一源文档的编译产物与 stub 两形态 key 相等", () => {
    const compiled = deriveAutoDraftSourceKey("F029-research-verification-pipeline-1781209999999.md", {
      sources: [{ path: "docs/features/F029-research-verification-pipeline.md" }],
    })
    const stub = deriveAutoDraftSourceKey(
      "F029-research-verification-pipeline-1781201669303.md",
      null,
    )
    assert.equal(compiled, stub)
  })

  it("12 位数字后缀不当时间戳剥（只剥恰好 13 位）", () => {
    assert.equal(
      deriveAutoDraftSourceKey("doc-123456789012.md", null),
      "doc-123456789012",
    )
  })

  it("sources 空数组 / path 非 string → 回落文件名 key", () => {
    assert.equal(
      deriveAutoDraftSourceKey("a-doc-1781201669303.md", { sources: [] }),
      "a-doc",
    )
    assert.equal(
      deriveAutoDraftSourceKey("a-doc-1781201669303.md", { sources: [{ path: 42 }] }),
      "a-doc",
    )
  })

  it("Windows 反斜杠 sources path 也取对 basename", () => {
    assert.equal(
      deriveAutoDraftSourceKey("x-1781201669303.md", {
        sources: [{ path: "docs\\features\\F028-workspace-explorer-tabs.md" }],
      }),
      "f028-workspace-explorer-tabs",
    )
  })

  it("不同源文档（B019 两篇）key 不同，不互相误伤", () => {
    const a = deriveAutoDraftSourceKey("B019-adr-guard-base-ref.md", null)
    const b = deriveAutoDraftSourceKey("B019-f018-embedding-huggingface-offline.md", null)
    assert.notEqual(a, b)
  })
})

// ── supersedeOlderAutoDrafts（真 fs 临时目录） ──────────────────────────

const FM_F029_COMPILED = `---
title: 调研与核查管道
sources:
  - type: text/markdown
    path: docs/features/F029-research-verification-pipeline.md
---

compiled body
`

const FM_F029_STUB = `---
id: F029
title: 调研与核查管道(stub)
---

stub body (sanitize 原文搬运，无 sources)
`

const FM_F026 = `---
title: F026 A2A
sources:
  - type: text/markdown
    path: docs/features/F026-a2a-reliability-layer.md
---

f026 body
`

async function setupAutoDir(): Promise<{ autoDir: string; draftRoot: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "auto-supersede-"))
  const draftRoot = path.join(tmp, "wiki", "concepts", "draft")
  const autoDir = path.join(draftRoot, "_auto")
  await mkdir(autoDir, { recursive: true })
  return { autoDir, draftRoot }
}

describe("supersedeOlderAutoDrafts", () => {
  it("同源旧 draft 搬 _superseded，新 committed + 异源不动", async () => {
    const { autoDir, draftRoot } = await setupAutoDir()
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781200633785.md"),
      FM_F029_STUB,
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201669303.md"),
      FM_F029_COMPILED,
      "utf-8",
    )
    await writeFile(path.join(autoDir, "F026-a2a-reliability-layer.md"), FM_F026, "utf-8")

    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline-1781201669303.md",
    })

    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.moved, ["F029-research-verification-pipeline-1781200633785.md"])

    const autoLeft = (await readdir(autoDir)).sort()
    assert.deepEqual(autoLeft, [
      "F026-a2a-reliability-layer.md",
      "F029-research-verification-pipeline-1781201669303.md",
    ])
    const superseded = await readdir(path.join(draftRoot, "_superseded"))
    assert.deepEqual(superseded, ["F029-research-verification-pipeline-1781200633785.md"])
    // 内容原样保留（搬运不是删除 — 数据神圣）
    const movedBody = await readFile(
      path.join(draftRoot, "_superseded", "F029-research-verification-pipeline-1781200633785.md"),
      "utf-8",
    )
    assert.equal(movedBody, FM_F029_STUB)
  })

  it("committed 自身永不被搬（即使 key 自匹配）", async () => {
    const { autoDir } = await setupAutoDir()
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201669303.md"),
      FM_F029_COMPILED,
      "utf-8",
    )
    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline-1781201669303.md",
    })
    assert.deepEqual(result.moved, [])
    assert.deepEqual(await readdir(autoDir), [
      "F029-research-verification-pipeline-1781201669303.md",
    ])
  })

  it("frontmatter 解析失败的旧文件回落文件名 key 仍可收敛", async () => {
    const { autoDir, draftRoot } = await setupAutoDir()
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781200633785.md"),
      "---\n: : broken yaml [\n---\nbody",
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201669303.md"),
      FM_F029_COMPILED,
      "utf-8",
    )
    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline-1781201669303.md",
    })
    assert.deepEqual(result.moved, ["F029-research-verification-pipeline-1781200633785.md"])
    assert.deepEqual(await readdir(path.join(draftRoot, "_superseded")), [
      "F029-research-verification-pipeline-1781200633785.md",
    ])
  })

  it("目标已存在同名 → 加 -dup 后缀搬运不覆盖（数据神圣）", async () => {
    const { autoDir, draftRoot } = await setupAutoDir()
    const supersededDir = path.join(draftRoot, "_superseded")
    await mkdir(supersededDir, { recursive: true })
    await writeFile(
      path.join(supersededDir, "F029-research-verification-pipeline-1781200633785.md"),
      "already archived",
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781200633785.md"),
      FM_F029_STUB,
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201669303.md"),
      FM_F029_COMPILED,
      "utf-8",
    )

    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline-1781201669303.md",
    })

    assert.equal(result.failed.length, 0)
    assert.equal(result.moved.length, 1)
    const archived = (await readdir(supersededDir)).sort()
    assert.deepEqual(archived, [
      "F029-research-verification-pipeline-1781200633785-dup1.md",
      "F029-research-verification-pipeline-1781200633785.md",
    ])
    // 先到的归档内容不被覆盖
    const original = await readFile(
      path.join(supersededDir, "F029-research-verification-pipeline-1781200633785.md"),
      "utf-8",
    )
    assert.equal(original, "already archived")
  })

  it("德彪 r1 P1 · 时间戳守卫：候选 ts ≥ committed ts 不搬（乱序完成不吃新 draft）", async () => {
    const { autoDir, draftRoot } = await setupAutoDir()
    // 三个同源版本：更旧(633785) / committed(669303) / 更新(999999) —— 慢 ingest 后完成场景
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781200633785.md"),
      FM_F029_STUB,
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201669303.md"),
      FM_F029_COMPILED,
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201999999.md"),
      FM_F029_STUB,
      "utf-8",
    )

    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline-1781201669303.md",
    })

    assert.deepEqual(result.moved, ["F029-research-verification-pipeline-1781200633785.md"])
    const autoLeft = (await readdir(autoDir)).sort()
    assert.deepEqual(autoLeft, [
      "F029-research-verification-pipeline-1781201669303.md",
      "F029-research-verification-pipeline-1781201999999.md",
    ])
    assert.deepEqual(await readdir(path.join(draftRoot, "_superseded")), [
      "F029-research-verification-pipeline-1781200633785.md",
    ])
  })

  it("德彪 r1 P1 · 无时间戳 legacy（backfill 名）被有戳 committed 收敛", async () => {
    const { autoDir, draftRoot } = await setupAutoDir()
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline.md"),
      FM_F029_STUB,
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201669303.md"),
      FM_F029_COMPILED,
      "utf-8",
    )
    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline-1781201669303.md",
    })
    assert.deepEqual(result.moved, ["F029-research-verification-pipeline.md"])
    assert.deepEqual(await readdir(path.join(draftRoot, "_superseded")), [
      "F029-research-verification-pipeline.md",
    ])
  })

  it("德彪 r1 P1 · committed 自身无时间戳 → 保守不搬任何文件", async () => {
    const { autoDir, draftRoot } = await setupAutoDir()
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline.md"),
      FM_F029_COMPILED,
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781200633785.md"),
      FM_F029_STUB,
      "utf-8",
    )
    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline.md",
    })
    assert.deepEqual(result.moved, [])
    let supersededExists = true
    try {
      await readdir(path.join(draftRoot, "_superseded"))
    } catch {
      supersededExists = false
    }
    assert.equal(supersededExists, false)
  })

  it("committed 文件读不到（race 被删）→ 空结果不抛", async () => {
    const { autoDir } = await setupAutoDir()
    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "gone-1781201669303.md",
    })
    assert.deepEqual(result.moved, [])
    assert.deepEqual(result.failed, [])
  })

  it("autoDir 不存在 → 空结果不抛（fresh wiki）", async () => {
    const result = await supersedeOlderAutoDrafts({
      autoDir: path.join(os.tmpdir(), "auto-supersede-nonexistent", "_auto"),
      committedFileName: "x-1781201669303.md",
    })
    assert.deepEqual(result.moved, [])
    assert.deepEqual(result.failed, [])
  })

  it("非 .md 文件与子目录忽略", async () => {
    const { autoDir, draftRoot } = await setupAutoDir()
    await mkdir(path.join(autoDir, "F029-research-verification-pipeline-9999999999999.dir"), {
      recursive: true,
    })
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781200633785.md.bak"),
      "not md",
      "utf-8",
    )
    await writeFile(
      path.join(autoDir, "F029-research-verification-pipeline-1781201669303.md"),
      FM_F029_COMPILED,
      "utf-8",
    )
    const result = await supersedeOlderAutoDrafts({
      autoDir,
      committedFileName: "F029-research-verification-pipeline-1781201669303.md",
    })
    assert.deepEqual(result.moved, [])
    let supersededExists = true
    try {
      await readdir(path.join(draftRoot, "_superseded"))
    } catch {
      supersededExists = false
    }
    assert.equal(supersededExists, false)
  })
})
