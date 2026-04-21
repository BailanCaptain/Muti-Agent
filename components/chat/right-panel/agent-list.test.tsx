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

  it("stop button is icon-only (no 停止 text node) so running/idle rows keep same width", () => {
    const onStopClick = vi.fn()
    render(<AgentList agents={sampleAgents} onStopClick={onStopClick} />)
    const stopBtn = screen.getByRole("button", { name: /停止 黄仁勋/ })
    expect(stopBtn.textContent?.trim()).toBe("")
    fireEvent.click(stopBtn)
    expect(onStopClick).toHaveBeenCalledWith("claude")
  })
})
