/**
 * F027 P4.6 · Phase 2 LLM compile · schema 校验
 * 真相源：docs/plans/V16.5-final.md chap 26 行 2782-2814 + 行 2380
 *   "LLM 编译输出不符 schema → 重试 N 次 fallback draft + 连续失败熔断"
 *
 * 重试 / 熔断逻辑由 caller (compile-pipeline) 处理；本模块只做：
 *   1. parse JSON（兼容前后空白 + ```json fence wrapping）
 *   2. shape 校验：5 种 relation / 3 种 verdict / 4 种 canonical_owner / 5 种 type
 *   3. 缺字段抛 LLMCompileSchemaError（caller 决定重试 vs fallback）
 */

import {
  type CrossRef,
  type CrossRefRelation,
  type CanonicalOwnerSuggestion,
  type DedupDecision,
  type DedupVerdict,
  type DraftQuality,
  type LLMCompileOutput,
  LLMCompileSchemaError,
} from "./types"

const VALID_RELATIONS: readonly CrossRefRelation[] = [
  "extends",
  "supersedes",
  "references",
  "contradicts",
  "implements",
] as const
const VALID_VERDICTS: readonly DedupVerdict[] = ["new_entity", "merge_into", "supersedes"] as const
const VALID_OWNER_SUGGESTIONS: readonly CanonicalOwnerSuggestion[] = [
  "wiki/concepts/",
  "wiki/rules/",
  "wiki/methods/",
  "wiki/people/",
] as const
const VALID_TYPES: readonly LLMCompileOutput["type"][] = [
  "concept",
  "rule",
  "method",
  "lesson",
  "external-ref",
] as const

/**
 * 容错 parse：
 * - 直接 JSON.parse 成功 → 返回
 * - ```json ... ``` fence 包裹 → 剥 fence 后 parse
 * - parse 失败 → 抛 LLMCompileSchemaError(field="<root>")
 */
