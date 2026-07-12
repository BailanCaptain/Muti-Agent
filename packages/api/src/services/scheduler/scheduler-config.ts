/**
 * F027 P19.3a · ConfigLoader（无文件 fallback 内置默认）
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md §1 Iron Laws 3 gate + AC-P2-3a
 *
 * v2b F3 拆分：
 *   - **P19.3a (本文件)**: loader + 默认 schema + cron 校验 + 时区 + DST 行为；
 *     **无 wiki.config.yaml 文件 → fallback 内置默认调度**；
 *     **断言：测试运行前后 worktree 内 wiki.config.yaml 不存在 / 未被创建**
 *     （绑 Iron Laws 3 gate）
 *   - P19.3b（阻塞）：Gate 2 批准后创建真 wiki.config.yaml
 *
 * 不做：
 *   - 不创建 wiki.config.yaml（Iron Laws 3 红线）
 *   - 不写默认配置到磁盘
 *   - 不依赖 wiki.config.example.yaml（P19.3b 才有）
 *
 * loader 实现完整（含 YAML 解析路径）以便 Gate 2 后 P19.3b 直接接入。
 */

import fs from "node:fs"
import path from "node:path"
import { Cron } from "croner"
import type { FastifyBaseLogger } from "fastify"
import yaml from "yaml"
import { createLogger } from "../../lib/logger"

/**
 * v2b F3 + 范-r1 P1-2：feature.md AC-P2-1 列 9 scheduled jobs，但其中两个不是
 * cron-pattern 的（StartupReconciler one-shot / DocsWatcher fs watcher）。
 * 用 `kind` 区分：
 *   - 'cron'    — croner 周期触发（7 个）
 *   - 'startup' — runtime 起来后跑一次（1 个：StartupReconciler）
 *   - 'watcher' — fs watch / event-driven，本身无周期（1 个：DocsWatcher）
 * spec 把后两者也算"scheduled"做 inventory（健康检查 / panel 列表）。
 */
export type ScheduledJobKind = "cron" | "startup" | "watcher"

export interface ScheduledJobConfig {
  /** Job name；与 NightlyJobScheduler register() spec.name 对齐。 */
  name: string
  /** kind: cron(croner pattern) / startup(one-shot) / watcher(fs/event-driven). 默认 'cron'。 */
  kind: ScheduledJobKind
  /**
   * cron 表达式（kind='cron'）；
   * 'startup' 用 '@startup' 标记；
   * 'watcher' 用 '@watcher' 标记。
   * croner 校验仅对 'cron' kind 生效。
   */
  cron: string
  /** 时区；走 SchedulerConfig.defaultTimezone 默认。non-cron kind 此字段记录但不参与触发。 */
  timezone: string
  /** Per-job timeout（秒）。watcher kind 此字段语义为单次事件处理超时。 */
  timeoutSeconds: number
  /**
   * Window 长度（分钟）。
   * **范-r1 P2-1 修复**：plan §4 锁定 windowEnd = scheduledFor + min(cron_period, 5min)
   * → 默认 5；长任务时长用 timeoutSeconds 表达。non-cron kind windowMinutes=0。
   */
  windowMinutes: number
}

export interface SchedulerConfig {
  /** plan §5 Open#5：默认 Asia/Shanghai。 */
  defaultTimezone: string
  /** Scheduled (cron-based) jobs。 */
  scheduled: ScheduledJobConfig[]
  /** 配置来源标记；'fallback:default' 或 'file:<absolutePath>'。 */
  source: string
}

