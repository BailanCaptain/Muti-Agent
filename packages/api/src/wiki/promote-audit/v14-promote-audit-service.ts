/**
 * F027 Phase 4 AC-P4-1 b · V14 Tainted_source promote 二次审计 service
 *
 * 真相源: docs/plans/V16.5-final.md line 838-846 (Tainted_source promote 二次审计)
 *
 * Spec (V16.5 line 840-846) promote 前二次审计：
 *   1. entity body 是否含命令式语句（"必须/忽略/覆盖" 等 + **上下文**）
 *   2. body 是否含 prompt 结构（`system:` 等）
 *   3. body 是否引用 tainted_source 字段（必须改写为陈述句，不能直引）
 *
 * 【posture C · 收尾】小孙拍：spec 第 1 步「命令式语句 + 上下文」regex 读不了「上下文/意图」
 *   —— 旧版 imperative 子串匹配（必须/ignore/must）把任何含这些词的正常自指 wiki 文档全拦
 *   （小孙 41 篇 _auto draft 全挂，r1-r3 三轮证明 regex 收敛不了）。改为 **LLM 语义判官**
 *   读意图（v14-llm-judge.ts），复用 wikiCompile 可配模型（createDynamicWikiCompileRunner）。
 *
 * 分层（廉价确定性 → 语义）：
 *   - prompt_structure（字面 system:/[INST]/im_start 标记，686 canonical 实测 0-FP）
 *   - tainted_source_direct_quote（substring 比对，确定性）
 *   - llm_semantic_injection（LLM 判官读意图，取代旧 imperative regex 层）
 *
 * 两个入口（设计审 critique P1）：
 *   - auditStructural(input)：**同步**，只跑结构层 + tainted 层（确定性、0 LLM）。给
 *     preview / 审批列表 on-mount 做即时禁用判断，不每次挂载烧 LLM。
 *   - audit(input)：**async**，结构层 → tainted 层 → LLM judge 层。真 promote/batch 的权威裁决。
 *
 * 失败语义 (plan v5 AC-P4-2)：reject reason 标 layer + matched patterns + hint。
 *   judge 三态：llm_semantic_injection（真注入，需改写）/ judge_parse_failed /
 *   judge_unavailable（后两者是基础设施可重试，**不 fail-open**）。
 */

import type { HaikuRunner } from "../../runtime/haiku-runner"
import { createDynamicWikiCompileRunner } from "../../runtime/wiki-compile-runner"
import { type JudgeOutcome, runJudge } from "./v14-llm-judge"

const PROMPT_STRUCTURE_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /(^|\n)\s*system\s*[:：]/i, label: "system: 行" },
  { pattern: /(^|\n)\s*assistant\s*[:：]/i, label: "assistant: 行" },
  { pattern: /(^|\n)\s*user\s*[:：]/i, label: "user: 行" },
  { pattern: /<\s*system\s*>/i, label: "<system> 标签" },
  { pattern: /<\s*\/?\s*(im_start|im_end)\s*\|?>/i, label: "im_start/im_end 标记" },
  { pattern: /\[\s*INST\s*\]/i, label: "[INST] 标记" },
  { pattern: /\|\s*im_start\s*\|/i, label: "|im_start| 边界" },
] as const

const MIN_TAINTED_DIRECT_QUOTE_LEN = 15

export type V14AuditLayer =
  | "prompt_structure"
  | "tainted_source_direct_quote"
  /** posture C · LLM 语义判官判定为注入（取代旧 imperative_statement regex 层）。 */
  | "llm_semantic_injection"
  /** posture C · 判官返回无法解析，裁决不可信（可重试，非内容问题）。 */
  | "judge_parse_failed"
  /** posture C · 判官基础设施挂（编译引擎/超时），可重试，非内容问题。 */
  | "judge_unavailable"
  /** 德彪 r3 P1 · 人审豁免文档 promote 复检仍 sanitize-blocked（promote-wiki-service 设置）。 */
  | "exemption_sanitize_blocked"

export interface V14RejectReason {
  layer: V14AuditLayer
  matchedPatterns: readonly string[]
  hint: string
}

export interface V14PromoteAuditInput {
  /** Entity body (LLM 已编译的 wiki entity 正文)。 */
  body: string
  /**
   * tainted_source 字段：drop 时 sanitize 标 tainted 的 raw text（如 quoted_spans）；
   * promote 时若 body 直引该原文（非陈述句改写）→ reject。不传 = 跳过 layer 3。
   */
  taintedSourceFields?: readonly string[]
}

export interface V14PromoteAuditResult {
  passed: boolean
  /** passed=false 时非空。passed=true 时不存在。 */
  rejectReason?: V14RejectReason
}

export interface V14PromoteAuditServiceDeps {
  /**
   * LLM 判官 runner。默认 lazy createDynamicWikiCompileRunner（复用 wikiCompile 可配模型，
   * 与收录设置卡同一套）。测试注 stub。
   */
  runner?: HaikuRunner
  /** 判官 timeout（默认 v14-llm-judge JUDGE_TIMEOUT_MS=60s）。 */
  judgeTimeoutMs?: number
}

