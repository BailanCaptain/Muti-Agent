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
import yaml from "yaml"
import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface ScheduledJobConfig {
  /** Job name；与 NightlyJobScheduler register() spec.name 对齐。 */
  name: string
  /** croner 兼容 cron 表达式（5/6/7-part）。 */
  cron: string
  /** 时区；默认走 SchedulerConfig.defaultTimezone。 */
  timezone: string
  /** Per-job timeout（秒）；默认 600s（10min）。 */
  timeoutSeconds: number
  /** Window 长度（分钟）；默认 5min（短）/ 30min（长 job）。windowEnd = scheduledFor + windowMinutes。 */
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
 * v2b F3 fallback：无 wiki.config.yaml 时使用，覆盖 P19.6-P19.13 的 7 个 scheduled jobs。
 * 实际 NightlyJobScheduler register 时仍由各 job 落地 commit 注入对应 handler；本表只
 * 决定 cron pattern + tz + timeout/window 默认值。
 *
 * 注：plan §1 称"9 scheduled + 2 event-driven=11"。当前显式列 7 个 scheduled
 * （DAG P19.6/8/9/10/11/12/13）；剩余 2 个 scheduled job 在 Week 4 buffer
 * 阶段补全（如 LeaseHeartbeat 内化为 trace）—— 本 loader 不假设固定 7 个。
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  defaultTimezone: "Asia/Shanghai",
  source: "fallback:default",
  scheduled: [
    {
      name: "room-compiler-tick",
      cron: "*/5 * * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 240,
      windowMinutes: 5,
    },
    {
      name: "nightly-health-check",
      cron: "0 4 * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 600,
      windowMinutes: 30,
    },
    {
      name: "nightly-vacuum",
      cron: "0 5 * * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 1800,
      windowMinutes: 30,
    },
    {
      name: "weekly-draft-digest",
      cron: "0 9 * * 1",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 600,
      windowMinutes: 30,
    },
    {
      name: "drift-detector",
      cron: "0 10 * * 1",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 600,
      windowMinutes: 30,
    },
    {
      name: "monthly-snapshot",
      cron: "0 3 1 * *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 1800,
      windowMinutes: 60,
    },
    {
      name: "archive-yearly-sessions",
      cron: "0 3 1 1 *",
      timezone: "Asia/Shanghai",
      timeoutSeconds: 3600,
      windowMinutes: 60,
    },
  ],
}

export interface LoadSchedulerConfigOptions {
  /** Worktree / 主仓 root；默认 process.cwd()。 */
  rootDir?: string
  /** 测试用：override config 文件路径。 */
  configPath?: string
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
 * v2b F3 / AC-P2-3a 行为：
 *   - 若 wiki.config.yaml 不存在 → 返回 DEFAULT_SCHEDULER_CONFIG（不创建文件）
 *   - 若存在（Gate 2 后 P19.3b 创建）→ 解析 YAML + 校验 + 合并默认
 *
 * **Iron Laws 3**：本函数纯只读，绝不创建 / 修改 wiki.config.yaml。
 */
export function loadSchedulerConfig(opts: LoadSchedulerConfigOptions = {}): LoadResult {
  const log = opts.logger ?? createLogger("scheduler-config")
  const rootDir = opts.rootDir ?? process.cwd()
  const checkedPath = opts.configPath ?? path.join(rootDir, "wiki.config.yaml")

  if (!fs.existsSync(checkedPath)) {
    log.info({ checkedPath, source: DEFAULT_SCHEDULER_CONFIG.source }, "no config file, using fallback default")
    return {
      config: DEFAULT_SCHEDULER_CONFIG,
      fromFile: false,
      checkedPath,
    }
  }

  // P19.3b 路径（Day 3 不预期走到这里 —— Gate 2 未批 时 worktree 不应有 wiki.config.yaml）
  const raw = fs.readFileSync(checkedPath, "utf-8")
  const parsed = parseAndValidateConfig(raw, checkedPath)
  log.info({ checkedPath, jobs: parsed.scheduled.length, source: parsed.source }, "loaded config from file")
  return {
    config: parsed,
    fromFile: true,
    checkedPath,
  }
}

/**
 * v2b F3 helper：测试断言 worktree 根目录不存在 wiki.config.yaml。
 * 任何 P19.3a 测试运行前后都应通过此断言（Iron Laws 3 fail-safe）。
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
    throw new Error(`scheduler-config: YAML parse failed at ${sourcePath}: ${(err as Error).message}`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`scheduler-config: ${sourcePath} must be a YAML object`)
  }
  const obj = parsed as Record<string, unknown>
  const defaultTimezone = typeof obj.defaultTimezone === "string"
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
  return {
    name: j.name,
    cron: j.cron,
    timezone: typeof j.timezone === "string" ? j.timezone : defaultTimezone,
    timeoutSeconds: typeof j.timeoutSeconds === "number" ? j.timeoutSeconds : 600,
    windowMinutes: typeof j.windowMinutes === "number" ? j.windowMinutes : 5,
  }
}

function validateJobCron(job: ScheduledJobConfig): void {
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
