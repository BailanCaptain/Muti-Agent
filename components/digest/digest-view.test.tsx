import { render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DigestDayResponse } from "./digest-model"
import { DigestView } from "./digest-view"

const { push } = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}))

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode
    href: string
    [key: string]: unknown
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

const originalFetch = globalThis.fetch

function archivedDay(businessDate: string): DigestDayResponse {
  return {
    businessDate,
    labels: {
      "official-ai": "官方 AI",
      "news-hot": "热点新闻",
    },
    items: [
      {
        id: "ai-1",
        category: "ai",
        sourceId: "official-ai",
        title: "周末 AI 进展",
        canonicalUrl: "https://example.com/ai",
        publishedAt: "2026-07-25T04:00:00.000Z",
        rawSnippet: "AI 摘要",
      },
      {
        id: "hot-1",
        category: "hot",
        sourceId: "news-hot",
        title: "周末行业热点",
        canonicalUrl: "https://example.com/hot",
        publishedAt: "2026-07-26T04:00:00.000Z",
        rawSnippet: "热点摘要",
      },
    ],
    summary: {
      businessDate,
      degraded: false,
      counts: { content: 2, github: 0, podcast: 0, scanned: 2 },
      podcastItemIds: [],
      githubItemIds: [],
      sourceHealth: [],
      summary: {
        degraded: false,
        overview: ["周末两天值得关注的变化"],
        sections: [
          { category: "ai", picks: [{ itemId: "ai-1", summaryZh: "AI 摘要" }] },
          { category: "hot", picks: [{ itemId: "hot-1", summaryZh: "热点摘要" }] },
        ],
      },
    },
  }
}

function mockArchive(day: DigestDayResponse) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith("/api/daily-digest/dates")) {
      return new Response(JSON.stringify({ dates: [day.businessDate] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.endsWith(`/api/daily-digest/${day.businessDate}`)) {
      return new Response(JSON.stringify(day), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  push.mockReset()
})

describe("DigestView 周一周末速览", () => {
  it("周一使用周末语义和周六—周日覆盖标签，并固定显示五栏诚实空态", async () => {
    const day = archivedDay("2026-07-27")
    mockArchive(day)

    render(<DigestView date={day.businessDate} />)

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("周末速览")
    expect(screen.getByText("MULTI-AGENT · WEEKEND ROUNDUP")).toBeInTheDocument()
    expect(
      screen.getByText("周末速览 · WEEKEND AT A GLANCE · 07.25—07.26（周六—周日）"),
    ).toBeInTheDocument()
    expect(screen.getByText("TRENDING THIS WEEKEND")).toBeInTheDocument()

    const sectionHeadings = screen.getAllByRole("heading", { level: 2 })
    expect(sectionHeadings.map((heading) => heading.textContent)).toEqual([
      "AI · 人工智能",
      "社区动态",
      "周末热点",
      "播客速递",
      "开源榜单",
    ])

    for (const label of ["社区动态", "播客速递", "开源榜单"]) {
      const section = screen.getByRole("heading", { level: 2, name: label }).closest("section")
      expect(section).not.toBeNull()
      expect(within(section as HTMLElement).getByText("本期暂无合资格内容。")).toBeInTheDocument()
      expect(within(section as HTMLElement).queryAllByRole("link")).toHaveLength(0)
    }
  })

  it("周二至周五保留每日标题，且空播客与开源榜单仍隐藏", async () => {
    const day = archivedDay("2026-07-28")
    mockArchive(day)

    render(<DigestView date={day.businessDate} />)

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("每日简报")
    await waitFor(() => {
      expect(screen.getByText("今日速览 · AT A GLANCE")).toBeInTheDocument()
    })
    expect(screen.getByText("TRENDING TODAY")).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "今日热点" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 2, name: "播客速递" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 2, name: "开源榜单" })).not.toBeInTheDocument()
  })
})
