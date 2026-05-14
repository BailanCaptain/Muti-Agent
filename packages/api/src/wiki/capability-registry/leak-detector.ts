/**
 * F027 P9 · sender risk leak detector
 * 真相源：docs/plans/V16.5-final.md chap 13 行 1492
 *   "risks 严禁暴露给 receiver — receiver 后来 read_wiki 才能看到。"
 *
 * 用途：
 *   - fixture 红绿验证（red-leaks-sender-risk.json 必须被检出 leak；
 *     green-neutralized.json 必须 clean）
 *   - 集成测试 / 运行时 audit hook
 *
 * 算法：
 *   遍历 envelope 所有字符串字段，对每个 sender（registry 里所有非 receiver
 *   的 agent）的"敏感字段"（top_risks.text + must_not + capability_digest_for_self）
 *   做子串匹配。命中即 leak。
 *
 * 匹配规则（保守优先：宁误报不漏报）：
 *   - 子串匹配（不是 word boundary）—— 攻击者会用半句嵌入
 *   - 大小写不敏感
 *   - top_risks 的 LL-XX id 也作单独 sentinel（短 id 也算 leak 信号）
 *   - 排除 ≤ 4 字符的 fragment（避免 "API" / "log" 等过短词误报）
 */

import type { CapabilityRegistry, ReceiverHandoffEnvelope } from "./types"

export interface LeakFinding {
  /** 哪个 agent 的 sensitive data 漏出 */
  sourceAgent: string
  /** 哪个槽位漏出（top_risks / must_not / capability_digest_for_self） */
  sourceField: "top_risks" | "must_not" | "capability_digest_for_self"
  /** 漏出的具体片段（≤ 80 char 截断） */
  leakedFragment: string
  /** envelope 里命中的 path（如 "task" / "collaboration_contract.context_summary"） */
  envelopeField: string
}

export interface LeakScanResult {
  hasLeak: boolean
  findings: LeakFinding[]
}

/**
 * 单 fragment 长度阈值。短于此的 risk text fragment 不参与匹配
 * （避免 "log" / "API" 等通用词误报）。
 */
const MIN_FRAGMENT_LEN = 5

export interface LeakDetectorOptions {
  /**
   * 范-r1 P2：聚合扫描。把 envelope 所有 string 字段拼接成单一字符串再扫。
   * 抓"跨字段拼接绕过"——attacker 把 risk text 拆到 evidence[0] + evidence[1]
   * 让单字段子串扫描漏抓。
   * 默认 false 保持向后兼容 + 单字段精确定位（envelopeField 不准确）；
   * audit hook / runtime 强 sec 模式应开 true。
   */
  aggregate?: boolean
}

/**
 * 扫 envelope 是否漏出 sender（不含 receiver 自己）的 sensitive fields。
 * 主用途：fixture red 验证 + audit hook。
 */
