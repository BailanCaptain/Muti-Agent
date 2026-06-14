import { describe, expect, it } from "vitest"
import { RichBlockSchema } from "@multi-agent/shared"

describe("RichBlockSchema (F030 AC3)", () => {
  it("accepts a valid card with tone and fields", () => {
    const result = RichBlockSchema.safeParse({
      kind: "card",
      id: "c1",
      title: "Review 通过",
      tone: "success",
      bodyMarkdown: "0 P1 / 0 P2，放行合入。",
      fields: [{ label: "P1", value: "0" }],
    })
    expect(result.success).toBe(true)
  })

  it("accepts a minimal card (id + title only)", () => {
    expect(RichBlockSchema.safeParse({ kind: "card", id: "c1", title: "状态" }).success).toBe(true)
  })

  it("rejects a card with an invalid tone", () => {
    const result = RichBlockSchema.safeParse({ kind: "card", id: "c1", title: "x", tone: "purple" })
    expect(result.success).toBe(false)
  })

  it("rejects a card with more than 12 fields", () => {
    const fields = Array.from({ length: 13 }, (_, i) => ({ label: `k${i}`, value: `v${i}` }))
    expect(RichBlockSchema.safeParse({ kind: "card", id: "c1", title: "x", fields }).success).toBe(
      false,
    )
  })

  it("rejects a card without a title", () => {
    expect(RichBlockSchema.safeParse({ kind: "card", id: "c1" }).success).toBe(false)
  })

  it("accepts a valid checklist with checked states", () => {
    const result = RichBlockSchema.safeParse({
      kind: "checklist",
      id: "cl1",
      title: "AC 进度",
      items: [
        { id: "i1", text: "AC1 tone 着色", checked: true },
        { id: "i2", text: "AC6 dogfood" },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("rejects a checklist with empty items", () => {
    expect(
      RichBlockSchema.safeParse({ kind: "checklist", id: "cl1", items: [] }).success,
    ).toBe(false)
  })

  it("rejects a checklist with more than 50 items", () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ id: `i${i}`, text: `item ${i}` }))
    expect(RichBlockSchema.safeParse({ kind: "checklist", id: "cl1", items }).success).toBe(false)
  })

  it("rejects a checklist with duplicate item ids (r1 P3-4: item id is the React key)", () => {
    const result = RichBlockSchema.safeParse({
      kind: "checklist",
      id: "cl1",
      items: [
        { id: "i1", text: "第一条" },
        { id: "i1", text: "重复 id" },
      ],
    })
    expect(result.success).toBe(false)
  })

  it("rejects an unknown kind", () => {
    expect(RichBlockSchema.safeParse({ kind: "audio", id: "a1", text: "喵" }).success).toBe(false)
  })

  it("strips unknown extra keys instead of rejecting (forward compat)", () => {
    const result = RichBlockSchema.safeParse({
      kind: "card",
      id: "c1",
      title: "x",
      futureField: "ignored",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect("futureField" in result.data).toBe(false)
    }
  })

  it("rejects an oversized bodyMarkdown (>4000 chars)", () => {
    const body = "x".repeat(4001)
    expect(
      RichBlockSchema.safeParse({ kind: "card", id: "c1", title: "x", bodyMarkdown: body }).success,
    ).toBe(false)
  })
})
