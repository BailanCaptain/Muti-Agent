import { describe, expect, it } from "vitest"
import { parseRichSegments } from "./rich-content"

const card = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: "card", id: "c1", title: "Review 通过", tone: "success", ...over })

const fence = (json: string) => "```cc_rich\n" + json + "\n```"

describe("parseRichSegments (F030 AC3/AC4)", () => {
  it("returns a single markdown segment for plain text", () => {
    const segments = parseRichSegments("hello **world**")
    expect(segments).toEqual([{ kind: "markdown", content: "hello **world**" }])
  })

  it("splits text + card fence into ordered segments", () => {
    const content = `先说结论：通过。\n\n${fence(card())}\n\n后续步骤见下。`
    const segments = parseRichSegments(content)
    expect(segments.map((s) => s.kind)).toEqual(["markdown", "card", "markdown"])
    expect(segments[0]).toMatchObject({ content: expect.stringContaining("先说结论") })
    expect(segments[1]).toMatchObject({ id: "c1", title: "Review 通过", tone: "success" })
    expect(segments[2]).toMatchObject({ content: expect.stringContaining("后续步骤") })
  })

  it("parses a valid checklist fence", () => {
    const json = JSON.stringify({
      kind: "checklist",
      id: "cl1",
      title: "AC 进度",
      items: [
        { id: "i1", text: "AC1", checked: true },
        { id: "i2", text: "AC2" },
      ],
    })
    const segments = parseRichSegments(fence(json))
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: "checklist", id: "cl1", title: "AC 进度" })
  })

  it("does NOT parse a cc_rich fence nested inside another backtick fence", () => {
    const content = "````markdown\n" + fence(card()) + "\n````"
    const segments = parseRichSegments(content)
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe("markdown")
  })

  it("does NOT parse a cc_rich fence nested inside a tilde fence", () => {
    const content = "~~~\n" + fence(card()) + "\n~~~"
    const segments = parseRichSegments(content)
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe("markdown")
  })

  it("keeps invalid JSON fences as markdown (fail-closed)", () => {
    const content = "```cc_rich\n{not json at all\n```"
    const segments = parseRichSegments(content)
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe("markdown")
    expect((segments[0] as { content: string }).content).toContain("{not json at all")
  })

  it("keeps schema-invalid blocks as markdown (unknown kind, bad tone)", () => {
    const badKind = fence(JSON.stringify({ kind: "audio", id: "a1", text: "喵" }))
    const badTone = fence(card({ tone: "purple" }))
    const segments = parseRichSegments(`${badKind}\n${badTone}`)
    expect(segments.every((s) => s.kind === "markdown")).toBe(true)
    const merged = segments.map((s) => (s as { content: string }).content).join("\n")
    expect(merged).toContain('"audio"')
    expect(merged).toContain('"purple"')
  })

  it("dedupes blocks with the same id within one message (keeps first)", () => {
    const first = fence(card({ title: "第一个" }))
    const second = fence(card({ title: "第二个" }))
    const segments = parseRichSegments(`${first}\n${second}`)
    const cards = segments.filter((s) => s.kind === "card")
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ title: "第一个" })
  })

  it("degrades blocks beyond the per-message cap of 8 back to markdown", () => {
    const fences = Array.from({ length: 9 }, (_, i) => fence(card({ id: `c${i}` }))).join("\n")
    const segments = parseRichSegments(fences)
    const cards = segments.filter((s) => s.kind === "card")
    expect(cards).toHaveLength(8)
    const tail = segments.filter((s) => s.kind === "markdown")
    expect(tail.map((s) => (s as { content: string }).content).join("")).toContain('"c8"')
  })

  it("hides an unclosed cc_rich fence entirely (no black frame, prelude kept)", () => {
    const content = "进行中…\n```cc_rich\n" + card()
    const segments = parseRichSegments(content)
    // 未闭合 cc_rich → 不渲染：无卡片、围栏原文不进 markdown（无黑框）、前导自然语言保留
    expect(segments.some((s) => s.kind === "card")).toBe(false)
    const md = segments
      .filter((s) => s.kind === "markdown")
      .map((s) => (s as { content: string }).content)
      .join("")
    expect(md).not.toContain("cc_rich")
    expect(md).toContain("进行中")
  })

  it("keeps an unclosed PLAIN code fence as markdown (only cc_rich is hidden)", () => {
    const content = "```js\nconst x = 1"
    const segments = parseRichSegments(content)
    expect(segments.some((s) => s.kind === "card")).toBe(false)
    expect(segments[0].kind).toBe("markdown")
    expect((segments[0] as { content: string }).content).toContain("const x = 1")
  })

  it("emits closed cards but hides a trailing unclosed cc_rich fence", () => {
    const content = fence(card()) + "\n```cc_rich\n{half"
    const segments = parseRichSegments(content)
    expect(segments.some((s) => s.kind === "card")).toBe(true)
    const md = segments
      .filter((s) => s.kind === "markdown")
      .map((s) => (s as { content: string }).content)
      .join("")
    expect(md).not.toContain("half")
  })

  it("merges adjacent markdown runs into one segment", () => {
    const content = "a\n\n```cc_rich\n{bad\n```\n\nb"
    const segments = parseRichSegments(content)
    expect(segments).toHaveLength(1)
    expect(segments[0].kind).toBe("markdown")
  })

  it("preserves fence-free content verbatim — incl. leading 4-space indented code (r1 P2-1)", () => {
    const content = "    const x = 1\n    return x\n\nplain tail"
    expect(parseRichSegments(content)).toEqual([{ kind: "markdown", content }])
  })

  it("preserves indented code around a fence without trim rewrites (r1 P2-1)", () => {
    const content = "    lead code\n" + fence(card()) + "\n    tail code"
    const segments = parseRichSegments(content)
    expect(segments.map((s) => s.kind)).toEqual(["markdown", "card", "markdown"])
    expect((segments[0] as { content: string }).content).toContain("    lead code")
    expect((segments[2] as { content: string }).content).toContain("    tail code")
  })

  it("parses a top-level ~~~cc_rich tilde fence (r1 P2-2)", () => {
    const content = "~~~cc_rich\n" + card() + "\n~~~"
    const segments = parseRichSegments(content)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: "card", id: "c1" })
  })
})
