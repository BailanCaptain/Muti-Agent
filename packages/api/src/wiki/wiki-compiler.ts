/**
 * F027 P2 · WikiCompiler — wiki entity → 派生视图（纯函数）。
 * 真相源：docs/plans/V16.5-final.md chap 5 + chap 19
 *
 * 范-r2 修复后版：
 *   - chap 19 派生结构：v-XXX/{index,rules,concepts,rooms-active,rooms-archive,episodes}.md
 *     + sources.md / log.md（chap 19 没明示，进版本目录保持一致）
 *   - 顶层 wiki/index.md（注入 prompt 入口）单独 atomic write，不进 manifest.files 载荷
 *   - manifest.files 只列 v-XXX/ 内文件（与 chap 19 reader 走 v-<version>/ 一致性约定对齐）
 *   - chap 19 categorization 用 path-prefix heuristic（rules/concepts/episodes）+ type 路由（room → rooms-active）
 *
 * 调用者（5s debounce 触发器 createWikiIndexRecompiler / NightlyJobScheduler / smoke script）负责：
 *   - 决定 version 号（YYYYMMDDNN，chap 19 格式）
 *   - 拉 wiki_events（compiler 不查 DB）+ 扫文件源建 WikiMemory[]（wiki-memory-from-files，
 *     B2/B1-c 接文件源；wiki_memories 表已砍）
 *   - 持有 leader_term（compiler 不知道 lease，P3.5 在调用方拦）
 *
 * chap 19 categorization mapping（path-prefix heuristic，best-effort）：
 *   - rules.md       = canonical_owner_path 含 "/rules/"
 *   - concepts.md    = canonical_owner_path 含 "/concepts/"
 *   - rooms-active.md = type='room'（30d 时间分流留 P3.5 NightlyJobScheduler）
 *   - rooms-archive.md = (placeholder，P3.5 接 active/archive 分流)
 *   - episodes.md    = type='work' OR canonical_owner_path 含 "/episodes/"
 *   - 未匹配的 canonical 进 v-XXX/index.md 的 "Other" 段
 *
 * LLM-driven 完整 categorization 留 P4.6（Phase 1 Week 4）。
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { WikiEvent } from "../db/repositories/wiki-events-types"
import { writeFileAtomic } from "./atomic-write"
import type { IndexManifest, IndexManifestFile } from "./index-manifest"
import { writeManifestAtomic } from "./index-manifest"
import type {
  CompileInput,
  CompileResult,
  WikiMemory,
  WikiMemoryType,
} from "./wiki-compiler-types"

const TOP_INDEX_FILENAME = "index.md"

/** chap 19 顶层 index.md "最近热门" 显示的 canonical memory 数量。 */
const RECENT_HOT_LIMIT = 5

/** chap 19 categorization key（与 v-XXX/ 文件名 1:1）。 */
type Chap19Cat =
  | "rules"
  | "concepts"
  | "rooms-active"
  | "rooms-archive"
  | "episodes"
  | "other"

const CHAP19_CATS: Chap19Cat[] = ["rules", "concepts", "rooms-active", "rooms-archive", "episodes"]

