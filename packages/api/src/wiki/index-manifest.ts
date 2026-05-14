/**
 * F027 P21 · Atomic Manifest Protocol — wiki/index/manifest.json 的事务写。
 * 真相源：docs/plans/V16.5-final.md chap 19
 *
 * 范-r2 重构（P2 二轮 review fix）：
 *   - manifest 写复用 atomic-write.ts 的 writeFileAtomic（与 P2 顶层 wiki/index.md 共用）
 *   - cleanupOrphanTmp 改用 cleanupAtomicOrphans（generic glob 兼容多种 atomic-write target）
 *   - 公共 API（writeManifestAtomic / readManifest / cleanupOrphanTmp）签名不变
 *
 * 协议（不变）：
 *   write : unique tmp 文件 → fsync(file) → atomic rename → fsync(dir, best-effort)
 *   read  : 直接 readFile manifest.json（rename 是单步原子，读到的要么旧版要么新版）
 *   crash : 写到一半崩 → unique tmp 残留 → 启动时 cleanupOrphanTmp glob 扫掉
 */

import fs from "node:fs"
import path from "node:path"

import { cleanupAtomicOrphans, writeFileAtomic } from "./atomic-write"

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

/**
 * 原子写 manifest —— 范-r2 重构：调用通用 writeFileAtomic（atomic-write.ts），
 * 与 P2 顶层 wiki/index.md 共用同款 unique tmp + fsync + rename + dir fsync 协议。
 *
 * mkdir 由 writeFileAtomic 内部做（path.dirname(targetPath)）— 不在外层重复 mkdir，
 * 避免 Windows 紧凑 rename loop 下 dir handle race（实测：100 iter 重复 mkdir 触 EPERM）。
 */
export function writeManifestAtomic(dir: string, manifest: IndexManifest): void {
  const json = JSON.stringify(manifest, null, 2) + "\n"
  writeFileAtomic(manifestPath(dir), json)
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
 * Startup reconciler：清理 orphan .tmp 文件（崩溃残留）。
 * 范-r2：复用 cleanupAtomicOrphans（generic glob，匹配 *.<pid>-<ms>-<seq>.tmp 模式）—
 * 同时清掉 manifest.json.<x>.tmp + index.md.<x>.tmp 等所有 atomic-write 残留。
 *
 * 返回清掉的文件数。dir 不存在返 0（不抛）。
 */
export function cleanupOrphanTmp(dir: string): number {
  return cleanupAtomicOrphans(dir)
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
