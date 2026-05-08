import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { DispatchValidationRetryPayload } from "@multi-agent/shared"
import { useDispatchRetryStore } from "./dispatch-retry-store"

function makePayload(
  overrides: Partial<DispatchValidationRetryPayload> = {},
): DispatchValidationRetryPayload {
  return {
    sessionGroupId: "g1",
    threadId: "t1",
    invocationId: "inv1",
    agentId: "claude",
    messageId: "msg-1",
    attemptIndex: 1,
    maxAttempts: 3,
    reason: "nested_call_tag",
    originalText: "[Call: @A ... [Call: @B] ...]",
    status: "retrying",
    occurredAt: "2026-04-28T01:00:00Z",
    ...overrides,
  }
}

describe("dispatch-retry-store (F026 P3.1 · AC-14 · 实时进度卡 store)", () => {
  beforeEach(() => {
    useDispatchRetryStore.setState({ active: {} })
  })

  afterEach(() => {
    useDispatchRetryStore.setState({ active: {} })
  })

  it("recordRetry stores retrying payload keyed by messageId", () => {
    const payload = makePayload()
    useDispatchRetryStore.getState().recordRetry(payload)
    expect(useDispatchRetryStore.getState().active["msg-1"]).toEqual(payload)
  })

  it("recordRetry overwrites earlier attempt with later attempt for same messageId", () => {
    const first = makePayload({ attemptIndex: 1 })
    const second = makePayload({ attemptIndex: 2, occurredAt: "2026-04-28T01:00:05Z" })
    useDispatchRetryStore.getState().recordRetry(first)
    useDispatchRetryStore.getState().recordRetry(second)
    expect(useDispatchRetryStore.getState().active["msg-1"]?.attemptIndex).toBe(2)
  })

  it("recordRetry status=exhausted clears the entry (banner takes over)", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ attemptIndex: 3 }))
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ attemptIndex: 3, status: "exhausted" }),
    )
    expect(useDispatchRetryStore.getState().active["msg-1"]).toBeUndefined()
  })

  it("AC-21 · recordRetry status=settled clears the entry (retry 收尾后进度卡撤掉)", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ attemptIndex: 1 }))
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ attemptIndex: 2, status: "settled" }),
    )
    expect(useDispatchRetryStore.getState().active["msg-1"]).toBeUndefined()
  })

  it("clearRetry removes a single messageId entry without affecting others", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-A" }))
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-B" }))
    useDispatchRetryStore.getState().clearRetry("msg-A")
    expect(useDispatchRetryStore.getState().active["msg-A"]).toBeUndefined()
    expect(useDispatchRetryStore.getState().active["msg-B"]).toBeDefined()
  })

  it("clearRetry on missing messageId is a no-op", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-X" }))
    useDispatchRetryStore.getState().clearRetry("msg-NOT-THERE")
    expect(useDispatchRetryStore.getState().active["msg-X"]).toBeDefined()
  })

  it("reset wipes all entries", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-1" }))
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-2" }))
    useDispatchRetryStore.getState().reset()
    expect(useDispatchRetryStore.getState().active).toEqual({})
  })
})