export function compileWiki(input: CompileInput): CompileResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const versionDir = path.join(input.wikiRoot, "index", `v-${input.version}`)
  fs.mkdirSync(versionDir, { recursive: true })
  fs.mkdirSync(input.wikiRoot, { recursive: true })

  const canonical = input.memories.filter((m) => m.state === "canonical")
  const grouped = groupByChap19(canonical)
  const canonicalByType = bucketByType(canonical)
  const committedEvents = input.events.filter((e) => e.state === "committed")

  const filesWritten: string[] = []
  const manifestFiles: IndexManifestFile[] = []

  // 1. v-XXX/index.md = 该版本全文索引（按 chap 19 8 类分组 + Other 段）
  const verIndex = renderVersionedIndex(grouped, canonical, generatedAt, input.version)
  writeAndTrack(input.wikiRoot, posixJoin("index", `v-${input.version}`, "index.md"), verIndex, filesWritten, manifestFiles)

  // 2. v-XXX/{cat}.md × 5 — chap 19 categorization
  for (const cat of CHAP19_CATS) {
    const rel = posixJoin("index", `v-${input.version}`, `${cat}.md`)
    const content = renderCategoryFile(cat, grouped[cat] ?? [], generatedAt, input.version)
    writeAndTrack(input.wikiRoot, rel, content, filesWritten, manifestFiles)
  }

  // 3. v-XXX/sources.md — provenance + body hash（范-r2 nit3）
  const sourcesContent = renderSources(canonical, generatedAt)
  writeAndTrack(input.wikiRoot, posixJoin("index", `v-${input.version}`, "sources.md"), sourcesContent, filesWritten, manifestFiles)

  // 4. v-XXX/log.md — committed wiki_events 审计
  const logContent = renderLog(committedEvents, generatedAt)
  writeAndTrack(input.wikiRoot, posixJoin("index", `v-${input.version}`, "log.md"), logContent, filesWritten, manifestFiles)

  // 5. manifest.json (atomic write via P21)
  const manifest: IndexManifest = {
    version: input.version,
    generatedAt,
    files: manifestFiles,
    sourceEventSeq: maxEventId(input.events),
  }
  writeManifestAtomic(path.join(input.wikiRoot, "index"), manifest)
  filesWritten.push(posixJoin("index", "manifest.json"))

  // 6. 顶层 wiki/index.md（注入 prompt 入口）— atomic write，不进 manifest.files 载荷
  // 范-r2 fix Q3：顶层非 atomic 是 correctness 问题，必须 atomic。
  const topIndex = renderTopIndex(canonicalByType, canonical, generatedAt, input.version)
  writeFileAtomic(path.join(input.wikiRoot, TOP_INDEX_FILENAME), topIndex)
  filesWritten.push(TOP_INDEX_FILENAME)

  return {
    version: input.version,
    manifest,
    filesWritten,
    stats: {
      canonicalByType: countByType(canonicalByType),
      totalEvents: input.events.length,
      committedEvents: committedEvents.length,
    },
  }
}

// ============================================================================
// chap 19 categorization mapping
// ============================================================================

function categorize(m: WikiMemory): Chap19Cat {
  const p = m.canonicalOwnerPath
  if (m.type === "room") return "rooms-active" // 30d 分流留 P3.5
  if (p.includes("/rules/")) return "rules"
  if (p.includes("/concepts/")) return "concepts"
  if (m.type === "work" || p.includes("/episodes/")) return "episodes"
  return "other"
}

function groupByChap19(canonical: WikiMemory[]): Record<Chap19Cat, WikiMemory[]> {
  const out: Record<Chap19Cat, WikiMemory[]> = {
    rules: [],
    concepts: [],
    "rooms-active": [],
    "rooms-archive": [],
    episodes: [],
    other: [],
  }
  for (const m of canonical) {
    const cat = categorize(m)
    out[cat].push(m)
  }
  return out
}

// ============================================================================
// 渲染层 —— 纯字符串生成，便于单测 snapshot
// ============================================================================

function renderCategoryFile(
  cat: Chap19Cat,
  memories: WikiMemory[],
  generatedAt: string,
  version: string,
): string {
  const lines: string[] = []
  lines.push(`# Wiki · ${cat} (${memories.length})`)
  lines.push("")
  lines.push(`> 派生 by WikiCompiler @ ${generatedAt} (manifest version: ${version})`)
  lines.push("")
  if (cat === "rooms-archive" && memories.length === 0) {
    lines.push("*（rooms-archive 是 30 天以上未活跃 placeholder — P3.5 NightlyJobScheduler 接 active/archive 分流）*")
    lines.push("")
    return lines.join("\n")
  }
  if (memories.length === 0) {
    lines.push("*（无匹配 canonical 行）*")
    lines.push("")
    return lines.join("\n")
  }
  const sorted = [...memories].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  for (const m of sorted) {
    lines.push(`## ${m.name}`)
    lines.push("")
    lines.push(`- **Path**: \`${m.canonicalOwnerPath}\``)
    lines.push(`- **Type**: ${m.type}`)
    if (m.contributedBy.length > 0) {
      lines.push(`- **Contributed by**: ${m.contributedBy.join(", ")}`)
    }
    if (m.ttlDays != null) {
      lines.push(`- **TTL**: ${m.ttlDays} days`)
    }
    if (m.supersedes && m.supersedes.length > 0) {
      lines.push(`- **Supersedes**: ${m.supersedes.join(", ")}`)
    }
    lines.push("")
    lines.push(excerpt(m.body))
    lines.push("")
  }
  return lines.join("\n")
}

