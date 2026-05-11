/**
 * F027 P21 · Atomic Manifest Protocol — wiki/index/manifest.json 的事务写。
 * 真相源：docs/plans/V16.5-final.md chap 19
 *
 * 协议：
 *   write : tmp 文件 → fsync → atomic rename → 老 manifest 被原子覆盖
 *   read  : 直接 readFile manifest.json（rename 是单步原子，读到的要么旧版要么新版）
 *   crash : 写到一半崩 → tmp 残留 → 启动时 cleanupOrphanTmp 删掉，readManifest 仍读老版
 *
 * 平台：
 *   - POSIX：fs.renameSync 是 atomic（同 fs 内）
 *   - Windows：Node 用 MoveFileExW(MOVEFILE_REPLACE_EXISTING) — 原子覆盖
 *
 * 不做：
 *   - 多版本目录（v-XXX/）管理 → P2 WikiCompiler 写 manifest.files 时一并维护
 *   - source_event_seq 计算 → WikiCompiler 调 wiki_events repo 取 max(id)
 *   - archive（7 天前的 v-XXX 打 tar.gz）→ P3.5 NightlyJobScheduler
 *   - manifest hash 校验 → 暂不（version 已是单调；hash 留 P2 hash 内容时再加）
 */

import fs from "node:fs"
import path from "node:path"

export interface IndexManifestFile {
  /** 相对 wiki/index/v-<version>/ 的路径，如 "rules.md"。 */
  path: string
  /** 内容 hash（sha256 hex）。 */
  hash: string
  sizeBytes: number
}

export interface IndexManifest {
  /** 单调递增 version 字符串，如 "2026050601"（YYYYMMDDNN）。 */
  version: string
  generatedAt: string
  files: IndexManifestFile[]
  /**
   * 当时 wiki_events 表的最新 id（重放 evidence pack 用）。
   * 0 = 初始化空 manifest，没有 wiki_events 落库时。
   */
  sourceEventSeq: number
}

export const MANIFEST_FILENAME = "manifest.json"
export const TMP_SUFFIX = ".tmp"

export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_FILENAME)
}

export function tmpManifestPath(dir: string): string {
  return path.join(dir, MANIFEST_FILENAME + TMP_SUFFIX)
}

/**
 * 原子写：dir/manifest.json.tmp → fsync → atomic rename → manifest.json。
 *
 * 步骤：
 *   1. mkdir -p dir
 *   2. open tmp + writeFileSync JSON + fsync(fd) + close —— 保证 page cache 落盘
 *   3. fs.renameSync(tmp, target) —— 原子覆盖（POSIX rename / Windows MoveFileEx）
 *
 * 崩溃 case：
 *   - 步 2 中崩 → tmp 残留，target 不变 → 下次 cleanupOrphanTmp 清理
 *   - 步 3 中崩 → rename 是单 syscall，要么完整成功要么完整失败 → 不会出现"半改"
 *   - rename 后崩 → 下次启动看 target 是新 manifest，无残留
 *
 * 同 dir 并发写 → 后到的 rename 覆盖前者；callers 应该按 leader_term 串行（P3.5 lease）。
 */
export function writeManifestAtomic(dir: string, manifest: IndexManifest): void {
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = tmpManifestPath(dir)
  const targetPath = manifestPath(dir)
  const json = JSON.stringify(manifest, null, 2) + "\n"

  // open + write + fsync + close —— 不能用 writeFileSync 因为它不暴露 fd 做 fsync
  const fd = fs.openSync(tmpPath, "w")
  try {
    fs.writeSync(fd, json)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  // atomic rename overwrites target; tmp is consumed
  fs.renameSync(tmpPath, targetPath)
}

/**
 * 读 manifest.json。返回 null = 文件不存在（首次启动 / 完全没编译过）。
 * JSON 解析失败抛 — 上层（compiler / health check）应当拒绝继续运行。
 */
export function readManifest(dir: string): IndexManifest | null {
  const target = manifestPath(dir)
  let buf: string
  try {
    buf = fs.readFileSync(target, "utf-8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  const parsed = JSON.parse(buf) as unknown
  if (!isValidManifest(parsed)) {
    throw new Error(`Invalid manifest schema at ${target}: missing required fields`)
  }
  return parsed
}

/**
 * Startup reconciler：清理 orphan .tmp 文件。崩溃后 tmp 残留时调用。
 * 返回 true = 真清了一份；false = 没有 orphan。不抛（缺文件 = 干净）。
 */
export function cleanupOrphanTmp(dir: string): boolean {
  const tmpPath = tmpManifestPath(dir)
  try {
    fs.unlinkSync(tmpPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}

function isValidManifest(value: unknown): value is IndexManifest {
  if (!value || typeof value !== "object") return false
  const m = value as Record<string, unknown>
  if (typeof m.version !== "string" || m.version.length === 0) return false
  if (typeof m.generatedAt !== "string") return false
  if (typeof m.sourceEventSeq !== "number") return false
  if (!Array.isArray(m.files)) return false
  for (const f of m.files) {
    if (!f || typeof f !== "object") return false
    const file = f as Record<string, unknown>
    if (typeof file.path !== "string") return false
    if (typeof file.hash !== "string") return false
    if (typeof file.sizeBytes !== "number") return false
  }
  return true
}
