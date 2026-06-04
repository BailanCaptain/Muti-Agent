/**
 * F027 B2/B1-c · 全局索引重编 orchestrator —— compileWiki 接 debounce 槽。
 *
 * wiring gap（2026-06-05 审计）：compileWiki（全局索引 wiki/index.md + index/v-XXX/*.md 唯一
 * 生产者，KB tab 读它）此前**零生产调用**——5s debounce 的 recompileDerivedViews 槽被 chunk A 的
 * reindexWiki（FTS 增量）占了，compileWiki 从没接进去（scheduler-bootstrap.ts:292 注释自承
 * "markdown 派生视图重编仍 follow-up 独立 F-id"）。本 orchestrator 把 compileWiki 真接进来。
 *
 * 链路：scanEntities()（注入；生产用 scanWikiEntitiesFs）→ buildWikiMemoriesFromEntities（按
 * canonical_owner_path marker 过滤 + 映射）→ compileWiki（写 index.md / index/v-XXX/*.md）。
 * events 可选注入（喂 log.md + sourceEventSeq）；缺则空（log.md 空，不影响索引主体）。
 *
 * **数据现状**：真 wiki 文件现 0 个带 canonical_owner_path（审计）→ 索引现编出来是空壳（诚实：
 * 还没 canonical 记忆）。B3 backfill 跑 LLM 编译填 frontmatter 后，本 orchestrator 编出非空索引。
 *
 * fail-soft：scan / compile 抛错被 catch + log，不让 debounce.fire() 崩（已有 reentrancy guard）。
 */

import type { WikiEvent } from "../db/repositories/wiki-events-types"
import { compileWiki } from "./wiki-compiler"
import type { ScannedWikiEntity } from "./wiki-memory-from-files"
import { buildWikiMemoriesFromEntities } from "./wiki-memory-from-files"

export interface WikiIndexRecompileDeps {
  /** markdown 文件根（`<X>/concepts/*.md` 中的 `<X>`；同 scanWikiEntitiesFs wikiRoot 约定）。 */
  wikiRoot: string
  /** 扫 wiki 文件实体（生产注入 scanWikiEntitiesFs(wikiRoot)）。 */
  scanEntities: () => Promise<ScannedWikiEntity[]>
  /** 可选：拉 wiki_events 喂 log.md + sourceEventSeq；缺则空数组。 */
  fetchEvents?: () => Promise<WikiEvent[]>
  /** 版本号生成（YYYYMMDDNN，chap 19）；缺则按 UTC 当前 YYYYMMDDHH 派生。 */
  version?: () => string
  logger?: { error(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void }
}

function defaultVersion(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`
}

/**
 * 返回一个 recompile fn，接进 WikiCompilerDebounce.recompileDerivedViews（与 reindexWiki 并存）。
 * 每次 wiki_events 写后 5s idle → 扫文件重编全局索引。
 */
export function createWikiIndexRecompiler(deps: WikiIndexRecompileDeps): () => Promise<void> {
  return async () => {
    try {
      const entities = await deps.scanEntities()
      const memories = buildWikiMemoriesFromEntities(entities)
      const events = deps.fetchEvents ? await deps.fetchEvents() : []
      const version = (deps.version ?? defaultVersion)()
      compileWiki({ wikiRoot: deps.wikiRoot, version, events, memories })
    } catch (err) {
      deps.logger?.error({ err }, "[wiki-index-recompile] compileWiki failed (caught — debounce 不崩)")
    }
  }
}
