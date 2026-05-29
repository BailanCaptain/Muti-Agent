/**
 * F027 v3 G11 · preview 路径用 no-op WikiEventsWriter
 *
 * 真相源：types.ts:238 WikiEventsWriter interface + post-compile.ts:120
 *   postCompile 调 wikiEvents.append 留"编译完成"审计 row。
 *
 * 为什么 preview 用 no-op：
 *   - preview 是 read-only 预览（10min TTL，可能永不 commit）。给每次 preview 都落
 *     wiki_events 审计 row 会污染 event log（大量 un-committed 编译）。
 *   - 真正的审计 row 在 commit 时由 updateWiki 的 PREPARE/COMMIT wiki_events 落
 *     （action="write"，ingest-commit.ts 链路）—— 那才是权威落盘审计。
 *   - 故 preview 的 postCompile 用 no-op writer：返回占位 eventId，不写 DB。
 *
 * MVP 取舍（记入 v3 review follow-up）：
 *   渲染进 compiled markdown frontmatter 的 ingest_metadata.ingest_event_id 会是占位 ""，
 *   commit 落盘后该字段不回填真 eventId（权威审计是 updateWiki write row）。
 *   若需 frontmatter 内嵌真 ingest_event_id，后续可在 commit 路径 split postCompile 重跑。
 */

import type { WikiEventsWriter } from "./types"

/**
 * 返回一个不落 DB 的 WikiEventsWriter，append 直接返回占位 eventId（默认 ""）。
 * @param placeholderEventId postCompile 回填到 frontmatter 的占位值（默认 ""）
 */
export function createPreviewWikiEventsWriter(placeholderEventId = ""): WikiEventsWriter {
  return {
    async append() {
      return { eventId: placeholderEventId }
    },
  }
}