/**
 * v2b F3 fallback：无 wiki.config.yaml（Iron Laws 3 Gate 2 未批）时使用。
 *
 * **范-r1 P1-2 修复**：feature.md AC-P2-1 锁定 9 scheduled + 2 event-driven，
 * 之前缩成 7 是 spec 漂移。补齐：
 *   - 7 cron jobs（P19.6/8/9/10/11/12/13）
 *   - 1 startup-only job（P19.5 StartupReconciler — runtime 起来跑一次）
 *   - 1 watcher job（P19.7 DocsWatcher — chokidar fs watch，无周期）
 *
 * **范-r1 P2-1 修复**：windowMinutes 全部统一 5（plan §4 锁定 min(cron_period,
 * 5min)）。长任务运行时长用 timeoutSeconds 表达；non-cron kind windowMinutes=0。
 *
 * 实际 NightlyJobScheduler register 时仍由各 job 落地 commit 注入对应 handler；
 * 本表只决定调度元数据（kind / pattern / tz / timeout / window）默认值。
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  defaultTimezone: "Asia/Shanghai",
  source: "fallback:default",
  scheduled: [
    // ── kind: 'cron' (9) ─────────────────────────────────────────────────
    {
      name: "room-compiler-tick",
      kind: "cron",
      cron: "*/5 * * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 240,
      windowMinutes: 5,
    },
    {
      name: "nightly-health-check",
      kind: "cron",
      cron: "0 4 * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 600,
      windowMinutes: 5,
    },
    {
      name: "nightly-vacuum",
      kind: "cron",
      cron: "0 5 * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 1800,
      windowMinutes: 5,
    },
    {
      name: "weekly-draft-digest",
      kind: "cron",
      cron: "0 9 * * 1",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 600,
      windowMinutes: 5,
    },
    {
      name: "drift-detector",
      kind: "cron",
      cron: "0 10 * * 1",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 600,
      windowMinutes: 5,
    },
    {
      name: "monthly-snapshot",
      kind: "cron",
      cron: "0 3 1 * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 1800,
      windowMinutes: 5,
    },
    {
      name: "archive-yearly-sessions",
      kind: "cron",
      cron: "0 3 1 1 *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 3600,
      windowMinutes: 5,
    },
    // F037 日报：07:30 主发送 + 每小时安全网（reconcile 幂等单入口，D11 触发点 ①③)。
    // 看门狗 7200s：须高于全链真实最坏才不产生假 timeout/幽灵任务。最坏有界路径
    // （顺序腿相加；源阶段并发取 max。07-11 三拍 r1 P2-2 德彪重算——此前 4920 账
    // 漏了并发源 max=podcast、YouTube 字幕超时腿、SMTP）：
    //   源阶段 max = 播客 STT 预算 900s（podcast.ts timeoutBudgetMs；X 540 次之）
    // + summarize 4 尝试×2 模型×360s = 2880s（小孙 07-11 拍「重试 3 次宁缺勿发清单版」）
    // + 深读 3 抓×(字幕 90s 超时+429 退避 30s+重试 90s)=630s + LLM 2×360s=720s → 1350s
    //   （07-12 字幕命中率批：429 退避重试一次；单条 210s 已盖过非 yt 的 20s http 回落腿）
    // + 翻译 2×360s = 720s
    // + SMTP 发送总 deadline 120s（email-sender SMTP_SEND_DEADLINE_MS——r2 P2-2：三段
    //   nodemailer 超时是分段/无活动窗不是总时限，真上限=sendMail 外层 race+到点关连接）
    // = 5970s；取 7200s 留余量（每腿自有硬超时，链不可能真挂死；看门狗只为逻辑级挂死兜底）。
    // 改任何一腿的超时/尝试次数必须重算这笔账——scheduler-config.test 账目关系测试会咬
    {
      name: "daily-digest",
      kind: "cron",
      cron: "30 7 * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 7200,
      windowMinutes: 5,
    },
    {
      name: "daily-digest-reconcile",
      kind: "cron",
      cron: "10 * * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 7200,
      windowMinutes: 5,
    },
    // ── kind: 'startup' (2) — runtime 起来后跑一次 ───────────────────────
    {
      name: "startup-reconciler",
      kind: "startup",
      cron: "@startup",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 60,
      windowMinutes: 0,
    },
    // F037 日报：进程启动补发（机器 07:30 不在线场景，D11 触发点 ②）
    {
      name: "daily-digest-startup",
      kind: "startup",
      cron: "@startup",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 7200,
      windowMinutes: 0,
    },
    // ── kind: 'watcher' (1) — fs watch，无周期 ──────────────────────────
    {
      name: "docs-watcher",
      kind: "watcher",
      cron: "@watcher",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 30,
      windowMinutes: 0,
    },
  ],
}

