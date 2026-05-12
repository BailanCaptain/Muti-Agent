/**
 * F027 P4 · sanitize 5 层防御 · 4 个无状态 pass
 * 真相源：docs/plans/V16.5-final.md chap 7 行 778-806
 *
 * 每个 pass 是纯函数：input text → { text, segments, triggers }
 *   - text：本 pass 处理后的文本（可能比 input 短，被剥离的部分进 segments）
 *   - segments：QuarantinedSegment 数组
 *   - triggers：RedLineTrigger 数组（仅 Pass 2/4 会产出，其它为空）
 *
 * Pass 5（multi-pass 整合）由 sanitize-raw-drop.ts 主控（fixed-point 循环）。
 */

import type { QuarantinedSegment, RedLineTrigger, SanitizePassOutput } from "./types"

// ─────────────────────────────────────────────────────────────────────
// Pass 1 · Unicode 归一化（NFKC + invisible / bidi / tag chars 剥离）
// ─────────────────────────────────────────────────────────────────────

/**
 * 控制字符（除 \t \n \r）：U+0000-U+0008 / U+000B / U+000C / U+000E-U+001F / U+007F
 * ANSI escape 攻击 / 终端注入靠这些字符。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit purpose — strip control chars
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * 不可见格式字符 + bidi override。
 * 攻击向量：
 *   - "IMPORTANT[ZWSP]:" 用 ZWSP 绕过行首 keyword 匹配
 *   - U+202E RLO 让 "txt.exe.png" 显示成 "txt.png.exe"（隐藏可执行）
 *   - U+E0000-U+E007F Unicode tag chars 隐藏指令（OpenAI 2024 jailbreak 报告，单独 UNICODE_TAG_RE 处理）
 *
 * 覆盖（用 alternation 避免 biome noMisleadingCharacterClass 抱怨 ZWJ）：
 *   - U+200B-U+200F: ZWSP / ZWNJ / ZWJ / LRM / RLM
 *   - U+2060-U+2064: WORD JOINER / invisible operators
 *   - U+2066-U+2069: bidi isolates
 *   - U+202A-U+202E: bidi LRO/RLO/PDF/LRE/RLE
 *   - U+FEFF: BOM
 */
const INVISIBLE_FORMAT_RE =
  /​|‌|‍|‎|‏|⁠|⁡|⁢|⁣|⁤|⁦|⁧|⁨|⁩|‪|‫|‬|‭|‮|﻿/g

/** Unicode tag chars 单独剥离（U+E0000-U+E007F，使用 surrogate pair 在 JS 里需 unicode flag） */
const UNICODE_TAG_RE = /[\u{E0000}-\u{E007F}]/gu

export function pass1Unicode(input: string): SanitizePassOutput {
  const segments: QuarantinedSegment[] = []

  // 0) NFKC 归一化（同形字 → 标准字符）。例：full-width "Ｓｙｓｔｅｍ" → "System"
  // 不当作 segment 记录（这是合规化操作，不是隔离）
  const nfkc = input.normalize("NFKC")

  // 1) 控制字符 剥离 + 记 segment
  const afterControl = stripAndRecord(nfkc, CONTROL_CHARS_RE, "control_char", segments)

  // 2) 不可见格式 + bidi override 剥离 + 记 segment
  const afterInvisible = stripAndRecord(
    afterControl,
    INVISIBLE_FORMAT_RE,
    "invisible_format_char",
    segments,
  )

  // 3) Unicode tag chars 剥离
  const afterTag = stripAndRecord(afterInvisible, UNICODE_TAG_RE, "unicode_tag", segments)

  return { text: afterTag, segments, triggers: [] }
}

