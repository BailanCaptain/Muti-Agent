/**
 * F027 #285 S1 · SessionSummaryWikiWriter —— 会话滚动摘要双写 wiki 文件。
 *
 * 背景（深迁移 plan .runtime/reviews/F285-deep-migration-plan.md）：session_memories 表是
 * 旧 3 记忆工具（get_room_summary / search_room_memories / get_memory）唯一后端，4 件套
 * （read_wiki / search_wiki / query_messages / update_wiki）覆盖不到 → 工具后端退不掉。
 * 本 writer 把每次滚动摘要落 `<wikiRoot>/rooms/<roomId>/session-summary.md`：
 *   - RoomCompiler 派生视图同款 writeFileAtomic 直写（room-compiler.ts:279 先例）；
 *   - reindexWikiEntities 扫 `<X>/wiki/` 全 bucket 递归 → 文件自动进 search_wiki FTS；
 *   - read_wiki 直接可读 → 旧 3 工具职能被 4 件套接管，后端可真退役（#285 S3）；
 *   - **不带 canonical_owner_path marker** → isCompiledMemoryEntity 排除 → 不进全局
 *     canonical 索引（滚动摘要 ≠ canonical 知识，小孙 2026-06-06 原始顾虑）。
 *
 * 双写契约：表仍是 source of truth（自动注入 getOrCreateSummary 照读表）；本 writer 是
 * 附加覆盖面，**任何失败 warn 不抛**——摘要主链路（写表 + prompt 注入）不受影响。
 *
 * roomId 安全：白名单清洗 [A-Za-z0-9_-]（防 `../` path 注入——warnings containment
 * 6 轮 review 教训，list/read 同树纪律）；resolver 缺/抛/清洗后为空 → sessionGroupId 兜底。
 */

import path from "node:path"
import { writeFileAtomic } from "./atomic-write"

export interface SessionSummaryWriteInput {
  sessionGroupId: string
  summary: string
  keywords: string
  createdAt: string
}

export interface SessionSummaryWikiWriter {
  write(input: SessionSummaryWriteInput): void
}

export interface CreateSessionSummaryWriterOptions {
  /** wiki 文件根（= server.ts roomCompile 同根；写入根必须 = 索引器扫描根，B2 双根教训）。 */
  wikiRoot: string
  /** sessionGroupId → canonical roomId（R-###）；null/抛错 → sessionGroupId 兜底。 */
  resolveRoomId: (sessionGroupId: string) => string | null
  /** fail-soft 观测（缺省静默）。 */
  warn?: (msg: string) => void
  /**
   * receive 德彪 r1 P1-1：落盘成功后通知（server.ts 接 fireWikiCommit → 5s debounce →
   * reindexWiki，与 updateWiki commit 同链）。直写不产 wiki_events → 不通知则
   * wiki_entity_index 滞后到下次 boot/别的 commit，search_wiki 读不到新摘要。
   * 仅写成功才调；回调自身抛错 fail-soft warn（通知失败不毁摘要主链路）。
   */
  onWritten?: () => void
}

/** 目录名白名单清洗：只留 [A-Za-z0-9_-]，防 path 注入；清洗后空 → null。 */
function sanitizeDirName(raw: string): string | null {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "")
  return cleaned.length > 0 ? cleaned : null
}

export function createSessionSummaryWikiWriter(
  opts: CreateSessionSummaryWriterOptions,
): SessionSummaryWikiWriter {
  return {
    write(input: SessionSummaryWriteInput): void {
      try {
        let roomIdRaw: string | null = null
        try {
          roomIdRaw = opts.resolveRoomId(input.sessionGroupId)
        } catch {
          roomIdRaw = null // resolver 挂掉 → sessionGroupId 兜底，不让摘要链路炸
        }
        const dirName =
          sanitizeDirName(roomIdRaw ?? "") ?? sanitizeDirName(input.sessionGroupId) ?? "unknown-room"
        const target = path.join(opts.wikiRoot, "rooms", dirName, "session-summary.md")
        const content = [
          "---",
          "generated_by: memory-service",
          `session_group_id: ${input.sessionGroupId}`,
          `keywords: ${input.keywords}`,
          `updated_at: ${input.createdAt}`,
          "---",
          "",
          input.summary,
          "",
        ].join("\n")
        writeFileAtomic(target, content)
        // P1-1 · 写成功 → 通知 reindex debounce（回调抛错单独 fail-soft，不混入写失败语义）
        try {
          opts.onWritten?.()
        } catch (err) {
          opts.warn?.(
            `session-summary-writer: onWritten 通知失败（reindex 可能滞后到下次 boot/commit）: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      } catch (err) {
        opts.warn?.(
          `session-summary-writer: 写 wiki 摘要失败（fail-soft，表写入不受影响）group=${input.sessionGroupId}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  }
}