export class V14PromoteAuditService {
  private readonly injectedRunner?: HaikuRunner
  private readonly judgeTimeoutMs?: number
  private lazyRunner?: HaikuRunner

  constructor(deps: V14PromoteAuditServiceDeps = {}) {
    this.injectedRunner = deps.runner
    this.judgeTimeoutMs = deps.judgeTimeoutMs
  }

  /** lazy 解析 runner：注入优先；否则首次用时建 dynamic runner（无状态，可共享；不阻塞模块加载）。 */
  private resolveRunner(): HaikuRunner {
    if (this.injectedRunner) return this.injectedRunner
    if (!this.lazyRunner) this.lazyRunner = createDynamicWikiCompileRunner()
    return this.lazyRunner
  }

  /**
   * 同步结构层审计（结构标记 + tainted 直引）。确定性、0 LLM。
   * 给 preview / 审批列表即时禁用判断用（设计审 critique P1：preview on-mount 不烧 LLM）。
   * 注意：结构层 pass **不等于**最终通过——真 promote 还要过 LLM judge（见 audit）。
   */
  auditStructural(input: V14PromoteAuditInput): V14PromoteAuditResult {
    const body = input.body ?? ""

    const promptStructure = detectPromptStructure(body)
    if (promptStructure.length > 0) {
      return {
        passed: false,
        rejectReason: {
          layer: "prompt_structure",
          matchedPatterns: promptStructure,
          hint: "wiki entity 不能含 prompt 结构标记（system:/[INST]/im_start 等）。这是 prompt-injection 风险。",
        },
      }
    }

    if (input.taintedSourceFields && input.taintedSourceFields.length > 0) {
      const directQuotes = detectTaintedDirectQuotes(body, input.taintedSourceFields)
      if (directQuotes.length > 0) {
        return {
          passed: false,
          rejectReason: {
            layer: "tainted_source_direct_quote",
            matchedPatterns: directQuotes,
            hint: `wiki entity 直引了 tainted_source 原文。请改写为陈述句（"原文说 X" → "X"）后再 promote。`,
          },
        }
      }
    }

    return { passed: true }
  }

  /**
   * 权威审计（async）。结构层 → tainted 层（确定性短路，命中即 reject，0 LLM）→ LLM 语义判官。
   * 真 promote / batch 用。
   */
  async audit(input: V14PromoteAuditInput): Promise<V14PromoteAuditResult> {
    const structural = this.auditStructural(input)
    if (!structural.passed) return structural

    let judge = await runJudge(input.body ?? "", this.resolveRunner(), {
      timeoutMs: this.judgeTimeoutMs,
    })
    // F027 promote 后台化补丁：judge_parse_failed 是「判官输出不规整被 fail-closed parser
    // 拒绝」的基础设施抖动（2026-06-15 实测 8 篇失败 7 篇属此类，复测即过）——同请求内
    // 自动重试一次压掉假失败；两次都不规整仍 fail-closed 返回。真裁决（safe/injection）
    // 与 judge_unavailable（runner 层已带 fallback 链）不重试。
    if (judge.result === "judge_parse_failed") {
      judge = await runJudge(input.body ?? "", this.resolveRunner(), {
        timeoutMs: this.judgeTimeoutMs,
      })
    }
    if (judge.result === "safe") return { passed: true }
    return { passed: false, rejectReason: mapJudgeToReject(judge) }
  }
}

function mapJudgeToReject(judge: JudgeOutcome): V14RejectReason {
  switch (judge.result) {
    case "injection":
      return {
        layer: "llm_semantic_injection",
        matchedPatterns: [judge.reason || "LLM 判定为 prompt-injection"],
        hint: "LLM 语义审计判定本文含 prompt-injection 意图（操纵/越狱/套取系统提示）。请改写为纯描述性陈述句后再转正。",
      }
    case "judge_parse_failed":
      return {
        layer: "judge_parse_failed",
        matchedPatterns: [judge.reason || "judge output unparseable"],
        hint: "LLM 判官返回无法解析，裁决不可信（不是内容问题）。请稍后重试 promote。",
      }
    default:
      return {
        layer: "judge_unavailable",
        matchedPatterns: [judge.reason || "judge runner unavailable"],
        hint: "LLM 判官暂不可用（编译引擎挂/超时），这不是内容问题。请稍后重试 promote。",
      }
  }
}

function detectPromptStructure(body: string): string[] {
  const matched: string[] = []
  for (const { pattern, label } of PROMPT_STRUCTURE_PATTERNS) {
    if (pattern.test(body)) matched.push(label)
  }
  return matched
}

function detectTaintedDirectQuotes(body: string, taintedFields: readonly string[]): string[] {
  const matched: string[] = []
  for (const field of taintedFields) {
    if (typeof field !== "string") continue
    const normalized = field.trim()
    if (normalized.length < MIN_TAINTED_DIRECT_QUOTE_LEN) continue
    if (body.includes(normalized)) {
      const preview = normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized
      matched.push(preview)
    }
  }
  return matched
}
