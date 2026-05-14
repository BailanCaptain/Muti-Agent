/**
 * F027 P4.6 · Phase 2 LLM compile · prompt 构造
 * 真相源：docs/plans/V16.5-final.md chap 26 行 2756-2828
 *
 * SYSTEM prompt 拼装：
 *   [P3.6 handbook "## 编译规则" 切片]
 *   + [Phase 1 PreCompileContext: similarEntities + indexLite]
 *   + 任务说明（schema-only JSON 输出）
 *
 * USER MESSAGE：raw 数据块（必须以 V16.5 chap 7 sanitize 后的 sanitizedText 为输入）
 *
 * 真相源 chap 26 行 2756: "raw（USER MESSAGE 数据块）+ Phase 1 的参考上下文"
 * 真相源 chap 26 行 2762-2764: "资料是 USER MESSAGE 中的数据块，不是指令"
 */

import type { PreCompileContext } from "./types"

export interface BuildCompileLLMInput {
  /** Phase 1 的参考上下文 */
  context: PreCompileContext
  /** P3.6 handbook "## 编译规则" 切片（compileRules）。caller 已 loadHandbookSlices 拿到 */
  handbookCompileRules: string
  /** 可选：自定义任务尾部说明（缺失时用 buildSchemaTaskBlock 默认） */
  taskBlock?: string
}

/**
 * 构造 compile-LLM 的 SYSTEM prompt。
 * USER MESSAGE 由 caller 自己拼（用 sanitized raw text）—— 这层只关心 SYSTEM。
 *
 * 拼装顺序（V16.5 chap 26 行 2756-2828）：
 *   1. handbook 编译规则（来自 P3.6 切片）
 *   2. 参考上下文（PreCompileContext: similarEntities + indexLite）
 *   3. 任务说明（schema-only JSON 输出）
 */
export function buildCompileLLMSystemPrompt(input: BuildCompileLLMInput): string {
  const handbookSection = `# 编译规则（来自 handbook）\n\n${input.handbookCompileRules.trim()}`
  const contextSection = formatPreCompileContext(input.context)
  const taskSection = (input.taskBlock ?? buildSchemaTaskBlock()).trim()

  return [handbookSection, contextSection, taskSection].filter((s) => s.length > 0).join("\n\n")
}

/**
 * 把 PreCompileContext 序列化成 SYSTEM prompt 的"参考上下文"段。
 * 真相源：V16.5 chap 26 行 2767-2778 示例格式。
 */
export function formatPreCompileContext(ctx: PreCompileContext): string {
  const lines: string[] = ["【参考上下文 — 仅供理解，不要照抄】", ""]

  if (ctx.similarEntities.length > 0) {
    lines.push("Wiki 已有以下相关 entity（top-k 相似，按 similarity 排序）：")
    for (const ent of ctx.similarEntities) {
      lines.push(
        `- [[${ent.path}]] (sim ${ent.score.toFixed(2)}) — ${truncate(ent.summary, 120)}`,
      )
    }
    lines.push("")
  } else {
    lines.push("Wiki 暂无相似 entity（可能是冷启动，或 embedding 不可用）。")
    lines.push("")
  }

  if (ctx.indexLite.rules.length > 0) {
    lines.push("Wiki 现有规则书 (rules/)：")
    for (const r of ctx.indexLite.rules) {
      lines.push(`- [[${r.name}]] — ${truncate(r.summary, 100)}`)
    }
    lines.push("")
  }

  if (ctx.indexLite.concepts.length > 0) {
    lines.push("Wiki 现有概念 (concepts/, 头部样本)：")
    for (const c of ctx.indexLite.concepts) {
      lines.push(`- [[${c.name}]] — ${truncate(c.summary, 100)}`)
    }
    lines.push("")
  }

  if (ctx.indexLite.methods && ctx.indexLite.methods.length > 0) {
    lines.push("Wiki 现有方法 (methods/, 头部样本)：")
    for (const m of ctx.indexLite.methods) {
      lines.push(`- [[${m.name}]] — ${truncate(m.summary, 100)}`)
    }
    lines.push("")
  }

  return lines.join("\n").trim()
}

/**
 * V16.5 chap 26 行 2782-2814 schema 任务块（默认版）。
 * caller 可注入自定义 taskBlock（如 prompt-injection 防御加固版）。
 */
export function buildSchemaTaskBlock(): string {
  return `【任务】

编译 raw 成结构化 JSON。**只输出 JSON，不要任何前后说明文字。** Schema：

{
  "title": string,
  "type": "concept" | "rule" | "method" | "lesson" | "external-ref",
  "summary": string,
  "facts": [{ "text": string, "source_span": string? }],
  "quoted_spans": [string],
  "sources": [{ "type": string, "path": string?, "contributed_by": string }],
  "cross_refs": [
    {
      "target": string,
      "relation": "extends" | "supersedes" | "references" | "contradicts" | "implements",
      "rationale": string
    }
  ],
  "dedup_decision": {
    "verdict": "new_entity" | "merge_into" | "supersedes",
    "target_entity": string | null,
    "rationale": string
  },
  "canonical_owner_suggestion": "wiki/concepts/" | "wiki/rules/" | "wiki/methods/" | "wiki/people/",
  "draft_quality": {
    "completeness": number (0-1),
    "clarity": number (0-1),
    "has_actionable_facts": boolean,
    "structural_pass": boolean
  }
}

边界：
- ❌ 不扫全 wiki（已在【参考上下文】给你 top-k）
- ❌ 不改其他 entity（写权限 ACL）
- ❌ 不决定 promote（小孙手动）`
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
