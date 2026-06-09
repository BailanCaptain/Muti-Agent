/**
 * F027 B2/B1-c · 文件实体 → WikiMemory 适配器（compileWiki 迁文件源）。
 *
 * 背景（wiring gap 审计 2026-06-05）：compileWiki（全局索引 wiki/index.md + index/v-XXX/*.md
 * 唯一生产者）输入 `CompileInput.memories: WikiMemory[]` 原来自被 chunk B 砍的 wiki_memories
 * 表 → 永空。本模块把扫描到的 wiki 文件（WikiEntity{path,frontmatter,body}）映射成 WikiMemory，
 * 让 compileWiki 改吃文件源（V16.5 chap 14「记忆=文件单一真相源」）。
 *
 * **过滤契约（关键）**：scanWikiEntitiesFs 扫全部 wiki/*.md（含 rooms/viewfinder.md、log.md、
 * index/ 派生视图、warnings 等非记忆文件）。只有**编译过的 canonical 记忆实体**才进全局索引，
 * 其标志 = frontmatter 有 `canonical_owner_path`（compile pipeline / ingest post-compile 写）。
 * 无此 marker 的文件（派生视图 / 日志 / 未编译草稿）一律排除。
 *   → 实测现 0 真文件带 canonical_owner_path（审计），故索引现为空（诚实：还没 canonical 记忆）；
 *     B3 backfill 跑 LLM 编译填 frontmatter 后索引才非空。
 *
 * heuristic（实体已含 canonical_owner_path 但缺其他字段时）：
 *   - state: 显式优先；缺/非法 → path 含 /draft/ 则 draft，否则 canonical
 *   - type:  显式优先；缺 → path 推断（/rooms/→room, /agents|/people/→user, /lessons/→feedback,
 *            /episodes|/work/→work, 其余 project）
 *   - name:  frontmatter.name ?? basename(path)
 */

import path from "node:path"
import type { WikiMemory, WikiMemoryState, WikiMemoryType } from "./wiki-compiler-types"

/** 结构化输入（匹配 scanWikiEntitiesFs 的 WikiEntity；结构化避免 wiki→scheduler 耦合）。 */
export interface ScannedWikiEntity {
  path: string
  frontmatter: Record<string, unknown>
  body: string
}

const VALID_TYPES: ReadonlySet<string> = new Set(["room", "project", "user", "feedback", "work"])
const VALID_STATES: ReadonlySet<string> = new Set(["draft", "canonical", "deprecated"])

function asStringArray(v: unknown): string[] | null {
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[]
  return null
}

function inferType(fm: Record<string, unknown>, entityPath: string): WikiMemoryType {
  if (typeof fm.type === "string" && VALID_TYPES.has(fm.type)) return fm.type as WikiMemoryType
  const p = entityPath
  if (p.includes("/rooms/")) return "room"
  if (p.includes("/agents/") || p.includes("/people/")) return "user"
  if (p.includes("/lessons/")) return "feedback"
  if (p.includes("/episodes/") || p.includes("/work/")) return "work"
  return "project"
}

function inferState(fm: Record<string, unknown>, entityPath: string): WikiMemoryState {
  if (typeof fm.state === "string" && VALID_STATES.has(fm.state)) return fm.state as WikiMemoryState
  // 缺/非法 state：draft 子目录默认 draft，canonical 树默认 canonical（B3 backfill 后显式化）。
  return entityPath.includes("/draft/") ? "draft" : "canonical"
}

function deriveName(fm: Record<string, unknown>, entityPath: string): string {
  if (typeof fm.name === "string" && fm.name.trim().length > 0) return fm.name
  return path.posix.basename(entityPath.replace(/\\/g, "/"), ".md")
}

/**
 * 是否「编译过的 canonical 记忆实体」（进全局索引的资格）= frontmatter 有 canonical_owner_path。
 * 排除派生视图（viewfinder/log/decisions）、index/、warnings、未编译文件。
 */
export function isCompiledMemoryEntity(entity: ScannedWikiEntity): boolean {
  const v = entity.frontmatter.canonical_owner_path
  return typeof v === "string" && v.trim().length > 0
}

/** 文件实体 → WikiMemory（compileWiki 输入）。缺字段走 heuristic。纯函数。 */
export function wikiEntityToWikiMemory(entity: ScannedWikiEntity, id: number): WikiMemory {
  const fm = entity.frontmatter
  const createdAt = typeof fm.created_at === "string" ? fm.created_at : ""
  const updatedAt = typeof fm.updated_at === "string" ? fm.updated_at : createdAt
  return {
    id,
    type: inferType(fm, entity.path),
    name: deriveName(fm, entity.path),
    canonicalOwnerPath:
      typeof fm.canonical_owner_path === "string" ? fm.canonical_owner_path : entity.path,
    promotionTarget: null,
    ttlDays: typeof fm.ttl_days === "number" ? fm.ttl_days : null,
    supersedes: asStringArray(fm.supersedes),
    replacesInBuckets: null,
    sourceMessageIds: asStringArray(fm.sources),
    contributedBy: asStringArray(fm.contributed_by) ?? [],
    crossRefs: null,
    dedupDecision: null,
    body: entity.body,
    state: inferState(fm, entity.path),
    createdAt,
    updatedAt,
  }
}

/** B2-P3-2 · heuristic 触发观测回调（缺省 = 静默，向后兼容）。 */
export interface BuildWikiMemoriesOptions {
  /** marker 实体缺显式合法 type/state（heuristic 兜底）时调一次（含 path + 推断值）。 */
  warn?: (msg: string) => void
}

/**
 * WikiEntity[] → WikiMemory[]：先按 isCompiledMemoryEntity 过滤（排派生视图/未编译），再映射，
 * id 按序（1-based）。
 *
 * B2-P3-2（德彪 B2 review defer 项）：带 marker 但缺/非法 type/state 的实体不 skip
 * （skip = 静默藏内容，比不完整元数据更糟），heuristic 兜底照旧，但通过 opts.warn 暴露
 * —— 运营从日志能看到哪些实体以推断元数据进了 canonical 索引（B3 backfill 写规范化
 * frontmatter 后该 warn 应归零）。
 */
export function buildWikiMemoriesFromEntities(
  entities: ScannedWikiEntity[],
  opts?: BuildWikiMemoriesOptions,
): WikiMemory[] {
  return entities.filter(isCompiledMemoryEntity).map((e, i) => {
    const memory = wikiEntityToWikiMemory(e, i + 1)
    if (opts?.warn) {
      const fm = e.frontmatter
      const typeExplicit = typeof fm.type === "string" && VALID_TYPES.has(fm.type)
      const stateExplicit = typeof fm.state === "string" && VALID_STATES.has(fm.state)
      if (!typeExplicit || !stateExplicit) {
        opts.warn(
          `wiki-memory-from-files: ${e.path} 缺显式合法 type/state（heuristic 兜底 type=${memory.type} state=${memory.state}）— 实体 frontmatter 应显式化`,
        )
      }
    }
    return memory
  })
}
