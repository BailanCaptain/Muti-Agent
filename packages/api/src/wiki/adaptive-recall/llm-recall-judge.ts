/**
 * F027 P13.2 r2 · LlmRecallJudge — Hard Gate 第二层真 LLM judge
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1383-1395
 *
 * 范-r1 P1-2 修：兑现 P11 hard-gate.ts:75-79 注释承诺"真 LLM judge 在 P13 接入"。
 *
 * 与 LlmCritiqueAgent 的区别（不复用，因 LLM 任务语义不同）：
 *   - LlmCritiqueAgent: 判"已召回的 hits 是否充分覆盖 query"（5 级 fallback 内部）
 *   - LlmRecallJudge:  判"agent draft 是否需要召回历史"（detectRecallTrigger 第二层）
 *
 * 触发 case：detectRecallTrigger 第一层 deterministic 没命中，draft 含历史关键词
 * （之前/上次/已决定/一直以来）但无 cite → LLM 判"是否真在引用历史"。
 *   - 是真在引用但无证据 → required=true（agent 应触发 5 级 fallback）
 *   - 只是字面含关键词（如"之前的代码不在了"）→ required=false
 */

import type {
  RecallJudgeProvider,
  TriggerContext,
} from "../memory-preflight/types"
import type { ClaudeRunner } from "./critique-agent"

const DEFAULT_TIMEOUT_MS = 30000
const DRAFT_TRUNCATE = 600

export interface LlmRecallJudgeOptions {
  /** Claude CLI 单次调用超时；默认 30s */
  timeoutMs?: number
}

// ─── Prompt 构造 ────────────────────────────────────────────────────────

export function buildRecallJudgePrompt(
  draft: string,
  context: TriggerContext,
): string {
  const citedMsgs = context.citedMessageIds ?? []
  const citedDecs = context.citedDecisionIds ?? []
  const cites =
    citedMsgs.length === 0 && citedDecs.length === 0
      ? "（无 cite）"
      : `${citedMsgs.length > 0 ? `messages: [${citedMsgs.join(", ")}]` : ""}${citedDecs.length > 0 ? ` decisions: [${citedDecs.join(", ")}]` : ""}`

  return `你是召回必要性判定器。判定 agent 即将发出的 draft 是否需要先做记忆召回。

[判定原则]
- "需要召回"：draft 真在引用历史结论（"之前我们决定 X"/"上次拍了 Y"/"一直以来按 Z"），且没有给出证据链 cite
- "不需要召回"：
  · 只是字面含关键词但无引用语义（如"之前的代码不在了"/"上次没说"）
  · 含 cite（已带证据链 [decision_id=N] / [msg_xxx] / [D-N] / [a2a_call=...]）
  · 是 turn-local 对话不涉及历史（询问 / 即时计算 / 当前文件查看）

[scenario]
${context.scenario}

[draft]
${draft.slice(0, DRAFT_TRUNCATE)}

[已 cite 的证据]
${cites}

只返回 JSON，不要任何解释或 markdown 包装：
{"required": <bool>, "reason": "<≤80字 判定依据>"}`
}

// ─── Parse + 防 hallucination ──────────────────────────────────────────

export interface RecallJudgeResult {
  required: boolean
  reason: string
}

export function parseRecallJudgeJson(raw: string): RecallJudgeResult {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const jsonText = fenced ? fenced[1].trim() : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(
      `recall-judge-parse-failed: ${err instanceof Error ? err.message : String(err)} (raw len=${raw.length})`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("recall-judge-parse-failed: not an object")
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.required !== "boolean") {
    throw new Error(
      `recall-judge-parse-failed: required 必须为 boolean (got ${typeof obj.required})`,
    )
  }
  const reason =
    typeof obj.reason === "string" && obj.reason.trim().length > 0
      ? obj.reason.trim().slice(0, 200)
      : obj.required
        ? "llm_judged_required"
        : "llm_judged_not_required"
  return { required: obj.required, reason }
}

// ─── LlmRecallJudge 实现 ────────────────────────────────────────────────

export class LlmRecallJudge implements RecallJudgeProvider {
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly opts: LlmRecallJudgeOptions = {},
  ) {}

  async judge(input: {
    draft: string
    context: TriggerContext
  }): Promise<RecallJudgeResult> {
    const prompt = buildRecallJudgePrompt(input.draft, input.context)
    const result = await this.runner.runPrompt(prompt, {
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    if (!result.ok) {
      throw new Error(`recall-judge-runner-failed: ${result.error ?? "unknown"}`)
    }
    return parseRecallJudgeJson(result.text)
  }
}
