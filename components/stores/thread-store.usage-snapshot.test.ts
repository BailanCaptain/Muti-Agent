import { beforeEach, describe, expect, it, vi } from "vitest"
import { useThreadStore } from "./thread-store"

vi.mock("@/components/ws/client", () => ({
  subscribeToRoom: () => {},
  connectRealtime: () => () => {},
  socketClient: {},
}))

/**
 * F043 AC8 · applyUsageSnapshot：轮中 usage.snapshot WS 事件 → 面板卡片实时刷新。
 * 只 patch 目标 provider 的四个字段，其余卡片状态（running/preview 等）不动。
 */

function seedProviders() {
  useThreadStore.setState({
    providers: {
      claude: {
        threadId: "t-claude",
        alias: "黄仁勋",
        currentModel: "claude-opus-4-8",
        quotaSummary: "",
        preview: "",
        running: true,
        fillRatio: 0.05,
        usedTokens: 10_000,
        windowTokens: 1_000_000,
        usageSource: "exact",
      },
      codex: {
        threadId: "t-codex",
        alias: "范德彪",
        currentModel: "gpt-5.6-sol",
        quotaSummary: "",
        preview: "",
        running: false,
        fillRatio: null,
      },
      gemini: {
        threadId: "t-gemini",
        alias: "桂芬",
        currentModel: null,
        quotaSummary: "",
        preview: "",
        running: false,
        fillRatio: null,
      },
    } as never,
  })
}

describe("F043 AC8 applyUsageSnapshot", () => {
  beforeEach(() => {
    seedProviders()
  })

  it("patches target provider card with live usage values", () => {
    useThreadStore.getState().applyUsageSnapshot({
      provider: "claude",
      usedTokens: 280_000,
      windowTokens: 1_000_000,
      fillRatio: 0.28,
      source: "exact",
    })
    const card = useThreadStore.getState().providers.claude
    expect(card.usedTokens).toBe(280_000)
    expect(card.windowTokens).toBe(1_000_000)
    expect(card.fillRatio).toBe(0.28)
    expect(card.usageSource).toBe("exact")
    // 其余字段不动
    expect(card.running).toBe(true)
    expect(card.alias).toBe("黄仁勋")
    // 其他 provider 不受影响
    expect(useThreadStore.getState().providers.codex.fillRatio).toBeNull()
  })

  it("no-op when provider card absent (跨房间事件防御)", () => {
    useThreadStore.setState({ providers: {} as never })
    useThreadStore.getState().applyUsageSnapshot({
      provider: "claude",
      usedTokens: 1,
      windowTokens: 2,
      fillRatio: 0.5,
      source: "approx",
    })
    expect(useThreadStore.getState().providers).toEqual({})
  })
})
