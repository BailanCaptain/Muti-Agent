import { AGENT_PROFILES, PROVIDERS } from "@multi-agent/shared"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { TimelineWelcome } from "./timeline-welcome"

// F039 AC6: 空房间欢迎空态（roadmap P0#6 复活，视觉版）——
// 三 agent 介绍 + @ 用法提示，替换孤零零的「尚无消息。」。
describe("TimelineWelcome", () => {
  it("renders every agent's name and role from AGENT_PROFILES (data-driven, 不硬编码名册)", () => {
    render(<TimelineWelcome />)
    for (const provider of PROVIDERS) {
      const profile = AGENT_PROFILES[provider]
      expect(screen.getByText(profile.name)).toBeTruthy()
      expect(screen.getByText(profile.role)).toBeTruthy()
    }
  })

  it("teaches the @ dispatch affordance (含 @所有人 并行提示)", () => {
    render(<TimelineWelcome />)
    expect(screen.getByTestId("timeline-welcome").textContent).toContain("@所有人")
    expect(screen.getByTestId("timeline-welcome").textContent).toContain("@")
  })

  it("renders agent strengths so 小孙知道该 @ 谁", () => {
    render(<TimelineWelcome />)
    for (const provider of PROVIDERS) {
      expect(screen.getByText(AGENT_PROFILES[provider].strengths)).toBeTruthy()
    }
  })
})
