import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { RealtimeServerEvent } from "@multi-agent/shared"
import { extractSessionGroupId, shouldDeliver } from "./ws-routing"

describe("extractSessionGroupId (F026 P0 Day2 · I3)", () => {
  it("returns sessionGroupId from assistant_delta payload", () => {
    const ev: RealtimeServerEvent = {
      type: "assistant_delta",
      payload: { sessionGroupId: "room-A", messageId: "m1", delta: "hi" },
    }
    assert.equal(extractSessionGroupId(ev), "room-A")
  })

  it("returns null when status event has no sessionGroupId", () => {
    const ev: RealtimeServerEvent = {
      type: "status",
      payload: { message: "hello" },
    }
    assert.equal(extractSessionGroupId(ev), null)
  })

  it("returns null when message.created has no sessionGroupId (legacy shape)", () => {
    const ev: RealtimeServerEvent = {
      type: "message.created",
      payload: {
        threadId: "t1",
        message: {
          id: "msg-1",
          provider: "claude",
          alias: "仁勋",
          role: "assistant",
          content: "x",
          createdAt: "2026-04-24T00:00:00Z",
        } as unknown as RealtimeServerEvent extends { type: "message.created" } ? never : never,
      } as never,
    } as RealtimeServerEvent
    assert.equal(extractSessionGroupId(ev), null)
  })

  it("derives sessionGroupId from dispatch.blocked attempts[0]", () => {
    const ev: RealtimeServerEvent = {
      type: "dispatch.blocked",
      payload: {
        attempts: [{ sessionGroupId: "room-A" } as never, { sessionGroupId: "room-A" } as never],
      },
    }
    assert.equal(extractSessionGroupId(ev), "room-A")
  })

  it("returns null when dispatch.blocked attempts is empty", () => {
    const ev: RealtimeServerEvent = {
      type: "dispatch.blocked",
      payload: { attempts: [] },
    }
    assert.equal(extractSessionGroupId(ev), null)
  })

  it("returns sessionGroupId from approval.resolved payload", () => {
    const ev: RealtimeServerEvent = {
      type: "approval.resolved",
      payload: { sessionGroupId: "room-B", requestId: "r1", granted: true },
    }
    assert.equal(extractSessionGroupId(ev), "room-B")
  })
})

describe("shouldDeliver (F026 P0 Day2 · I3)", () => {
  it("delivers when event groupId matches socket subscription", () => {
    assert.equal(shouldDeliver("room-A", "room-A"), true)
  })

  it("drops when event groupId does NOT match socket subscription", () => {
    assert.equal(shouldDeliver("room-B", "room-A"), false)
  })

  it("drops when event has groupId but socket is unsubscribed (strict mode)", () => {
    assert.equal(shouldDeliver(undefined, "room-A"), false)
  })

  it("fan-outs (delivers) when event has no groupId — legacy fallback", () => {
    assert.equal(shouldDeliver("room-A", null), true)
    assert.equal(shouldDeliver(undefined, null), true)
  })

  it("fuzz · 10000 room-A events produce 0 leakage to room-B socket", () => {
    let leakedToB = 0
    let deliveredToA = 0
    for (let i = 0; i < 10000; i++) {
      const eventGroupId = "room-A"
      if (shouldDeliver("room-A", eventGroupId)) deliveredToA++
      if (shouldDeliver("room-B", eventGroupId)) leakedToB++
    }
    assert.equal(leakedToB, 0, "B must be a black hole for A traffic")
    assert.equal(deliveredToA, 10000)
  })
})