export interface LoadSchedulerConfigOptions {
  /** Worktree / 主仓 root；默认 process.cwd()。 */
  rootDir?: string
  /** 测试用：override config 文件路径（不绑 Iron Laws 3 fail-safe）。 */
  configPath?: string
  /**
   * **范-r1 P1-1 修复**：v2b F3 + Iron Laws 3 fail-safe gate2Approved 开关。
   *
   * - false (默认)：worktree 根 wiki.config.yaml 存在即 throw，绝不加载真文件
   *   （即使有人偷偷创建文件也挡住，强制走 fallback）。
   * - true：spec 流程 Gate 2 已批准，loader 才会真读 wiki.config.yaml。
   *
   * configPath override 路径不受此 gate 约束（测试 / 开发 inline yaml 走自定义路径）。
   */
  gate2Approved?: boolean
  logger?: FastifyBaseLogger
}

export interface LoadResult {
  config: SchedulerConfig
  /** true = 真文件加载；false = fallback 默认。 */
  fromFile: boolean
  /** 检查路径（可能不存在）。 */
  checkedPath: string
}

/**
 * 加载 scheduler 配置。
 *
 * v2b F3 / AC-P2-3a + 范-r1 P1-1 行为：
 *   - opts.configPath 注入（测试 / 开发 inline yaml）→ 直接走 YAML 解析路径，不锁
 *   - 否则查 `<rootDir>/wiki.config.yaml`：
 *     - **gate2Approved=false (默认)**：文件存在则 throw（Iron Laws 3 fail-safe，
 *       防偷偷创建绕过 Gate 2）；不存在则走 fallback default。
 *     - gate2Approved=true：文件存在则 YAML 解析；不存在则 fallback default。
 *
 * **Iron Laws 3**：本函数纯只读，绝不创建 / 修改 wiki.config.yaml。
 */
export function loadSchedulerConfig(opts: LoadSchedulerConfigOptions = {}): LoadResult {
  const log = opts.logger ?? createLogger("scheduler-config")
  const rootDir = opts.rootDir ?? process.cwd()
  const isExplicitPath = !!opts.configPath
  const checkedPath = opts.configPath ?? path.join(rootDir, "wiki.config.yaml")

  // 范-r1 P1-1：root 默认路径走 Iron Laws 3 fail-safe；configPath 注入跳过此 gate
  if (!isExplicitPath && fs.existsSync(checkedPath) && !opts.gate2Approved) {
    throw new Error(
      `Iron Laws 3 violation: wiki.config.yaml exists at ${checkedPath} ` +
        "but gate2Approved=false; pass gate2Approved:true to override " +
        "(see F027 feature.md:292-294, plan §1 Iron Laws 3 gate)",
    )
  }

  if (!fs.existsSync(checkedPath)) {
    log.info(
      { checkedPath, source: DEFAULT_SCHEDULER_CONFIG.source },
      "no config file, using fallback default",
    )
    return {
      config: DEFAULT_SCHEDULER_CONFIG,
      fromFile: false,
      checkedPath,
    }
  }

  // P19.3b 路径（Day 3 不预期走到这里 —— Gate 2 未批 时 worktree 不应有 wiki.config.yaml）
  const raw = fs.readFileSync(checkedPath, "utf-8")
  const parsed = parseAndValidateConfig(raw, checkedPath)
  log.info(
    { checkedPath, jobs: parsed.scheduled.length, source: parsed.source },
    "loaded config from file",
  )
  return {
    config: parsed,
    fromFile: true,
    checkedPath,
  }
}

/**
 * v2b F3 helper：测试断言 worktree 根目录**root-only**不存在 wiki.config.yaml。
 *
 * 任何 P19.3a 测试运行前后都应通过此断言（Iron Laws 3 fail-safe）。
 *
 * **范-r1 P2-4 修复**：明确合同为 root-only（**不**做 recursive 扫描）。理由：
 *   - P19.3b 真文件就该在 worktree 根（spec 约定单一 wiki.config.yaml 位置）
 *   - 子目录测试垃圾（`.runtime/test/wiki.config.yaml` 等）不算违反 Iron Laws 3
 *   - recursive 扫描会被 node_modules / .runtime 等目录拖累且误报多
 *
 * 如未来需要更严格（例如 CI 全树扫），新增 `assertNoConfigFileRecursive` 别函数。
 */
