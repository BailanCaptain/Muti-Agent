/**
 * F027 Phase 3 P20 · AdaptiveRecallCoordinator — Week 2 Day 7-8 a (AC-P3-9 a)
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 2 Day 7-8
 *   + Phase 1 P13 AdaptiveRecallExecutor (packages/api/src/wiki/adaptive-recall/executor.ts)
 *   + V16.5 chap 12 行 1367-1444
 *
 * 职责（"orchestrator 接 executeAdaptiveRecall 调用点"）:
 *   - 包装 executeAdaptiveRecall + per-turn budget 默认配置
 *   - scenario gating：只在 wake_up / a2a_handoff 触发（session_bootstrap 已有 P11 Pack）
 *   - disabled 态 passthrough：未启用时把 caller 已有的 taskMemoryPackHits 透传出去
 *   - fail-soft：executor 抛错不阻塞 prompt 组装，passthrough taskMemoryPackHits + log warn
 *
 * Day 7-8 a 范围 = 仅 wiring + 配置层：
 *   - Coordinator 默认 enabled=false（boot 时注入 noop 实例）
 *   - 真启用 + ExecutorDeps（critique LLM / level2-4 backend / Level5Sink）由 Phase 4 接入
 *   - prompt_audit 9 字段写入是 Day 8 b（Coordinator 输出含 output 供 Day 8 b 读）
 *   - Level5Sink 生产实现是 Day 9 c（Coordinator config.executorDeps.level5 接 noop / stub）
 *
 * 不做（Day 7-8 a 范围外）：
 *   - 不调真 Critique LLM（caller 注入 stub）
 *   - 不写 prompt_audit（Day 8 b）
 *   - 不实现 Level5Sink 生产（Day 9 c）
 *   - 不接 RoomCompiler（Day 8 b 时 prompt_audit 写入需要时一并）
 *
 * caller 接通模式（参考 message-service.ts A2A 路径）：
 *   const result = await coordinator.executeIfNeeded({roomId, alias, scenario, trigger, query, taskMemoryPackHits})
 *   const assembled = await assemblePrompt({
 *     ...,
 *     scenario,
 *     memoryPreflight: result.hits.length > 0 ? { hits: toAssemblePromptHits(result.hits) } : null,
 *   })
 */

import { executeAdaptiveRecall } from "../wiki/adaptive-recall/executor"
import { DEFAULT_RECALL_BUDGET } from "../wiki/adaptive-recall/types"
import type { ExecuteOutput, ExecutorDeps, RecallBudget } from "../wiki/adaptive-recall/types"
import type { RecallHit } from "../wiki/memory-preflight/types"

/** 触发 recall 的 scenario 白名单。 */
export type RecallScenario = "session_bootstrap" | "wake_up" | "a2a_handoff" | "direct_turn"

const DEFAULT_TRIGGER_SCENARIOS: ReadonlyArray<RecallScenario> = ["wake_up", "a2a_handoff"]

export interface RecallCoordinatorInput {
  roomId: string
  alias: string
  scenario: RecallScenario
  /**
   * 触发原因 — caller 派生（如 "a2a_call", "wake_up_history_keyword", "user_mention"）。
   * 透传给 executeAdaptiveRecall + 写入 prompt_audit.recall_trigger（Day 8 b）。
   */
  trigger: string
  /** 召回主题 query — caller 派生（agent draft 摘要 / capability digest / task 文本）。 */
  query: string
  /** P11 loadTaskMemoryPack 输出的 hits（作 L1 input；可空）。 */
  taskMemoryPackHits?: ReadonlyArray<RecallHit>
  /** 单次调用 budget override（默认走 config.defaultBudget）。 */
  budgetOverride?: Partial<RecallBudget>
}

export type RecallCoordinatorReason =
  | "disabled"
  | "scenario_skip"
  | "deps_missing"
  | "executor_error"
  | "ok"

export interface RecallCoordinatorResult {
  /** true = executor 真跑了一次；false = 走 passthrough。 */
  executed: boolean
  /** 未 executed 时的具体原因 + executed=true 时固定 "ok"。 */
  reason: RecallCoordinatorReason
  /**
   * 出 hits：
   *   - executed=true → executor 输出 hits
   *   - executed=false → input.taskMemoryPackHits 透传（caller 接 memoryPreflight 不丢上下文）
   */
  hits: ReadonlyArray<RecallHit>
  /** Executor 输出（executed=true 时非空）— Day 8 b prompt_audit 写入用。 */
  output?: ExecuteOutput
  /** Executor 抛错（reason=executor_error 时非空）— 仅 log，不阻塞 prompt 组装。 */
  error?: Error
}

