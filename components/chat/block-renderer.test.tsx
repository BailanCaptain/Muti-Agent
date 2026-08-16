import { normalizeMessageToBlocks } from "@/lib/blocks"
import type { TimelineMessage } from "@multi-agent/shared"
import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BlockRenderer } from "./block-renderer"

afterEach(() => {
  vi.unstubAllEnvs()
})

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

describe("BlockRenderer B047 runtime API resources", () => {
  it("loads internal upload images through the page hostname", () => {
    vi.stubEnv("NEXT_PUBLIC_API_HTTP_URL", "http://192.0.2.1:8787")

    render(
      <BlockRenderer
        provider="claude"
        blocks={[
          {
            kind: "image",
            url: "http://192.0.2.1:8787/uploads/screenshot.png",
            alt: "Screenshot",
          },
        ]}
      />,
    )

    expect(screen.getByRole("img", { name: "Screenshot" })).toHaveAttribute(
      "src",
      "http://localhost:8787/uploads/screenshot.png",
    )
  })

  it("downloads internal upload files through the page hostname", () => {
    vi.stubEnv("NEXT_PUBLIC_API_HTTP_URL", "http://192.0.2.1:8787")

    render(
      <BlockRenderer
        provider="claude"
        blocks={[
          {
            kind: "file",
            url: "http://192.0.2.1:8787/uploads/report.txt",
            name: "report.txt",
          },
        ]}
      />,
    )

    expect(screen.getByTestId("file-block")).toHaveAttribute(
      "href",
      "http://localhost:8787/uploads/report.txt",
    )
  })

  it("does not rewrite external image URLs", () => {
    vi.stubEnv("NEXT_PUBLIC_API_HTTP_URL", "http://192.0.2.1:8787")

    render(
      <BlockRenderer
        provider="claude"
        blocks={[
          {
            kind: "image",
            url: "https://cdn.example.com/uploads/reference.png",
            alt: "Reference",
          },
        ]}
      />,
    )

    expect(screen.getByRole("img", { name: "Reference" })).toHaveAttribute(
      "src",
      "https://cdn.example.com/uploads/reference.png",
    )
  })
})

// F036 #10 卡型扩展端到端：closed cc_rich → schema → parseRichSegments → 卡片渲染
describe("BlockRenderer × F036 #10 table/progress", () => {
  it("renders a table card from a closed cc_rich table fence", () => {
    const json = JSON.stringify({
      kind: "table",
      id: "t1",
      title: "对比",
      columns: ["A", "B"],
      rows: [["1", "2"]],
    })
    const blocks = normalizeMessageToBlocks(msg({ content: `\`\`\`cc_rich\n${json}\n\`\`\`` }))
    const { container } = render(<BlockRenderer blocks={blocks} provider="claude" />)
    expect(container.querySelector('[data-block="table"]')).toBeTruthy()
    expect(screen.getByText("对比")).toBeInTheDocument()
    expect(container.querySelector("pre")).toBeNull()
  })

  it("renders a progress card from a closed cc_rich progress fence", () => {
    const json = JSON.stringify({
      kind: "progress",
      id: "p1",
      title: "进度",
      items: [{ label: "X", value: 70 }],
    })
    const blocks = normalizeMessageToBlocks(msg({ content: `\`\`\`cc_rich\n${json}\n\`\`\`` }))
    const { container } = render(<BlockRenderer blocks={blocks} provider="claude" />)
    expect(container.querySelector('[data-block="progress"]')).toBeTruthy()
    expect(screen.getByText("进度")).toBeInTheDocument()
    expect(screen.getByText("70%")).toBeInTheDocument()
  })

  it("does NOT render a table card for a ragged table (row width != columns) — fail-closed", () => {
    // 缺位行（2 列 1 格）→ union superRefine 拒 → 不出 table 卡（范德彪-r P2：避免静默丢数据）
    const under = JSON.stringify({ kind: "table", id: "t1", columns: ["A", "B"], rows: [["x"]] })
    const blocksU = normalizeMessageToBlocks(msg({ content: `\`\`\`cc_rich\n${under}\n\`\`\`` }))
    expect(
      render(<BlockRenderer blocks={blocksU} provider="claude" />).container.querySelector(
        '[data-block="table"]',
      ),
    ).toBeNull()
    // 超宽行（2 列 3 格）→ 同样拒 → 不出 table 卡
    const over = JSON.stringify({
      kind: "table",
      id: "t2",
      columns: ["A", "B"],
      rows: [["x", "y", "z"]],
    })
    const blocksO = normalizeMessageToBlocks(msg({ content: `\`\`\`cc_rich\n${over}\n\`\`\`` }))
    expect(
      render(<BlockRenderer blocks={blocksO} provider="claude" />).container.querySelector(
        '[data-block="table"]',
      ),
    ).toBeNull()
  })
})
