import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ObservationBar } from "./observation-bar"

describe("ObservationBar", () => {
  it("renders 3 metric numbers (messages/evidence/followUp) + session chain link", () => {
    render(
      <ObservationBar
        messages={12}
        evidence={3}
        followUp={5}
        sessionChainHref="/sessions"
      />,
    )
    expect(screen.getByText("12")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
    expect(screen.getByText("5")).toBeTruthy()
    expect(screen.getByRole("link", { name: /会话链/ })).toBeTruthy()
  })

  it("labels the 3 metrics as 消息/证据/跟进", () => {
    render(
      <ObservationBar
        messages={0}
        evidence={0}
        followUp={0}
        sessionChainHref="/sessions"
      />,
    )
    expect(screen.getByText("消息")).toBeTruthy()
    expect(screen.getByText("证据")).toBeTruthy()
    expect(screen.getByText("跟进")).toBeTruthy()
  })

  it("session chain link uses provided href", () => {
    render(
      <ObservationBar
        messages={0}
        evidence={0}
        followUp={0}
        sessionChainHref="/rooms/r-abc/sessions"
      />,
    )
    const link = screen.getByRole("link", { name: /会话链/ }) as HTMLAnchorElement
    expect(link.getAttribute("href")).toBe("/rooms/r-abc/sessions")
  })
})
