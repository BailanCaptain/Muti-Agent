import type { TimelineMessage } from "@multi-agent/shared"

const EVIDENCE_PATTERN = /(https?:\/\/|```|^\s*>|\|.+\|)/m

export function summarizeTimelineStats(timeline: TimelineMessage[]) {
  let evidence = 0
  let followUp = 0

  for (const message of timeline) {
    const content = message.content
    const thinking = message.thinking ?? ""
    if (message.role === "user") followUp += 1
    if (EVIDENCE_PATTERN.test(content) || EVIDENCE_PATTERN.test(thinking)) evidence += 1
  }

  return { messages: timeline.length, evidence, followUp }
}
