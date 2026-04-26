// B019 一次性 backfill 脚本 — 给已有 messages 表生成缺失的 embeddings
//
// 用途：F018 P5 完工到 B019 修复之间，所有 fire-and-forget generateAndStore
// 都因 huggingface.co 撞墙永降级，1856 条 messages 全部没写 embedding。
// 修复后**新**消息会写，但**老**消息不会自动 backfill。
//
// 本脚本一次性扫 messages 表，对没 embedding 的 assistant 消息补写。
//
// 数据安全（铁律 1 数据神圣）:
//   - 不读 / 不写 主库 data/multi-agent.sqlite
//   - 显式接受 --db <path> 指向目标库（应是 worktree preview 或 staging 临时库）
//   - 只 INSERT 到 message_embeddings 表（不修改 / 不删除任何已有数据）
//   - idempotent: 已有 messageId 的 embedding 跳过，重跑无副作用
//
// 用法:
//   pnpm tsx scripts/B019-backfill-embeddings.ts --db .runtime/worktree-preview/data/multi-agent.sqlite
//   pnpm tsx scripts/B019-backfill-embeddings.ts --db <path> --dry-run    # 只统计不写入
//   pnpm tsx scripts/B019-backfill-embeddings.ts --db <path> --limit 100  # 只 backfill 最近 100 条

import fs from "node:fs"
import { SqliteStore } from "../packages/api/src/db/sqlite"
import { EmbeddingService } from "../packages/api/src/services/embedding-service"

interface MessageRow {
  id: string
  thread_id: string
  content: string
  created_at: string
}

function parseArgs() {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx >= 0 ? args[idx + 1] : undefined
  }
  const has = (flag: string) => args.includes(flag)
  return {
    dbPath: get("--db"),
    dryRun: has("--dry-run"),
    limit: get("--limit") ? Number.parseInt(get("--limit") ?? "0", 10) : undefined,
  }
}

async function main() {
  const { dbPath, dryRun, limit } = parseArgs()

  if (!dbPath) {
    console.error("ERROR: --db <path> is required (don't run on main db, use preview/staging copy)")
    console.error("Usage: pnpm tsx scripts/B019-backfill-embeddings.ts --db <path> [--dry-run] [--limit N]")
    process.exit(1)
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: db not found: ${dbPath}`)
    process.exit(1)
  }

  // 铁律 1 防御：明确不允许指向主库
  if (dbPath.includes("data/multi-agent.sqlite") && !dbPath.includes("worktree-preview") && !dbPath.includes("staging")) {
    console.error(`ERROR: refusing to backfill main db (${dbPath}) — Iron Law 1: 数据神圣不可改写`)
    console.error("使用 sqlite3 .backup 复制到 worktree-preview / staging 临时库后再跑 backfill")
    process.exit(1)
  }

  console.log(`[backfill] db: ${dbPath}`)
  console.log(`[backfill] dry-run: ${dryRun ? "YES (will not write)" : "NO (will INSERT)"}`)
  console.log(`[backfill] limit: ${limit ?? "no limit (all eligible messages)"}`)

  const store = new SqliteStore(dbPath)
  const svc = new EmbeddingService({ store })

  // ---- Step 1: 找出需要 backfill 的 messages ----
  // 条件: role='assistant' AND content 非空 AND 没有现存 embedding (按 messageId)
  const limitClause = limit ? `LIMIT ${limit}` : ""
  const candidates = store.db
    .prepare(`
      SELECT m.id, m.thread_id, m.content, m.created_at
      FROM messages m
      LEFT JOIN message_embeddings e ON e.message_id = m.id
      WHERE m.role = 'assistant'
        AND m.content != ''
        AND m.content != '[empty response]'
        AND e.message_id IS NULL
      ORDER BY m.created_at ASC
      ${limitClause}
    `)
    .all() as MessageRow[]

  console.log(`[backfill] found ${candidates.length} candidate messages without embedding`)

  const totalMessages = (
    store.db.prepare("SELECT COUNT(*) as n FROM messages WHERE role='assistant'").get() as { n: number }
  ).n
  const existingEmbeds = (
    store.db.prepare("SELECT COUNT(*) as n FROM message_embeddings").get() as { n: number }
  ).n
  console.log(`[backfill]   total assistant messages: ${totalMessages}`)
  console.log(`[backfill]   already-embedded: ${existingEmbeds}`)
  console.log(`[backfill]   to backfill: ${candidates.length}`)

  if (dryRun) {
    console.log("\n[backfill] dry-run: stopping before write. preview 5:")
    for (const c of candidates.slice(0, 5)) {
      console.log(`  - ${c.id} (thread=${c.thread_id.slice(0, 8)}, created=${c.created_at}, len=${c.content.length})`)
    }
    return
  }

  if (candidates.length === 0) {
    console.log("\n[backfill] nothing to do.")
    return
  }

  // ---- Step 2: 加载模型 ----
  console.log("\n[backfill] step 2: ensureModel ...")
  const t0 = Date.now()
  const ok = await svc.ensureModel()
  if (!ok) {
    console.error("[backfill] ensureModel failed — local weights not loadable")
    process.exit(1)
  }
  console.log(`[backfill]   ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  // ---- Step 3: 逐条 generateAndStore ----
  console.log(`\n[backfill] step 3: backfilling ${candidates.length} embeddings ...`)
  let success = 0
  let failed = 0
  const start = Date.now()

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    try {
      // generateAndStore 内部已 try/catch，失败会 logger.warn 不抛
      // 但我们想拿到精确成功率，所以再包一层
      const before = (
        store.db.prepare("SELECT COUNT(*) as n FROM message_embeddings WHERE message_id = ?").get(c.id) as { n: number }
      ).n
      await svc.generateAndStore(c.id, c.thread_id, c.content)
      const after = (
        store.db.prepare("SELECT COUNT(*) as n FROM message_embeddings WHERE message_id = ?").get(c.id) as { n: number }
      ).n
      if (after > before) {
        success++
      } else {
        failed++
      }
    } catch (err) {
      failed++
      console.warn(`  ! ${c.id} failed: ${(err as Error).message}`)
    }

    if ((i + 1) % 100 === 0 || i === candidates.length - 1) {
      const elapsed = (Date.now() - start) / 1000
      const rate = (i + 1) / elapsed
      const eta = (candidates.length - i - 1) / rate
      console.log(
        `  progress: ${i + 1}/${candidates.length} (${success} ok / ${failed} fail) — ${rate.toFixed(1)} msg/s, eta ${eta.toFixed(0)}s`,
      )
    }
  }

  const totalElapsed = (Date.now() - start) / 1000
  const finalCount = (
    store.db.prepare("SELECT COUNT(*) as n FROM message_embeddings").get() as { n: number }
  ).n

  console.log(`\n[backfill] done in ${totalElapsed.toFixed(1)}s`)
  console.log(`  success: ${success}`)
  console.log(`  failed:  ${failed}`)
  console.log(`  message_embeddings now: ${finalCount} rows (was ${existingEmbeds})`)
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err.message ?? err)
  console.error(err.stack)
  process.exit(1)
})
