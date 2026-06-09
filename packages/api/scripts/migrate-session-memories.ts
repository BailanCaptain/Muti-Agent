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

import { existsSync as fsExistsSync, statSync as fsStatSync } from "node:fs"
import path from "node:path"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../src/db/schema"
import { getSqliteClient } from "../src/routes/phase3/sqlite-helper"
import { createSessionSummaryWikiWriter } from "../src/wiki/session-summary-writer"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface MigrateSessionMemoriesResult {
  /** 有摘要的 group 数（= 应导出条数）。 */
  groups: number
  /** 实际写盘成功条数。 */
  written: number
  /** receive 德彪 r1 P1-2：写失败条数（CLI 据此非零退出，不再静默假成功）。 */
  failed: number
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
  // 每 group 最新一条 —— receive 德彪 r1 P2-4：相关子查询按 created_at DESC, rowid DESC
  // 显式定序（同 created_at 并列取后插入那条），不靠 GROUP BY 任取的非确定行为。
  const rows = client
    .prepare(
      `SELECT m.session_group_id, m.summary, m.keywords, m.created_at, sg.room_id
       FROM session_memories m
       LEFT JOIN session_groups sg ON sg.id = m.session_group_id
       WHERE m.rowid = (
         SELECT m2.rowid FROM session_memories m2
         WHERE m2.session_group_id = m.session_group_id
         ORDER BY m2.created_at DESC, m2.rowid DESC
         LIMIT 1
       )`,
    )
    .all() as LatestMemoryRow[]

  const roomIdByGroup = new Map(rows.map((r) => [r.session_group_id, r.room_id]))
  // receive 德彪 r1 P1-2：失败显式计数（writer fail-soft 不抛，每次失败恰好 warn 一次）。
  let failed = 0
  const writer = createSessionSummaryWikiWriter({
    wikiRoot: opts.wikiRoot,
    resolveRoomId: (g) => roomIdByGroup.get(g) ?? null,
    warn: (msg) => {
      failed++
      opts.warn?.(msg)
    },
  })
  for (const row of rows) {
    writer.write({
      sessionGroupId: row.session_group_id,
      summary: row.summary,
      keywords: row.keywords,
      createdAt: row.created_at,
    })
  }
  return { groups: rows.length, written: rows.length - failed, failed }
}

/**
 * receive 德彪 r1 P1-2：路径前置校验 —— createDrizzleDb 对不存在的路径会**新建空库**，
 * 错误 SQLITE_PATH 会静默导出 0 条且 exit 0 假成功；错误 WIKI_ROOT 会建平行目录。
 * 两者都必须真实存在才放行。
 */
export function validateMigratePaths(sqlitePath: string, wikiRootEnv: string): void {
  if (!fsExistsSync(sqlitePath)) {
    throw new Error(`SQLITE_PATH 不存在：${sqlitePath}（createDrizzleDb 会静默新建空库 → 假成功）`)
  }
  if (!fsExistsSync(wikiRootEnv)) {
    throw new Error(`WIKI_ROOT 不存在：${wikiRootEnv}（会创建平行目录写错根）`)
  }
  // r2 德彪 P1：existsSync 会放行任意已有目录（typo 根照样建 <错根>/wiki/... exit 0 假成功）。
  // sentinel = <WIKI_ROOT>/wiki 必须已是目录（真主库根必有：roomCompile/indexer 双层结构）。
  const wikiSentinel = path.join(wikiRootEnv, "wiki")
  if (!fsExistsSync(wikiSentinel) || !fsStatSync(wikiSentinel).isDirectory()) {
    throw new Error(
      `WIKI_ROOT 下缺 wiki/ 子目录：${wikiSentinel} —— 不是真 wiki 根（真主库根必有双层结构），拒绝写入避免平行树`,
    )
  }
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
  // receive 德彪 r1 P1-2：路径必须真实存在（createDrizzleDb 会静默建空库假成功）
  validateMigratePaths(sqlitePath, wikiRootEnv)
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
    // receive 德彪 r1 P1-2 + r2 P2：有失败 → exitCode=1（不用 process.exit —— 让 finally
    // close() 正常走完、stdout/stderr flush 不被截断）
    if (result.failed > 0) {
      console.error(`[migrate-session-memories] ${result.failed}/${result.groups} 条导出失败`)
      process.exitCode = 1
    }
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
