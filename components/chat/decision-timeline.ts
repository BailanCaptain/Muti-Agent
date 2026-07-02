import type { DecisionRecord, DecisionRequest } from "@multi-agent/shared"

// F033 · 时间线决策分轨纯函数（纯函数·单测见 decision-timeline.test.ts）。
// pending = 活句柄（可点 DecisionCard），records = 已决账本（disabled DecisionRecordCard）。
// 同 requestId 两轨都有时 pending 优先——live 卡可点，record 是它的历史影子。
export type DecisionTimelineSplit = {
  inlineDecisionsByMsgId: Map<string, DecisionRequest[]>
  standAloneDecisions: DecisionRequest[]
  inlineRecordsByMsgId: Map<string, DecisionRecord[]>
  standaloneRecords: DecisionRecord[]
}

export function splitDecisionsForTimeline(
  pending: DecisionRequest[],
  records: DecisionRecord[],
  activeGroupId: string | null,
): DecisionTimelineSplit {
  const inlineDecisionsByMsgId = new Map<string, DecisionRequest[]>()
  const standAloneDecisions: DecisionRequest[] = []
  const inlineRecordsByMsgId = new Map<string, DecisionRecord[]>()
  const standaloneRecords: DecisionRecord[] = []

  if (!activeGroupId) {
    return {
      inlineDecisionsByMsgId,
      standAloneDecisions,
      inlineRecordsByMsgId,
      standaloneRecords,
    }
  }

  const pendingIds = new Set<string>()
  for (const d of pending) {
    if (d.sessionGroupId !== activeGroupId) continue
    pendingIds.add(d.requestId)
    if (d.anchorMessageId) {
      const list = inlineDecisionsByMsgId.get(d.anchorMessageId)
      if (list) list.push(d)
      else inlineDecisionsByMsgId.set(d.anchorMessageId, [d])
    } else {
      standAloneDecisions.push(d)
    }
  }

  const sortedRecords = records
    .filter((r) => r.sessionGroupId === activeGroupId && !pendingIds.has(r.requestId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const r of sortedRecords) {
    if (r.anchorMessageId) {
      const list = inlineRecordsByMsgId.get(r.anchorMessageId)
      if (list) list.push(r)
      else inlineRecordsByMsgId.set(r.anchorMessageId, [r])
    } else {
      standaloneRecords.push(r)
    }
  }

  return { inlineDecisionsByMsgId, standAloneDecisions, inlineRecordsByMsgId, standaloneRecords }
}
