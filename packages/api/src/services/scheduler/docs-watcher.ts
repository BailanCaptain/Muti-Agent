/**
 * F027 P19.7 · DocsWatcher (V16.5.3 D1) — chokidar 增量监听 + 半写 race mitigation
 *
 * 真相源：docs/plans/V16.5-final.md chap 17 line 1807, line 2656-2662 + AC-P2-7
 *
 * 职责（Day 6 watcher 壳；实际 ingest pipeline 由 onEvent 注入）：
 *   - chokidar 监听 watchPaths（默认 docs/{features|bugReport|lessons}）
 *   - 半写 race mitigation：chokidar 内置 awaitWriteFinish 等 size/mtime 稳定
 *     stabilityThreshold ms（默认 1.5s）后才 emit add/change
 *   - 60s debounce 防保存中频繁触发（V16.5 chap 17 line 2661 锁定）：
 *     稳定后启 60s 计时；同 path 再次 add/change 重置计时；超时 → fire onEvent
 *   - 忽略临时文件：*.tmp / *~ / *.swp / .DS_Store / .git/* 等
 *   - unlink 立即 fire（无 debounce — 文件已没了无 race）
 *
 * 不做：
 *   - 不实现 ingest pipeline（onEvent 注入；caller 串 sanitize / LLM 编译）
 *   - 不绑 leader gate（caller 在 onEvent 内自己判 leader.shouldSkipJob）
 *   - 不写 wiki/concepts/draft/_auto/<date>-<slug>.md（caller 业务逻辑）
 *   - 不与 NightlyJobScheduler 直接耦合（DocsWatcher kind='watcher' 是 inventory
 *     条目；scheduler-runtime 集成层 wire）
 *
 * chokidar v5 是 ESM-only：用 await import("chokidar") 动态引入（同
 * embedding-service.ts:165 @huggingface/transformers 模式）。
 */

import path from "node:path"
import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export type DocsEventKind = "add" | "change" | "unlink"

export interface DocsEvent {
  kind: DocsEventKind
  /** Absolute path of the file. */
  absolutePath: string
  /** Best-effort relative path (relative to longest matching watchPath prefix). */
  relativePath: string
}

export interface DocsWatcherOptions {
  /** Absolute paths to watch（如 [docs/features, docs/bugReport, docs/lessons] 全 abs）。 */
  watchPaths: string[]
  /**
   * Stable file event handler（onEvent 抛错被吞 + log warn，不打断 watcher）。
   * caller 串 ingest pipeline / leader guard / job_trace。
   */
  onEvent: (event: DocsEvent) => Promise<void> | void
  /** 60s debounce 防保存中频繁触发；V16.5 chap 17 锁定默认 60_000。 */
  debounceMs?: number
  /** chokidar awaitWriteFinish stabilityThreshold；默认 1500ms（半写 race mitigation）。 */
  stabilityMs?: number
  /** 额外 ignored patterns；默认含 tmp / swap / .DS_Store / .git/。 */
  ignored?: (string | RegExp)[]
  logger?: FastifyBaseLogger
  /**
   * 可注入 watcher 工厂（测试用：注入 fake source 直驱合成 add/change/unlink 事件，脱离真
   * chokidar / 真 fs / 真 timer 时序 → 确定性 + 负载免疫）。默认 = chokidar（production 路径，
   * 行为不变）。详见 FileWatchSource / defaultChokidarFactory。
   */
  watchSourceFactory?: WatchSourceFactory
}

const DEFAULT_IGNORED: (string | RegExp)[] = [
  /\.tmp$/i,
  /~$/, // emacs / vim backup
  /\.swp$/i,
  /\.swo$/i,
  /\.DS_Store$/,
  /[/\\]\.git[/\\]/,
  /[/\\]node_modules[/\\]/,
]

