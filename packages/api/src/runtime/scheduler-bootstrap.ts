/**
 * F027 Phase 3 P20 · scheduler-bootstrap — Week 1 Day 1
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §1.2-8 + §9 + §4 AC-P3-7
 *
 * 职责：API server boot 时把 Phase 2 已建好的 11 个 job class 真接进
 *   `SchedulerRuntime`，注入真 fs/db 依赖，跑起来 go-live。
 *
 * 走 fallback config（无 wiki.config.yaml）— Iron Laws 3 负断言：
 *   不存在 / 不创建 / 不写入 wiki.config.yaml；Gate 2 未批准 → 真配置路径
 *   保持 BLOCKED；fallback config 来源可观测（`source: 'fallback:default'`）。
 *
 * Day 1 范围（plan §3 Week 1 Day 1）：
 *   - 11 job adapter 装配（plan §9 映射表）
 *   - StartupReconciler：直接用（业务全在 SQL UPDATE/DELETE，不需要业务回调）
 *   - 其他 jobs：业务侧回调按下方更新说明注入真业务（wikiRoot/runner 缺失才 noop fallback）
 *
 * 【已接真业务（下方原 "不做" 列表已 stale，保留作演进记录）】：
 *   - RoomCompilerTick.compileExecutor：Week 5 hotfix 接真 roomCompileExecutor（server.ts 注入）
 *   - DocsWatcher.onEvent：final-vision P1-2 接 DocsIngestRunner（含 G11 真 LLM 编译）
 *   - NightlyHealthCheck/WeeklyDraftDigest/DriftDetector/MonthlySnapshot/ArchiveYearlySessions：
 *     F027 v3 G2 接真 scanner（见 ~line 200）
 *   - ChainedAlertNotifier.pushAlert：server.ts 注入 ws broadcast
 *   原 Phase-3-Day-1 scaffold "不做" 项（下列）现已由 v3 G2 / final-vision / Week5 hotfix 接通：
 *   - ~~不接 RoomCompilerTick.compileExecutor 真业务~~ → 已接
 *   - ~~不接 DocsWatcher.onEvent 真 ingest pipeline~~ → 已接
 *   - ~~不接 NightlyHealthCheck.scanEntities 真扫描~~ → 已接
 *   - ~~不接 WeeklyDraftDigest.scanDrafts / pushDigest~~ → 已接
 *   - ~~不接 DriftDetector.scanTriggers / openUpdateDraft~~ → 已接
 *   - ~~不接 MonthlySnapshot.recompileAllRooms~~ → 已接（MVP recompiled===current）
 *   - ~~不接 ArchiveYearlySessions.scanSessions~~ → 已接
 *   - WikiCompilerDebounce.recompileDerivedViews：F027 wiring 接真 reindex（opts.reindexWiki →
 *     wiki_entity_index 增量重建，search_wiki / adaptive-recall Level 2 的索引 producer）；
 *     markdown 派生视图（index/sources/log 程序编）重生成仍 follow-up（独立 F-id）。
 *   - ~~不接 ChainedAlertNotifier.pushAlert 真 room MCP~~ → 已接 ws broadcast
 *
 * 验收（AC-P3-7）：
 *   - API server 启动后 SchedulerRuntime 实例化 + 11 job 注册成功
 *   - 至少一条 startup-reconciler trace 落 .runtime/job-traces/
 *   - Iron Laws 3 文件系统断言：worktree root 无 wiki.config.yaml
 *   - app.close() → SchedulerRuntime.stop() idempotent
 */

