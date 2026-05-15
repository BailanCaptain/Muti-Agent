/**
 * F027 P19.11 · DriftDetector (cron 0 10 * * 1 Asia/Shanghai)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-13 + V16.5 chap
 * line 1502-1515（Drift Policy）+ line 1811
 *
 * 职责：每周一 10:00 扫 3 类 drift trigger，每个 trigger 自动开一个 update draft：
 *   - new_lesson      — 新 LL-XXX 加入 → 检查 agent top_risks 更新
 *   - model_upgrade   — 模型升级（Claude 4.6 → 4.7）→ capability_digest review
 *   - handoff_failure — handoff 失败 retrospect → 自动开 update draft
 *
 * 职责（Day 13 detection 逻辑壳；scan/open 由 caller 注入）：
 *   - scanTriggers() 返当前所有未处理的 drift trigger
 *   - openUpdateDraft(draft) 真开 draft（caller 串 wiki ingest / task 创建）
 *   - 本类只做 trigger → draft stub 映射；纯逻辑可单测
 *
 * 更新流程（V16.5 chap line 1512）：draft 提交者 = 本人 agent；reviewer =
 * 另一 agent；promoter = 小孙。本类只负责"开 draft"这一步。
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export type DriftTriggerKind = "new_lesson" | "model_upgrade" | "handoff_failure"

export interface DriftTrigger {
  kind: DriftTriggerKind
  /** 触发源标识：LL-031 / claude-opus-4-7 / handoff-<id> 等。 */
  ref: string
  /** 人类可读描述。 */
  detail: string
}

export interface DriftUpdateDraft {
  trigger: DriftTrigger
  /** 建议更新的目标 wiki 区域（caller 决定真实落盘 path）。 */
  targetArea: string
  /** draft 标题。 */
  title: string
  /** draft body（markdown）。 */
  body: string
}

export interface DriftDetectorOptions {
  /** Caller-injected scanner; 返当前未处理的 drift trigger 列表。 */
  scanTriggers: () => Promise<DriftTrigger[]>
  /**
   * Caller-injected draft opener; 真开 update draft。
   * 不注入时 result 仍记录应开的 draft（dry-run / 测试模式）。
   */
  openUpdateDraft?: (draft: DriftUpdateDraft) => Promise<void>
  /** Inject clock (testing); 默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
}

export interface DriftDetectionResult {
  scannedAt: string
  triggers: DriftTrigger[]
  draftsOpened: DriftUpdateDraft[]
  /** openUpdateDraft 抛错的 trigger（draft 未成功开）。 */
  failed: { trigger: DriftTrigger; error: string }[]
}

export class DriftDetector {
  private readonly opts: DriftDetectorOptions
  private readonly log: FastifyBaseLogger
  private readonly clock: () => Date

  constructor(opts: DriftDetectorOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger("drift-detector")
    this.clock = opts.clock ?? (() => new Date())
  }

  async run(): Promise<DriftDetectionResult> {
    const triggers = await this.opts.scanTriggers()
    const draftsOpened: DriftUpdateDraft[] = []
    const failed: { trigger: DriftTrigger; error: string }[] = []

    for (const trigger of triggers) {
      const draft = buildUpdateDraft(trigger)
      if (this.opts.openUpdateDraft) {
        try {
          await this.opts.openUpdateDraft(draft)
          draftsOpened.push(draft)
        } catch (err) {
          const error = (err as Error).message
          this.log.warn({ err, trigger }, "openUpdateDraft threw")
          failed.push({ trigger, error })
        }
      } else {
        // dry-run：无 opener，仅记录
        draftsOpened.push(draft)
      }
    }

    const result: DriftDetectionResult = {
      scannedAt: this.clock().toISOString(),
      triggers,
      draftsOpened,
      failed,
    }
    this.log.info(
      { triggers: triggers.length, opened: draftsOpened.length, failed: failed.length },
      "drift detection done",
    )
    return result
  }
}

/** trigger → update draft stub 映射（按 kind 决定 targetArea / title / body）。 */
export function buildUpdateDraft(trigger: DriftTrigger): DriftUpdateDraft {
  switch (trigger.kind) {
    case "new_lesson":
      return {
        trigger,
        targetArea: "agent top_risks",
        title: `Drift: new lesson ${trigger.ref} → review agent top_risks`,
        body: [
          `# Drift Update Draft — new lesson ${trigger.ref}`,
          "",
          `Trigger: 新 lesson \`${trigger.ref}\` 加入。`,
          `Detail: ${trigger.detail}`,
          "",
          "Action: 检查相关 agent 的 top_risks 是否需要更新以反映此 lesson。",
        ].join("\n"),
      }
    case "model_upgrade":
      return {
        trigger,
        targetArea: "capability_digest",
        title: `Drift: model upgrade ${trigger.ref} → review capability_digest`,
        body: [
          `# Drift Update Draft — model upgrade ${trigger.ref}`,
          "",
          `Trigger: 模型升级到 \`${trigger.ref}\`。`,
          `Detail: ${trigger.detail}`,
          "",
          "Action: review capability_digest，更新模型能力 / 限制描述。",
        ].join("\n"),
      }
    case "handoff_failure":
      return {
        trigger,
        targetArea: "handoff retrospect",
        title: `Drift: handoff failure ${trigger.ref} → retrospect`,
        body: [
          `# Drift Update Draft — handoff failure ${trigger.ref}`,
          "",
          `Trigger: handoff 失败 \`${trigger.ref}\`。`,
          `Detail: ${trigger.detail}`,
          "",
          "Action: retrospect 此次 handoff 失败，更新协作流程 / capability registry。",
        ].join("\n"),
      }
  }
}
