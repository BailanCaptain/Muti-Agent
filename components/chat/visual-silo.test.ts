import { describe, expect, it } from "vitest"
import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { getVisualSiloClassName } from "./visual-silo"

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

describe("F026 P5 F5 · getVisualSiloClassName (并列卡片 Visual Silo)", () => {
  it("returns silo styles when displayMode is nested (sibling 独立卡片)", () => {
    const cls = getVisualSiloClassName(makeMessage({ a2aDisplayMode: "nested" }))
    expect(cls).toMatch(/border-2/)
    expect(cls.length).toBeGreaterThan(0)
  })

  it("returns empty string when displayMode is inline (主流默认)", () => {
    const cls = getVisualSiloClassName(makeMessage({ a2aDisplayMode: "inline" }))
    expect(cls).toBe("")
  })

  it("returns empty string when displayMode is background (F8 处理)", () => {
    const cls = getVisualSiloClassName(makeMessage({ a2aDisplayMode: "background" }))
    expect(cls).toBe("")
  })

  it("returns empty string when displayMode is undefined (legacy/non-a2a)", () => {
    const cls = getVisualSiloClassName(makeMessage())
    expect(cls).toBe("")
  })
})
