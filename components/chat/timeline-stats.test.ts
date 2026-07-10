import type { TimelineMessage } from "@multi-agent/shared"
import { describe, expect, it } from "vitest"
import { summarizeTimelineStats } from "./timeline-stats"

describe("F044 summarizeTimelineStats", () => {
  it("counts messages, evidence and follow-ups in one property pass without concatenating text", () => {
    let contentReads = 0
    let thinkingReads = 0
    const message = {
      id: "m1",
      provider: "codex",
      alias: "范德彪",
      role: "user",
      messageType: "final",
      model: null,
      createdAt: "2026-07-10T00:00:00Z",
      get content() {
        contentReads += 1
        return "plain question"
      },
      get thinking() {
        thinkingReads += 1
        return "evidence: https://example.test"
      },
    } as TimelineMessage

    expect(summarizeTimelineStats([message])).toEqual({
      messages: 1,
      evidence: 1,
      followUp: 1,
    })
    expect(contentReads).toBe(1)
    expect(thinkingReads).toBe(1)
  })
})