import os from "node:os"
import path from "node:path"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyBaseLogger } from "fastify"
import { CompilerLeaderRepository } from "../db/repositories/compiler-leader-repository"
import type * as schema from "../db/schema"
import { ArchiveYearlySessions } from "../services/scheduler/archive-yearly-sessions"
import {
  type ChainedAlert,
  ChainedAlertNotifier,
} from "../services/scheduler/chained-alert-notifier"
import type { DocsIngestRunner } from "../services/scheduler/docs-ingest-runner"
import { DocsWatcher } from "../services/scheduler/docs-watcher"
import { DriftDetector } from "../services/scheduler/drift-detector"
import type { JobTrace } from "../services/scheduler/job-trace"
import { MonthlySnapshot } from "../services/scheduler/monthly-snapshot"
import { NightlyHealthCheck } from "../services/scheduler/nightly-health-check"
import { NightlyVacuum } from "../services/scheduler/nightly-vacuum"
import { RoomCompilerTick } from "../services/scheduler/room-compiler-tick"
import {
  assertNoConfigFile,
  type SchedulerConfig,
  type ScheduledJobConfig,
  loadSchedulerConfig,
} from "../services/scheduler/scheduler-config"
import {
  type CronJobRegistration,
  type EventDrivenJobRegistration,
  SchedulerRuntime,
  type StartupJobRegistration,
} from "../services/scheduler/scheduler-runtime"
import { StartupReconciler } from "../services/scheduler/startup-reconciler"
import { WeeklyDraftDigest } from "../services/scheduler/weekly-draft-digest"
import { WikiCompilerDebounce } from "../services/scheduler/wiki-compiler-debounce"
import {
  scanAgentSessionsFs,
  scanDriftTriggersDb,
  scanRoomViewfindersForSnapshot,
  scanWikiDraftsFs,
  scanWikiEntitiesFs,
} from "../services/scheduler/wiki-scanners"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface SchedulerBootOptions {
  db: DrizzleDb
  log: FastifyBaseLogger
  /**
   * 调度告警（failed / timeout / recovered_from_crash / lease_lost）推送 hook。
   * 生产由 server.ts 包装 broadcaster.broadcast；测试可注入 spy。
   * 拆成两个具体 hook 而非 broadcaster — 避免依赖 RealtimeServerEvent union 类型。
   */
  pushAlert?: (trace: JobTrace) => void | Promise<void>
  /** ChainedAlertNotifier 推送 hook（chained_suspect 命中后实时推 room）。 */
  pushChainedAlert?: (alert: ChainedAlert) => void | Promise<void>
  /** Trace 落盘 root；默认 process.cwd()。生产 = worktree root。 */
  rootDir?: string
  /** 告警目标 room；默认 R-201。 */
  alertRoom?: string
  /** 跳过 boot（CI / 单测）；默认 false。 */
  skipBoot?: boolean
  /**
   * Week 5 hotfix · RoomCompiler 真业务接入 (替换 noop compileExecutor).
   * 见 packages/api/src/orchestrator/production-room-compile-executor.ts.
   * 缺 → fallback noop (跟 Phase 3 行为一致).
   */
  roomCompileExecutor?: () => Promise<{ roomsProcessed: number }>
  /**
   * F027 final-vision P1-2 · DocsWatcher.onEvent 真业务接入 (替换 noop onEvent).
   * 见 packages/api/src/services/scheduler/docs-ingest-runner.ts.
   *
   * 缺 → fallback noop (跟 Phase 3 Day 1 行为一致 — boot 不强依赖)。
   * 传入 → docs/features|bugReport|lessons 增量变化 → 真走 preview → commit → 落 wiki/concepts/draft/_auto/
   *
   * docsWatcherEnabled 仍由 MULTI_AGENT_DOCS_WATCHER env 控制（final-vision P1-2 默认改 "1"，
   * 测试/CI/preview 用 "0" 关）。
   */
  docsIngestRunner?: DocsIngestRunner
  /**
   * F027 AC-P1-5 codex P2-3 · recent_drops 历史语料库 retention（NightlyVacuum 每夜 prune 超窗）。
   * 缺 → 不 prune（向后兼容）。server.ts 注入 RecentDropsRepository。
   */
  recentDrops?: { pruneOlderThan(cutoffMs: number): number }
  /**
   * F027 v3 G2 · wiki 根目录（cron scanner 扫 fs 用）。
   *
   * 缺 → 走 noop fallback (跟 v3 之前 Phase 3 行为一致 — boot 不强依赖)。
   * 传入 → 5 cron job (NightlyHealthCheck / WeeklyDraftDigest / DriftDetector /
   *        MonthlySnapshot / ArchiveYearlySessions) 接真业务 scanner。
   *
   * 约定与 server.ts 其他 caller 一致: `process.env.WIKI_ROOT || path.join(rootDir, ".runtime", "wiki")`。
   * 内部 fs 路径 `<wikiRoot>/rooms/<id>/viewfinder.md` 等 (跟 RoomCompiler 落盘对齐)。
   */
  wikiRoot?: string
  /**
   * F027 wiring · wiki 搜索索引 reindex 回调（接 WikiCompilerDebounce.recompileDerivedViews）。
   * 缺 → noop（跟之前 Phase 3 行为一致）。传入 → wiki 写 commit debounce 收敛后增量 reindex
   * `wiki_entity_index`（search_wiki / adaptive-recall Level 2 的索引 producer）。
   */
  reindexWiki?: () => Promise<void>
  /**
   * F027 wiring · 把 `WikiCompilerDebounce.onWikiEvent` 交还 caller。
   * caller（server.ts）在 `createWikiServices.onCommit` 里调它 → wiki 写 commit 触发 debounce。
   * boot 内建 debounce、caller 早于 boot 建 wikiServices，故用此 late-bind forwarder 串联。
   */
  registerOnWikiCommit?: (fire: () => void) => void
}

