/**
 * F027 Phase 4 AC-P4-1 b · V14 Tainted_source promote 二次审计 service
 *
 * 真相源: docs/plans/V16.5-final.md line 838-846 (Tainted_source promote 二次审计)
 *
 * Spec (V16.5 line 840-846):
 *   promote 操作前必须经过二次审计:
 *     1. entity body 是否含命令式语句（"必须" / "必需" / "忽略" / "覆盖"等 + 上下文）
 *     2. body 是否含 prompt 结构（`system:` 等）
 *     3. body 是否引用 tainted_source 字段（必须改写为陈述句，不能直引）
 *
 *   审计失败 → promote 拒绝，要求小孙改写 body
 *   审计通过 + 小孙 confirm → promote 成功，写 wiki_events 含 audit_passed_by: 小孙
 *
 * 跟 sanitize 5 层 (sanitize-raw-drop.ts) 的区别:
 *   - sanitize 5 层: drop 入口 时跑（unicode/html/fence/encoding/multi-pass）
 *   - V14 audit: promote 时跑，针对 LLM 已编译的 entity body 做语义层 prompt-injection 检测
 *
 * 失败语义 (plan v5 AC-P4-2):
 *   - reject reason 标 layer + matched patterns + hint 让用户改写 body
 *   - draft 留原位（caller 不 mv）
 *   - Inspector 显示 reject 历史
 */

const IMPERATIVE_PATTERNS_CN: readonly string[] = [
  "必须",
  "必需",
  "忽略",
  "覆盖",
  "应当",
  "应该",
  "禁止",
  "不允许",
  "必要",
  "无视",
  "请勿",
  "切勿",
] as const

/**
 * EN imperative word-boundary patterns (P2-3 r1 修):
 *   旧版本用 "must " / "ignore " 等 space 后缀字符串匹配，被 `Ignore.` / `ignore\n` /
 *   句尾 `you must` 全部 bypass (codex r1 P2-3)。
 *   改 \b regex 用 word boundary，覆盖标点 / newline / 句尾。
 *   case-insensitive 包词根 + 复合短语两类。
 */
const IMPERATIVE_PATTERNS_EN_REGEX: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bmust\b/i, label: "must" },
  { pattern: /\bshall\b/i, label: "shall" },
  { pattern: /\bshould\b/i, label: "should" },
  { pattern: /\bignore\b/i, label: "ignore" },
  { pattern: /\boverride\b/i, label: "override" },
  { pattern: /\bdisregard\b/i, label: "disregard" },
  { pattern: /\bforget\b/i, label: "forget" },
  { pattern: /\breveal\b/i, label: "reveal" },
] as const

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
  | "imperative_statement"
  | "prompt_structure"
  | "tainted_source_direct_quote"

export interface V14RejectReason {
  layer: V14AuditLayer
  matchedPatterns: readonly string[]
  hint: string
}

export interface V14PromoteAuditInput {
  /** Entity body (LLM 已编译的 wiki entity 正文)。 */
  body: string
  /**
   * tainted_source 字段：drop 时如果 sanitize 把某段 raw text 标 tainted (例如
   * `quoted_spans` 区段)，promote 时若 body 直引该原文（非陈述句改写） → reject。
   * 不传 = 跳过 layer 3 检查。
   */
  taintedSourceFields?: readonly string[]
}

export interface V14PromoteAuditResult {
  passed: boolean
  /** passed=false 时非空。passed=true 时不存在。 */
  rejectReason?: V14RejectReason
}

export class V14PromoteAuditService {
  audit(input: V14PromoteAuditInput): V14PromoteAuditResult {
    const body = input.body ?? ""

    const imperative = detectImperative(body)
    if (imperative.length > 0) {
      return {
        passed: false,
        rejectReason: {
          layer: "imperative_statement",
          matchedPatterns: imperative,
          hint: "wiki entity 不能含命令式语句（必须/忽略/覆盖等）。请改写为陈述句描述事实。",
        },
      }
    }

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
}

function detectImperative(body: string): string[] {
  const matched = new Set<string>()
  for (const cn of IMPERATIVE_PATTERNS_CN) {
    if (body.includes(cn)) matched.add(cn)
  }
  for (const { pattern, label } of IMPERATIVE_PATTERNS_EN_REGEX) {
    if (pattern.test(body)) matched.add(label)
  }
  return Array.from(matched)
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
      const preview =
        normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized
      matched.push(preview)
    }
  }
  return matched
}
