import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RealtimeBroadcaster } from "../../routes/ws"
import { createRealtimeAuditBroadcaster } from "./realtime-audit-broadcaster"

/**
 * F027 P4 AC-P4-8 (e2) · RealtimeAuditBroadcaster 单测
 *
 * 测试覆盖:
 *   (1) broadcast 转发到 realtime broadcaster
 *   (2) payload 完整传递
 *   (3) event.type 始终 'recall.escalated'
 *   (4) realtime.broadcast 内部抛错 不传播 (caller ProductionLevel5Sink 自己 fail-soft)
 */

function mockRealtime(): { broadcaster: RealtimeBroadcaster; events: unknown[] } {
  const events: unknown[] = []
  return {
    broadcaster: {
      broadcast: (event) => {
        events.push(event)
      },
    },
    events,
  }
}

describe("createRealtimeAuditBroadcaster", () => {
  it("(1) broadcast 转发到 realtime broadcaster", () => {
    const { broadcaster, events } = mockRealtime()
    const audit = createRealtimeAuditBroadcaster(broadcaster)

    audit.broadcast({
      type: "recall.escalated",
      payload: {
        roomId: "R-001",
        alias: "黄仁勋",
        trigger: "wake_up",
        visitedLevels: [2, 3, 4],
        reason: "all levels exhausted",
        totalMs: 1500,
        critiqueCalls: 4,
        wikiEventId: 42,
        eventPath: "audit/recall/R-001/2026-05-24T04:00:00.000Z",
        ts: "2026-05-24T04:00:00.000Z",
      },
    })

    assert.equal(events.length, 1)
  })

  it("(2) payload 完整传递", () => {
    const { broadcaster, events } = mockRealtime()
    const audit = createRealtimeAuditBroadcaster(broadcaster)

    const inputEvent = {
      type: "recall.escalated" as const,
      payload: {
        roomId: "R-007",
        alias: "范德彪",
        trigger: "a2a_handoff",
        visitedLevels: [2, 3, 4, 5] as ReadonlyArray<number>,
        reason: "user requested manual review",
        totalMs: 8000,
        critiqueCalls: 12,
        wikiEventId: 999,
        eventPath: "audit/recall/R-007/foo",
        ts: "2026-05-24T05:00:00.000Z",
      },
    }
    audit.broadcast(inputEvent)

    assert.deepEqual(events[0], inputEvent)
  })

  it("(3) event.type 始终 'recall.escalated'", () => {
    const { broadcaster, events } = mockRealtime()
    const audit = createRealtimeAuditBroadcaster(broadcaster)
    audit.broadcast({
      type: "recall.escalated",
      payload: {
        roomId: "R-002",
        alias: "x",
        trigger: "t",
        visitedLevels: [],
        reason: "r",
        totalMs: 0,
        critiqueCalls: 0,
        wikiEventId: 0,
        eventPath: "p",
        ts: "t",
      },
    })
    assert.equal((events[0] as { type: string }).type, "recall.escalated")
  })

  it("(4) realtime.broadcast 抛错 propagates (caller 自 fail-soft handle)", () => {
    const broadcaster: RealtimeBroadcaster = {
      broadcast: () => {
        throw new Error("ws closed")
      },
    }
    const audit = createRealtimeAuditBroadcaster(broadcaster)
    // 我们让错误透传 — ProductionLevel5Sink.escalate (level5-escalate-sink.ts:204) 自己 try/catch fail-soft
    assert.throws(() =>
      audit.broadcast({
        type: "recall.escalated",
        payload: {
          roomId: "R-001",
          alias: "x",
          trigger: "t",
          visitedLevels: [],
          reason: "r",
          totalMs: 0,
          critiqueCalls: 0,
          wikiEventId: 0,
          eventPath: "p",
          ts: "t",
        },
      }),
    )
  })
})
