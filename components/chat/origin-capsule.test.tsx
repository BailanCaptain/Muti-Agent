import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { OriginCapsule } from "./origin-capsule"

function makeMessage(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  const base: TimelineMessage = {
    id: "msg-1",
    provider: "gemini" as Provider,
    alias: "桂芬",
    role: "assistant",
    content: "",
    messageType: "connector",
    model: null,
    createdAt: "2026-04-29T10:00:00Z",
  }
  return { ...base, ...overrides }
}

describe("F026 P5 F2 · OriginCapsule (溯源胶囊)", () => {
  it("renders capsule when a2aOnBehalfOf is set", () => {
    render(
      <OriginCapsule
        message={makeMessage({
          a2aCallId: "call-1",
          a2aConvenerId: "codex:范德彪",
          a2aOnBehalfOf: "user:村长",
        })}
      />,
    )
    const capsule = screen.getByTestId("origin-capsule")
    expect(capsule).toBeTruthy()
    expect(capsule.textContent).toMatch(/范德彪/)
    expect(capsule.textContent).toMatch(/桂芬/)
    expect(capsule.textContent).toMatch(/村长/)
  })

  it("returns null when a2aOnBehalfOf is missing (普通消息 / 非 a2a 派发)", () => {
    const { container } = render(<OriginCapsule message={makeMessage()} />)
    expect(container.firstChild).toBeNull()
  })

  it("returns null when a2aOnBehalfOf is null (LEFT JOIN no-match)", () => {
    const { container } = render(
      <OriginCapsule
        message={makeMessage({
          a2aCallId: "call-1",
          a2aConvenerId: "codex:范德彪",
          a2aOnBehalfOf: null,
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("strips 'user:' prefix from on-behalf id (defaults to 村长 when empty)", () => {
    render(
      <OriginCapsule
        message={makeMessage({
          a2aCallId: "call-1",
          a2aConvenerId: "codex:范德彪",
          a2aOnBehalfOf: "user:",
        })}
      />,
    )
    expect(screen.getByTestId("origin-capsule").textContent).toMatch(/村长/)
  })

  it("strips '{provider}:' prefix to leave only alias (人类可读)", () => {
    render(
      <OriginCapsule
        message={makeMessage({
          a2aCallId: "call-1",
          a2aConvenerId: "claude:黄仁勋",
          a2aOnBehalfOf: "gemini:桂芬",
        })}
      />,
    )
    const text = screen.getByTestId("origin-capsule").textContent ?? ""
    expect(text).not.toMatch(/claude:/)
    expect(text).not.toMatch(/gemini:/)
    expect(text).toMatch(/黄仁勋/)
    expect(text).toMatch(/桂芬/)
  })
})
