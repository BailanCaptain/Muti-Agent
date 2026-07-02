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
import type { RedLineTrigger, SanitizeOptions, SanitizePassOutput, SanitizeResult } from "./types"

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
  "reveal your prompt",
  "reveal your instructions",
  "forget your instructions",
  "override your instructions",
  "your new task is",
  "from now on you",
] as const

/**
 * 语境正则红线（小写文本上扫）。裸 "system prompt" 是本项目技术文档的日常词汇
 * （2026-06-15 F007/F019 人审豁免文档 promote 复检实测误伤），从裸子串降为
 * 「攻击语态共现」判定。德彪 r1 P1 修：动词枚举+固定方向被 6 类 PoC 绕过
 * （provide/return 缺、倒序 "system prompt: reveal it"、复数 prompts、>40 字 padding、
 * 松散问句），改为——
 *   - exfil/override 动词与 "system prompt(s)" **双向** 80 字符窗内共现（动词在前限同句
 *     [^.!?]，名词在前用行窗 [^\n]——"system prompt. now reveal it" 类跨句仍算攻击）
 *   - 问句 what … system prompt(s)（60 字窗，不再要求 is/are 紧邻）
 *   - 授令句式 new system prompt / your system prompt is
 * 纯语义改写（不含字面 system prompt）本层不管，归 promote LLM 判官（posture C）。
 */
const EXFIL_VERBS =
  "reveal|ignore|disregard|override|forget|leak|show|print|repeat|output|dump|expose|bypass|share|tell|give|send|paste|copy|disclose|quote|recite|provide|return|display|read|fetch|retrieve|write|list|say|reproduce|transcribe"
const JAILBREAK_CONTEXT_REGEXES: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: new RegExp(`\\b(?:${EXFIL_VERBS})\\b[^\\n.!?]{0,80}\\bsystem prompts?\\b`),
    label: "attack-verb … system prompt",
  },
  {
    pattern: new RegExp(`\\bsystem prompts?\\b[^\\n]{0,80}\\b(?:${EXFIL_VERBS})\\b`),
    label: "system prompt … attack-verb",
  },
  // 问句式套取（what … system prompt）—— 无攻击动词但同为 exfiltration 意图
  {
    pattern: /\bwhat\b[^\n.!?]{0,60}\bsystem prompts?\b/,
    label: "what … system prompt",
  },
  { pattern: /\bnew system prompts?\b/, label: "new system prompt" },
  { pattern: /\byour system prompt is\b/, label: "your system prompt is" },
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

  // Pass 5 收尾：jailbreak 模板检测。
  // 德彪 r2/r3 P1 · 换行拆分绕过：裸模板 + 语境正则**统一跑在「空白折叠」文本上**
  // （\s+ → 单空格）——"ignore previous\ninstructions" / "what is your\nsystem prompt?" /
  // "system\nprompt" 类跨行字面攻击折叠后照常命中（r3 前裸模板走 indexOf(lowerText)，
  // 是补丁前既有的同族缺口，一并收口）。
  // 已知接受的 FP 面：折叠把相邻 markdown 列表项接成一句，动词与 system prompt 跨项共现
  // 会误红——本层 fail-closed 方向，误伤走人审豁免/改写通道（有既定流程）。
  // position 为折叠文本上的近似位置（trigger 只用于展示/去重，不回写原文）。
  const lowerText = current.toLowerCase()
  const collapsedText = lowerText.replace(/\s+/g, " ")
  for (const tpl of JAILBREAK_TEMPLATES) {
    const idx = collapsedText.indexOf(tpl)
    if (idx >= 0) {
      allTriggers.push({
        reason: "jailbreak_template",
        matched: tpl,
        position: idx,
      })
    }
  }
  for (const { pattern, label } of JAILBREAK_CONTEXT_REGEXES) {
    const m = pattern.exec(collapsedText)
    if (m) {
      allTriggers.push({
        reason: "jailbreak_template",
        matched: label,
        position: m.index,
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
