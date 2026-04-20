import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ChatHeader } from "./chat-header"

describe("ChatHeader", () => {
  it("renders the product title and subtitle", () => {
    render(<ChatHeader />)
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Multi-Agent")
    expect(screen.getByText("多智能体协同工作空间")).toBeInTheDocument()
  })

  it("renders children slot when provided", () => {
    render(
      <ChatHeader>
        <button type="button">ActionSlot</button>
      </ChatHeader>,
    )
    expect(screen.getByRole("button", { name: "ActionSlot" })).toBeInTheDocument()
  })

  it("omits children container when none provided", () => {
    render(<ChatHeader />)
    expect(screen.queryByRole("button", { name: "ActionSlot" })).not.toBeInTheDocument()
  })
})