export interface AdaptiveRecallCoordinatorConfig {
  /**
   * 启用开关。Day 7-8 a 默认 false — 仅 wiring + scenario 识别 + budget 注入到位，
   * 不真触发 LLM call（Critique Agent + level backend 需 Phase 4 接通）。
   * Phase 4 接 backend 后 server.ts 切 enabled=true。
   */
  enabled?: boolean
  /**
   * 触发 scenario 白名单。默认 ['wake_up', 'a2a_handoff']。
   *   - 'session_bootstrap' 已由 P11 loadTaskMemoryPack 覆盖（冷启 prompt 已含 Pack）
   *   - 'direct_turn' 默认不触发（user → agent 单次问答场景）
   */
  triggerScenarios?: ReadonlyArray<RecallScenario>
  /** Default budget — caller per-turn 可以 budgetOverride。默认 P13 DEFAULT_RECALL_BUDGET。 */
  defaultBudget?: Partial<RecallBudget>
  /** Executor deps（critique + level2-4 + level5 sink）。enabled=true 时必传。 */
  executorDeps?: ExecutorDeps
  /** 注入 executeAdaptiveRecall（测试用；默认走真实模块）。 */
  executor?: typeof executeAdaptiveRecall
  /** Logger（warn 用；fail-soft + skip 路径都需要可观测）。 */
  logger?: { warn(obj: unknown, msg?: string): void }
}

export class AdaptiveRecallCoordinator {
  private readonly enabled: boolean
  private readonly triggerScenarios: ReadonlyArray<RecallScenario>
  private readonly defaultBudget: Partial<RecallBudget>
  private readonly executorDeps?: ExecutorDeps
  private readonly executor: typeof executeAdaptiveRecall
  private readonly logger?: { warn(obj: unknown, msg?: string): void }

  constructor(config: AdaptiveRecallCoordinatorConfig = {}) {
    this.enabled = config.enabled ?? false
    this.triggerScenarios = config.triggerScenarios ?? DEFAULT_TRIGGER_SCENARIOS
    this.defaultBudget = config.defaultBudget ?? {}
    this.executorDeps = config.executorDeps
    this.executor = config.executor ?? executeAdaptiveRecall
    this.logger = config.logger
  }

  async executeIfNeeded(input: RecallCoordinatorInput): Promise<RecallCoordinatorResult> {
    const passthroughHits = input.taskMemoryPackHits ?? []

    if (!this.enabled) {
      return { executed: false, reason: "disabled", hits: passthroughHits }
    }
    if (!this.triggerScenarios.includes(input.scenario)) {
      return { executed: false, reason: "scenario_skip", hits: passthroughHits }
    }
    if (!this.executorDeps) {
      this.logger?.warn(
        { stage: "adaptive_recall_coordinator", input },
        "AdaptiveRecallCoordinator: enabled=true but executorDeps missing; passthrough",
      )
      return { executed: false, reason: "deps_missing", hits: passthroughHits }
    }

    const mergedBudget: Partial<RecallBudget> = {
      ...this.defaultBudget,
      ...input.budgetOverride,
    }

    try {
      const output = await this.executor(
        {
          roomId: input.roomId,
          alias: input.alias,
          trigger: input.trigger,
          query: input.query,
          taskMemoryPack: input.taskMemoryPackHits,
          budget: mergedBudget,
        },
        this.executorDeps,
      )
      return { executed: true, reason: "ok", hits: output.hits, output }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.logger?.warn(
        {
          stage: "adaptive_recall_coordinator.executor_error",
          err: { name: e.name, message: e.message },
          input,
        },
        "executeAdaptiveRecall threw; fail-soft passthrough",
      )
      return {
        executed: false,
        reason: "executor_error",
        hits: passthroughHits,
        error: e,
      }
    }
  }

  /** 当前生效的默认 budget（merge DEFAULT_RECALL_BUDGET + config.defaultBudget）— 调试 / 测试用。 */
  getEffectiveBudget(): RecallBudget {
    return { ...DEFAULT_RECALL_BUDGET, ...this.defaultBudget }
  }

  /** Coordinator 当前是否启用（boot / health-check / inspector UI 用）。 */
  isEnabled(): boolean {
    return this.enabled
  }
}

/**
 * 默认 noop coordinator（boot 注入；Phase 4 启用真 Coordinator 后替换）。
 *
 * 行为：enabled=false → 永远 passthrough；不调 executor / 不写 audit / 不触发任何 LLM。
 */
export function createNoopAdaptiveRecallCoordinator(): AdaptiveRecallCoordinator {
  return new AdaptiveRecallCoordinator({ enabled: false })
}

/** 派生 scenario → 默认 trigger 字符串（caller 没显式给 trigger 时的兜底）。 */
export function deriveTriggerFromScenario(scenario: RecallScenario): string {
  switch (scenario) {
    case "wake_up":
      return "wake_up"
    case "a2a_handoff":
      return "a2a_call"
    case "session_bootstrap":
      return "session_bootstrap"
    case "direct_turn":
      return "direct_turn"
    default:
      return "unknown"
  }
}
