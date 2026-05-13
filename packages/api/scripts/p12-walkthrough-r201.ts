import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
/**
 * F027 P12 R-201 真数据 walkthrough
 *
 * 跑真 Sonnet 4.6 在主仓 R-201 真实最近 N 条 messages 上端到端编译 viewfinder。
 * 主仓 sqlite read-only，所有写入到临时 sqlite。
 *
 * 跑：(cd packages/api && pnpm exec node --import tsx scripts/p12-walkthrough-r201.ts)
 */
import Database from "better-sqlite3"
import { createDrizzleDb } from "../src/db/drizzle-instance"
import { createSonnetRunner } from "../src/runtime/haiku-runner"
import { createViewfinderCompileFn } from "../src/wiki/viewfinder/compile-fn"
import { HaikuDecisionJudge } from "../src/wiki/viewfinder/decision-extractor"
import { DecisionLedger } from "../src/wiki/viewfinder/decision-ledger"

const MAIN_DB = "C:/Users/-/Desktop/Multi-Agent/data/multi-agent.sqlite"
const ROOM_ID = "R-201"
const MESSAGES_LIMIT = 50
const SONNET_TIMEOUT_MS = 60000
const CONCURRENCY = 3

async function main() {
  // ─── 1. 准备临时 sqlite + drizzle init schema ────────────────────────

  const tmpDir = mkdtempSync(path.join(tmpdir(), "p12-walk-"))
  const tmpDbPath = path.join(tmpDir, "walkthrough.sqlite")
  console.log(`[1/5] 临时 sqlite: ${tmpDbPath}`)
  const { raw: db, close: closeDb } = createDrizzleDb(tmpDbPath)

  // ─── 2. 从主仓 read-only 拉 R-201 数据 → 写临时 db ──────────────────

  console.log("[2/5] 从主仓拉 R-201 数据...")
  const main = new Database(MAIN_DB, { readonly: true })

  const sg = main
    .prepare(
      "SELECT id, title, created_at, updated_at, room_id FROM session_groups WHERE room_id = ?",
    )
    .get(ROOM_ID) as
    | {
        id: string
        title: string
        created_at: string
        updated_at: string
        room_id: string
      }
    | undefined
  if (!sg) {
    console.error(`No session_group with room_id=${ROOM_ID} in main db`)
    process.exit(1)
  }
  console.log(`    session_group: ${sg.id} title="${sg.title}"`)
  db.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at, room_id) VALUES (?, ?, ?, ?, ?)",
  ).run(sg.id, sg.title, sg.created_at, sg.updated_at, sg.room_id)

  const threads = main
    .prepare(
      "SELECT id, session_group_id, provider, alias, updated_at FROM threads WHERE session_group_id = ?",
    )
    .all(sg.id) as Array<{
    id: string
    session_group_id: string
    provider: string
    alias: string
    updated_at: string
  }>
  for (const t of threads) {
    db.prepare(
      "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(t.id, t.session_group_id, t.provider, t.alias, t.updated_at)
  }
  console.log(`    threads: ${threads.length}`)

  const messages = (
    main
      .prepare(`
      SELECT m.id, m.thread_id, m.role, m.content, m.created_at
      FROM messages m
      JOIN threads t ON m.thread_id = t.id
      WHERE t.session_group_id = ?
      ORDER BY m.created_at DESC LIMIT ?
    `)
      .all(sg.id, MESSAGES_LIMIT) as Array<{
      id: string
      thread_id: string
      role: string
      content: string
      created_at: string
    }>
  ).reverse()
  for (const m of messages) {
    db.prepare(
      "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(m.id, m.thread_id, m.role, m.content, m.created_at)
  }
  console.log(
    `    messages: ${messages.length} (${messages.filter((m) => m.role === "user").length} user / ${messages.filter((m) => m.role === "assistant").length} asst)`,
  )

  const calls = main
    .prepare(`
    SELECT call_id, parent_call_id, root_call_id, issuer_id, convener_id, reply_to,
           deadline_at, status, session_group_id, created_at, updated_at
    FROM a2a_calls
    WHERE session_group_id = ?
      AND status IN ('pending','working','failed','timeout','cancelled')
    ORDER BY created_at DESC LIMIT 20
  `)
    .all(sg.id) as Array<Record<string, string>>
  for (const c of calls) {
    db.prepare(`
    INSERT INTO a2a_calls (
      call_id, parent_call_id, root_call_id, issuer_id, convener_id, reply_to,
      deadline_at, status, session_group_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
      c.call_id,
      c.parent_call_id,
      c.root_call_id,
      c.issuer_id,
      c.convener_id,
      c.reply_to,
      c.deadline_at,
      c.status,
      c.session_group_id,
      c.created_at,
      c.updated_at,
    )
  }
  console.log(`    a2a_calls: ${calls.length} (含历史 stale —— B024 兜底会过滤)`)

  main.close()

  // ─── 3. 创建 ledger + 真 Sonnet judge + compile-fn ──────────────────

  console.log(
    `[3/5] 初始化真 Sonnet 4.6 judge (timeout=${SONNET_TIMEOUT_MS}ms, concurrency=${CONCURRENCY})...`,
  )
  const ledger = new DecisionLedger(db)
  const sonnet = createSonnetRunner()
  const judge = new HaikuDecisionJudge(sonnet, SONNET_TIMEOUT_MS)

  const compile = createViewfinderCompileFn({
    db,
    ledger,
    judge,
    fencingToken: "walkthrough-leader",
    leaderTerm: "walk-1",
    judgeConcurrency: CONCURRENCY,
    judgeTimeoutMs: SONNET_TIMEOUT_MS,
  })

  // ─── 4. 跑编译 ──────────────────────────────────────────────────────

  const userMsgs = messages.filter((m) => m.role === "user")
  console.log(
    `[4/5] 编译开始 — ${messages.length} 条 messages（${userMsgs.length} user）→ Sonnet 判定...`,
  )
  console.log(`    （冷启 18s，热启 8-9s/each，并发 ${CONCURRENCY}，预计 1-2 分钟）`)
  const startMs = Date.now()
  const result = await compile({
    roomId: ROOM_ID,
    prevCheckpoint: null,
    newMessages: messages.map((m, i) => ({
      seq: i + 1,
      messageId: m.id,
      committedAt: m.created_at,
      role: m.role as "user" | "assistant" | "system" | "tool",
    })),
    newSeals: [],
  })
  const elapsedMs = Date.now() - startMs
  console.log(`    编译完成，耗时 ${(elapsedMs / 1000).toFixed(1)}s`)

  // ─── 5. 输出三件套 ────────────────────────────────────────────────

  const outDir = tmpDir
  writeFileSync(path.join(outDir, "viewfinder.md"), result.viewfinderMd)
  writeFileSync(path.join(outDir, "decisions.md"), result.decisionsMd)
  writeFileSync(path.join(outDir, "log.md"), result.logMd)
  console.log(`[5/5] 输出 → ${outDir}`)

  console.log("\n========== viewfinder.md ==========\n")
  console.log(result.viewfinderMd)
  console.log("\n========== decisions.md ==========\n")
  console.log(result.decisionsMd)
  console.log("\n========== log.md ==========\n")
  console.log(result.logMd)

  closeDb()
}

main().catch((err) => {
  console.error("walkthrough failed:", err)
  process.exit(1)
})