/**
 * Boot scheduler runtime — Week 1 Day 1 主入口。
 *
 * 返回值：
 *   - SchedulerRuntime instance（caller 应在 onClose hook 里 await .stop()）
 *   - null：opts.skipBoot=true（caller 应跳过 stop）
 *
 * 异常：
 *   - loadSchedulerConfig 抛 Iron Laws 3 violation → 直接抛出（boot 失败明示 BLOCKED）
 */
export async function bootSchedulerRuntime(
  opts: SchedulerBootOptions,
): Promise<SchedulerRuntime | null> {
  if (opts.skipBoot) {
    opts.log.info("MULTI_AGENT_SKIP_SCHEDULER=1, scheduler boot skipped")
    return null
  }
  const rootDir = opts.rootDir ?? process.cwd()
  const alertRoom = opts.alertRoom ?? "R-201"

  // 1. fallback config — AC-P3-7 Iron Laws 3 fail-safe（范-r1 P2-1 双断言）
  //
  // 双断言：
  //   - boot 入口显式 assertNoConfigFile(rootDir)（防 boot 后并发创建被 loader miss）
  //   - loadSchedulerConfig 内部 gate2Approved=false 二次检查
  //
  // 任一抛错 → boot 失败明示 BLOCKED；不创建任何 wiki.config.yaml。
  assertNoConfigFile(rootDir)
  const { config, fromFile, checkedPath } = loadSchedulerConfig({
    rootDir,
    gate2Approved: false,
    logger: opts.log,
  })
  opts.log.info(
    { fromFile, checkedPath, source: config.source, jobs: config.scheduled.length },
    "scheduler config loaded",
  )

  // 2. CompilerLeaderRepository（drizzleDb 包装）
  const leaseRepo = new CompilerLeaderRepository(opts.db)

  // 3. 11 job instances — 业务回调按 Day 1 范围注入 noop / minimal stub
  const reconciler = new StartupReconciler({ db: opts.db, logger: opts.log })

  // Week 5 hotfix: 如果 caller 注入了真 roomCompileExecutor (server.ts 走真业务),
  // 用真; 否则 fallback 到 noop (跟 Phase 3 行为一致, 测试 / CI 用).
  const tick = new RoomCompilerTick({
    compileExecutor:
      opts.roomCompileExecutor ?? (async () => ({ roomsProcessed: 0 })),
    logger: opts.log,
  })

  // F027 final-vision P1-2 修：默认 enable docs-watcher (env 默认 "1")，接 DocsIngestRunner 真业务。
  // - opts.docsIngestRunner 缺时 onEvent fallback noop (保 Phase 3 Day 1 行为 — boot 不强依赖)
  // - MULTI_AGENT_DOCS_WATCHER=0 显式关 (CI / 单测 / 不需要 ingest 的 preview server)
  const docsWatcherEnabled = (process.env.MULTI_AGENT_DOCS_WATCHER ?? "1") === "1"
  const docsIngestRunner = opts.docsIngestRunner
  const watcher = docsWatcherEnabled
    ? new DocsWatcher({
        watchPaths: [
          path.join(rootDir, "docs", "features"),
          path.join(rootDir, "docs", "bugReport"),
          path.join(rootDir, "docs", "lessons"),
        ],
        onEvent: docsIngestRunner
          ? async (event) => {
              await docsIngestRunner.runIngest(event)
            }
          : async () => {},
        logger: opts.log,
      })
    : null

  // F027 v3 G2 · cron scanner 真业务接通（替换原 5 个 async () => [] noop）。
  // wikiRoot 缺 → fallback noop（boot 不强依赖；test/CI 跑空 cron 不挂）。
  // wikiRoot 有 → fs / SQL 真扫；scanner 内部 fail-soft（单文件错跳过 + warn）。
  const noopScanEntities = async () => []
  const noopScanDrafts = async () => []
  const noopScanTriggers = async () => []
  const noopRecompile = async () => []
  const noopScanSessions = async () => []

  const healthCheck = new NightlyHealthCheck({
    scanEntities: opts.wikiRoot
      ? scanWikiEntitiesFs(opts.wikiRoot, opts.log)
      : noopScanEntities,
    logger: opts.log,
  })

  // F027 AC-P1-5 codex P2-3：NightlyVacuum 接 recent_drops retention（注入才 prune）
  const vacuum = new NightlyVacuum({
    db: opts.db,
    rootDir,
    logger: opts.log,
    recentDrops: opts.recentDrops,
  })

  const draftDigest = new WeeklyDraftDigest({
    scanDrafts: opts.wikiRoot
      ? scanWikiDraftsFs(opts.wikiRoot, opts.log)
      : noopScanDrafts,
    logger: opts.log,
  })

  const drift = new DriftDetector({
    // DB 扫不依赖 wikiRoot — 直接接 wiki_events + a2a_calls
    scanTriggers: scanDriftTriggersDb(opts.db, opts.log),
    logger: opts.log,
  })

  // MonthlySnapshot MVP: scanner 读 current viewfinder.md，recompiled === current
  // 等价于 drift=0 不触发 replace；真 LLM-from-scratch 重编留独立 F-id（noop fallback OK）。
  const snapshot = new MonthlySnapshot({
    recompileAllRooms: opts.wikiRoot
      ? scanRoomViewfindersForSnapshot(opts.db, opts.wikiRoot, opts.log)
      : noopRecompile,
    logger: opts.log,
  })

  const archive = new ArchiveYearlySessions({
    scanSessions: opts.wikiRoot
      ? scanAgentSessionsFs(opts.wikiRoot, opts.log)
      : noopScanSessions,
    logger: opts.log,
  })

  const debounce = new WikiCompilerDebounce({
    // F027 wiring · recompileDerivedViews 接真 reindex（wiki_entity_index 增量重建）。
    // 缺 reindexWiki → noop（markdown 派生视图 index/sources/log 重编仍 follow-up 独立 F-id）。
    recompileDerivedViews: opts.reindexWiki ?? (async () => {}),
    logger: opts.log,
  })
  // F027 wiring · 把 onWikiEvent 交还 caller，让 wiki 写 commit（createWikiServices.onCommit）触发本 debounce。
  opts.registerOnWikiCommit?.(() => debounce.onWikiEvent())

  const alertNotifier = new ChainedAlertNotifier({
    pushAlert: async (alert) => {
      if (opts.pushChainedAlert) await opts.pushChainedAlert(alert)
    },
    targetRoom: alertRoom,
    logger: opts.log,
  })

  // 4. 装配 cron / startup / event-driven adapter（plan §9 映射表）
  const cronJobs: CronJobRegistration[] = []
  const startupJobs: StartupJobRegistration[] = []
  const eventDrivenJobs: EventDrivenJobRegistration[] = []

  const cronCfgByName = indexCronJobs(config)
  const startupCfgByName = indexJobsByKind(config, "startup")

  // ── cron jobs (7) ────────────────────────────────────────────────────
  const tickCfg = cronCfgByName.get("room-compiler-tick")
  if (tickCfg) {
    cronJobs.push({
      name: "room-compiler-tick",
      cron: tickCfg.cron,
      timezone: tickCfg.timezone,
      windowMinutes: tickCfg.windowMinutes,
      timeoutSeconds: tickCfg.timeoutSeconds,
      run: async (ctx) => {
        const outcome = await tick.tick(ctx.scheduledFor)
        // RoomCompilerTick 自报 "failed" status → 抛错让 SchedulerRuntime 接管落 failed trace。
        // 其他 status（ok / skipped_reentry / missed_window）透传。
        if (outcome.status === "failed") {
          throw new Error(`room-compiler-tick failed: ${outcome.error}`)
        }
        return { status: outcome.status, result: outcome }
      },
    })
  }

  const hcCfg = cronCfgByName.get("nightly-health-check")
  if (hcCfg) {
    cronJobs.push({
      name: "nightly-health-check",
      cron: hcCfg.cron,
      timezone: hcCfg.timezone,
      windowMinutes: hcCfg.windowMinutes,
      timeoutSeconds: hcCfg.timeoutSeconds,
      run: async () => ({ status: "ok", result: await healthCheck.run() }),
    })
  }

  const vacuumCfg = cronCfgByName.get("nightly-vacuum")
  if (vacuumCfg) {
    cronJobs.push({
      name: "nightly-vacuum",
      cron: vacuumCfg.cron,
      timezone: vacuumCfg.timezone,
      windowMinutes: vacuumCfg.windowMinutes,
      timeoutSeconds: vacuumCfg.timeoutSeconds,
      run: async () => ({ status: "ok", result: vacuum.run() }),
    })
  }

  const wddCfg = cronCfgByName.get("weekly-draft-digest")
  if (wddCfg) {
    cronJobs.push({
      name: "weekly-draft-digest",
      cron: wddCfg.cron,
      timezone: wddCfg.timezone,
      windowMinutes: wddCfg.windowMinutes,
      timeoutSeconds: wddCfg.timeoutSeconds,
      run: async () => ({ status: "ok", result: await draftDigest.run() }),
    })
  }

  const driftCfg = cronCfgByName.get("drift-detector")
  if (driftCfg) {
    cronJobs.push({
      name: "drift-detector",
      cron: driftCfg.cron,
      timezone: driftCfg.timezone,
      windowMinutes: driftCfg.windowMinutes,
      timeoutSeconds: driftCfg.timeoutSeconds,
      run: async () => ({ status: "ok", result: await drift.run() }),
    })
  }

  const snapshotCfg = cronCfgByName.get("monthly-snapshot")
  if (snapshotCfg) {
    cronJobs.push({
      name: "monthly-snapshot",
      cron: snapshotCfg.cron,
      timezone: snapshotCfg.timezone,
      windowMinutes: snapshotCfg.windowMinutes,
      timeoutSeconds: snapshotCfg.timeoutSeconds,
      run: async () => ({ status: "ok", result: await snapshot.run() }),
    })
  }

  const archiveCfg = cronCfgByName.get("archive-yearly-sessions")
  if (archiveCfg) {
    cronJobs.push({
      name: "archive-yearly-sessions",
      cron: archiveCfg.cron,
      timezone: archiveCfg.timezone,
      windowMinutes: archiveCfg.windowMinutes,
      timeoutSeconds: archiveCfg.timeoutSeconds,
      run: async () => ({ status: "ok", result: await archive.run() }),
    })
  }

  // ── startup jobs (1) ─────────────────────────────────────────────────
  const reconcilerCfg = startupCfgByName.get("startup-reconciler")
  if (reconcilerCfg) {
    startupJobs.push({
      name: "startup-reconciler",
      timeoutSeconds: reconcilerCfg.timeoutSeconds,
      run: async () => ({ status: "ok", result: reconciler.reconcile() }),
    })
  }

  // ── event-driven jobs (3) ────────────────────────────────────────────
  if (watcher) {
    eventDrivenJobs.push({
      name: "docs-watcher",
      start: () => watcher.start(),
      stop: () => watcher.stop(),
    })
  }
  eventDrivenJobs.push({
    name: "wiki-compiler-debounce",
    start: () => {},
    stop: () => debounce.stop(),
  })
  eventDrivenJobs.push({
    name: "chained-alert-notifier",
    start: () => {},
    stop: () => {},
  })

  // 5. 实例化 SchedulerRuntime + start
  const runtime = new SchedulerRuntime({
    leaderAlias: buildLeaderAlias(),
    leaseRepo,
    cronJobs,
    startupJobs,
    eventDrivenJobs,
    rootDir,
    defaultTimezone: config.defaultTimezone,
    alertRoom,
    pushAlert: opts.pushAlert
      ? async (trace) => {
          await opts.pushAlert?.(trace)
        }
      : undefined,
    logger: opts.log,
  })
  await runtime.start()
  opts.log.info(
    {
      leaderAlias: buildLeaderAlias(),
      cronJobs: cronJobs.length,
      startupJobs: startupJobs.length,
      eventDrivenJobs: eventDrivenJobs.length,
      configSource: config.source,
    },
    "F027 P20 scheduler go-live",
  )
  return runtime
}

