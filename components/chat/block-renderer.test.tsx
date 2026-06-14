import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { TimelineMessage } from "@multi-agent/shared"
import { normalizeMessageToBlocks } from "@/lib/blocks"
import { BlockRenderer } from "./block-renderer"

function msg(over: Partial<TimelineMessage>): TimelineMessage {
  return {
    id: "m1",
    provider: "claude",
    alias: "黄仁勋",
    role: "assistant",
    content: "",
    messageType: "final",
    model: null,
    ...over,
  } as TimelineMessage
}

const UNCLOSED = '汇报中\n```cc_rich\n{"kind":"card","id":"c1","title":"x"'

// F030 AC6 端到端（DOM 级，确定性 — 取代脆弱的真实流式抓帧）：
// 证明"含未闭合 cc_rich 的消息渲染时绝不出现黑框代码块"。渲染不看 messageType，
// 所以 final 消息 + 未闭合 content 的渲染结果，与流式中间态完全等价——这是确定性证据。
describe("BlockRenderer × unclosed cc_rich (F030 AC6 黑框)", () => {
  it.each(["progress", "final"] as const)(
    "renders NO <pre> black frame for unclosed cc_rich (messageType=%s; 等价流式中间态)",
    (messageType) => {
      const blocks = normalizeMessageToBlocks(msg({ messageType, content: UNCLOSED }))
      const { container } = render(<BlockRenderer blocks={blocks} provider="claude" />)
      // <pre> = 黑色代码块（markdown-message CodeBlock，bg-slate-900）——绝不出现
      expect(container.querySelector("pre")).toBeNull()
      // 围栏前的自然语言正常显示（只隐藏未闭合围栏那段）
      expect(screen.getByText(/汇报中/)).toBeInTheDocument()
    },
  )

  it("renders a real card (no code block) for a closed cc_rich fence", () => {
    const closed = '```cc_rich\n{"kind":"card","id":"c1","title":"完成","tone":"success"}\n```'
    const blocks = normalizeMessageToBlocks(msg({ messageType: "final", content: closed }))
    const { container } = render(<BlockRenderer blocks={blocks} provider="claude" />)
    expect(screen.getByText("完成")).toBeInTheDocument()
    expect(container.querySelector("pre")).toBeNull()
    expect(screen.queryByText(/生成中/)).not.toBeInTheDocument()
  })
})
