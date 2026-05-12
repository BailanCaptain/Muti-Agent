/**
 * F027 P9 · handoff 中性改写
 * 真相源：docs/plans/V16.5-final.md chap 13 行 1478-1492
 * AC: AC-P1-13 ——
 *   sender alias 黄仁勋 → @桂芬 时，receiver 看到的 prompt
 *   不暴露 sender risks（top_risks / must_not / capability_digest_for_self）
 *
 * 设计原则：
 *   - **白名单输出**：rewriter 只输出 4 字段固定 envelope
 *     ({ sender_alias, receiver_alias, task, receiver_capability_digest, collaboration_contract })
 *     不允许 receiver 端通过任何字段反推 sender 内部状态
 *   - **registry 单向取数**：从 receiver 取 capability_digest 和 must_do；
 *     sender 槽位**不读**（防 future bug 把 sender data 漏进去）
 *   - **任务文本 sanitize**：task / contextSummary 走 sanitizeRawDrop 通流
 *     （5 层防御 + chained pattern 兼容）；这里只做 envelope 层结构防护
 *   - **expected_evidence 中性化**：sender 提供的 evidence 要求 + receiver
 *     handoff_contract 自身条款合并 dedupe；sender 的 must_do 不引进来
 */

import type {
  AgentCapability,
  CapabilityRegistry,
  ReceiverHandoffEnvelope,
  SenderHandoff,
} from "./types"
import { UnknownReceiverError } from "./types"

export function rewriteHandoffForReceiver(
  handoff: SenderHandoff,
  registry: CapabilityRegistry,
): ReceiverHandoffEnvelope {
  const receiverCap = registry.agents.get(handoff.receiverAlias)
  if (!receiverCap) {
    throw new UnknownReceiverError(handoff.receiverAlias, [...registry.agents.keys()])
  }

  // 严格只用 receiver 槽位 —— 这里**不读**任何 sender 槽位，防 future bug 把
  // sender data 漏进 envelope。sender_alias 只作 metadata（receiver 总要知道谁在派）。
  const receiverDigest = receiverCap.capability_digest_for_self.trim()
  const receiverMustDo = neutralizeMustDo(receiverCap)

  // expected_evidence：sender 显式给的 + receiver handoff_contract 自身条款
  // dedupe 后输出。sender 的 must_do / top_risks 不引进来。
  const expectedEvidence = dedupeStrings([
    ...(handoff.expectedEvidence ?? []),
    ...receiverCap.handoff_contract,
  ])

  return {
    sender_alias: handoff.senderAlias,
    receiver_alias: handoff.receiverAlias,
    task: handoff.task.trim(),
    receiver_capability_digest: receiverDigest,
    collaboration_contract: {
      sender_alias: handoff.senderAlias,
      context_summary: (handoff.contextSummary ?? "").trim(),
      expected_evidence: expectedEvidence,
      receiver_must_do: receiverMustDo,
      // V16.5 chap 13 行 1489: do_not_section 恒空（"任何 do_not 都不暴露"）
      do_not_section: [],
    },
  }
}

/**
 * 中性化 receiver 的 must_do：
 * receiver 自己的 must_do 是给"接 handoff 后做什么"用的，本身就是 receiver
 * 视角的纪律，可见无碍。但是要注意：receiver 的 must_do 里如果引了 sender
 * 名字（如 "改 message schema 必须 sync 黄仁勋"），保留没问题（这是 receiver
 * 自己的 sync 约束，不暴露黄仁勋的 risks）。
 */
function neutralizeMustDo(receiverCap: AgentCapability): string[] {
  return receiverCap.must_do.slice()
}

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of arr) {
    const trimmed = s.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Caller-side 取 self capability_digest（wake-up 注入用，V16.5 chap 13 行 1498）。
 * 不走 rewriter 通流（那是 cross-agent handoff 用的）；self prompt 注入是
 * agent 自己看自己的 6 槽位摘要，可见全部。
 */
export function getSelfCapabilityDigest(
  agentAlias: string,
  registry: CapabilityRegistry,
): string {
  const cap = registry.agents.get(agentAlias)
  if (!cap) {
    throw new Error(
      `cannot get self digest: agent "${agentAlias}" not in registry. Known: ${[
        ...registry.agents.keys(),
      ].join(", ")}`,
    )
  }
  return cap.capability_digest_for_self.trim()
}
