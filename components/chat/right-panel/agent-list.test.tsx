import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AgentList } from "./agent-list"

const sampleAgents = [
  { provider: "claude" as const, alias: "黄仁勋", model: "claude-opus-4-7", running: true },
  { provider: "codex" as const, alias: "范德彪", model: "gpt-5", running: false },
  { provider: "gemini" as const, alias: "桂芬", model: null, running: false },
]

describe("AgentList", () => {
  it("renders one row per agent with alias + model pill", () => {
    render(<AgentList agents={sampleAgents} />)
    expect(screen.getByText("黄仁勋")).toBeTruthy()
    expect(screen.getByText("范德彪")).toBeTruthy()
    expect(screen.getByText("桂芬")).toBeTruthy()
    expect(screen.getByText("claude-opus-4-7")).toBeTruthy()
    expect(screen.getByText("gpt-5")).toBeTruthy()
  })

  it("shows 未设置 when model is null", () => {
    render(<AgentList agents={sampleAgents} />)
    expect(screen.getByText("未设置")).toBeTruthy()
  })

  it("marks running agents with pulse state (role=status 'running' / 'idle')", () => {
    render(<AgentList agents={sampleAgents} />)
    const statuses = screen.getAllByRole("status")
    expect(statuses).toHaveLength(3)
    expect(statuses[0]?.getAttribute("data-state")).toBe("running")
    expect(statuses[1]?.getAttribute("data-state")).toBe("idle")
    expect(statuses[2]?.getAttribute("data-state")).toBe("idle")
  })

  it("renders a gear button per agent and calls onConfigClick with provider", () => {
    const onConfigClick = vi.fn()
    render(<AgentList agents={sampleAgents} onConfigClick={onConfigClick} />)
    const gears = screen.getAllByRole("button", { name: /配置/ })
    expect(gears).toHaveLength(3)
    fireEvent.click(gears[1]!)
    expect(onConfigClick).toHaveBeenCalledWith("codex")
  })

  it("gear button is still present without onConfigClick (no-op)", () => {
    render(<AgentList agents={sampleAgents} />)
    const gears = screen.getAllByRole("button", { name: /配置/ })
    expect(gears).toHaveLength(3)
    fireEvent.click(gears[0]!) // should not throw
  })

  it("renders orange dot next to model pill for providers with session override (AC-10)", () => {
    const agents = [
      { provider: "claude" as const, alias: "黄仁勋", model: "claude-opus-4-7", running: false, hasSessionOverride: true },
      { provider: "codex" as const, alias: "范德彪", model: "gpt-5", running: false, hasSessionOverride: false },
    ]
    render(<AgentList agents={agents} />)
    const dots = screen.getAllByTestId("session-override-dot")
    expect(dots).toHaveLength(1)
    expect(dots[0]?.getAttribute("data-provider")).toBe("claude")
  })

  it("does not render the dot when hasSessionOverride is undefined", () => {
    render(<AgentList agents={sampleAgents} />)
    expect(screen.queryAllByTestId("session-override-dot")).toHaveLength(0)
  })

  it("renders placeholder context row when fillRatio is null (stable layout before first run)", () => {
    const agents = [
      { provider: "claude" as const, alias: "黄仁勋", model: "claude-opus-4-7", running: false, fillRatio: null },
    ]
    render(<AgentList agents={agents} />)
    expect(screen.getByText("待运行")).toBeTruthy()
  })

  it("AC-31: shows inline detail used/total (剩余 X%) next to bar — always visible, not hover", () => {
    const agents = [
      {
        provider: "claude" as const,
        alias: "黄仁勋",
        model: "claude-opus-4-7",
        running: false,
        fillRatio: 0.42,
        window: 200_000,
        actionPct: 0.9,
      },
    ]
    render(<AgentList agents={agents} />)
    const detail = screen.getByTestId("agent-context-detail")
    expect(detail).toBeTruthy()
    expect(detail.getAttribute("data-provider")).toBe("claude")
    // used = round(0.42 * 200000) = 84000 → 84k；window = 200k
    expect(detail.textContent).toMatch(/84k\s*\/\s*200k/)
    // AC-31 review fix: 显示距 seal 阈值的剩余空间 = round(actionPct*100 - fillRatio*100) = 48
    expect(detail.textContent).toMatch(/\(剩余\s*48%\)/)
    // Regression guard: must NOT be hover-only (no opacity-0 / group-hover classes)
    const cls = detail.getAttribute("class") ?? ""
    expect(cls).not.toMatch(/opacity-0/)
    expect(cls).not.toMatch(/group-hover/)
  })

  it("AC-31 review fix: detail clamps remaining at 0 when fillRatio exceeds actionPct", () => {
    // 已超过 seal 阈值（防御边界——理论上 seal trigger 已封存，但保护渲染）
    const agents = [
      {
        provider: "claude" as const,
        alias: "黄仁勋",
        model: "claude-opus-4-7",
        running: false,
        fillRatio: 0.95,
        window: 200_000,
        actionPct: 0.9,
      },
    ]
    render(<AgentList agents={agents} />)
    const detail = screen.getByTestId("agent-context-detail")
    expect(detail.textContent).toMatch(/\(剩余\s*0%\)/)
  })

  it("AC-31: detail not rendered when fillRatio is null (no data yet)", () => {
    const agents = [
      {
        provider: "claude" as const,
        alias: "黄仁勋",
        model: "claude-opus-4-7",
        running: false,
        fillRatio: null,
      },
    ]
    render(<AgentList agents={agents} />)
    expect(screen.queryByTestId("agent-context-detail")).toBeNull()
  })

  it("AC-32: shows 已封存 badge when sealed=true (until next user turn)", () => {
    const agents = [
      {
        provider: "claude" as const,
        alias: "黄仁勋",
        model: "claude-opus-4-7",
        running: false,
        sealed: true,
      },
    ]
    render(<AgentList agents={agents} />)
    const badge = screen.getByTestId("agent-sealed-badge")
    expect(badge).toBeTruthy()
    expect(badge.getAttribute("data-provider")).toBe("claude")
    expect(badge.textContent).toMatch(/已封存/)
  })

  it("AC-32: no 已封存 badge when sealed is false/undefined", () => {
    render(<AgentList agents={sampleAgents} />)
    expect(screen.queryByTestId("agent-sealed-badge")).toBeNull()
  })

  it("stop button is icon-only (no 停止 text node) so running/idle rows keep same width", () => {
    const onStopClick = vi.fn()
    render(<AgentList agents={sampleAgents} onStopClick={onStopClick} />)
    const stopBtn = screen.getByRole("button", { name: /停止 黄仁勋/ })
    expect(stopBtn.textContent?.trim()).toBe("")
    fireEvent.click(stopBtn)
    expect(onStopClick).toHaveBeenCalledWith("claude")
  })
})
