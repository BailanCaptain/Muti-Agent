import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ObservationBar } from "./observation-bar"

describe("ObservationBar", () => {
  it("renders 3 metric numbers (messages/evidence/followUp)", () => {
    render(<ObservationBar messages={12} evidence={3} followUp={5} />)
    expect(screen.getByText("12")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
    expect(screen.getByText("5")).toBeTruthy()
  })

  // F036 #1：删死链「会话链 →」——href="#invocation-chain" 全代码库无目标锚点，去除。
  it("no longer renders the dead 会话链 link", () => {
    render(<ObservationBar messages={0} evidence={0} followUp={0} />)
    expect(screen.queryByRole("link", { name: /会话链/ })).toBeNull()
  })

  it("labels the 3 metrics as 消息/证据/跟进", () => {
    render(<ObservationBar messages={0} evidence={0} followUp={0} />)
    expect(screen.getByText("消息")).toBeTruthy()
    expect(screen.getByText("证据")).toBeTruthy()
    expect(screen.getByText("跟进")).toBeTruthy()
  })

  it("AC-31: never renders seal-progress-list (info moved to agent-card tooltip)", () => {
    const { container } = render(<ObservationBar messages={0} evidence={0} followUp={0} />)
    expect(container.querySelector('[data-testid="seal-progress-list"]')).toBeNull()
  })
})