export function parseLLMCompileJSON(raw: string): unknown {
  const trimmed = raw.trim()
  // 剥 ```json ... ``` fence
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  const candidate = fenceMatch ? fenceMatch[1] : trimmed
  try {
    return JSON.parse(candidate)
  } catch (err) {
    throw new LLMCompileSchemaError(
      "<root>",
      `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Shape 校验 + 类型转换。
 * 缺必填 / 类型错 / 枚举值不在白名单 → 抛 LLMCompileSchemaError。
 */
export function validateLLMCompileOutput(parsed: unknown): LLMCompileOutput {
  const obj = assertObject(parsed, "<root>")
  const title = assertString(obj, "title")
  const type = assertEnum(obj, "type", VALID_TYPES)
  const summary = assertString(obj, "summary")
  const facts = assertFacts(obj.facts)
  const quoted_spans = assertStringArray(obj, "quoted_spans")
  const sources = assertSources(obj.sources)
  const cross_refs = assertCrossRefs(obj.cross_refs)
  const dedup_decision = assertDedupDecision(obj.dedup_decision)
  const canonical_owner_suggestion = assertEnum(
    obj,
    "canonical_owner_suggestion",
    VALID_OWNER_SUGGESTIONS,
  )
  const draft_quality = assertDraftQuality(obj.draft_quality)

  return {
    title,
    type,
    summary,
    facts,
    quoted_spans,
    sources,
    cross_refs,
    dedup_decision,
    canonical_owner_suggestion,
    draft_quality,
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

function assertObject(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new LLMCompileSchemaError(field, `expected object, got ${typeOf(v)}`)
  }
  return v as Record<string, unknown>
}

function assertString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new LLMCompileSchemaError(key, `expected non-empty string, got ${typeOf(v)}`)
  }
  return v
}

function assertEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const v = obj[key]
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new LLMCompileSchemaError(
      key,
      `expected one of [${allowed.join(", ")}], got ${JSON.stringify(v)}`,
    )
  }
  return v as T
}

function assertStringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key]
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new LLMCompileSchemaError(key, `expected string[], got ${typeOf(v)}`)
  }
  return v as string[]
}

function assertFacts(v: unknown): LLMCompileOutput["facts"] {
  if (!Array.isArray(v)) {
    throw new LLMCompileSchemaError("facts", `expected array, got ${typeOf(v)}`)
  }
  const out: LLMCompileOutput["facts"] = []
  for (const [i, item] of v.entries()) {
    const f = assertObject(item, `facts[${i}]`)
    const text = assertString(f, "text")
    const sourceSpan = f.source_span
    if (sourceSpan !== undefined && typeof sourceSpan !== "string") {
      throw new LLMCompileSchemaError(
        `facts[${i}].source_span`,
        `expected string | undefined, got ${typeOf(sourceSpan)}`,
      )
    }
    out.push({ text, ...(typeof sourceSpan === "string" ? { source_span: sourceSpan } : {}) })
  }
  return out
}

function assertSources(v: unknown): LLMCompileOutput["sources"] {
  if (!Array.isArray(v)) {
    throw new LLMCompileSchemaError("sources", `expected array, got ${typeOf(v)}`)
  }
  const out: LLMCompileOutput["sources"] = []
  for (const [i, item] of v.entries()) {
    const s = assertObject(item, `sources[${i}]`)
    const type = assertString(s, "type")
    const contributed_by = assertString(s, "contributed_by")
    const pathRaw = s.path
    if (pathRaw !== undefined && typeof pathRaw !== "string") {
      throw new LLMCompileSchemaError(
        `sources[${i}].path`,
        `expected string | undefined, got ${typeOf(pathRaw)}`,
      )
    }
    out.push({ type, contributed_by, ...(typeof pathRaw === "string" ? { path: pathRaw } : {}) })
  }
  return out
}

function assertCrossRefs(v: unknown): CrossRef[] {
  if (!Array.isArray(v)) {
    throw new LLMCompileSchemaError("cross_refs", `expected array, got ${typeOf(v)}`)
  }
  const out: CrossRef[] = []
  for (const [i, item] of v.entries()) {
    const r = assertObject(item, `cross_refs[${i}]`)
    const target = assertString(r, "target")
    const relation = assertEnum(r, "relation", VALID_RELATIONS)
    const rationale = assertString(r, "rationale")
    out.push({ target, relation, rationale })
  }
  return out
}

function assertDedupDecision(v: unknown): DedupDecision {
  const d = assertObject(v, "dedup_decision")
  const verdict = assertEnum(d, "verdict", VALID_VERDICTS)
  const targetEntity = d.target_entity
  let target_entity: string | null
  if (targetEntity === null) {
    target_entity = null
  } else if (typeof targetEntity === "string") {
    target_entity = targetEntity
  } else {
    throw new LLMCompileSchemaError(
      "dedup_decision.target_entity",
      `expected string | null, got ${typeOf(targetEntity)}`,
    )
  }
  // 业务校验：merge_into / supersedes 必须有 target_entity
  if ((verdict === "merge_into" || verdict === "supersedes") && target_entity === null) {
    throw new LLMCompileSchemaError(
      "dedup_decision.target_entity",
      `verdict=${verdict} requires non-null target_entity`,
    )
  }
  const rationale = assertString(d, "rationale")
  return { verdict, target_entity, rationale }
}

function assertDraftQuality(v: unknown): DraftQuality {
  const q = assertObject(v, "draft_quality")
  const completeness = assertNumber01(q, "completeness")
  const clarity = assertNumber01(q, "clarity")
  const has_actionable_facts = assertBoolean(q, "has_actionable_facts")
  const structural_pass = assertBoolean(q, "structural_pass")
  return { completeness, clarity, has_actionable_facts, structural_pass }
}

function assertNumber01(obj: Record<string, unknown>, key: string): number {
  const v = obj[key]
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new LLMCompileSchemaError(
      `draft_quality.${key}`,
      `expected number in [0,1], got ${typeOf(v)}`,
    )
  }
  return v
}

function assertBoolean(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key]
  if (typeof v !== "boolean") {
    throw new LLMCompileSchemaError(`draft_quality.${key}`, `expected boolean, got ${typeOf(v)}`)
  }
  return v
}

function typeOf(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  return typeof v
}
