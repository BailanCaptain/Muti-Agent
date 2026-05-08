import { describe, expect, it } from "vitest"
import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { getMystAreaClassName } from "./myst-area"

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

describe("F026 P5 F7 · getMystAreaClassName (A2A 密谋区淡紫底色)", () => {
  it("returns purple bg when a2aParentCallId is set (sub-call = 密谋区)", () => {
    const cls = getMystAreaClassName(makeMessage({ a2aParentCallId: "call-parent" }))
    expect(cls).toMatch(/bg-purple/)
  })

  it("returns empty string when a2aParentCallId is null (主流不上紫)", () => {
    const cls = getMystAreaClassName(makeMessage({ a2aParentCallId: null }))
    expect(cls).toBe("")
  })

  it("returns empty string when a2aParentCallId is undefined", () => {
    const cls = getMystAreaClassName(makeMessage())
    expect(cls).toBe("")
  })

  it("returns empty string when a2aParentCallId is empty string", () => {
    const cls = getMystAreaClassName(makeMessage({ a2aParentCallId: "" }))
    expect(cls).toBe("")
  })

  it("uses bg-purple-50/30 (D6 spec line 387 拍板淡紫 30% alpha)", () => {
    const cls = getMystAreaClassName(makeMessage({ a2aParentCallId: "call-parent" }))
    expect(cls).toMatch(/bg-purple-50\/30/)
  })
})
