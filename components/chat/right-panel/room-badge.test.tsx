import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { RoomBadge, formatShortHash } from "./room-badge"

describe("RoomBadge", () => {
  it("shows global R-xxx id when provided", () => {
    render(<RoomBadge title="品鉴小屋" roomId="r-abcdef1234567890" globalRoomId="R-042" />)
    expect(screen.getByText("品鉴小屋")).toBeTruthy()
    expect(screen.getByText("R-042")).toBeTruthy()
  })

  it("falls back to #shortHash when globalRoomId is null (legacy rows)", () => {
    render(<RoomBadge title="品鉴小屋" roomId="r-abcdef1234567890" globalRoomId={null} />)
    expect(screen.getByText(/#r-abcd/)).toBeTruthy()
  })

  it("formatShortHash takes first 6 chars of roomId", () => {
    expect(formatShortHash("r-abcdef1234567890")).toBe("r-abcd")
    expect(formatShortHash("short")).toBe("short")
  })

  it("renders even when title is empty (fallback to '未命名')", () => {
    render(<RoomBadge title="" roomId="r-xyz000" />)
    expect(screen.getByText(/未命名/)).toBeTruthy()
  })
})