/**
 * DocsWatcher 依赖的最小文件监听事件面（chokidar FSWatcher 的子集）。
 * 抽出此 seam 让测试注入 fake source —— DocsWatcher 自有逻辑（debounce 收敛 / kind 收敛 /
 * unlink cancel pending / relativePath / onEvent 错误隔离）得以脱离真 chokidar + 真 fs 时序
 * 做确定性单测（不再被满负载下 chokidar 事件饿死 → 不 flaky）。
 */
export interface FileWatchSource {
  on(event: "add" | "change" | "unlink", handler: (filePath: string) => void): unknown
  on(event: "error", handler: (err: unknown) => void): unknown
  once(event: "ready", handler: () => void): unknown
  close(): Promise<void>
}

/** chokidar 兼容的构造 options（DocsWatcher 传给 factory 的子集）。 */
export interface WatchSourceOptions {
  ignored: (string | RegExp)[]
  ignoreInitial: boolean
  persistent: boolean
  awaitWriteFinish: { stabilityThreshold: number; pollInterval: number }
}

/** watcher 工厂：production 默认走 chokidar；测试注入 fake source。 */
export type WatchSourceFactory = (
  paths: string[],
  options: WatchSourceOptions,
) => FileWatchSource | Promise<FileWatchSource>

/**
 * 默认 chokidar 工厂（production 路径，行为与原实现一致）。
 * chokidar v5 是 ESM-only：用 await import 动态引入（同 embedding-service.ts:165 模式）。
 */
const defaultChokidarFactory: WatchSourceFactory = async (paths, options) => {
  const { watch } = await import("chokidar")
  return watch(paths, options) as unknown as FileWatchSource
}

export class DocsWatcher {
  private readonly watchPaths: string[]
  private readonly onEvent: (event: DocsEvent) => Promise<void> | void
  private readonly debounceMs: number
  private readonly stabilityMs: number
  private readonly ignored: (string | RegExp)[]
  private readonly log: FastifyBaseLogger
  private readonly watchSourceFactory: WatchSourceFactory

  private fsWatcher: FileWatchSource | null = null
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>()
  /** Track last seen kind per path（debounce 收敛时使用）。 */
  private readonly pendingKinds = new Map<string, DocsEventKind>()

  constructor(opts: DocsWatcherOptions) {
    this.watchPaths = opts.watchPaths.map((p) => path.resolve(p))
    this.onEvent = opts.onEvent
    this.debounceMs = opts.debounceMs ?? 60_000
    this.stabilityMs = opts.stabilityMs ?? 1500
    this.ignored = [...DEFAULT_IGNORED, ...(opts.ignored ?? [])]
    this.log = opts.logger ?? createLogger("docs-watcher")
    this.watchSourceFactory = opts.watchSourceFactory ?? defaultChokidarFactory
  }

  /** 启动 chokidar watcher。idempotent。 */
  async start(): Promise<void> {
    if (this.fsWatcher) {
      this.log.debug("watcher already started, start() noop")
      return
    }
    // 范-r1 P3 修复：pollInterval clamp [10ms, 100ms]
    //   - 10ms 绝对最小（防极小 stabilityMs 下 5ms 过度 CPU；tests-only 场景）
    //   - 100ms 上限（production stabilityMs >= 1000ms 时不需要更频繁）
    //   - target = stability/3（确保 stability 内能 poll ≥ 2 次收敛判定）
    // production 推荐 stabilityMs >= 1000ms（pollInterval 即 100ms）。
    const pollInterval = Math.max(10, Math.min(100, Math.floor(this.stabilityMs / 3)))
    // watcher 经可注入工厂创建（默认 chokidar；测试注入 fake source 脱离真 fs 时序）
    const fsWatcher = await this.watchSourceFactory(this.watchPaths, {
      ignored: this.ignored,
      ignoreInitial: true, // 启动时已存在的文件不算 add（避免 backfill 由 watcher 触发）
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: this.stabilityMs,
        pollInterval,
      },
    })

    fsWatcher.on("add", (filePath) => this.scheduleDebounced("add", filePath))
    fsWatcher.on("change", (filePath) => this.scheduleDebounced("change", filePath))
    // unlink 立即 fire（文件已没了无 race；但仍 cancel 任何 pending debounce）
    fsWatcher.on("unlink", (filePath) => this.fireUnlink(filePath))
    fsWatcher.on("error", (err) => {
      this.log.error({ err }, "chokidar watcher error")
    })

