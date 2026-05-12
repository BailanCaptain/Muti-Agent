/**
 * F027 P14.a · wiki entity indexer
 * 真相源：docs/plans/V16.5-final.md chap 21 P14 + chap 22 行 2386 "FTS5 索引构建慢"
 *
 * 职责：
 *   - 扫 <wikiRoot>/wiki/<bucket>/**\/*.md 文件树
 *   - 增量判定：(path, mtime_ms, source_hash) 三元组比对 DB；mtime 变才读 body 算 hash
 *   - INSERT 新文件 / UPDATE 内容变更 / DELETE 磁盘已删的 DB 行
 *   - 静默单文件失败（IO 错误 / 编码错），记录到 failed[]，不阻塞 indexer
 *
 * 性能：100k entity × 平均 5KB body ≈ 500MB 索引。mtime 增量保证 indexer warm
 * 启动只 reindex 改动文件。冷启动 / 全量 reindex 接 P14 后续 phase 异步化。
 */

import crypto from "node:crypto"
import type { Dirent } from "node:fs"
import { promises as fsAsync } from "node:fs"
import path from "node:path"
import { and, eq, like } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import { wikiEntityIndex } from "../../db/schema"
import type { IndexerReport, WikiEntityFile } from "./types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface IndexerOptions {
  /** wikiRoot 绝对路径（caller 传 worktree root，indexer 自己 join wiki/） */
  wikiRoot: string
  /** drizzle DB 实例（与 RoomCompiler / agent-sessions 同库） */
  db: DrizzleDb
  /** 限制扫的 buckets（默认全扫 wiki/* 子目录） */
  buckets?: string[]
  /** 当前 ISO 时间（注入便于测试） */
  now?: string
  /** 单文件 body 长度上限（防意外大文件吃光内存；默认 1MB） */
  maxBodyBytes?: number
}

const DEFAULT_MAX_BODY = 1_048_576 // 1 MB

export async function reindexWikiEntities(opts: IndexerOptions): Promise<IndexerReport> {
  const t0 = Date.now()
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY
  const wikiDir = path.join(opts.wikiRoot, "wiki")
  const nowIso = opts.now ?? new Date().toISOString()

  const failed: IndexerReport["failed"] = []
  const filesOnDisk = new Map<string, WikiEntityFile>() // relPath → entity

  // 1) 磁盘扫文件
  let buckets: string[]
  try {
    const entries = await fsAsync.readdir(wikiDir, { withFileTypes: true })
    buckets = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    if (opts.buckets) buckets = buckets.filter((b) => opts.buckets?.includes(b))
  } catch (err) {
    // wikiDir 不存在 = 空 indexer 报告（不报错）
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    buckets = []
  }

  for (const bucket of buckets) {
    const bucketDir = path.join(wikiDir, bucket)
    await walkMd(bucketDir, async (absPath, mtimeMs) => {
      const relPath = path.relative(opts.wikiRoot, absPath).replace(/\\/g, "/")
      try {
        const stat = await fsAsync.stat(absPath)
        if (stat.size > maxBytes) {
          failed.push({ relPath, error: `body exceeds maxBodyBytes (${stat.size} > ${maxBytes})` })
          return
        }
        const buf = await fsAsync.readFile(absPath, "utf8")
        const hash = sha256Hex(buf)
        const name = path.basename(absPath, ".md")
        filesOnDisk.set(relPath, {
          relPath,
          bucket,
          name,
          body: buf,
          sourceHash: hash,
          mtimeMs,
        })
      } catch (err) {
        failed.push({ relPath, error: errorMessage(err) })
      }
    })
  }

  // 2) DB 当前已索引行（限 buckets，若指定）
  const existing = opts.buckets
    ? bucketsFilter(opts.db, opts.buckets)
    : opts.db.select().from(wikiEntityIndex).all()
  const dbByPath = new Map<string, typeof wikiEntityIndex.$inferSelect>()
  for (const row of existing) {
    dbByPath.set(row.path, row)
  }

  // 3) Diff & upsert
  let inserted = 0
  let updated = 0
  let skipped = 0
  let removed = 0

  for (const [relPath, file] of filesOnDisk) {
    const dbRow = dbByPath.get(relPath)
    if (!dbRow) {
      opts.db
        .insert(wikiEntityIndex)
        .values({
          path: relPath,
          bucket: file.bucket,
          name: file.name,
          body: file.body,
          sourceHash: file.sourceHash,
          mtimeMs: file.mtimeMs,
          indexedAt: nowIso,
        })
        .run()
      inserted++
      continue
    }
    if (dbRow.sourceHash === file.sourceHash && dbRow.mtimeMs === file.mtimeMs) {
      skipped++
      continue
    }
    // 内容变更或 mtime 不同（即使 hash 同也更新 mtime 防下次再读）
    opts.db
      .update(wikiEntityIndex)
      .set({
        bucket: file.bucket,
        name: file.name,
        body: file.body,
        sourceHash: file.sourceHash,
        mtimeMs: file.mtimeMs,
        indexedAt: nowIso,
      })
      .where(eq(wikiEntityIndex.path, relPath))
      .run()
    updated++
  }

  // 4) DB 有但磁盘已无 → DELETE
  for (const relPath of dbByPath.keys()) {
    if (!filesOnDisk.has(relPath)) {
      opts.db.delete(wikiEntityIndex).where(eq(wikiEntityIndex.path, relPath)).run()
      removed++
    }
  }

  return {
    scanned: filesOnDisk.size,
    inserted,
    updated,
    skipped,
    removed,
    failed,
    durationMs: Date.now() - t0,
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

function bucketsFilter(
  db: DrizzleDb,
  buckets: string[],
): Array<typeof wikiEntityIndex.$inferSelect> {
  // drizzle 没原生 OR-IN helper；用多 like 兜底（buckets 通常 ≤ 5）
  if (buckets.length === 0) return []
  if (buckets.length === 1) {
    return db.select().from(wikiEntityIndex).where(eq(wikiEntityIndex.bucket, buckets[0])).all()
  }
  // 多 bucket：UNION 实现 — drizzle 接口繁，这里直接 prefix-like 多次 query 合并去重
  const seen = new Set<string>()
  const out: Array<typeof wikiEntityIndex.$inferSelect> = []
  for (const b of buckets) {
    const rows = db
      .select()
      .from(wikiEntityIndex)
      .where(and(eq(wikiEntityIndex.bucket, b), like(wikiEntityIndex.path, "wiki/%")))
      .all()
    for (const r of rows) {
      if (!seen.has(r.path)) {
        seen.add(r.path)
        out.push(r)
      }
    }
  }
  return out
}

async function walkMd(
  dir: string,
  visit: (absPath: string, mtimeMs: number) => Promise<void>,
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = (await fsAsync.readdir(dir, { withFileTypes: true })) as unknown as Dirent[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
  for (const ent of entries) {
    const name = String(ent.name)
    const abs = path.join(dir, name)
    if (ent.isDirectory()) {
      await walkMd(abs, visit)
    } else if (ent.isFile() && name.endsWith(".md")) {
      const stat = await fsAsync.stat(abs)
      await visit(abs, stat.mtimeMs)
    }
  }
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex")
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