function renderVersionedIndex(
  grouped: Record<Chap19Cat, WikiMemory[]>,
  allCanonical: WikiMemory[],
  generatedAt: string,
  version: string,
): string {
  const lines: string[] = []
  lines.push(`# Wiki Index v-${version}`)
  lines.push("")
  lines.push(`> 派生 by WikiCompiler @ ${generatedAt}`)
  lines.push("")
  lines.push("## chap 19 分类（按 canonical 行）")
  lines.push("")
  for (const cat of CHAP19_CATS) {
    lines.push(`- **${cat}**: ${grouped[cat].length} → \`${cat}.md\``)
  }
  if (grouped.other.length > 0) {
    lines.push(`- **other**: ${grouped.other.length}（未匹配 chap 19 categorization heuristic）`)
  }
  lines.push("")
  if (grouped.other.length > 0) {
    lines.push("## Other（未分类 canonical）")
    lines.push("")
    for (const m of grouped.other) {
      lines.push(`- [${m.name}](${m.canonicalOwnerPath}) — type=${m.type}`)
    }
    lines.push("")
  }
  lines.push("## 最近全部 canonical（按 updatedAt DESC）")
  lines.push("")
  const sorted = [...allCanonical].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  for (const m of sorted.slice(0, 20)) {
    lines.push(`- [${m.name}](${m.canonicalOwnerPath}) — type=${m.type}`)
  }
  lines.push("")
  return lines.join("\n")
}

