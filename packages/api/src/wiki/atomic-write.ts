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
 * F027 replace 补丁（德彪 replace-r3 P1）· 原子 create-if-absent：target 已存在则**内核级**
 * 拒绝，绝不覆盖——关掉 existsSync→rename 的 TOCTOU（rename 会替换既存文件，check 后的
 * 并发创建会被盲覆盖）。
 *
 * 原理：tmp 写全 + fsync 后 `fs.linkSync(tmp, target)`——硬链接创建在 POSIX/NTFS 都是
 * 原子的 create-if-absent（target 已存在 → EEXIST，一个字节不动）。成功后 unlink tmp，
 * target 回到 nlink=1（瞬时 nlink=2 窗口无害；containment 读原语的 hardlink 检查在
 * 稳态看到的是 1）。
 *
 * 返回 "created" | "exists"（exists = 并发已占位，caller 按 dest_exists 语义处理）。
 */
export function writeFileAtomicIfAbsent(targetPath: string, content: string): "created" | "exists" {
  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })

  const tmpPath = generateAtomicTmpPath(targetPath)
  const fd = fs.openSync(tmpPath, "w")
  try {
    fs.writeSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  try {
    linkWithRetry(tmpPath, targetPath)
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // tmp 清理 best-effort（orphan 由 cleanupAtomicOrphans 兜底）
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists"
    throw err
  }
  // 德彪 replace-r4 P2：tmp unlink 失败不能吞——留下 nlink=2 会被 containment 读原语
  // （path-containment 拒 nlink>1）当 hardlink 攻击拒读，「写成功但页面打不开」。
  // 微 retry 后仍失败 → 回滚 target（同 inode，AV 握着句柄时大概率同败，则如实抛错，
  // 状态=target 在盘但事件将被 caller abort，tmp orphan 由 cleanupAtomicOrphans 兜底，
  // AV 释放后 nlink 自然回 1）。
  try {
    unlinkWithRetry(tmpPath)
  } catch (unlinkErr) {
    let rolledBack = false
    try {
      fs.unlinkSync(targetPath)
      rolledBack = true
    } catch {
      // 同 inode 句柄被握，回滚同败
    }
    const targetState = rolledBack ? "已回滚（可重试）" : "留盘待 reconcile（orphan 清理后 nlink 回 1）"
    throw new Error(
      `atomic-if-absent: tmp unlink failed (nlink=2 会被 containment 拒读，不能静默成功)；target ${targetState}: ${(unlinkErr as Error).message}`,
    )
  }
  if (process.platform !== "win32") {
    try {
      const dirFd = fs.openSync(dir, "r")
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // POSIX edge — 跳过
    }
  }
  return "created"
}

/** unlink 版微 retry（德彪 replace-r4 P2）：AV/indexer 短暂握句柄时重试，与 rename/link 同故障模型。 */
function unlinkWithRetry(p: string): void {
  let lastErr: NodeJS.ErrnoException | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.unlinkSync(p)
      return
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === "ENOENT") return // 已不在（并发清理）→ 目标达成
      if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") throw err
      lastErr = e
      const until = Date.now() + 10
      while (Date.now() < until) {
        // spin
      }
    }
  }
  throw lastErr ?? new Error(`unlink failed after retries: ${p}`)
}

/** link 版微 retry：EEXIST 必须**立即**上抛（它是语义结果不是瞬时故障）；只 retry AV/indexer 类。 */
function linkWithRetry(src: string, dest: string): void {
  let lastErr: NodeJS.ErrnoException | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.linkSync(src, dest)
      return
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") throw err
      lastErr = e
      const until = Date.now() + 10
      while (Date.now() < until) {
        // spin
      }
    }
  }
  throw lastErr ?? new Error(`link failed after retries: ${src} → ${dest}`)
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
