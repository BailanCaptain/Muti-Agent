#!/usr/bin/env tsx
/**
 * F027 #285 S2 · migrate-session-memories —— 存量 session_memories 一次性导出 wiki。
 *
 * 真相源：.runtime/reviews/F285-deep-migration-plan.md（深迁移 plan S2）
 *
 * 干什么：每个 session group 取**最新**一条滚动摘要，写
 * `<wikiRoot>/rooms/<roomId>/session-summary.md`（S1 SessionSummaryWikiWriter 同路径同格式
 * —— 跑过之后日常新摘要双写覆盖同一文件，无双轨）。
 *
 * **Iron Law：只读导出，session_memories 表一行不动**；物理 DROP 永远小孙手动。
 *
 * 跑法（合 dev 后主库一次性运维步，与 ingest-module 同 env fail-fast 口径）：
 *   SQLITE_PATH=<主库sqlite> WIKI_ROOT=<主库wiki根·单层> \
 *     pnpm tsx packages/api/scripts/migrate-session-memories.ts
 *   （wikiRoot 实际写入用 `<WIKI_ROOT>/wiki`，与 server.ts roomCompileWikiRoot 同口径。）
 */

import path from "node:path"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../src/db/schema"
import { getSqliteClient } from "../src/routes/phase3/sqlite-helper"
import { createSessionSummaryWikiWriter } from "../src/wiki/session-summary-writer"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface MigrateSessionMemoriesResult {
  /** 有摘要的 group 数（= 应导出条数）。 */
  groups: number
  /** 实际写盘条数（writer fail-soft 失败的不计）。 */
  written: number
}

interface LatestMemoryRow {
  session_group_id: string
  summary: string
  keywords: string
  created_at: string
  room_id: string | null
}

/** 可测核心：每 group 最新一条摘要 → S1 writer 落 wiki。表只读。 */
export function migrateSessionMemories(opts: {
  db: DrizzleDb
  wikiRoot: string
  warn?: (msg: string) => void
}): MigrateSessionMemoriesResult {
  const client = getSqliteClient(opts.db)
  // 每 group 最新一条（rowid 兜底打平同 created_at 并列）+ LEFT JOIN 拿 canonical roomId
  const rows = client
    .prepare(
      `SELECT m.session_group_id, m.summary, m.keywords, m.created_at, sg.room_id
       FROM session_memories m
       JOIN (
         SELECT session_group_id, MAX(created_at) AS max_created
         FROM session_memories GROUP BY session_group_id
       ) latest
         ON m.session_group_id = latest.session_group_id
        AND m.created_at = latest.max_created
       LEFT JOIN session_groups sg ON sg.id = m.session_group_id
       GROUP BY m.session_group_id`,
    )
    .all() as LatestMemoryRow[]

  const roomIdByGroup = new Map(rows.map((r) => [r.session_group_id, r.room_id]))
  let written = 0
  const writer = createSessionSummaryWikiWriter({
    wikiRoot: opts.wikiRoot,
    resolveRoomId: (g) => roomIdByGroup.get(g) ?? null,
    warn: (msg) => {
      written-- // writer fail-soft 不抛 → 用 warn 回调把失败条从计数里扣掉
      opts.warn?.(msg)
    },
  })
  for (const row of rows) {
    written++
    writer.write({
      sessionGroupId: row.session_group_id,
      summary: row.summary,
      keywords: row.keywords,
      createdAt: row.created_at,
    })
  }
  return { groups: rows.length, written }
}

async function main() {
  // env fail-fast（德彪 ingest-module P2 同口径：少配 env 静默写错根 = B2 双根事故重演）
  const sqlitePath = process.env.SQLITE_PATH
  const wikiRootEnv = process.env.WIKI_ROOT
  if (!sqlitePath || !wikiRootEnv) {
    throw new Error(
      "migrate-session-memories 需显式 env：SQLITE_PATH（主库 sqlite）+ WIKI_ROOT（主库 wiki 根·单层）；缺一即抛。",
    )
  }
  const { createDrizzleDb } = await import("../src/db/drizzle-instance")
  const { db, close } = createDrizzleDb(sqlitePath)
  try {
    const result = migrateSessionMemories({
      db,
      // 双层根：写入根 = <WIKI_ROOT>/wiki（server.ts roomCompileWikiRoot 同口径 = 索引器扫描树）
      wikiRoot: path.join(wikiRootEnv, "wiki"),
      warn: (msg) => console.error(`[migrate-session-memories] ${msg}`),
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    close()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
