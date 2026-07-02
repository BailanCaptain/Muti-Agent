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

// F036 #10 卡型扩展
describe("RichBlockSchema · table (F036 #10)", () => {
  const valid = {
    kind: "table",
    id: "t1",
    title: "档位对比",
    columns: ["维度", "low", "high"],
    rows: [
      ["速度", "快", "慢"],
      ["质量", "中", "高"],
    ],
  }

  it("accepts a valid table", () => {
    expect(RichBlockSchema.safeParse(valid).success).toBe(true)
  })

  it("accepts a minimal table (1 col, 1 row, no title)", () => {
    expect(
      RichBlockSchema.safeParse({ kind: "table", id: "t1", columns: ["x"], rows: [["1"]] }).success,
    ).toBe(true)
  })

  it("rejects a table whose row width != columns (fail-closed via union superRefine)", () => {
    // 缺位行（valid 是 3 列，给 2 格）→ 拒
    expect(RichBlockSchema.safeParse({ ...valid, rows: [["速度", "快"]] }).success).toBe(false)
    // 超宽行（多余格渲染会被静默丢弃 → 拒收，范德彪-r P2）
    expect(
      RichBlockSchema.safeParse({ ...valid, rows: [["速度", "快", "慢", "额外"]] }).success,
    ).toBe(false)
  })

  it("rejects a table with no columns / no rows", () => {
    expect(RichBlockSchema.safeParse({ kind: "table", id: "t1", columns: [], rows: [] }).success).toBe(
      false,
    )
  })

  it("rejects a table with more than 8 columns", () => {
    const columns = Array.from({ length: 9 }, (_, i) => `c${i}`)
    const rows = [columns.map((_, i) => `${i}`)]
    expect(RichBlockSchema.safeParse({ kind: "table", id: "t1", columns, rows }).success).toBe(false)
  })

  it("rejects a table with more than 50 rows", () => {
    const rows = Array.from({ length: 51 }, () => ["a"])
    expect(
      RichBlockSchema.safeParse({ kind: "table", id: "t1", columns: ["x"], rows }).success,
    ).toBe(false)
  })
})

describe("RichBlockSchema · progress (F036 #10)", () => {
  const valid = {
    kind: "progress",
    id: "p1",
    title: "投票结果",
    items: [
      { label: "方案 A", value: 60, tone: "success", caption: "12 票" },
      { label: "方案 B", value: 40 },
    ],
  }

  it("accepts a valid progress block with tone + caption", () => {
    expect(RichBlockSchema.safeParse(valid).success).toBe(true)
  })

  it("rejects a progress item with value > 100", () => {
    expect(
      RichBlockSchema.safeParse({
        kind: "progress",
        id: "p1",
        items: [{ label: "x", value: 120 }],
      }).success,
    ).toBe(false)
  })

  it("rejects a progress item with an invalid tone", () => {
    expect(
      RichBlockSchema.safeParse({
        kind: "progress",
        id: "p1",
        items: [{ label: "x", value: 10, tone: "purple" }],
      }).success,
    ).toBe(false)
  })

  it("rejects a progress block with empty items", () => {
    expect(RichBlockSchema.safeParse({ kind: "progress", id: "p1", items: [] }).success).toBe(false)
  })

  it("rejects a progress block with more than 20 items", () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ label: `i${i}`, value: 1 }))
    expect(RichBlockSchema.safeParse({ kind: "progress", id: "p1", items }).success).toBe(false)
  })
})
