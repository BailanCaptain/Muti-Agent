/**
 * F027 P2 范-r2 修复 · 抽出来的 atomic write helper —— 共用 P21 manifest 写 + P2 顶层 wiki/index.md 写。
 * 真相源：docs/plans/V16.5-final.md chap 19（Atomic Manifest Protocol；wiki/index.md 是 prompt 注入入口）
 *
 * 协议：tmp 文件 → fsync(file) → atomic rename → fsync(dir, best-effort)
 *
 * 平台：
 *   - POSIX：fs.renameSync 原子（同 fs 内）；rename 后 fsync 父目录保证 rename 持久化
 *   - Windows：MoveFileExW(MOVEFILE_REPLACE_EXISTING) 原子；目录 fsync best-effort（NTFS 不需要）
 *
 * 不变量：
 *   - tmp 名 = <target-basename>.<pid>-<ms>-<seq>.tmp（unique 防多 writer 撞 fsync）
 *   - tmp 与 target 同 dir（rename 必须同 fs）
 *   - rename 后 tmp 消失（rename 消耗 source）
 */

import fs from "node:fs"
import path from "node:path"

/** 范-r2：generic glob —— 匹配 atomic-write 生成的所有 tmp 后缀模式。 */
export const ATOMIC_TMP_REGEX = /\.\d+-\d+-\d+\.tmp$/

let tmpCounter = 0

/** 生成 unique tmp 路径（与 target 同 dir，rename 同 fs 要求）。 */
export function generateAtomicTmpPath(targetPath: string): string {
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath)
  const pid = process.pid
  const ts = Date.now()
  const seq = ++tmpCounter
  return path.join(dir, `${base}.${pid}-${ts}-${seq}.tmp`)
}

/**
 * 原子写：unique tmp → fsync(file) → atomic rename → fsync(dir, best-effort)。
 *
 * 适用：任何"reader 不能容忍半写"的文件 —— 包括 manifest.json + wiki/index.md（注入 prompt 入口）。
 *
 * 调用方约定：自己持 lease/leader_term，atomic-write 不做并发控制（多 writer 时
 * 老 writer 的 rename 会被新 writer 覆盖）。Phase 1 P3.5 leader lease 是真正的串行保证。
 */
export function writeFileAtomic(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = generateAtomicTmpPath(targetPath)

  // open + write + fsync + close —— writeFileSync 不暴露 fd 做 fsync
  const fd = fs.openSync(tmpPath, "w")
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  renameWithRetry(tmpPath, targetPath)

  // best-effort dir fsync —— POSIX 要求 rename 这个 dir entry 变更也 flush。
  // Windows 跳过：(a) NTFS metadata journaling 自带 durability，dir fsync 不必要；
  //              (b) 实测在 Windows 紧凑 rename loop 中开 dir handle 会触发 EPERM
  //              （Iteration N 的 dir handle 还没全释放，N+1 的 rename 抢不到独占）。
  if (process.platform !== "win32") {
    try {
      const dirFd = fs.openSync(dir, "r")
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // POSIX edge: 极少见 — 跳过
    }
  }
}

/**
 * Windows-friendly rename with微 retry —— EPERM/EBUSY 通常是 antivirus / indexer
 * 在刚 close 的 tmp / target 上短暂 hold handle。POSIX 上几乎不触发，但同样 retry
 * 一遍是 free 的。最大 5 次 × 10ms = 50ms 阻塞上限，超过仍失败 → 真错误抛出。
 */
function renameWithRetry(src: string, dest: string): void {
  let lastErr: NodeJS.ErrnoException | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(src, dest)
      return
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") throw err
      lastErr = e
      // 短暂忙等：node 没 sync sleep，loop spin 10ms
      const until = Date.now() + 10
      while (Date.now() < until) {
        // spin
      }
    }
  }
  throw lastErr ?? new Error(`rename failed after retries: ${src} → ${dest}`)
}

/**
 * 扫 dir 下所有 atomic-write orphan tmp（崩溃残留）。
 * 仅匹配 ATOMIC_TMP_REGEX 模式，不动 manifest.json / .bak / 子目录 / 普通文件。
 * 返回清扫数量。dir 不存在返 0（不抛）。
 */
export function cleanupAtomicOrphans(dir: string): number {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw err
  }
  let cleaned = 0
  for (const name of entries) {
    if (!ATOMIC_TMP_REGEX.test(name)) continue
    try {
      fs.unlinkSync(path.join(dir, name))
      cleaned++
    } catch (err) {
      // 并发清理 race：两个 reconciler 抢同一文件
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }
  return cleaned
}
