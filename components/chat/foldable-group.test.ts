import { describe, expect, it } from "vitest"
import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { getFoldableGroupClassName } from "./foldable-group"

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

describe("F026 P5 F4 · getFoldableGroupClassName (折叠群组样式)", () => {
  it("returns fold styles when a2aParentCallId is set (sub-call)", () => {
    const cls = getFoldableGroupClassName(
      makeMessage({ a2aParentCallId: "call-parent" }),
    )
    expect(cls).toMatch(/opacity-60/)
    expect(cls).toMatch(/ml-8/)
    expect(cls).toMatch(/hover:opacity-100/)
  })

  it("returns base only when a2aParentCallId is null (root call or non-a2a)", () => {
    const cls = getFoldableGroupClassName(makeMessage({ a2aParentCallId: null }))
    expect(cls).not.toMatch(/opacity-60/)
    expect(cls).not.toMatch(/ml-8/)
  })

  it("returns base only when a2aParentCallId is undefined (legacy)", () => {
    const cls = getFoldableGroupClassName(makeMessage())
    expect(cls).not.toMatch(/opacity-60/)
    expect(cls).not.toMatch(/ml-8/)
  })

  it("returns base only when a2aParentCallId is empty string", () => {
    const cls = getFoldableGroupClassName(makeMessage({ a2aParentCallId: "" }))
    expect(cls).not.toMatch(/opacity-60/)
    expect(cls).not.toMatch(/ml-8/)
  })

  it("always includes 'mb-4' for vertical spacing (regression guard)", () => {
    const a = getFoldableGroupClassName(makeMessage())
    const b = getFoldableGroupClassName(makeMessage({ a2aParentCallId: "x" }))
    expect(a).toMatch(/mb-4/)
    expect(b).toMatch(/mb-4/)
  })

  it("includes transition-opacity for smooth hover (UX)", () => {
    const cls = getFoldableGroupClassName(
      makeMessage({ a2aParentCallId: "call-parent" }),
    )
    expect(cls).toMatch(/transition/)
  })
})
