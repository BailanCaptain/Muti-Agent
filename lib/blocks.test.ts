import { describe, expect, it } from "vitest"
import type { TimelineMessage } from "@multi-agent/shared"
import { normalizeMessageToBlocks } from "./blocks"

const FENCE = '```cc_rich\n{"kind": "card", "id": "c1", "title": "Review 通过", "tone": "success"}\n```'

function msg(over: Partial<TimelineMessage> = {}): TimelineMessage {
  return {
    id: "m1",
    provider: "claude",
    alias: "黄仁勋",
    role: "assistant",
    content: "hello",
    messageType: "final",
    model: null,
    ...over,
  }
}

describe("normalizeMessageToBlocks × cc_rich (F030 AC3/AC4)", () => {
  it("parses cc_rich fences in assistant messages into card blocks", () => {
    const blocks = normalizeMessageToBlocks(msg({ content: `结论：通过。\n\n${FENCE}` }))
    expect(blocks.map((b) => b.kind)).toEqual(["markdown", "card"])
    expect(blocks[1]).toMatchObject({ id: "c1", title: "Review 通过" })
  })

  it("does NOT parse cc_rich fences in user messages (channel is agent → 小孙)", () => {
    const blocks = normalizeMessageToBlocks(msg({ role: "user", content: FENCE }))
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("markdown")
  })

  it("keeps plain assistant messages as a single markdown block (regression)", () => {
    const blocks = normalizeMessageToBlocks(msg({ content: "纯文本，无围栏" }))
    expect(blocks).toEqual([{ kind: "markdown", content: "纯文本，无围栏" }])
  })

  it("keeps thinking first and image contentBlocks after content (order regression)", () => {
    const blocks = normalizeMessageToBlocks(
      msg({
        content: FENCE,
        thinking: "思考中",
        contentBlocks: [{ type: "image", url: "http://x/i.png" }],
      }),
    )
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "card", "image"])
  })

  // 未闭合 cc_rich 一律隐藏（不依赖 messageType——真实流式时它就是 final，只看围栏闭合与否）
  it.each(["progress", "final"] as const)(
    "hides an unclosed cc_rich fence entirely regardless of messageType=%s (no black frame)",
    (messageType) => {
      const blocks = normalizeMessageToBlocks(
        msg({ messageType, content: '稍等\n```cc_rich\n{"kind":"card"' }),
      )
      expect(blocks.some((b) => b.kind === "card")).toBe(false)
      const md = blocks
        .filter((b) => b.kind === "markdown")
        .map((b) => (b as { content: string }).content)
        .join("")
      expect(md).not.toContain("cc_rich") // 围栏源码不显示（无黑框）
      expect(md).toContain("稍等") // 前导自然语言保留
    },
  )

  it("two messages with the same block id stay independent (no cross-message stick)", () => {
    const a = normalizeMessageToBlocks(msg({ id: "m1", content: FENCE }))
    const b = normalizeMessageToBlocks(msg({ id: "m2", content: FENCE.replace("Review 通过", "另一条") }))
    expect(a.filter((x) => x.kind === "card")).toHaveLength(1)
    expect(b.filter((x) => x.kind === "card")).toHaveLength(1)
    expect(b.find((x) => x.kind === "card")).toMatchObject({ title: "另一条" })
  })
})

describe("normalizeMessageToBlocks × file contentBlocks (F040 P3 AC16)", () => {
  it("file contentBlock → FileBlock（name/size/mime 透传）", () => {
    const blocks = normalizeMessageToBlocks(
      msg({
        content: "带附件",
        contentBlocks: [
          { type: "file", url: "/uploads/ab.pdf", name: "周报.pdf", size: 20480, mime: "application/pdf" },
        ],
      }),
    )
    expect(blocks.map((b) => b.kind)).toEqual(["markdown", "file"])
    expect(blocks[1]).toEqual({
      kind: "file",
      url: "/uploads/ab.pdf",
      name: "周报.pdf",
      size: 20480,
      mime: "application/pdf",
    })
  })

  it("image + file 混合按声明序输出", () => {
    const blocks = normalizeMessageToBlocks(
      msg({
        content: "",
        contentBlocks: [
          { type: "image", url: "/uploads/a.png" },
          { type: "file", url: "/uploads/b.zip", name: "包.zip" },
        ],
      }),
    )
    expect(blocks.map((b) => b.kind)).toEqual(["image", "file"])
  })
})
