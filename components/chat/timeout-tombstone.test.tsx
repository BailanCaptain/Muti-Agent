import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { TimeoutTombstone } from "./timeout-tombstone"

function makeMessage(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  const base: TimelineMessage = {
    id: "msg-1",
    provider: "codex" as Provider,
    alias: "范德彪",
    role: "assistant",
    content: "",
    messageType: "connector",
    model: null,
    createdAt: "2026-04-29T10:00:00Z",
  }
  return { ...base, ...overrides }
}

describe("F026 P5 F3 · TimeoutTombstone (超时墓碑)", () => {
  it("renders tombstone when a2aCallStatus is timeout", () => {
    render(
      <TimeoutTombstone
        message={makeMessage({
          a2aCallId: "call-1",
          a2aCallStatus: "timeout",
          a2aConvenerId: "claude:黄仁勋",
        })}
      />,
    )
    const tombstone = screen.getByTestId("timeout-tombstone")
    expect(tombstone).toBeTruthy()
    expect(tombstone.textContent).toMatch(/范德彪/)
    expect(tombstone.textContent).toMatch(/响应超时/)
    expect(tombstone.textContent).toMatch(/黄仁勋/)
    expect(tombstone.textContent).toMatch(/请继续/)
  })

  it("returns null when a2aCallStatus is not timeout (done)", () => {
    const { container } = render(
      <TimeoutTombstone
        message={makeMessage({
          a2aCallId: "call-1",
          a2aCallStatus: "done",
          a2aConvenerId: "claude:黄仁勋",
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("returns null when a2aCallStatus is pending (派发中,不渲染墓碑)", () => {
    const { container } = render(
      <TimeoutTombstone
        message={makeMessage({
          a2aCallId: "call-1",
          a2aCallStatus: "pending",
          a2aConvenerId: "claude:黄仁勋",
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("returns null when a2aCallStatus is working (处理中,不渲染墓碑)", () => {
    const { container } = render(
      <TimeoutTombstone
        message={makeMessage({
          a2aCallId: "call-1",
          a2aCallStatus: "working",
          a2aConvenerId: "claude:黄仁勋",
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("returns null when message is not a2a-related (no callId)", () => {
    const { container } = render(<TimeoutTombstone message={makeMessage()} />)
    expect(container.firstChild).toBeNull()
  })

  it("strips '{provider}:' prefix from issuer (人类可读)", () => {
    render(
      <TimeoutTombstone
        message={makeMessage({
          a2aCallId: "call-1",
          a2aCallStatus: "timeout",
          a2aConvenerId: "gemini:桂芬",
        })}
      />,
    )
    const text = screen.getByTestId("timeout-tombstone").textContent ?? ""
    expect(text).not.toMatch(/gemini:/)
    expect(text).toMatch(/桂芬/)
  })

  it("falls back to '村长' when issuer is bare 'user:' prefix", () => {
    render(
      <TimeoutTombstone
        message={makeMessage({
          a2aCallId: "call-1",
          a2aCallStatus: "timeout",
          a2aConvenerId: "user:",
        })}
      />,
    )
    expect(screen.getByTestId("timeout-tombstone").textContent).toMatch(/村长/)
  })
})
