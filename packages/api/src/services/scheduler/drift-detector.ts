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

import { createHash } from "node:crypto"
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
  /** Caller-injected scanner; 返当前 drift trigger 列表。 */
  scanTriggers: () => Promise<DriftTrigger[]>
  /**
   * Caller-injected draft opener; 真开 update draft。
   * 不注入时 result 仍记录应开的 draft（dry-run / 测试模式）。
   */
  openUpdateDraft?: (draft: DriftUpdateDraft) => Promise<void>
  /**
   * **范-r1 P2-2 修复**：已处理过的 trigger key 集合（`<kind>:<ref>` 格式）。
   *
   * caller 注入跨 run 持久化的已处理集合（如上周已开过 draft 的 trigger）。
   * run() 跳过这些 trigger，避免同一 LL-XXX 连续多周重复开 draft → draft 泛滥。
   *
   * 另外 run() 内部也对**本次 scan 返回的重复 trigger**做 in-run 去重
   * （同 kind:ref 出现多次只开一个 draft）。
   *
   * 默认 (undefined): 不做跨 run 去重（仅 in-run 去重）。
   */
  processedTriggerKeys?: Set<string>
  /** Inject clock (testing); 默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
}

/** trigger 唯一 key：`<kind>:<ref>`。去重 + processed 集合用。 */
export function driftTriggerKey(t: DriftTrigger): string {
  return `${t.kind}:${t.ref}`
}

export interface DriftDetectionResult {
  scannedAt: string
  /** scanTriggers 返回的原始 trigger（含重复 / 已处理）。 */
  triggers: DriftTrigger[]
  draftsOpened: DriftUpdateDraft[]
  /** openUpdateDraft 抛错的 trigger（draft 未成功开）。 */
  failed: { trigger: DriftTrigger; error: string }[]
  /** 范-r1 P2-2: 因已处理 / 本次重复而 skip 的 trigger 数。 */
  skippedDuplicate: number
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
    let skippedDuplicate = 0

    // 范-r1 P2-2: 跨 run（caller 注入）+ in-run 去重
    const seen = new Set<string>(this.opts.processedTriggerKeys ?? [])

    for (const trigger of triggers) {
      const key = driftTriggerKey(trigger)
      if (seen.has(key)) {
        skippedDuplicate += 1
        continue
      }
      seen.add(key) // in-run 去重：同次 scan 重复的后续也 skip

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
      skippedDuplicate,
    }
    this.log.info(
      {
        triggers: triggers.length,
        opened: draftsOpened.length,
        failed: failed.length,
        skippedDuplicate,
      },
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

// ── 收尾修1 · drift draft 落盘 + 跨 run dedup helper ───────────────────────
//
// openUpdateDraft 把 drift trigger 写成 `_auto/` draft（轻路径：sanitize + updateWiki，
// 不走 LLM 编译——drift draft 是系统生成的 TODO stub，不是需编译的知识实体）。
// wiki_events.reason 写 `drift:<kind>:<ref>` 精确编码 trigger key——跨 run dedup 直接读
// reason 反解（避开 basename `drift-<kind>-<ref>` 的 kind 含_/ref 含- 反解歧义，设计审 critique P1）。

/** drift draft 的 wiki_events.reason 前缀。dedup 按此前缀扫已开 draft。 */
export const DRIFT_DRAFT_REASON_PREFIX = "drift:"

/**
 * drift draft 落盘的 alias + 目录——opener 写入、scanner dedup 反查的**单一真相**。
 * 德彪 r1 P2：dedup 必须用 alias+path 双约束，否则任何 committed event 复用 `drift:` reason
 * 就能永久压掉真 trigger（reason 命名空间污染）。
 */
export const DRIFT_DETECTOR_ALIAS = "drift-detector"
export const DRIFT_DRAFT_DIR = "wiki/concepts/draft/_auto"

/** trigger → wiki_events.reason（精确编码 key，dedup 反解用）。 */
export function driftDraftReason(trigger: DriftTrigger): string {
  return `${DRIFT_DRAFT_REASON_PREFIX}${driftTriggerKey(trigger)}`
}

/** 从 wiki_events.reason 反解 trigger key（非 drift draft → null）。与 driftDraftReason 严格互逆。 */
export function parseDriftDraftReasonKey(reason: string | null | undefined): string | null {
  if (typeof reason !== "string" || !reason.startsWith(DRIFT_DRAFT_REASON_PREFIX)) return null
  const key = reason.slice(DRIFT_DRAFT_REASON_PREFIX.length)
  return key.length > 0 ? key : null
}

/**
 * trigger → draft 文件 basename。ref 清洗 `[^a-zA-Z0-9_-]→_` 防路径注入（handoff call_id 可含
 * 任意字符）。
 *
 * 德彪 r1 P1：单纯清洗会碰撞——`a:b` 与 `a/b` 都 →`a_b` → 同路径，第二个 trigger 用 baseHash:null
 * 新建只会持续 CAS conflict 永不进审批队列。附**原始 key 的短 hash** 保证路径单射（dedup 仍走
 * wiki_events.reason 精确编码，与 basename 解耦，故加 hash 不影响去重）。
 */
export function driftDraftBasename(trigger: DriftTrigger): string {
  const safeRef = trigger.ref.replace(/[^a-zA-Z0-9_-]/g, "_")
  const keyHash = createHash("sha256").update(driftTriggerKey(trigger)).digest("hex").slice(0, 8)
  return `drift-${trigger.kind}-${safeRef}-${keyHash}`
}

/**
 * 收尾修1 · drift 告警（独立 shape，**不复用 ChainedAlert**——那是 chained_suspect 专用语义，
 * 设计审 critique P2）。drift.run 开了 draft / 有失败时，cron 旁路推此告警。
 *
 * ⚠️ 诚实：当前后端 scheduler.* ws 事件全库无 UI consumer（与既有 scheduler.alert 同档）→ 本告警
 * 推到 ws 线但暂不到小孙屏幕。**小孙真看得到的信号 = drift draft 进审批队列**（openUpdateDraft 落 _auto/）。
 * ws 端到端 UI 落地是独立 follow-up（前端 RealtimeServerEvent union + handler）。
 */
export interface DriftAlert {
  scannedAt: string
  draftsOpened: number
  failed: number
  /** 开出的 draft 标题（= 审批队列里小孙看到的条目）。 */
  draftTitles: string[]
  targetRoom: string
}

export function buildDriftAlert(result: DriftDetectionResult, targetRoom: string): DriftAlert {
  return {
    scannedAt: result.scannedAt,
    draftsOpened: result.draftsOpened.length,
    failed: result.failed.length,
    draftTitles: result.draftsOpened.map((d) => d.title),
    targetRoom,
  }
}
