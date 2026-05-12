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

/**
 * 扫 envelope 是否漏出 sender（不含 receiver 自己）的 sensitive fields。
 * 主用途：fixture red 验证 + audit hook。
 */
export function detectSenderRiskLeak(
  envelope: ReceiverHandoffEnvelope,
  registry: CapabilityRegistry,
): LeakScanResult {
  const findings: LeakFinding[] = []
  const envelopeStrings = collectEnvelopeStrings(envelope)

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

    // 在 envelope 字符串里找
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
