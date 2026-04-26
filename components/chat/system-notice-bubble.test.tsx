import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { SystemNoticeBubble } from "./system-notice-bubble"

function makeNotice(content: string, provider: Provider = "claude"): TimelineMessage {
  return {
    id: "notice-1",
    provider,
    alias: "黄仁勋",
    role: "assistant",
    content,
    messageType: "system_notice",
    model: null,
    createdAt: "2026-04-25T08:00:00Z",
  }
}

describe("SystemNoticeBubble (AC-32)", () => {
  it("renders the notice content prominently", () => {
    render(
      <SystemNoticeBubble
        message={makeNotice("黄仁勋 上下文已用 45%，自动封存，下一轮开新 session。")}
      />,
    )
    expect(screen.getByText(/已用 45%/)).toBeTruthy()
    expect(screen.getByText(/自动封存/)).toBeTruthy()
  })

  it("renders with role=note for assistive tech (system message, not chat reply)", () => {
    render(<SystemNoticeBubble message={makeNotice("封存通知")} />)
    expect(screen.getByRole("note")).toBeTruthy()
  })

  it("claude provider uses violet accent (matches agent-card tone)", () => {
    const { container } = render(<SystemNoticeBubble message={makeNotice("x", "claude")} />)
    const card = container.querySelector('[data-testid="system-notice-card"]')
    expect(card).toBeTruthy()
    expect(card?.getAttribute("data-provider")).toBe("claude")
    expect(card?.className).toMatch(/violet/)
    expect(card?.className).not.toMatch(/amber|sky/)
  })

  it("codex provider uses amber accent", () => {
    const { container } = render(<SystemNoticeBubble message={makeNotice("x", "codex")} />)
    const card = container.querySelector('[data-testid="system-notice-card"]')
    expect(card?.getAttribute("data-provider")).toBe("codex")
    expect(card?.className).toMatch(/amber/)
    expect(card?.className).not.toMatch(/violet|sky/)
  })

  it("gemini provider uses sky accent", () => {
    const { container } = render(<SystemNoticeBubble message={makeNotice("x", "gemini")} />)
    const card = container.querySelector('[data-testid="system-notice-card"]')
    expect(card?.getAttribute("data-provider")).toBe("gemini")
    expect(card?.className).toMatch(/sky/)
    expect(card?.className).not.toMatch(/violet|amber/)
  })
})