export function detectSenderRiskLeak(
  envelope: ReceiverHandoffEnvelope,
  registry: CapabilityRegistry,
  options?: LeakDetectorOptions,
): LeakScanResult {
  const findings: LeakFinding[] = []
  const envelopeStrings = collectEnvelopeStrings(envelope)

  // 范-r1 P2：聚合扫描准备 —— 用换行拼接所有非 receiver 字段，让 attacker 拆到
  // 多个字段的 risk text 在聚合视图下重组。换行不参与匹配（risk text 不会含换行
  // 前缀 + risk text 也不跨行写）。
  const aggregateText = options?.aggregate
    ? envelopeStrings.map((e) => e.value).join("\n")
    : null

  for (const [agentName, cap] of registry.agents) {
    if (agentName === envelope.receiver_alias) continue // receiver 自己的 data 不算 leak

    // 收集该 agent 的"敏感片段"
    const sensitiveFragments: Array<{
      field: "top_risks" | "must_not" | "capability_digest_for_self"
      fragment: string
    }> = []
    for (const risk of cap.top_risks) {
      // text 整段 + LL-XX id 都作 sentinel
      if (risk.text.length >= MIN_FRAGMENT_LEN) {
        sensitiveFragments.push({ field: "top_risks", fragment: risk.text })
      }
      if (risk.id.length >= MIN_FRAGMENT_LEN) {
        sensitiveFragments.push({ field: "top_risks", fragment: risk.id })
      }
    }
    for (const m of cap.must_not) {
      if (m.length >= MIN_FRAGMENT_LEN) {
        sensitiveFragments.push({ field: "must_not", fragment: m })
      }
    }
    // capability_digest_for_self 整体段 + 按行拆（行级 sentinel 抓"被强质疑易道歉"等单条）
    for (const line of cap.capability_digest_for_self.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length >= MIN_FRAGMENT_LEN) {
        sensitiveFragments.push({
          field: "capability_digest_for_self",
          fragment: trimmed,
        })
      }
    }

    // 在 envelope 字符串里找（单字段扫，envelopeField 精确定位）
    for (const { field, fragment } of sensitiveFragments) {
      const fragLower = fragment.toLowerCase()
      for (const { fieldPath, value } of envelopeStrings) {
        if (value.toLowerCase().includes(fragLower)) {
          findings.push({
            sourceAgent: agentName,
            sourceField: field,
            leakedFragment: truncate(fragment),
            envelopeField: fieldPath,
          })
        }
      }
    }

    // 范-r1 P2：聚合 n-gram 扫描（aggregate=true 时）
    // 攻击者把 risk text 拆到多个字段（中间隔无关文本）→ 单字段子串扫漏抓 +
    // naive `\n` 拼接也漏（被 "evidence B：" 等分隔文本切断）。
    // 算法：对每个 risk fragment 取 8 字符滑动窗口集合，看在聚合文本里命中比例。
    // 命中 ≥ N_GRAM_LEAK_RATIO → 报 leak（fragment 大部分内容仍可被 receiver 还原）。
    if (aggregateText !== null) {
      const aggLower = aggregateText.toLowerCase()
      for (const { field, fragment } of sensitiveFragments) {
        if (fragment.length < N_GRAM_WINDOW) continue
        const ratio = ngramMatchRatio(fragment.toLowerCase(), aggLower)
        if (ratio >= N_GRAM_LEAK_RATIO) {
          findings.push({
            sourceAgent: agentName,
            sourceField: field,
            leakedFragment: truncate(fragment),
            envelopeField: `<aggregate ngram=${ratio.toFixed(2)}>`,
          })
        }
      }
    }
  }

  return { hasLeak: findings.length > 0, findings: dedupeFindings(findings) }
}

interface EnvelopeStringEntry {
  fieldPath: string
  value: string
}

function collectEnvelopeStrings(env: ReceiverHandoffEnvelope): EnvelopeStringEntry[] {
  const out: EnvelopeStringEntry[] = []
  out.push({ fieldPath: "task", value: env.task })
  out.push({ fieldPath: "receiver_capability_digest", value: env.receiver_capability_digest })
  out.push({
    fieldPath: "collaboration_contract.context_summary",
    value: env.collaboration_contract.context_summary,
  })
  for (const [i, ev] of env.collaboration_contract.expected_evidence.entries()) {
    out.push({ fieldPath: `collaboration_contract.expected_evidence[${i}]`, value: ev })
  }
  for (const [i, m] of env.collaboration_contract.receiver_must_do.entries()) {
    out.push({ fieldPath: `collaboration_contract.receiver_must_do[${i}]`, value: m })
  }
  // do_not_section 恒空，跳过
  return out
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 范-r1 P2：n-gram 滑动窗口长度 + 命中比例阈值。
 * 8 字符窗口在中文 / ASCII 混合文本里平衡误报 / 漏报：
 *   - 中文 8 字符约 = 8 codepoint ≈ 半句意；ASCII 8 字符约 = 一个长 word
 *   - 0.5 命中比例：half-copy 还原即报 leak（attacker 拆 2 段已暴露主体）
 *   - 风险：极短 risk text (< 8 字符) 跳过；调用方依赖 LL-XX id sentinel 兜底
 */
const N_GRAM_WINDOW = 8
const N_GRAM_LEAK_RATIO = 0.5

function ngramMatchRatio(needleLower: string, haystackLower: string): number {
  const windows = new Set<string>()
  for (let i = 0; i <= needleLower.length - N_GRAM_WINDOW; i++) {
    const w = needleLower.slice(i, i + N_GRAM_WINDOW)
    // 跳过纯空白 / 纯标点 window（避免 "   /   " 类窗口被任何文本命中）
    if (/^[\s\p{P}]+$/u.test(w)) continue
    windows.add(w)
  }
  if (windows.size === 0) return 0
  let hit = 0
  for (const w of windows) {
    if (haystackLower.includes(w)) hit++
  }
  return hit / windows.size
}

function dedupeFindings(arr: LeakFinding[]): LeakFinding[] {
  const seen = new Set<string>()
  const out: LeakFinding[] = []
  for (const f of arr) {
    const key = `${f.sourceAgent}::${f.sourceField}::${f.leakedFragment}::${f.envelopeField}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}
