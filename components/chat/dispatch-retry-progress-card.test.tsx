import { describe, it, expect, beforeEach } from "vitest"
import { render, renderHook, screen } from "@testing-library/react"
import type { DispatchValidationRetryPayload } from "@multi-agent/shared"
import {
  DispatchRetryProgressCard,
  DispatchRetryStreamingLock,
  useDispatchRetryStreamingLock,
} from "./dispatch-retry-progress-card"
import { useDispatchRetryStore } from "../stores/dispatch-retry-store"

function makePayload(
  overrides: Partial<DispatchValidationRetryPayload> = {},
): DispatchValidationRetryPayload {
  return {
    sessionGroupId: "g1",
    threadId: "t1",
    invocationId: "inv1",
    agentId: "claude",
    messageId: "msg-progress-1",
    attemptIndex: 1,
    maxAttempts: 3,
    reason: "nested_call_tag",
    originalText: "[Call: @A ... [Call: @B] ...]",
    status: "retrying",
    occurredAt: "2026-04-28T01:00:00Z",
    ...overrides,
  }
}

describe("DispatchRetryProgressCard (F026 P3.1 · AC-14)", () => {
  beforeEach(() => {
    useDispatchRetryStore.setState({ active: {} })
  })

  it("renders nothing when no active retry exists for messageId", () => {
    const { container } = render(<DispatchRetryProgressCard messageId="absent" />)
    expect(container.firstChild).toBeNull()
  })

  it("renders attempt counters and Chinese 'rewriting' copy when active", () => {
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ messageId: "msg-A", attemptIndex: 2, maxAttempts: 3 }),
    )
    render(<DispatchRetryProgressCard messageId="msg-A" />)
    expect(screen.getByText(/正在重写/)).toBeTruthy()
    expect(screen.getByText(/第\s*2\s*次\s*\/\s*最多\s*3\s*次/)).toBeTruthy()
  })

  it("shows nested_call_tag reason label in Chinese", () => {
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ messageId: "msg-B", reason: "nested_call_tag" }),
    )
    render(<DispatchRetryProgressCard messageId="msg-B" />)
    expect(screen.getByText(/嵌套\s*\[Call:\]/)).toBeTruthy()
  })

  it("shows naked_at_with_real_teammate reason label in Chinese (R-057)", () => {
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ messageId: "msg-B2", reason: "naked_at_with_real_teammate" }),
    )
    render(<DispatchRetryProgressCard messageId="msg-B2" />)
    expect(screen.getByText(/行首裸\s*@\s*缺\s*\[Call:\]\s*包装/)).toBeTruthy()
  })

  it("uses role=status for assistive tech (live region)", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-D" }))
    render(<DispatchRetryProgressCard messageId="msg-D" />)
    const card = screen.getByRole("status")
    expect(card).toBeTruthy()
    expect(card.getAttribute("data-testid")).toBe("dispatch-retry-progress-card")
  })

  it("does not render after exhausted (banner takes over)", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-E" }))
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ messageId: "msg-E", status: "exhausted" }),
    )
    const { container } = render(<DispatchRetryProgressCard messageId="msg-E" />)
    expect(container.firstChild).toBeNull()
  })

  it("AC-21 · does not render after settled (retry 收尾后撤掉)", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-S" }))
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ messageId: "msg-S", status: "settled" }),
    )
    const { container } = render(<DispatchRetryProgressCard messageId="msg-S" />)
    expect(container.firstChild).toBeNull()
  })
})

describe("useDispatchRetryStreamingLock + DispatchRetryStreamingLock (F026 P3.1 · AC-22)", () => {
  beforeEach(() => {
    useDispatchRetryStore.setState({ active: {} })
  })

  it("AC-22 · 无 active retry 时 isLocked=false", () => {
    const { result } = renderHook(() => useDispatchRetryStreamingLock("absent"))
    expect(result.current.isLocked).toBe(false)
  })

  it("AC-22 · status=retrying 时 isLocked=true 且暴露 attemptIndex/maxAttempts", () => {
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ messageId: "msg-L", attemptIndex: 2, maxAttempts: 3 }),
    )
    const { result } = renderHook(() => useDispatchRetryStreamingLock("msg-L"))
    expect(result.current.isLocked).toBe(true)
    expect(result.current.attemptIndex).toBe(2)
    expect(result.current.maxAttempts).toBe(3)
  })

  it("AC-22 · status=settled 后 isLocked=false（store 自清，retry 收尾解锁）", () => {
    useDispatchRetryStore.getState().recordRetry(makePayload({ messageId: "msg-L2" }))
    useDispatchRetryStore.getState().recordRetry(
      makePayload({ messageId: "msg-L2", status: "settled" }),
    )
    const { result } = renderHook(() => useDispatchRetryStreamingLock("msg-L2"))
    expect(result.current.isLocked).toBe(false)
  })

  it("AC-22 · DispatchRetryStreamingLock 渲染占位文案 + 进度计数", () => {
    render(<DispatchRetryStreamingLock attemptIndex={2} maxAttempts={3} />)
    expect(screen.getByText(/正在按合规协议重写/)).toBeTruthy()
    expect(screen.getByText(/第\s*2\s*次\s*\/\s*最多\s*3\s*次/)).toBeTruthy()
    expect(screen.getByTestId("dispatch-retry-streaming-lock")).toBeTruthy()
  })
})