export function assertNoConfigFile(rootDir: string, configBasename = "wiki.config.yaml"): void {
  const p = path.join(rootDir, configBasename)
  if (fs.existsSync(p)) {
    throw new Error(
      `Iron Laws 3 violation: ${configBasename} exists at ${p}; ` +
        "Gate 2 not yet approved (see F027 feature.md:292-294)",
    )
  }
}

// ── private ────────────────────────────────────────────────────────────

function parseAndValidateConfig(raw: string, sourcePath: string): SchedulerConfig {
  let parsed: unknown
  try {
    parsed = yaml.parse(raw)
  } catch (err) {
    throw new Error(
      `scheduler-config: YAML parse failed at ${sourcePath}: ${(err as Error).message}`,
    )
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`scheduler-config: ${sourcePath} must be a YAML object`)
  }
  const obj = parsed as Record<string, unknown>
  const defaultTimezone =
    typeof obj.defaultTimezone === "string"
      ? obj.defaultTimezone
      : DEFAULT_SCHEDULER_CONFIG.defaultTimezone

  const rawScheduled = obj.scheduled
  if (!Array.isArray(rawScheduled)) {
    throw new Error(`scheduler-config: 'scheduled' must be an array at ${sourcePath}`)
  }
  const scheduled: ScheduledJobConfig[] = rawScheduled.map((j, idx) =>
    normalizeJob(j, idx, defaultTimezone, sourcePath),
  )
  // 验证 cron + tz
  for (const job of scheduled) {
    validateJobCron(job)
  }
  return {
    defaultTimezone,
    scheduled,
    source: `file:${sourcePath}`,
  }
}

function normalizeJob(
  raw: unknown,
  idx: number,
  defaultTimezone: string,
  sourcePath: string,
): ScheduledJobConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`scheduler-config: scheduled[${idx}] must be object at ${sourcePath}`)
  }
  const j = raw as Record<string, unknown>
  if (typeof j.name !== "string" || j.name.length === 0) {
    throw new Error(`scheduler-config: scheduled[${idx}].name required at ${sourcePath}`)
  }
  if (typeof j.cron !== "string" || j.cron.length === 0) {
    throw new Error(`scheduler-config: ${j.name}.cron required`)
  }
  // 范-r1 P1-2: kind 字段，默认 'cron'
  const kindRaw = typeof j.kind === "string" ? j.kind : "cron"
  if (kindRaw !== "cron" && kindRaw !== "startup" && kindRaw !== "watcher") {
    throw new Error(
      `scheduler-config: ${j.name}.kind must be 'cron'|'startup'|'watcher', got '${kindRaw}'`,
    )
  }
  return {
    name: j.name,
    kind: kindRaw,
    cron: j.cron,
    timezone: typeof j.timezone === "string" ? j.timezone : defaultTimezone,
    timeoutSeconds: typeof j.timeoutSeconds === "number" ? j.timeoutSeconds : 600,
    // 范-r1 P2-1: 默认 5min；non-cron kind 默认 0
    windowMinutes:
      typeof j.windowMinutes === "number" ? j.windowMinutes : kindRaw === "cron" ? 5 : 0,
  }
}

function validateJobCron(job: ScheduledJobConfig): void {
  // 范-r1 P1-2: non-cron kind 跳过 croner 校验
  if (job.kind !== "cron") return
  try {
    // croner 构造时 paused:true 不挂 timer，纯做语法 + tz 校验
    new Cron(job.cron, { name: `validate-${job.name}`, timezone: job.timezone, paused: true })
  } catch (err) {
    throw new Error(
      `scheduler-config: ${job.name} invalid cron '${job.cron}' tz='${job.timezone}': ` +
        (err as Error).message,
    )
  }
}