function stripAndRecord(
  input: string,
  regex: RegExp,
  reason: QuarantinedSegment["reason"],
  segments: QuarantinedSegment[],
): string {
  const matches = [...input.matchAll(regex)]
  if (matches.length === 0) return input
  // 合并相邻匹配为一个 segment（避免每个 zero-width char 占一行）
  const distinct = new Set<string>(matches.map((m) => m[0]))
  segments.push({
    reason,
    original: matches.map((m) => m[0]).join(""),
    detail: `${matches.length} occurrence(s); chars=${[...distinct]
      .map((c) => `U+${c.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`)
      .join(",")}`,
    positionHint: matches[0].index,
  })
  return input.replace(regex, "")
}

// ─────────────────────────────────────────────────────────────────────
// Pass 2 · HTML / comment AST 解析
// ─────────────────────────────────────────────────────────────────────

/** HTML 注释 `<!-- ... -->`（含跨行）—— 强制进 quoted_spans，原文剥离 */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
/** `<script>...</script>`（不区分大小写，跨行）→ 红线 + 剥离 */
const HTML_SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi
/** `<iframe>...</iframe>` → 红线 + 剥离 */
const HTML_IFRAME_RE = /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi
/** 单标签 `<script ... />` 或自闭合 → 红线 + 剥离 */
const HTML_SCRIPT_SELFCLOSE_RE = /<script\b[^>]*\/?>/gi
const HTML_IFRAME_SELFCLOSE_RE = /<iframe\b[^>]*\/?>/gi
/** 危险 URL scheme：javascript: / data:text/html / vbscript: */
const DANGEROUS_URL_RE =
  /\b(?:javascript:|data:text\/html|vbscript:|data:application\/javascript)/gi

export function pass2Html(input: string): SanitizePassOutput {
  const segments: QuarantinedSegment[] = []
  const triggers: RedLineTrigger[] = []
  let text = input

  // [顺序保护] 注释先于 script/iframe —— 否则若文档别处零散出现 `<script>` 字符（注释 / 引用），
  // <script>...</script> 的 lazy 匹配会跨越中间所有内容（含 HTML 注释）一并吃掉，导致
  // html_comment segment 漏报。先把注释拆出来再处理 tag 块。
  const commentMatches = [...text.matchAll(HTML_COMMENT_RE)]
  for (const m of commentMatches) {
    segments.push({
      reason: "html_comment",
      original: m[0],
      positionHint: m.index,
    })
  }
  text = text.replace(HTML_COMMENT_RE, "")

  // <script> / <iframe>（成对 + 自闭合）→ 红线 + 剥离
  text = stripWithRedLine(text, HTML_SCRIPT_RE, "html_script", "dangerous_html_tag", segments, triggers)
  text = stripWithRedLine(
    text,
    HTML_SCRIPT_SELFCLOSE_RE,
    "html_script",
    "dangerous_html_tag",
    segments,
    triggers,
  )
  text = stripWithRedLine(text, HTML_IFRAME_RE, "html_iframe", "dangerous_html_tag", segments, triggers)
  text = stripWithRedLine(
    text,
    HTML_IFRAME_SELFCLOSE_RE,
    "html_iframe",
    "dangerous_html_tag",
    segments,
    triggers,
  )

  // 危险 URL scheme → 红线 + 剥离 URL token（不剥整段，只标 dangerous segment）
  const urlMatches = [...text.matchAll(DANGEROUS_URL_RE)]
  for (const m of urlMatches) {
    segments.push({
      reason: "html_dangerous_url",
      original: m[0],
      positionHint: m.index,
    })
    triggers.push({
      reason: "dangerous_url_scheme",
      matched: m[0].slice(0, 60),
      position: m.index,
    })
  }
  text = text.replace(DANGEROUS_URL_RE, "")

  return { text, segments, triggers }
}

function stripWithRedLine(
  input: string,
  regex: RegExp,
  segReason: QuarantinedSegment["reason"],
  trigReason: RedLineTrigger["reason"],
  segments: QuarantinedSegment[],
  triggers: RedLineTrigger[],
): string {
  const matches = [...input.matchAll(regex)]
  for (const m of matches) {
    segments.push({ reason: segReason, original: m[0], positionHint: m.index })
    triggers.push({
      reason: trigReason,
      matched: m[0].slice(0, 80),
      position: m.index,
    })
  }
  return input.replace(regex, "")
}

// ─────────────────────────────────────────────────────────────────────
// Pass 3 · Fence-aware role-token 检测
// ─────────────────────────────────────────────────────────────────────

/** ``` 或 ~~~ 围栏（含可选 lang 标签 + 跨行内容） */
const FENCE_RE = /(```|~~~)([^\n`~]*)\n([\s\S]*?)\n\1/g

