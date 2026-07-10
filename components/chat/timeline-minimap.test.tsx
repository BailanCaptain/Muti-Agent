import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import {
  TimelineMinimap,
  buildMinimapMarkers,
  type MinimapItem,
  type MinimapMarker,
} from "./timeline-minimap"

const markers: MinimapMarker[] = [
  { index: 0, kind: "user", label: "你 · 前端能优化啥", topPct: 0 },
  { index: 4, kind: "seal", label: "封存 · 黄仁勋", topPct: 0.8 },
]

describe("TimelineMinimap (render)", () => {
  it("renders one button per marker with kind + index data attrs", () => {
    render(<TimelineMinimap markers={markers} onJump={() => {}} />)
    const buttons = screen.getAllByRole("button")
    expect(buttons).toHaveLength(2)
    expect(buttons[0].getAttribute("data-kind")).toBe("user")
    expect(buttons[1].getAttribute("data-kind")).toBe("seal")
    expect(buttons[1].getAttribute("data-index")).toBe("4")
  })

  it("positions each marker by topPct and clamps into [0,100]%", () => {
    render(
      <TimelineMinimap
        markers={[
          { index: 0, kind: "user", label: "a", topPct: 0 },
          { index: 1, kind: "seal", label: "b", topPct: 0.8 },
          { index: 2, kind: "user", label: "c", topPct: 1.5 },
        ]}
        onJump={() => {}}
      />,
    )
    const b = screen.getAllByRole("button")
    expect(b[0].style.top).toBe("0%")
    expect(b[1].style.top).toBe("80%")
    expect(b[2].style.top).toBe("100%") // clamped
  })

  it("calls onJump with the marker index on click", () => {
    const onJump = vi.fn()
    render(<TimelineMinimap markers={markers} onJump={onJump} />)
    fireEvent.click(screen.getAllByRole("button")[1])
    expect(onJump).toHaveBeenCalledWith(4)
  })

  it("exposes the label as accessible name + tooltip text", () => {
    render(<TimelineMinimap markers={markers} onJump={() => {}} />)
    expect(screen.getByRole("button", { name: "封存 · 黄仁勋" })).toBeTruthy()
    expect(screen.getByText("你 · 前端能优化啥")).toBeTruthy()
  })

  it("renders nothing when there are no markers", () => {
    const { container } = render(<TimelineMinimap markers={[]} onJump={() => {}} />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId("timeline-minimap")).toBeNull()
  })
})

describe("buildMinimapMarkers (F036 #9 锚点构建)", () => {
  const id = (s: string) => s // 测试里不截断

  it("marks user questions and seals, with ordinal topPct", () => {
    const items: MinimapItem[] = [
      { kind: "message", role: "user", messageType: "final", alias: "你", content: "Q1" },
      { kind: "message", role: "assistant", messageType: "final", alias: "黄仁勋", content: "A1" },
      { kind: "message", role: "user", messageType: "final", alias: "你", content: "Q2" },
      {
        kind: "message",
        role: "assistant",
        messageType: "system_notice",
        alias: "黄仁勋",
        content: "封存",
      },
      { kind: "message", role: "user", messageType: "final", alias: "你", content: "Q3" },
    ]
    const out = buildMinimapMarkers(items, id)
    // 3 user + 1 seal = 4（assistant 不打标）
    expect(out.map((m) => m.kind)).toEqual(["user", "user", "seal", "user"])
    expect(out.map((m) => m.index)).toEqual([0, 2, 3, 4])
    expect(out[0].topPct).toBe(0) // index 0 / (5-1)
    expect(out[1].topPct).toBe(0.5) // index 2 / 4
    expect(out[2].label).toBe("封存 · 黄仁勋")
    expect(out[0].label).toBe("你 · Q1")
  })

  it("does NOT mark decisions (pending-only data model — would vanish after response)", () => {
    const items: MinimapItem[] = [
      { kind: "message", role: "user", messageType: "final", alias: "你", content: "Q" },
      { kind: "decision" },
    ]
    const out = buildMinimapMarkers(items, id)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("user")
  })

  it("applies the summarize fn to user content", () => {
    const out = buildMinimapMarkers(
      [{ kind: "message", role: "user", messageType: "final", alias: "你", content: "12345" }],
      (s) => s.slice(0, 3),
    )
    expect(out[0].label).toBe("你 · 123")
  })

  it("returns empty for an empty timeline (no divide-by-zero)", () => {
    expect(buildMinimapMarkers([], id)).toEqual([])
  })

  it("F044 caps long timelines, keeps every seal, and summarizes only retained users", () => {
    const items: MinimapItem[] = Array.from({ length: 400 }, (_, index) =>
      index % 50 === 0
        ? {
            kind: "message" as const,
            role: "assistant" as const,
            messageType: "system_notice",
            alias: "Reviewer",
            content: `seal-${index}`,
          }
        : {
            kind: "message" as const,
            role: "user" as const,
            messageType: "final",
            alias: "You",
            content: `question-${index}`,
          },
    )
    const summarize = vi.fn((content: string) => content)

    const first = buildMinimapMarkers(items, summarize)
    const second = buildMinimapMarkers(items, (content) => content)

    expect(first.length).toBeLessThanOrEqual(120)
    expect(first.filter((marker) => marker.kind === "seal").map((marker) => marker.index)).toEqual([
      0, 50, 100, 150, 200, 250, 300, 350,
    ])
    expect(summarize).toHaveBeenCalledTimes(first.filter((marker) => marker.kind === "user").length)
    expect(first.map((marker) => marker.index)).toEqual(second.map((marker) => marker.index))
  })
})