    // 等 ready event：chokidar 完成 initial scan 后才算真启动
    await new Promise<void>((resolve) => {
      let resolved = false
      const finish = () => {
        if (resolved) return
        resolved = true
        resolve()
      }
      fsWatcher.once("ready", finish)
      // 防御 timeout：若 ready 事件丢失，5s 后强制 resolve（chokidar 已开始 watching）
      setTimeout(finish, 5000).unref?.()
    })

    this.fsWatcher = fsWatcher
    this.log.info(
      {
        watchPaths: this.watchPaths,
        debounceMs: this.debounceMs,
        stabilityMs: this.stabilityMs,
        pollInterval,
      },
      "DocsWatcher started",
    )
  }

  /** 停止 watcher + 清所有 pending debounce。idempotent。 */
  async stop(): Promise<void> {
    if (!this.fsWatcher) return
    // 清 pending debounce（不 fire，cancel）
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
    this.pendingKinds.clear()
    try {
      await this.fsWatcher.close()
    } catch (err) {
      this.log.warn({ err }, "fsWatcher.close() threw (ignored)")
    }
    this.fsWatcher = null
    this.log.info("DocsWatcher stopped")
  }

  isRunning(): boolean {
    return this.fsWatcher !== null
  }

  /** 调试用：当前 pending debounce 队列长度。 */
  pendingCount(): number {
    return this.debounceTimers.size
  }

  // ── private ────────────────────────────────────────────────────────────

  private scheduleDebounced(kind: DocsEventKind, filePath: string): void {
    const abs = path.resolve(filePath)
    // 同 path 再触发：cancel 旧 timer、记 last kind（add 后接 change 取 add；
    // change 后接 change 仍 change；unlink 走 fireUnlink 单独路径）
    const existingTimer = this.debounceTimers.get(abs)
    if (existingTimer) clearTimeout(existingTimer)
    // last kind 收敛规则：保留更"早"的 kind（add 优先于 change，因为对 caller 是新文件信号）
    const prevKind = this.pendingKinds.get(abs)
    const finalKind: DocsEventKind = prevKind === "add" ? "add" : kind // 只有 prev=add 才不被 change 覆盖
    this.pendingKinds.set(abs, finalKind)

    const timer = setTimeout(() => {
      this.debounceTimers.delete(abs)
      this.pendingKinds.delete(abs)
      const event: DocsEvent = {
        kind: finalKind,
        absolutePath: abs,
        relativePath: this.relativeTo(abs),
      }
      this.dispatch(event)
    }, this.debounceMs)
    this.debounceTimers.set(abs, timer)
  }

  private fireUnlink(filePath: string): void {
    const abs = path.resolve(filePath)
    // cancel pending（add/change 已无意义 — 文件被删）
    const pendingTimer = this.debounceTimers.get(abs)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      this.debounceTimers.delete(abs)
      this.pendingKinds.delete(abs)
    }
    const event: DocsEvent = {
      kind: "unlink",
      absolutePath: abs,
      relativePath: this.relativeTo(abs),
    }
    this.dispatch(event)
  }

  private dispatch(event: DocsEvent): void {
    Promise.resolve()
      .then(() => this.onEvent(event))
      .catch((err) => {
        this.log.warn(
          { err, event },
          "onEvent threw (ignored — watcher continues, caller should isolate ingest errors)",
        )
      })
  }

  private relativeTo(abs: string): string {
    // 取最长匹配的 watchPath 前缀做 relative
    let bestRel: string | null = null
    let bestLen = -1
    for (const wp of this.watchPaths) {
      if (abs === wp || abs.startsWith(wp + path.sep)) {
        if (wp.length > bestLen) {
          bestLen = wp.length
          bestRel = path.relative(wp, abs)
        }
      }
    }
    return bestRel ?? abs
  }
}