/**
 * 模型对话格式 role token，case-insensitive。
 * 命中即"假装系统消息" → 整个 fence 内容进 quoted_spans。
 *
 * 覆盖：
 *   - `system:` / `user:` / `assistant:` / `developer:` / `tool:`（行首或 yaml-style）
 *   - `<|im_start|>` / `<|im_end|>` (ChatML)
 *   - `[INST]` / `[/INST]` (Llama-style)
 *   - `### Instruction:` / `### Response:` (Alpaca)
 *   - `Human:` / `Assistant:` (Anthropic-style)
 *   - YAML role assertion: `role: system` / `role: user`
 */
const ROLE_TOKEN_RE =
  /(?:^|\n)\s*(?:system|user|assistant|developer|tool|human)\s*[:：]|<\|im_(?:start|end)\|>|\[\/?INST\]|###\s*(?:Instruction|Response|Input|Output)\s*[:：]?|(?:^|\n)\s*role\s*[:：]\s*(?:system|user|assistant|developer)/gi

/** YAML/JSON 假装 messages 数组：`messages: [` 或 `"messages":` 等 */
const YAML_MESSAGES_RE =
  /(?:^|\n)\s*(?:["']?messages["']?\s*[:：]\s*\[|messages\s*:\s*\n\s*-\s*role\s*[:：])/gi

export function pass3Fence(input: string): SanitizePassOutput {
  const segments: QuarantinedSegment[] = []
  const triggers: RedLineTrigger[] = []

  let text = input
  // 1) 围栏块内含 role-token → 整个围栏剥离 + 进 quoted_spans
  const fenceMatches = [...text.matchAll(FENCE_RE)]
  // 倒序处理（保留偏移稳定）
  for (const m of fenceMatches.reverse()) {
    const fenceFull = m[0]
    const fenceLang = (m[2] ?? "").trim()
    const fenceBody = m[3] ?? ""
    if (ROLE_TOKEN_RE.test(fenceBody) || YAML_MESSAGES_RE.test(fenceBody)) {
      // reset lastIndex on global regexes used with .test
      ROLE_TOKEN_RE.lastIndex = 0
      YAML_MESSAGES_RE.lastIndex = 0
      segments.push({
        reason: "fence_role_token",
        original: fenceFull,
        detail: `fence lang="${fenceLang}" 内含 role-token / messages 数组`,
        positionHint: m.index,
      })
      // 围栏整段从 text 剥离
      const start = m.index ?? 0
      text = text.slice(0, start) + text.slice(start + fenceFull.length)
    } else {
      // reset 即便没命中也要 reset，避免下次 .test 起点错
      ROLE_TOKEN_RE.lastIndex = 0
      YAML_MESSAGES_RE.lastIndex = 0
    }
  }

  // 2) 围栏外的 yaml-style 假装 messages（防 sneaky 不在 fence 里的）
  const yamlMatches = [...text.matchAll(YAML_MESSAGES_RE)]
  for (const m of yamlMatches) {
    segments.push({
      reason: "fence_yaml_role",
      original: m[0],
      positionHint: m.index,
    })
  }
  if (yamlMatches.length > 0) text = text.replace(YAML_MESSAGES_RE, "\n")

  // 3) 围栏外裸的 `<|im_start|>` 等 ChatML / Llama 标签（不依赖 fence 包）
  const chatMlRe = /<\|im_(?:start|end)\|>|\[\/?INST\]/gi
  const chatMlMatches = [...text.matchAll(chatMlRe)]
  for (const m of chatMlMatches) {
    segments.push({
      reason: "fence_role_token",
      original: m[0],
      detail: "raw ChatML / Llama instruct token outside fence",
      positionHint: m.index,
    })
  }
  if (chatMlMatches.length > 0) text = text.replace(chatMlRe, "")

  return { text, segments, triggers }
}

// ─────────────────────────────────────────────────────────────────────
// Pass 4 · Encoding 探针（Base64 + 高熵段）
// ─────────────────────────────────────────────────────────────────────

const BASE64_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g
const JAILBREAK_KEYWORDS = [
  "ignore previous instructions",
  "ignore above instructions",
  "disregard previous",
  "you are now",
  "act as",
  "pretend to be",
  "system prompt",
  "reveal your prompt",
  "forget your instructions",
  "override your instructions",
]

export function pass4Encoding(
  input: string,
  entropyThreshold: number,
  base64MinLength: number,
): SanitizePassOutput {
  const segments: QuarantinedSegment[] = []
  const triggers: RedLineTrigger[] = []

  // 1) Base64 探测：找长串 base64 字符 + 解码 + 检 jailbreak keyword
  const b64Matches = [...input.matchAll(BASE64_RE)]
  let text = input
  for (const m of b64Matches) {
    const candidate = m[0]
    if (candidate.length < base64MinLength) continue
    let decoded: string
    try {
      decoded = Buffer.from(candidate, "base64").toString("utf-8")
    } catch {
      continue
    }
    const decodedLower = decoded.toLowerCase()
    const printableRatio = printableCharRatio(decoded)
    if (printableRatio < 0.6) continue // 解码出大量乱码 → 大概率不是 base64 文本
    segments.push({
      reason: "encoding_base64",
      original: candidate,
      decoded,
      detail: `base64 decoded ${decoded.length} chars (printable ratio=${printableRatio.toFixed(2)})`,
      positionHint: m.index,
    })
    // 解码后含 jailbreak keyword → 红线
    for (const kw of JAILBREAK_KEYWORDS) {
      if (decodedLower.includes(kw)) {
        triggers.push({
          reason: "encoded_jailbreak",
          matched: kw,
          position: m.index,
          detail: `base64 segment decoded contains "${kw}"`,
        })
        break
      }
    }
    // 剥离 base64 串本身
    text = text.replace(candidate, "")
  }

  // 2) 高熵段（除 base64 已处理的）：滑窗找 H > entropyThreshold 的连续段
  const highEntropySegments = findHighEntropySegments(text, entropyThreshold)
  for (const he of highEntropySegments) {
    segments.push({
      reason: "encoding_high_entropy",
      original: he.text,
      detail: `entropy=${he.entropy.toFixed(2)} bits/char (threshold=${entropyThreshold})`,
      positionHint: he.start,
    })
    text = text.slice(0, he.start) + text.slice(he.start + he.text.length)
  }

  return { text, segments, triggers }
}

function printableCharRatio(s: string): number {
  if (s.length === 0) return 0
  let printable = 0
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if ((code >= 0x20 && code <= 0x7e) || code === 0x09 || code === 0x0a || code >= 0x80) {
      printable++
    }
  }
  return printable / s.length
}

interface HighEntropyHit {
  text: string
  entropy: number
  start: number
}

function findHighEntropySegments(input: string, threshold: number): HighEntropyHit[] {
  // 按空白分词，对长度 ≥ 30 的 token 算香农熵
  const hits: HighEntropyHit[] = []
  const tokenRe = /\S{30,}/g
  for (const m of input.matchAll(tokenRe)) {
    const token = m[0]
    const h = shannonEntropy(token)
    if (h >= threshold) {
      hits.push({ text: token, entropy: h, start: m.index ?? 0 })
    }
  }
  return hits
}

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of freq.values()) {
    const p = c / s.length
    h -= p * Math.log2(p)
  }
  return h
}
