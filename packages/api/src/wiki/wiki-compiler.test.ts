/**
 * F027 P2 · WikiCompiler 单测（范-r2 修复后版）
 * 真相源：docs/plans/V16.5-final.md chap 19
 *
 * 范-r2 修复后期望：
 *   - v-XXX/ 内 chap 19 6 文件：index / rules / concepts / rooms-active / rooms-archive / episodes
 *   - v-XXX/ 内附加 2 文件：sources / log（chap 19 没明示，进版本目录保持一致）
 *   - 顶层 wiki/index.md 用 atomic write（无 .tmp 残留）
 *   - manifest.files 只列 v-XXX/ 内文件（顶层 wiki/index.md 是注入入口，不进 manifest 载荷）
 *   - chap 19 categorization 用 path-prefix heuristic（rules/concepts/episodes）+ type 路由（room→rooms-active）
 *
 * 覆盖：
 *   - 空 fixture → 8 个 v-XXX/ 文件 + 顶层 index + manifest
 *   - chap 19 categorization：room→rooms-active；path /rules/→rules；path /concepts/→concepts；
 *                           type=work→episodes；path /episodes/→episodes
 *   - 顶层 wiki/index.md 是 atomic write（无 .tmp 残留）
 *   - 多次 compile 不同 version → v-XXX/ 共存 + 顶层 index 总指最新
 *   - draft / deprecated 不进派生
 *   - aborted / pending events 不进 log.md
 *   - manifest sourceEventSeq = max(events.id)，files hash 与磁盘内容一致
 *   - sources.md 含 contentHash（追溯用 — 范-r2 nit 3）
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { ATOMIC_TMP_REGEX } from "./atomic-write"
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
    state: over.state ?? "canonical",
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
    action: over.action ?? "write",
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
    result: over.result ?? "ok",
    error: over.error ?? null,
    state: over.state ?? "committed",
    resultManifestVersion: over.resultManifestVersion ?? null,
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

const TEST_VERSION = "2026051101" // chap 19 YYYYMMDDNN 格式（范-r2 nit 2）

const CHAP19_FILES = [
  "index.md",
  "rules.md",
  "concepts.md",
  "rooms-active.md",
  "rooms-archive.md",
  "episodes.md",
  "sources.md",
  "log.md",
]

test("F027 P2 [范-r2]: 空 fixture → v-XXX/ 含 chap 19 8 文件 + 顶层 wiki/index.md + manifest", () => {
  const wikiRoot = safeTempDir("p2-r2-empty-")
  try {
    const result = compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [],
      generatedAt: "2026-05-11T10:00:00Z",
    })

    // chap 19 文件全部在 v-XXX/
    for (const f of CHAP19_FILES) {
      const p = path.join(wikiRoot, "index", `v-${TEST_VERSION}`, f)
      assert.ok(fs.existsSync(p), `expected ${p} to exist`)
    }
    // 顶层 wiki/index.md（注入 prompt 入口）
    assert.ok(fs.existsSync(path.join(wikiRoot, "index.md")))
    // manifest.json
    assert.ok(fs.existsSync(path.join(wikiRoot, "index", "manifest.json")))

    // 不再有 5 type 文件（旧实现）
    for (const t of ["project", "room", "user", "feedback", "work"]) {
      const stale = path.join(wikiRoot, "index", `v-${TEST_VERSION}`, `${t}.md`)
      assert.ok(!fs.existsSync(stale), `legacy ${stale} should NOT exist`)
    }

    // manifest.files 只列 v-XXX/ 内 8 文件（顶层 wiki/index.md 是注入入口，不进 manifest 载荷）
    const manifest = result.manifest
    assert.equal(manifest.files.length, CHAP19_FILES.length)
    for (const f of manifest.files) {
      assert.ok(f.path.startsWith(`index/v-${TEST_VERSION}/`), `manifest file ${f.path} should be under v-XXX/`)
    }
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: 顶层 wiki/index.md 是 atomic write（写后无 .tmp 残留）", () => {
  const wikiRoot = safeTempDir("p2-r2-top-atomic-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    // wiki/ 顶层无 index.md.<x>.tmp 残留
    const topLevel = fs.readdirSync(wikiRoot)
    const orphans = topLevel.filter((n) => ATOMIC_TMP_REGEX.test(n))
    assert.deepEqual(orphans, [], `expected no atomic .tmp residue, got: ${orphans.join(", ")}`)
    // wiki/index/ 下也无 .tmp 残留（manifest 也是 atomic）
    const idxLevel = fs.readdirSync(path.join(wikiRoot, "index"))
    const idxOrphans = idxLevel.filter((n) => ATOMIC_TMP_REGEX.test(n))
    assert.deepEqual(idxOrphans, [])
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: chap 19 categorization — type=room → rooms-active.md", () => {
  const wikiRoot = safeTempDir("p2-r2-cat-room-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [
        mem({ type: "room", name: "R-001 chat", canonicalOwnerPath: "wiki/room/r-001.md" }),
        mem({ type: "room", name: "R-002 chat", canonicalOwnerPath: "wiki/room/r-002.md" }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const active = fs.readFileSync(path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "rooms-active.md"), "utf-8")
    assert.match(active, /R-001 chat/)
    assert.match(active, /R-002 chat/)

    const archive = fs.readFileSync(path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "rooms-archive.md"), "utf-8")
    // rooms-archive 是 placeholder（P3.5 lease 30d 分流）— 不含 active 房间
    assert.doesNotMatch(archive, /R-001 chat/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: chap 19 categorization — path /rules/ → rules.md", () => {
  const wikiRoot = safeTempDir("p2-r2-cat-rules-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [
        mem({
          type: "project",
          name: "Iron Laws",
          canonicalOwnerPath: "wiki/project/rules/iron-laws.md",
        }),
        mem({ type: "project", name: "B022 Fix", canonicalOwnerPath: "wiki/project/B022.md" }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const rules = fs.readFileSync(path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "rules.md"), "utf-8")
    assert.match(rules, /Iron Laws/)
    assert.doesNotMatch(rules, /B022 Fix/) // 没在 /rules/ 下
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: chap 19 categorization — path /concepts/ → concepts.md", () => {
  const wikiRoot = safeTempDir("p2-r2-cat-concepts-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [
        mem({
          type: "project",
          name: "SessionBootstrap",
          canonicalOwnerPath: "wiki/project/concepts/session-bootstrap.md",
        }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const c = fs.readFileSync(path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "concepts.md"), "utf-8")
    assert.match(c, /SessionBootstrap/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: chap 19 categorization — type=work OR path /episodes/ → episodes.md", () => {
  const wikiRoot = safeTempDir("p2-r2-cat-episodes-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [
        mem({ type: "work", name: "F027 Phase 1 Week 1", canonicalOwnerPath: "wiki/work/f027-w1.md" }),
        mem({
          type: "project",
          name: "B022 Episode",
          canonicalOwnerPath: "wiki/project/episodes/b022.md",
        }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const ep = fs.readFileSync(path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "episodes.md"), "utf-8")
    assert.match(ep, /F027 Phase 1 Week 1/) // type=work 路由
    assert.match(ep, /B022 Episode/) // path /episodes/ 路由
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: 顶层 wiki/index.md 含分类计数 + 最近热门 + 指向最新 v-XXX/", () => {
  const wikiRoot = safeTempDir("p2-r2-top-content-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [
        mem({ type: "project", name: "P1", canonicalOwnerPath: "wiki/project/rules/p1.md" }),
        mem({ type: "user", name: "User-A", canonicalOwnerPath: "wiki/user/a.md" }),
        mem({ type: "room", name: "R-001", canonicalOwnerPath: "wiki/room/r1.md" }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const top = fs.readFileSync(path.join(wikiRoot, "index.md"), "utf-8")
    // chap 19 8 类分类计数（含 People / Drafts / Raw — 即使为 0）
    assert.match(top, /\*\*Rules\*\*/)
    assert.match(top, /\*\*Concepts\*\*/)
    assert.match(top, /\*\*People\*\*/)
    assert.match(top, /\*\*Rooms\*\*/)
    assert.match(top, /\*\*Episodes\*\*/)
    // 指向版本目录
    assert.match(top, new RegExp(`v-${TEST_VERSION}/`))
    // 最近热门段
    assert.match(top, /## 最近热门/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: draft / deprecated memories 不进派生（chap 19 文件全空但仍存在）", () => {
  const wikiRoot = safeTempDir("p2-r2-state-filter-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [
        mem({ type: "project", name: "draft-row", state: "draft" }),
        mem({ type: "project", name: "dep-row", state: "deprecated" }),
        mem({
          type: "project",
          name: "canonical-row",
          state: "canonical",
          canonicalOwnerPath: "wiki/project/concepts/x.md",
        }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const concepts = fs.readFileSync(
      path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "concepts.md"),
      "utf-8",
    )
    assert.match(concepts, /canonical-row/)
    assert.doesNotMatch(concepts, /draft-row/)
    assert.doesNotMatch(concepts, /dep-row/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: aborted / pending events 不进 log.md（只 committed）", () => {
  const wikiRoot = safeTempDir("p2-r2-evt-state-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [
        evt({ alias: "committed-a", state: "committed" }),
        evt({ alias: "pending-a", state: "pending", contentHash: null }),
        evt({ alias: "aborted-a", state: "aborted", contentHash: null }),
      ],
      memories: [],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const log = fs.readFileSync(path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "log.md"), "utf-8")
    assert.match(log, /committed-a/)
    assert.doesNotMatch(log, /pending-a/)
    assert.doesNotMatch(log, /aborted-a/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: manifest sourceEventSeq = max(events.id) + files hash 与磁盘一致", () => {
  const wikiRoot = safeTempDir("p2-r2-manifest-hash-")
  try {
    const events = [evt({}), evt({}), evt({})]
    const result = compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events,
      memories: [mem({ type: "project", body: "hello" })],
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
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2]: 多次 compile 不同 version → v-XXX 共存 + 顶层 index 总指最新 + manifest 总指最新", () => {
  const wikiRoot = safeTempDir("p2-r2-versions-")
  try {
    compileWiki({
      wikiRoot,
      version: "2026051101",
      events: [],
      memories: [
        mem({
          type: "project",
          name: "v1-only",
          canonicalOwnerPath: "wiki/project/concepts/v1.md",
        }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    compileWiki({
      wikiRoot,
      version: "2026051102",
      events: [],
      memories: [
        mem({
          type: "project",
          name: "v2-only",
          canonicalOwnerPath: "wiki/project/concepts/v2.md",
        }),
      ],
      generatedAt: "2026-05-11T10:01:00Z",
    })

    // 两版本目录都在
    assert.ok(fs.existsSync(path.join(wikiRoot, "index", "v-2026051101", "concepts.md")))
    assert.ok(fs.existsSync(path.join(wikiRoot, "index", "v-2026051102", "concepts.md")))

    // manifest.json + 顶层 wiki/index.md 都指向最新
    const m = readManifest(path.join(wikiRoot, "index"))
    assert.equal(m?.version, "2026051102")

    const top = fs.readFileSync(path.join(wikiRoot, "index.md"), "utf-8")
    assert.match(top, /v-2026051102/)
    assert.doesNotMatch(top, /v-2026051101/)
  } finally {
    safeCleanup(wikiRoot)
  }
})

test("F027 P2 [范-r2 nit3]: sources.md 含 contentHash（每条 canonical 行的内容 hash，追溯用）", () => {
  const wikiRoot = safeTempDir("p2-r2-sources-hash-")
  try {
    compileWiki({
      wikiRoot,
      version: TEST_VERSION,
      events: [],
      memories: [
        mem({
          type: "project",
          name: "P-A",
          canonicalOwnerPath: "wiki/project/concepts/a.md",
          body: "specific content for hash",
          contributedBy: ["黄仁勋"],
        }),
      ],
      generatedAt: "2026-05-11T10:00:00Z",
    })
    const sources = fs.readFileSync(
      path.join(wikiRoot, "index", `v-${TEST_VERSION}`, "sources.md"),
      "utf-8",
    )
    assert.match(sources, /wiki\/project\/concepts\/a\.md/)
    assert.match(sources, /Body hash/i) // hash 字段必现
    assert.match(sources, /sha256:/) // 真有 hash 格式
  } finally {
    safeCleanup(wikiRoot)
  }
})
