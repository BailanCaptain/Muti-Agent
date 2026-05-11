/**
 * F027 P21 · Atomic Manifest Protocol — wiki/index/manifest.json 的事务写。
 * 真相源：docs/plans/V16.5-final.md chap 19
 *
 * 协议：
 *   write : unique tmp 文件 → fsync(file) → atomic rename → fsync(dir, best-effort)
 *   read  : 直接 readFile manifest.json（rename 是单步原子，读到的要么旧版要么新版）
 *   crash : 写到一半崩 → unique tmp 残留 → 启动时 cleanupOrphanTmp glob 扫掉
 *
 * 平台：
 *   - POSIX：fs.renameSync 是 atomic（同 fs 内）；rename 后 fsync 父目录保证 rename 持久化
 *   - Windows：Node 用 MoveFileExW(MOVEFILE_REPLACE_EXISTING) — 原子覆盖；目录 fsync best-effort（NTFS 不需要）
 *
 * 范-review-r1 finding P1-2 修复（单 writer 保证由 P3.5 lease 维护，但仍需防御深度）：
 *   - tmp 命名 unique（pid-ts-counter）—— 多 writer 不会撞同一 tmp 互踩 fsync
 *   - cleanupOrphanTmp 扫 glob —— 多 writer 崩溃残留多个 tmp 都能清掉
 *   - dir fsync —— rename 自身的目录变更也 flush 到磁盘
 *
 * 不做：
 *   - 多版本目录（v-XXX/）管理 → P2 WikiCompiler 写 manifest.files 时一并维护
 *   - source_event_seq 计算 → WikiCompiler 调 wiki_events repo 取 max(id)
 *   - archive（7 天前的 v-XXX 打 tar.gz）→ P3.5 NightlyJobScheduler
 *   - manifest hash 校验 → 暂不（version 已是单调；hash 留 P2 hash 内容时再加）
 *   - cross-process lease —— P3.5 compiler_leader 表 + leader_term 强制单 writer
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

/** 范-review-r1 P1-2：tmp 命名格式 = manifest.json.<pid>-<ms>-<seq>.tmp */
const TMP_REGEX = /^manifest\.json\.\d+-\d+-\d+\.tmp$/

let tmpCounter = 0

export function manifestPath(dir: string): string {
  return path.join(dir, MANIFEST_FILENAME)
}

/**
 * 范-review-r1 P1-2：unique tmp name，防多 writer 互踩 fsync。
 * pid 区分进程；Date.now() 区分时段；counter 区分同 ms 内多次调用。
 */
function generateTmpName(): string {
  const pid = process.pid
  const ts = Date.now()
  const seq = ++tmpCounter
  return `${MANIFEST_FILENAME}.${pid}-${ts}-${seq}${TMP_SUFFIX}`
}

/**
 * 原子写：dir/manifest.json.<unique>.tmp → fsync(file) → atomic rename → fsync(dir, best-effort)。
 *
 * 步骤：
 *   1. mkdir -p dir
 *   2. open unique tmp + writeFileSync JSON + fsync(fd) + close —— 保证 page cache 落盘
 *   3. fs.renameSync(tmp, target) —— 原子覆盖（POSIX rename / Windows MoveFileEx）
 *   4. dir fsync best-effort —— rename 这个目录变更自身也要 flush（POSIX 要求）
 *
 * 崩溃 case：
 *   - 步 2 中崩 → unique tmp 残留，target 不变 → cleanupOrphanTmp glob 清理
 *   - 步 3 中崩 → rename 是单 syscall，要么完整成功要么完整失败 → 不会出现"半改"
 *   - 步 4 中崩 → 文件在 inode 表已 rename（用户可见），dir entry 持久化失败极小概率重启回退
 *     —— 单 writer 假设下不损坏；多 writer 由 P3.5 lease 串行
 *
 * 同 dir 并发：unique tmp 防 fsync 互踩；rename 序列化由 OS 保证；
 * 业务侧应额外用 P3.5 leader_term 串行写来防"老 writer 覆盖新 writer"。
 */
export function writeManifestAtomic(dir: string, manifest: IndexManifest): void {
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = path.join(dir, generateTmpName())
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

  // best-effort dir fsync —— POSIX 要求 rename 这个 dir entry 变更也 flush。
  // Windows 不支持 directory fd open，会 EPERM/EISDIR；NTFS 自身已 metadata-journal 化，跳过无害。
  try {
    const dirFd = fs.openSync(dir, "r")
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    // Windows / 不支持 dir fd 的文件系统 — 跳过
  }
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
 *
 * 范-review-r1 P1-2：扫 glob 清所有匹配 manifest.json.<pid>-<ms>-<seq>.tmp 的 orphan
 * （多 writer 各自留下不同 tmp 都能清掉）。仅扫 .tmp 后缀，不动 manifest.json / .bak / 子目录。
 *
 * 返回清掉的文件数。dir 不存在返 0（不抛）。0 = 干净 / N = 清掉 N 份。
 */
export function cleanupOrphanTmp(dir: string): number {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw err
  }
  let cleaned = 0
  for (const name of entries) {
    if (!TMP_REGEX.test(name)) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      cleaned++
    } catch (err) {
      // 并发清理 race：同时多个 reconciler 跑可能抢同一文件
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }
  return cleaned
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
