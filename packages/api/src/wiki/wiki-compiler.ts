/**
 * F027 P2 · WikiCompiler — wiki entity → 派生视图（纯函数）。
 * 真相源：docs/plans/V16.5-final.md chap 5 + chap 19
 *
 * 一次 compile() = 一次 tick：
 *   1. 按 type 分桶 memories（state='canonical'）
 *   2. 渲染 5 份 type 文件 → wiki/index/v-<version>/{type}.md
 *   3. 渲染 wiki/index.md（顶层摘要：分类计数 + 最近 5 hot）
 *   4. 渲染 wiki/sources.md（provenance：canonical → contributedBy / source_message_ids）
 *   5. 渲染 wiki/log.md（committed wiki_events 审计）
 *   6. 计算 manifest（含 file path/hash/sizeBytes + sourceEventSeq）
 *   7. atomic write manifest.json（P21）
 *
 * 调用者（5s debounce 触发器 / NightlyJobScheduler / smoke script）负责：
 *   - 决定 version 号（YYYYMMDDNN）
 *   - 拉 wiki_events / wiki_memories（compiler 不查 DB）
 *   - 持有 leader_term（compiler 不知道 lease，P3.5 在调用方拦）
 *
 * 写顺序约定：先写 type 子文件 → 再写顶层 index/sources/log → 最后 manifest.json。
 * manifest 在最后写保证 reader 看到 manifest.json 时所有 referenced files 都已落盘。
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type {
  WikiMemory,
  WikiMemoryType,
} from "../db/repositories/wiki-memories-types"
import { WIKI_MEMORY_TYPES } from "../db/repositories/wiki-memories-types"
import type { WikiEvent } from "../db/repositories/wiki-events-types"
import type { IndexManifest, IndexManifestFile } from "./index-manifest"
import { writeManifestAtomic } from "./index-manifest"
import type { CompileInput, CompileResult } from "./wiki-compiler-types"

const TOP_INDEX_FILENAME = "index.md"
const SOURCES_FILENAME = "sources.md"
const LOG_FILENAME = "log.md"

/** 顶层 index.md "最近热门" 显示的 canonical memory 数量。 */
const RECENT_HOT_LIMIT = 5

export function compileWiki(input: CompileInput): CompileResult {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const versionDir = path.join(input.wikiRoot, "index", `v-${input.version}`)
  fs.mkdirSync(versionDir, { recursive: true })
  fs.mkdirSync(input.wikiRoot, { recursive: true })

  const canonical = input.memories.filter((m) => m.state === "canonical")
  const canonicalByType = bucketByType(canonical)
  const committedEvents = input.events.filter((e) => e.state === "committed")

  const filesWritten: string[] = []
  const manifestFiles: IndexManifestFile[] = []

  // 1. 各 type canonical memory 列表（5 份）
  for (const type of WIKI_MEMORY_TYPES) {
    const rel = path.posix.join("index", `v-${input.version}`, `${type}.md`)
    const content = renderTypeFile(type, canonicalByType[type], generatedAt, input.version)
    writeAndTrack(input.wikiRoot, rel, content, filesWritten, manifestFiles)
  }

  // 2. 顶层 wiki/index.md（一级摘要）
  const indexContent = renderTopIndex(canonicalByType, canonical, generatedAt, input.version)
  writeAndTrack(input.wikiRoot, TOP_INDEX_FILENAME, indexContent, filesWritten, manifestFiles)

  // 3. wiki/sources.md（provenance）
  const sourcesContent = renderSources(canonical, generatedAt)
  writeAndTrack(input.wikiRoot, SOURCES_FILENAME, sourcesContent, filesWritten, manifestFiles)

  // 4. wiki/log.md（wiki_events 审计）
  const logContent = renderLog(committedEvents, generatedAt)
  writeAndTrack(input.wikiRoot, LOG_FILENAME, logContent, filesWritten, manifestFiles)

  // 5. manifest.json (atomic write via P21)
  const manifest: IndexManifest = {
    version: input.version,
    generatedAt,
    files: manifestFiles,
    sourceEventSeq: maxEventId(input.events),
  }
  writeManifestAtomic(path.join(input.wikiRoot, "index"), manifest)
  filesWritten.push(path.posix.join("index", "manifest.json"))

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
// 渲染层 —— 纯字符串生成，便于单测 snapshot
// ============================================================================

function renderTypeFile(
  type: WikiMemoryType,
  memories: WikiMemory[],
  generatedAt: string,
  version: string,
): string {
  const lines: string[] = []
  lines.push(`# Wiki · ${type} (${memories.length})`)
  lines.push("")
  lines.push(`> 派生 by WikiCompiler @ ${generatedAt} (manifest version: ${version})`)
  lines.push("")
  if (memories.length === 0) {
    lines.push("*（无 canonical 行）*")
    lines.push("")
    return lines.join("\n")
  }
  // 按 updatedAt DESC
  const sorted = [...memories].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  for (const m of sorted) {
    lines.push(`## ${m.name}`)
    lines.push("")
    lines.push(`- **Path**: \`${m.canonicalOwnerPath}\``)
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

function renderTopIndex(
  byType: Record<WikiMemoryType, WikiMemory[]>,
  allCanonical: WikiMemory[],
  generatedAt: string,
  version: string,
): string {
  const lines: string[] = []
  lines.push("# Wiki Index")
  lines.push("")
  lines.push(`> 派生 by WikiCompiler @ ${generatedAt} (manifest version: ${version})`)
  lines.push("")
  lines.push("## 分类")
  lines.push("")
  for (const type of WIKI_MEMORY_TYPES) {
    const count = byType[type].length
    lines.push(`- **${type}**: ${count} → \`wiki/index/v-${version}/${type}.md\``)
  }
  lines.push("")
  lines.push("## 最近热门")
  lines.push("")
  const recent = [...allCanonical].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, RECENT_HOT_LIMIT)
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
