/**
 * F027 P2 · WikiCompiler 单测
 * 真相源：docs/plans/V16.5-final.md chap 5 + chap 19
 *
 * 覆盖：
 *   - 空 fixture (no events / no memories) → 5 个 type 文件 + index/sources/log + manifest 全落盘
 *   - 多 type canonical 渲染：5 类各分文件 + 顶层 index 含分类计数
 *   - draft / deprecated memories 不进派生视图（只 canonical）
 *   - aborted / pending events 不进 log.md（只 committed）
 *   - manifest sourceEventSeq = max(events.id)
 *   - manifest 含全部 filesWritten + 每个 file 的 hash 与文件实际内容一致
 *   - 多次 compile 不同 version → 各自有独立 v-XXX/ 子目录共存
 *   - 顶层 index "最近热门" 取 5 条 canonical
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import type { WikiEvent } from "../db/repositories/wiki-events-types"
import type { WikiMemory } from "../db/repositories/wiki-memories-types"
import { readManifest } from "./index-manifest"
import { compileWiki } from "./wiki-compiler"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}

function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

let nextMemId = 1
let nextEvtId = 1

function mem(over: Partial<WikiMemory> = {}): WikiMemory {
  const id = nextMemId++
  const type = over.type ?? "project"
  return {
    id,
    type,
    name: over.name ?? `n-${id}`,
    canonicalOwnerPath: over.canonicalOwnerPath ?? `wiki/${type}/p-${id}.md`,
    promotionTarget: over.promotionTarget ?? null,
    ttlDays: over.ttlDays ?? null,
    supersedes: over.supersedes ?? null,
    replacesInBuckets: over.replacesInBuckets ?? null,
    sourceMessageIds: over.sourceMessageIds ?? null,
    contributedBy: over.contributedBy ?? ["黄仁勋"],
    crossRefs: over.crossRefs ?? null,
    dedupDecision: over.dedupDecision ?? null,
    body: over.body ?? `body for ${id}`,
    state: (over.state ?? "canonical"),
    createdAt: over.createdAt ?? "2026-05-11T10:00:00Z",
    updatedAt: over.updatedAt ?? "2026-05-11T10:00:00Z",
  }
}

function evt(over: Partial<WikiEvent> = {}): WikiEvent {
  const id = nextEvtId++
  return {
    id,
    ts: over.ts ?? "2026-05-11T10:00:00Z",
    alias: over.alias ?? "黄仁勋",
    action: (over.action ?? "write"),
    path: over.path ?? `wiki/project/p-${id}.md`,
    baseHash: over.baseHash ?? null,
    contentHash: over.contentHash ?? `sha256:c-${id}`,
    attemptedHash: over.attemptedHash ?? `sha256:a-${id}`,
    diffSummary: over.diffSummary ?? null,
    sourceMessageIds: over.sourceMessageIds ?? null,
    promotionTarget: over.promotionTarget ?? null,
    reason: over.reason ?? null,
    fencingToken: over.fencingToken ?? "1",
    leaderTerm: over.leaderTerm ?? "term-1",
    result: (over.result ?? "ok"),
    error: over.error ?? null,
    state: (over.state ?? "committed"),
    resultManifestVersion: over.resultManifestVersion ?? null,
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

test("F027 P2: 空 fixture → 派生 5 个 type 文件 + index/sources/log + manifest 全落盘", () => {
  const wikiRoot = safeTempDir("p2-empty-")
  try {
    const result = compileWiki({
      wikiRoot,
      version: "2026051101",
      events: [],
      memories: [],
      generatedAt: "2026-05-11T10:00:00Z",
    })

    // 5 type 文件 + 顶层 index/sources/log + manifest = 9 file
    assert.equal(result.filesWritten.length, 9)
    for (const t of ["project", "room", "user", "feedback", "work"]) {
      const p = path.join(wikiRoot, "index", "v-2026051101", `${t}.md`)
      assert.ok(fs.existsSync(p), `expected ${p} to exist`)
    }
    assert.ok(fs.existsSync(path.join(wikiRoot, "index.md")))
    assert.ok(fs.existsSync(path.join(wikiRoot, "sources.md")))
    assert.ok(fs.existsSync(path.join(wikiRoot, "log.md")))
    assert.ok(fs.existsSync(path.join(wikiRoot, "index", "manifest.json")))

    assert.equal(result.stats.totalEvents, 0)
    assert.equal(result.stats.committedEvents, 0)
    for (const t of ["room", "project", "user", "feedback", "work"] as const) {
      assert.equal(result.stats.canonicalByType[t], 0)
    }
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2: 多 type canonical 渲染 — 5 类各分文件 + 顶层 index 含分类计数", () => {
  const wikiRoot = safeTempDir("p2-multi-type-")
  try {
    const memories = [
      mem({ type: "project", name: "P-A", canonicalOwnerPath: "wiki/project/a.md" }),
      mem({ type: "project", name: "P-B", canonicalOwnerPath: "wiki/project/b.md" }),
      mem({ type: "user", name: "小孙", canonicalOwnerPath: "wiki/user/xiaosun.md" }),
      mem({ type: "feedback", name: "F-1", canonicalOwnerPath: "wiki/feedback/f1.md", ttlDays: 30 }),
      mem({ type: "work", name: "W-1", canonicalOwnerPath: "wiki/work/w1.md" }),
    ]
    const result = compileWiki({
      wikiRoot,
      version: "v1",
      events: [],
      memories,
      generatedAt: "2026-05-11T10:00:00Z",
    })

    assert.equal(result.stats.canonicalByType.project, 2)
    assert.equal(result.stats.canonicalByType.user, 1)
    assert.equal(result.stats.canonicalByType.feedback, 1)
    assert.equal(result.stats.canonicalByType.work, 1)
    assert.equal(result.stats.canonicalByType.room, 0)

    // project.md 含 2 个 memory
    const projectMd = fs.readFileSync(path.join(wikiRoot, "index", "v-v1", "project.md"), "utf-8")
    assert.match(projectMd, /Wiki · project \(2\)/)
    assert.match(projectMd, /## P-A/)
    assert.match(projectMd, /## P-B/)

    // 顶层 index.md 分类计数 + 最近热门
    const topIdx = fs.readFileSync(path.join(wikiRoot, "index.md"), "utf-8")
    assert.match(topIdx, /\*\*project\*\*: 2/)
    assert.match(topIdx, /\*\*user\*\*: 1/)
    assert.match(topIdx, /\*\*room\*\*: 0/)
    assert.match(topIdx, /## 最近热门/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2: draft / deprecated memories 不进派生视图（只渲染 canonical）", () => {
  const wikiRoot = safeTempDir("p2-state-filter-")
  try {
    const memories = [
      mem({ type: "project", name: "draft-row", state: "draft" }),
      mem({ type: "project", name: "deprecated-row", state: "deprecated" }),
      mem({ type: "project", name: "canonical-row", state: "canonical" }),
    ]
    const result = compileWiki({
      wikiRoot,
      version: "v1",
      events: [],
      memories,
      generatedAt: "2026-05-11T10:00:00Z",
    })
    assert.equal(result.stats.canonicalByType.project, 1)

    const projectMd = fs.readFileSync(path.join(wikiRoot, "index", "v-v1", "project.md"), "utf-8")
    assert.match(projectMd, /## canonical-row/)
    assert.doesNotMatch(projectMd, /draft-row/)
    assert.doesNotMatch(projectMd, /deprecated-row/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2: aborted / pending events 不进 log.md（只 committed）", () => {
  const wikiRoot = safeTempDir("p2-evt-state-")
  try {
    const events = [
      evt({ alias: "committed-a", state: "committed" }),
      evt({ alias: "pending-a", state: "pending", contentHash: null }),
      evt({ alias: "aborted-a", state: "aborted", contentHash: null }),
    ]
    const result = compileWiki({
      wikiRoot,
      version: "v1",
      events,
      memories: [],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    assert.equal(result.stats.totalEvents, 3)
    assert.equal(result.stats.committedEvents, 1)

    const log = fs.readFileSync(path.join(wikiRoot, "log.md"), "utf-8")
    assert.match(log, /committed-a/)
    assert.doesNotMatch(log, /pending-a/)
    assert.doesNotMatch(log, /aborted-a/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2: manifest sourceEventSeq = max(events.id) + files hash 与磁盘内容一致", () => {
  const wikiRoot = safeTempDir("p2-manifest-")
  try {
    const events = [evt({}), evt({}), evt({})] // ids 1,2,3 (counter shared，实际值由 nextEvtId 决定)
    const memories = [mem({ type: "project", body: "hello world" })]
    const result = compileWiki({
      wikiRoot,
      version: "v1",
      events,
      memories,
      generatedAt: "2026-05-11T10:00:00Z",
    })

    const expectedMax = events.reduce((m, e) => (e.id > m ? e.id : m), 0)
    assert.equal(result.manifest.sourceEventSeq, expectedMax)

    // 每个 file hash 与磁盘读出内容的 sha256 一致
    for (const f of result.manifest.files) {
      const abs = path.join(wikiRoot, f.path)
      const disk = fs.readFileSync(abs, "utf-8")
      assert.equal(sha256(disk), f.hash, `hash mismatch for ${f.path}`)
      assert.equal(Buffer.byteLength(disk, "utf-8"), f.sizeBytes)
    }

    // manifest.json 真落盘且 readManifest 能读
    const mIdx = readManifest(path.join(wikiRoot, "index"))
    assert.equal(mIdx?.version, "v1")
    assert.equal(mIdx?.files.length, result.manifest.files.length)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2: 多次 compile 不同 version → v-XXX/ 共存（旧版不被覆盖）", () => {
  const wikiRoot = safeTempDir("p2-versions-")
  try {
    compileWiki({
      wikiRoot,
      version: "v1",
      events: [],
      memories: [mem({ type: "project", name: "v1-only" })],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    compileWiki({
      wikiRoot,
      version: "v2",
      events: [],
      memories: [mem({ type: "project", name: "v2-only" })],
      generatedAt: "2026-05-11T10:01:00Z",
    })

    // 两版本目录都在
    assert.ok(fs.existsSync(path.join(wikiRoot, "index", "v-v1", "project.md")))
    assert.ok(fs.existsSync(path.join(wikiRoot, "index", "v-v2", "project.md")))

    // manifest.json 永远指向最新
    const m = readManifest(path.join(wikiRoot, "index"))
    assert.equal(m?.version, "v2")
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2: 顶层 index 最近热门 取最新 5 条 canonical（按 updatedAt DESC）", () => {
  const wikiRoot = safeTempDir("p2-recent-")
  try {
    const memories = []
    for (let i = 1; i <= 8; i++) {
      memories.push(
        mem({
          type: "project",
          name: `mem-${i}`,
          canonicalOwnerPath: `wiki/project/m-${i}.md`,
          updatedAt: `2026-05-11T10:0${i}:00Z`,
        }),
      )
    }
    compileWiki({
      wikiRoot,
      version: "v1",
      events: [],
      memories,
      generatedAt: "2026-05-11T11:00:00Z",
    })

    const top = fs.readFileSync(path.join(wikiRoot, "index.md"), "utf-8")
    // 最近热门只显示 5 条 (mem-8 to mem-4)
    assert.match(top, /mem-8/)
    assert.match(top, /mem-7/)
    assert.match(top, /mem-6/)
    assert.match(top, /mem-5/)
    assert.match(top, /mem-4/)
    // mem-3 / mem-2 / mem-1 不在最近热门段（但仍在 project.md 里）
    const recentSection = top.split("## 最近热门")[1] ?? ""
    assert.doesNotMatch(recentSection, /mem-3/)
    assert.doesNotMatch(recentSection, /mem-1/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2: sources.md 列全 canonical + 含 contributedBy / source_message_ids / supersedes", () => {
  const wikiRoot = safeTempDir("p2-sources-")
  try {
    compileWiki({
      wikiRoot,
      version: "v1",
      events: [],
      memories: [
        mem({
          type: "project",
          name: "P-A",
          canonicalOwnerPath: "wiki/project/a.md",
          contributedBy: ["黄仁勋", "范德彪"],
          sourceMessageIds: ["msg-1", "msg-2"],
          supersedes: ["wiki/project/old.md"],
        }),
        mem({ type: "user", name: "U-1", canonicalOwnerPath: "wiki/user/u1.md" }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })

    const sources = fs.readFileSync(path.join(wikiRoot, "sources.md"), "utf-8")
    assert.match(sources, /wiki\/project\/a\.md/)
    assert.match(sources, /黄仁勋, 范德彪/)
    assert.match(sources, /msg-1, msg-2/)
    assert.match(sources, /wiki\/project\/old\.md/)
    assert.match(sources, /wiki\/user\/u1\.md/)
  } finally {
    safeCleanup(wikiRoot)
  }
})
