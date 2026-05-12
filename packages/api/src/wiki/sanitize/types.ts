/**
 * F027 P4 · sanitize 5 层防御 · 共享类型
 * 真相源：docs/plans/V16.5-final.md chap 7 (raw drop taint model + 5 层防御)
 *
 * 核心数据流：
 *   raw drop（含可能的 prompt injection / 同形字 / 隐藏 HTML / fence 假装 / base64 编码）
 *     → sanitizeRawDrop()
 *     → SanitizeResult { sanitizedText, quarantinedSegments, redLineTriggers, blocked }
 *     → 通过：作 USER MESSAGE 数据块 + quarantinedSegments 作 quoted_spans 给 compile-LLM
 *     → blocked：进 wiki/concepts/draft/_quarantined/，等小孙手 review
 */

export type QuarantineReason =
  | "control_char"
  | "invisible_format_char"
  | "bidi_override"
  | "unicode_tag"
  | "html_comment"
  | "html_script"
  | "html_iframe"
  | "html_dangerous_url"
  | "fence_role_token"
  | "fence_yaml_role"
  | "encoding_base64"
  | "encoding_high_entropy"

export interface QuarantinedSegment {
  reason: QuarantineReason
  /** 原文片段（保留作 quoted_spans 给 LLM 看，让它知道有过攻击片段） */
  original: string
  /** 解码 / 解释后的内容（如 base64 → 解码结果；如 NFKC 归一化前 → 后） */
  decoded?: string
  /** 触发原因细节（如检测到的 keyword / 熵值） */
  detail?: string
  /** 被剥离前在原文中的近似位置（NFKC 归一化前） */
  positionHint?: number
}

export type RedLineReason =
  /** "ignore previous instructions" / "you are now" 等 jailbreak 模板 */
  | "jailbreak_template"
  /** <script> / <iframe> 标签出现 */
  | "dangerous_html_tag"
  /** javascript: / data:text/html: URL */
  | "dangerous_url_scheme"
  /** base64 解码后包含 jailbreak 关键词 */
  | "encoded_jailbreak"
  /** 文件 > maxBytes（默认 10 MB），防 token 炸弹 */
  | "size_exceeded"

export interface RedLineTrigger {
  reason: RedLineReason
  /** 触发的关键词 / 模式（短截断版，便于日志） */
  matched: string
  /** 触发位置（在 NFKC 归一化后的文本里） */
  position?: number
  /** 红线信号补充上下文（短） */
  detail?: string
}

export interface SanitizeResult {
  /** 经 5 层防御后的"安全"文本（quarantined 内容已剥离 / 替换 / 标注） */
  sanitizedText: string
  /** 隔离段列表，传给 LLM compile 时作为 quoted_spans —— LLM 看到这些片段时知道是隔离区，不可执行 */
  quarantinedSegments: QuarantinedSegment[]
  /** 红线触发；非空时 blocked=true，整体进 _quarantined/ */
  redLineTriggers: RedLineTrigger[]
  /**
   * 是否触发整体 BLOCK：
   *   1. redLineTriggers 非空，或
   *   2. quarantinedRatio > maxQuarantinedRatio（默认 30%）
   * blocked=true 时 caller 必须落 wiki/concepts/draft/_quarantined/ 不可走正常 ingest。
   */
  blocked: boolean
  /**
   * Multi-pass 实际跑的轮次。
   * V16.5 chap 7 Pass 5："前 4 层任何修改触发再扫一次"——
   * 直到一轮内所有 pass 都不再修改文本（fixed point）。
   */
  passes: number
  /** quarantined 字符数 / 原文字符数；超过 maxQuarantinedRatio 时整体 BLOCK */
  quarantinedRatio: number
  /** 输入字节数（统计用 + size_exceeded 报告） */
  inputBytes: number
}

export interface SanitizeOptions {
  /** 文件大小上限（字节）。> 此值 → red line size_exceeded + 不再处理。默认 10 MB。 */
  maxBytes?: number
  /** quarantined 字符占比超过此值 → 整体 BLOCK。默认 0.3（30%）。 */
  maxQuarantinedRatio?: number
  /** Multi-pass 最大轮次（防 pathological 死循环）。默认 5。 */
  maxPasses?: number
  /** 字符级香农熵阈值（bits/char）。≥ 此值视为高熵段（可能是 base64 / 加密 / 二进制）。默认 4.5。 */
  entropyThreshold?: number
  /** Base64 探测最小长度（短串 false positive 多）。默认 40。 */
  base64MinLength?: number
}

/** caller 拿到 blocked=true 想抛错时用 */
export class SanitizeBlockedError extends Error {
  readonly result: SanitizeResult
  constructor(result: SanitizeResult) {
    super(
      `raw drop sanitize blocked: ${result.redLineTriggers.length} red line(s) + ${(
        result.quarantinedRatio * 100
      ).toFixed(1)}% quarantined`,
    )
    this.name = "SanitizeBlockedError"
    this.result = result
  }
}

/** 单个 pass 的输出（main sanitizer 累加 segments / triggers，并按 text === before 判稳定） */
export interface SanitizePassOutput {
  text: string
  segments: QuarantinedSegment[]
  triggers: RedLineTrigger[]
}
