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
import { eq } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import { wikiEntityIndex } from "../../db/schema"
import type { IndexerReport } from "./types"

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

/**
 * 范-r1 重写：真增量 + failed 不删 + 事务包 diff。
 *
 * 算法（chap 22 行 2386 "FTS5 索引构建慢" 兜底"离线批量 + 灰度"对齐）：
 *   1. 先 SELECT DB 拿 (path, mtime_ms, source_hash, bucket, name) metadata（不含 body）
 *   2. 扫磁盘 stat 每个 .md 文件（不读 body）→ seenOnDiskPaths + diskMeta map
 *   3. 对每个 disk file：
 *      a. 不在 DB → 读 body + hash + INSERT
 *      b. 在 DB 且 mtime 相同 → skip（不读 body，不算 hash）
 *      c. 在 DB 且 mtime 不同 → 读 body 算 hash；hash 同 → 仅 UPDATE mtime；hash 不同 → 全 UPDATE
 *   4. DELETE 仅针对 (DB 有 - seenOnDiskPaths) 集合 — failed 文件保留旧索引
 *   5. 整 diff 包在 db.transaction({behavior: 'immediate'}) 防中途崩半态
 */
export async function reindexWikiEntities(opts: IndexerOptions): Promise<IndexerReport> {
  const t0 = Date.now()
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY
  const wikiDir = path.join(opts.wikiRoot, "wiki")
  const nowIso = opts.now ?? new Date().toISOString()

  const failed: IndexerReport["failed"] = []

  // ─── 1) DB 当前 metadata（不含 body，省内存）─────────────────────────
  const dbRows = selectDbMetadata(opts.db, opts.buckets)
  const dbByPath = new Map<string, DbMetaRow>()
  for (const row of dbRows) dbByPath.set(row.path, row)

  // ─── 2) 磁盘扫 .md 文件（只 stat，不读 body）─────────────────────────
  let bucketDirs: string[]
  try {
    const entries = await fsAsync.readdir(wikiDir, { withFileTypes: true })
    bucketDirs = entries.filter((e) => e.isDirectory()).map((e) => String(e.name))
    if (opts.buckets) bucketDirs = bucketDirs.filter((b) => opts.buckets?.includes(b))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    bucketDirs = []
  }

  type DiskMeta = {
    relPath: string
    absPath: string
    bucket: string
    name: string
    mtimeMs: number
    sizeBytes: number
  }
  const diskByPath = new Map<string, DiskMeta>()
  const seenOnDiskPaths = new Set<string>()

  for (const bucket of bucketDirs) {
    const bucketDir = path.join(wikiDir, bucket)
    await walkMd(bucketDir, async (absPath, mtimeMs) => {
      const relPath = path.relative(opts.wikiRoot, absPath).replace(/\\/g, "/")
      seenOnDiskPaths.add(relPath)
      try {
        const stat = await fsAsync.stat(absPath)
        if (stat.size > maxBytes) {
          // 范-r1 P1-3: failed 不算 deleted；保留 DB 旧索引
          failed.push({ relPath, error: `body exceeds maxBodyBytes (${stat.size} > ${maxBytes})` })
          return
        }
        const name = path.basename(absPath, ".md")
        diskByPath.set(relPath, { relPath, absPath, bucket, name, mtimeMs, sizeBytes: stat.size })
      } catch (err) {
        // 范-r1 P1-3: stat 失败 path 已进 seenOnDiskPaths → 不会被当 deleted 删除
        failed.push({ relPath, error: errorMessage(err) })
      }
    })
  }

  // ─── 3) Diff: 决定每条 path 的动作 + 按需读 body ──────────────────────
  type Action =
    | { kind: "insert"; meta: DiskMeta; body: string; hash: string }
    | { kind: "update"; meta: DiskMeta; body: string; hash: string; oldHash: string }
    | { kind: "skip" }
  type PlanEntry = { relPath: string; action: Action }
  const plan: PlanEntry[] = []
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const [relPath, dmeta] of diskByPath) {
    const dbRow = dbByPath.get(relPath)
    if (!dbRow) {
      try {
        const buf = await fsAsync.readFile(dmeta.absPath, "utf8")
        plan.push({
          relPath,
          action: { kind: "insert", meta: dmeta, body: buf, hash: sha256Hex(buf) },
        })
        inserted++
      } catch (err) {
        failed.push({ relPath, error: errorMessage(err) })
      }
      continue
    }
    // 同 path 已存在；只 mtime 相同就 skip（不读 body 省 IO）
    if (dbRow.mtimeMs === dmeta.mtimeMs) {
      plan.push({ relPath, action: { kind: "skip" } })
      skipped++
      continue
    }
    // mtime 不同 → 读 body 校 hash
    try {
      const buf = await fsAsync.readFile(dmeta.absPath, "utf8")
      const hash = sha256Hex(buf)
      // 范-r1 P1-2: hash 同也 UPDATE mtime（防下次再读）；hash 不同则全 UPDATE
      plan.push({
        relPath,
        action: { kind: "update", meta: dmeta, body: buf, hash, oldHash: dbRow.sourceHash },
      })
      updated++
    } catch (err) {
      failed.push({ relPath, error: errorMessage(err) })
    }
  }

  // ─── 4) DELETE: 仅 (dbByPath - seenOnDiskPaths)；failed/超大文件保留 ──
  const toDelete: string[] = []
  for (const dbPath of dbByPath.keys()) {
    if (!seenOnDiskPaths.has(dbPath)) toDelete.push(dbPath)
  }
  const removed = toDelete.length

  // ─── 5) 包事务执行 plan + delete（范-r1 P2-3）────────────────────────
  opts.db.transaction(
    (tx) => {
      for (const entry of plan) {
        const a = entry.action
        if (a.kind === "insert") {
          tx.insert(wikiEntityIndex)
            .values({
              path: entry.relPath,
              bucket: a.meta.bucket,
              name: a.meta.name,
              body: a.body,
              sourceHash: a.hash,
              mtimeMs: a.meta.mtimeMs,
              indexedAt: nowIso,
            })
            .run()
        } else if (a.kind === "update") {
          tx.update(wikiEntityIndex)
            .set({
              bucket: a.meta.bucket,
              name: a.meta.name,
              body: a.body,
              sourceHash: a.hash,
              mtimeMs: a.meta.mtimeMs,
              indexedAt: nowIso,
            })
            .where(eq(wikiEntityIndex.path, entry.relPath))
            .run()
        }
      }
      for (const p of toDelete) {
        tx.delete(wikiEntityIndex).where(eq(wikiEntityIndex.path, p)).run()
      }
    },
    { behavior: "immediate" },
  )

  return {
    scanned: diskByPath.size,
    inserted,
    updated,
    skipped,
    removed,
    failed,
    durationMs: Date.now() - t0,
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

/** 范-r1 P1-2: DB metadata only（不含 body 省内存）；按 buckets 过滤 */
type DbMetaRow = { path: string; bucket: string; name: string; sourceHash: string; mtimeMs: number }

function selectDbMetadata(db: DrizzleDb, buckets: string[] | undefined): DbMetaRow[] {
  const cols = {
    path: wikiEntityIndex.path,
    bucket: wikiEntityIndex.bucket,
    name: wikiEntityIndex.name,
    sourceHash: wikiEntityIndex.sourceHash,
    mtimeMs: wikiEntityIndex.mtimeMs,
  }
  if (!buckets || buckets.length === 0) {
    return db.select(cols).from(wikiEntityIndex).all()
  }
  const seen = new Set<string>()
  const out: DbMetaRow[] = []
  for (const b of buckets) {
    const rows = db.select(cols).from(wikiEntityIndex).where(eq(wikiEntityIndex.bucket, b)).all()
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