function renderTopIndex(
  byType: Record<WikiMemoryType, WikiMemory[]>,
  allCanonical: WikiMemory[],
  generatedAt: string,
  version: string,
): string {
  const lines: string[] = []
  lines.push("# Wiki Index")
  lines.push("")
  lines.push(`> 自动生成 by WikiCompiler @ ${generatedAt}`)
  lines.push(`> 当前版本: v-${version} → \`wiki/index/v-${version}/\``)
  lines.push("")
  lines.push("## 分类（chap 19 ontology）")
  lines.push("")
  // chap 19 example index.md 格式：分类 + 数字 + 完整文件链接
  const ruleCount = countCanonical(allCanonical, (m) => m.canonicalOwnerPath.includes("/rules/"))
  const conceptCount = countCanonical(allCanonical, (m) =>
    m.canonicalOwnerPath.includes("/concepts/"),
  )
  const peopleCount = byType.user.length
  const roomCount = byType.room.length
  const episodeCount = byType.work.length + countCanonical(allCanonical, (m) => m.canonicalOwnerPath.includes("/episodes/"))
  const draftCount = allCanonical.length === 0 ? 0 : 0 // canonical 不含 draft；P2 不渲染 draft
  const rawCount = countCanonical(
    allCanonical,
    (m) =>
      m.canonicalOwnerPath.includes("/raw/") ||
      m.canonicalOwnerPath.includes("/user-drops/") ||
      m.canonicalOwnerPath.includes("/conversations/") ||
      m.canonicalOwnerPath.includes("/work-products/"),
  )

  lines.push(`- **Rules**: ${ruleCount} → \`wiki/index/v-${version}/rules.md\``)
  lines.push(`- **Concepts**: ${conceptCount} → \`wiki/index/v-${version}/concepts.md\``)
  lines.push(`- **People**: ${peopleCount} (type=user canonical)`)
  lines.push(`- **Rooms**: ${roomCount}`)
  lines.push(`  - 完整活跃 → \`wiki/index/v-${version}/rooms-active.md\``)
  lines.push(`  - 历史归档 → \`wiki/index/v-${version}/rooms-archive.md\` (P3.5 lease 落地后接)`)
  lines.push(`- **Episodes**: ${episodeCount} → \`wiki/index/v-${version}/episodes.md\``)
  lines.push(`- **Raw**: ${rawCount} (P3 ingest 接入后填充)`)
  lines.push(`- **Drafts**: ${draftCount} (P2 不渲染 draft；P3 ingest 后接入)`)
  lines.push("")
  lines.push("## 最近热门")
  lines.push("")
  const recent = [...allCanonical]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, RECENT_HOT_LIMIT)
  if (recent.length === 0) {
    lines.push("*（无 canonical 行）*")
  } else {
    for (const m of recent) {
      lines.push(`- [${m.name}](${m.canonicalOwnerPath}) — ${m.type}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

function renderSources(canonical: WikiMemory[], generatedAt: string): string {
  const lines: string[] = []
  lines.push("# Wiki Sources")
  lines.push("")
  lines.push(`> 派生 by WikiCompiler @ ${generatedAt}`)
  lines.push("")
  if (canonical.length === 0) {
    lines.push("*（无 canonical 行）*")
    lines.push("")
    return lines.join("\n")
  }
  const sorted = [...canonical].sort((a, b) => a.canonicalOwnerPath.localeCompare(b.canonicalOwnerPath))
  for (const m of sorted) {
    lines.push(`## \`${m.canonicalOwnerPath}\``)
    lines.push("")
    lines.push(`- **Type**: ${m.type}`)
    lines.push(`- **Name**: ${m.name}`)
    lines.push(`- **Body hash**: \`sha256:${sha256Hex(m.body).slice(0, 16)}…\``) // 范-r2 nit3
    lines.push(`- **Body bytes**: ${Buffer.byteLength(m.body, "utf-8")}`)
    lines.push(`- **Contributed by**: ${m.contributedBy.length > 0 ? m.contributedBy.join(", ") : "(none)"}`)
    if (m.sourceMessageIds && m.sourceMessageIds.length > 0) {
      lines.push(`- **Source messages**: ${m.sourceMessageIds.join(", ")}`)
    }
    if (m.supersedes && m.supersedes.length > 0) {
      lines.push(`- **Supersedes**: ${m.supersedes.join(", ")}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

function renderLog(events: WikiEvent[], generatedAt: string): string {
  const lines: string[] = []
  lines.push("# Wiki Log")
  lines.push("")
  lines.push(`> 派生 by WikiCompiler @ ${generatedAt}`)
  lines.push("")
  if (events.length === 0) {
    lines.push("*（无 committed 事件）*")
    lines.push("")
    return lines.join("\n")
  }
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? 1 : -1))
  lines.push("| ts | alias | action | path | content_hash |")
  lines.push("|---|---|---|---|---|")
  for (const e of sorted) {
    const hash = e.contentHash ?? "(null)"
    lines.push(`| ${e.ts} | ${e.alias} | ${e.action} | \`${e.path}\` | \`${hash}\` |`)
  }
  lines.push("")
  return lines.join("\n")
}

// ============================================================================
// helpers
// ============================================================================

function bucketByType(memories: WikiMemory[]): Record<WikiMemoryType, WikiMemory[]> {
  const out: Record<WikiMemoryType, WikiMemory[]> = {
    room: [],
    project: [],
    user: [],
    feedback: [],
    work: [],
  }
  for (const m of memories) out[m.type].push(m)
  return out
}

function countByType(byType: Record<WikiMemoryType, WikiMemory[]>): Record<WikiMemoryType, number> {
  return {
    room: byType.room.length,
    project: byType.project.length,
    user: byType.user.length,
    feedback: byType.feedback.length,
    work: byType.work.length,
  }
}

function maxEventId(events: WikiEvent[]): number {
  let max = 0
  for (const e of events) if (e.id > max) max = e.id
  return max
}

function excerpt(body: string, maxLen = 200): string {
  const trimmed = body.trim()
  if (trimmed.length <= maxLen) return trimmed
  return `${trimmed.slice(0, maxLen)}…`
}

function countCanonical(memories: WikiMemory[], pred: (m: WikiMemory) => boolean): number {
  let n = 0
  for (const m of memories) if (pred(m)) n++
  return n
}

function writeAndTrack(
  wikiRoot: string,
  relPath: string,
  content: string,
  filesWritten: string[],
  manifestFiles: IndexManifestFile[],
): void {
  const abs = path.join(wikiRoot, relPath)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
  filesWritten.push(relPath)
  manifestFiles.push({
    path: relPath,
    hash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf-8"),
  })
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

function posixJoin(...parts: string[]): string {
  return parts.join("/")
}
