/**
 * F027 P4 · raw drop sanitize 5 层防御 · 主入口
 * 真相源：docs/plans/V16.5-final.md chap 7 行 778-857
 * AC: AC-P1-4 —— 5 层 fixture 全部命中 + chained_suspect 进 _quarantined/
 *
 * 设计：
 *   - 4 个无状态 pass（pass1-4）由 passes.ts 提供
 *   - 本文件实现：
 *     - Pass 5 multi-pass 整合（fixed-point loop）
 *     - 早 reject：size_exceeded
 *     - 红线：jailbreak 模板检测（在 sanitized text 上做，避免被 unicode 同形字 / base64 绕过）
 *     - quarantinedRatio 计算 + blocked 判定
 *
 * 调用契约：
 *   const result = sanitizeRawDrop(rawContent, options?)
 *   if (result.blocked) {
 *     // → 落 wiki/concepts/draft/_quarantined/<date>-<slug>.md
 *     //   frontmatter: { tainted_source: true, sanitize_block_reason: result.redLineTriggers, ... }
 *     // → 等小孙手 review
 *   } else {
 *     // 用 result.sanitizedText 作 USER MESSAGE 给 compile-LLM
 *     // result.quarantinedSegments 作 quoted_spans 区段
 *   }
 */

import { pass1Unicode, pass2Html, pass3Fence, pass4Encoding } from "./passes"
import type {
  RedLineTrigger,
  SanitizeOptions,
  SanitizePassOutput,
  SanitizeResult,
} from "./types"

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const DEFAULT_MAX_QUARANTINED_RATIO = 0.3
const DEFAULT_MAX_PASSES = 5
const DEFAULT_ENTROPY_THRESHOLD = 4.5
const DEFAULT_BASE64_MIN_LENGTH = 40
/**
 * [范-r1 P2-1 修] 短文本豁免阈值。input.length < 此值时不走 quarantinedRatio 判定，
 * 仅红线 (redLineTriggers) 才能 BLOCK。否则 `a​b` 单 ZWSP 就触发 33% ratio 误 block。
 */
const DEFAULT_MIN_RATIO_INPUT_CHARS = 100

/**
 * Jailbreak 模板（小写匹配）—— 在 sanitized text 上扫，因为前 4 层已剥离同形字 / base64。
 * 任何命中 → red line jailbreak_template。
 */
const JAILBREAK_TEMPLATES: readonly string[] = [
  "ignore previous instructions",
  "ignore above instructions",
  "ignore all previous",
  "disregard previous",
  "you are now",
  "you are an",
  "act as a",
  "pretend to be",
  "pretend you are",
  "system prompt",
  "reveal your prompt",
  "reveal your instructions",
  "forget your instructions",
  "override your instructions",
  "your new task is",
  "from now on you",
] as const

export function sanitizeRawDrop(input: string, options?: SanitizeOptions): SanitizeResult {
  const opts = {
    maxBytes: options?.maxBytes ?? DEFAULT_MAX_BYTES,
    maxQuarantinedRatio: options?.maxQuarantinedRatio ?? DEFAULT_MAX_QUARANTINED_RATIO,
    maxPasses: options?.maxPasses ?? DEFAULT_MAX_PASSES,
    entropyThreshold: options?.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD,
    base64MinLength: options?.base64MinLength ?? DEFAULT_BASE64_MIN_LENGTH,
  }

  // 早 reject：size 超限。直接 BLOCK，不继续处理（防 token 炸弹）。
  const inputBytes = Buffer.byteLength(input, "utf-8")
  if (inputBytes > opts.maxBytes) {
    return {
      sanitizedText: "",
      quarantinedSegments: [],
      redLineTriggers: [
        {
          reason: "size_exceeded",
          matched: `${inputBytes} bytes`,
          detail: `> maxBytes=${opts.maxBytes}`,
        },
      ],
      blocked: true,
      passes: 0,
      quarantinedRatio: 0,
      inputBytes,
    }
  }

  // Multi-pass fixed point：直到一轮内所有 pass 都不再修改文本
  let current = input
  const allSegments: SanitizeResult["quarantinedSegments"] = []
  const allTriggers: RedLineTrigger[] = []
  let passNum = 0
  for (; passNum < opts.maxPasses; passNum++) {
    const before = current
    const out = runOnePass(current, opts)
    current = out.text
    allSegments.push(...out.segments)
    allTriggers.push(...out.triggers)
    if (current === before) {
      passNum++ // 包含本轮（稳定的最后一轮）
      break
    }
  }

  // Pass 5 收尾：jailbreak 模板检测（在 sanitized text 上）
  const lowerText = current.toLowerCase()
  for (const tpl of JAILBREAK_TEMPLATES) {
    const idx = lowerText.indexOf(tpl)
    if (idx >= 0) {
      allTriggers.push({
        reason: "jailbreak_template",
        matched: tpl,
        position: idx,
      })
    }
  }

  // 计算 quarantined 占比
  const quarantinedChars = allSegments.reduce((s, seg) => s + seg.original.length, 0)
  const ratio = input.length > 0 ? quarantinedChars / input.length : 0

  // [范-r1 P2-1] 短文本不走 ratio 判定（避免 `a​b` 单 ZWSP 33% 误 block）
  const ratioApplies = input.length >= DEFAULT_MIN_RATIO_INPUT_CHARS
  const blocked = allTriggers.length > 0 || (ratioApplies && ratio > opts.maxQuarantinedRatio)

  return {
    sanitizedText: current,
    quarantinedSegments: allSegments,
    redLineTriggers: dedupeTriggers(allTriggers),
    blocked,
    passes: passNum,
    quarantinedRatio: ratio,
    inputBytes,
  }
}

function runOnePass(text: string, opts: Required<SanitizeOptions>): SanitizePassOutput {
  const segments: SanitizePassOutput["segments"] = []
  const triggers: SanitizePassOutput["triggers"] = []
  let cur = text

  const p1 = pass1Unicode(cur)
  cur = p1.text
  segments.push(...p1.segments)
  triggers.push(...p1.triggers)

  const p2 = pass2Html(cur)
  cur = p2.text
  segments.push(...p2.segments)
  triggers.push(...p2.triggers)

  const p3 = pass3Fence(cur)
  cur = p3.text
  segments.push(...p3.segments)
  triggers.push(...p3.triggers)

  const p4 = pass4Encoding(cur, opts.entropyThreshold, opts.base64MinLength)
  cur = p4.text
  segments.push(...p4.segments)
  triggers.push(...p4.triggers)

  return { text: cur, segments, triggers }
}

function dedupeTriggers(triggers: RedLineTrigger[]): RedLineTrigger[] {
  const seen = new Set<string>()
  const out: RedLineTrigger[] = []
  for (const t of triggers) {
    const key = `${t.reason}::${t.matched}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

export type { SanitizeOptions, SanitizeResult } from "./types"
export { SanitizeBlockedError } from "./types"