// ── private helpers ────────────────────────────────────────────────────

function indexCronJobs(config: SchedulerConfig): Map<string, ScheduledJobConfig> {
  const map = new Map<string, ScheduledJobConfig>()
  for (const j of config.scheduled) {
    if (j.kind === "cron") map.set(j.name, j)
  }
  return map
}

function indexJobsByKind(
  config: SchedulerConfig,
  kind: ScheduledJobConfig["kind"],
): Map<string, ScheduledJobConfig> {
  const map = new Map<string, ScheduledJobConfig>()
  for (const j of config.scheduled) {
    if (j.kind === kind) map.set(j.name, j)
  }
  return map
}

function buildLeaderAlias(): string {
  // 范-r1 P3-4 备注：单 process 模型用 hostname+pid 区分实例。
  // **容器场景（k8s pod）**：hostname=pod name + pid=1 通常稳定；副本扩缩容时不同 pod 自然有不同 hostname。
  // **cluster mode（node cluster / pm2 多 worker）**：master + workers 共享 hostname 但 pid 不同，会各自尝试 acquire lease；
  //   预期只有 1 个 worker 当选 leader（CompilerLeaderRepository 已实现 CAS 抢占），其余走 follower。
  return `${os.hostname()}-${process.pid}`
}

/**
 * 测试 / 调试用：暴露给 multiAgentContext 让集成测试 / panel API 拿运行时实例。
 *
 * 生产路径不直接用；onClose hook 由 caller 显式 wire。
 */
export type { SchedulerRuntime } from "../services/scheduler/scheduler-runtime"
