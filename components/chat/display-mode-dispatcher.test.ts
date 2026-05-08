import { describe, expect, it } from "vitest"
import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { shouldRenderBubble } from "./display-mode-dispatcher"

function makeMessage(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  const base: TimelineMessage = {
    id: "msg-1",
    provider: "codex" as Provider,
    alias: "范德彪",
    role: "assistant",
    content: "",
    messageType: "final",
    model: null,
    createdAt: "2026-04-29T10:00:00Z",
  }
  return { ...base, ...overrides }
}

describe("F026 P5 F8 · shouldRenderBubble (display_mode 三态 dispatcher)", () => {
  it("returns true when displayMode is inline (主流默认)", () => {
    expect(shouldRenderBubble(makeMessage({ a2aDisplayMode: "inline" }))).toBe(true)
  })

  it("returns true when displayMode is nested (独立卡片)", () => {
    expect(shouldRenderBubble(makeMessage({ a2aDisplayMode: "nested" }))).toBe(true)
  })

  it("returns false when displayMode is background (不渲染气泡)", () => {
    expect(shouldRenderBubble(makeMessage({ a2aDisplayMode: "background" }))).toBe(false)
  })

  it("returns true when displayMode is undefined (legacy / 非 a2a 默认渲染)", () => {
    expect(shouldRenderBubble(makeMessage())).toBe(true)
  })
})
