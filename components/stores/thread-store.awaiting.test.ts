import type { ThreadSnapshotDelta } from "@multi-agent/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useThreadStore } from "./thread-store"

vi.mock("@/components/ws/client", () => ({
  subscribeToRoom: () => {},
  connectRealtime: () => () => {},
  socketClient: {},
}))

/**
 * B026 · awaitingFirstOutput 生命周期：
 *   mark（page.tsx 收到空占位 message.created）→ 骨架点亮
 *   清除：assistant_delta 首字 / message.updated 终稿 / snapshot delta 里 provider
 *   running=false（异常轮兜底——轮结束了 content 还空 = 真空消息，不再骨架）。
 * 病灶背景：providers[].running 直到 CLI spawn 完成（实测 +23.4s）才 true，
 * 绑 running 的任何反馈都盖不住死区，必须用消息事件自身做触发。
 */

function makeDelta(over: Partial<ThreadSnapshotDelta> = {}): ThreadSnapshotDelta {
  const providers = useThreadStore.getState().providers
  return {
    sessionGroupId: "g1",
    newMessages: [],
    providers,
    invocationStats: [],
    ...over,
  }
}

function providersWithRunning(provider: "claude" | "codex" | "gemini", running: boolean) {
  const current = useThreadStore.getState().providers
  return {
    ...current,
    [provider]: { ...current[provider], running },
  }
}

describe("B026 awaitingFirstOutput", () => {
  beforeEach(() => {
    useThreadStore.setState({ awaitingFirstOutput: {}, timeline: [] } as never)
  })

  it("mark 后条目存在且记录 provider；重复 mark 幂等", () => {
    const s = useThreadStore.getState()
    s.markAwaitingFirstOutput("m1", "claude")
    s.markAwaitingFirstOutput("m1", "claude")
    expect(useThreadStore.getState().awaitingFirstOutput).toEqual({ m1: "claude" })
  })

  it("clearAwaitingFirstOutput 清除指定条目，不动别家", () => {
    const s = useThreadStore.getState()
    s.markAwaitingFirstOutput("m1", "claude")
    s.markAwaitingFirstOutput("m2", "codex")
    s.clearAwaitingFirstOutput("m1")
    expect(useThreadStore.getState().awaitingFirstOutput).toEqual({ m2: "codex" })
  })

  it("applyAssistantDelta（首个流式字）清除对应条目", () => {
    const s = useThreadStore.getState()
    s.markAwaitingFirstOutput("m1", "claude")
    s.applyAssistantDelta("m1", "第", 0)
    expect(useThreadStore.getState().awaitingFirstOutput.m1).toBeUndefined()
  })

  it("applyMessageUpdate（收尾终稿）清除对应条目", () => {
    const s = useThreadStore.getState()
    s.markAwaitingFirstOutput("m1", "claude")
    s.applyMessageUpdate({
      id: "m1",
      provider: "claude",
      alias: "黄仁勋",
      role: "assistant",
      content: "终稿",
      messageType: "final",
      model: null,
      createdAt: "2026-07-11T08:00:00.000Z",
    })
    expect(useThreadStore.getState().awaitingFirstOutput.m1).toBeUndefined()
  })

  it("applySnapshotDelta：running 下降沿（true→false = 轮结束）→ 清该 provider 全部条目", () => {
    useThreadStore.setState({ providers: providersWithRunning("claude", true) } as never)
    const s = useThreadStore.getState()
    s.markAwaitingFirstOutput("m1", "claude")
    s.markAwaitingFirstOutput("m2", "claude")
    s.markAwaitingFirstOutput("m3", "codex")
    s.applySnapshotDelta(
      makeDelta({
        providers: {
          ...providersWithRunning("claude", false),
          codex: { ...useThreadStore.getState().providers.codex, running: true },
        },
      }),
    )
    const awaiting = useThreadStore.getState().awaitingFirstOutput
    expect(awaiting.m1).toBeUndefined()
    expect(awaiting.m2).toBeUndefined()
    expect(awaiting.m3).toBe("codex")
  })

  it("applySnapshotDelta：running 持续 false（spawn 完成前的轮中 delta）→ 不误清（probe4 实测回归）", () => {
    // 病灶：轮开始 emit 的 delta 里 running=false（CLI 还没 spawn 完），
    // 「只看 false 就清」让骨架只活到第一个 delta 事件（~0.3s），死区又回壳卡片。
    useThreadStore.setState({ providers: providersWithRunning("claude", false) } as never)
    const s = useThreadStore.getState()
    s.markAwaitingFirstOutput("m1", "claude")
    s.applySnapshotDelta(makeDelta({ providers: providersWithRunning("claude", false) }))
    expect(useThreadStore.getState().awaitingFirstOutput.m1).toBe("claude")
  })

  it("applySnapshotDelta：provider running=true → 条目保留（spawn 完成不误清）", () => {
    const s = useThreadStore.getState()
    s.markAwaitingFirstOutput("m1", "claude")
    s.applySnapshotDelta(makeDelta({ providers: providersWithRunning("claude", true) }))
    expect(useThreadStore.getState().awaitingFirstOutput.m1).toBe("claude")
  })

  // 德彪 r1 P2-1：selectSessionGroup 不止切房——WS 重连（page.tsx onReconnect）和
  // seq gap catch-up 都以当前 groupId + force:true 重进本函数（F044 起）。无条件清
  // awaiting 会在死区中把活 marker 洗掉（快照无 message.created 重放，气泡回壳）。
  // 同房 resync 必须保留：无 force 走早退（不 fetch），force 走主路径重拉——两条都测。
  describe("selectSessionGroup 语义（P2-1）", () => {
    function stubFetch() {
      const providers = useThreadStore.getState().providers
      const activeGroupOf = (id: string) => ({
        id,
        roomId: null,
        title: "t",
        meta: "",
        timeline: [],
        hasPendingDispatches: false,
        dispatchBarrierActive: false,
        providers,
      })
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const m = /session-groups\/([^/?]+)/.exec(String(url))
          const body = m
            ? {
                activeGroup: activeGroupOf(m[1]),
                timelinePage: { hasMore: false, nextCursor: null },
              }
            : { pending: [], records: [], items: [], flushes: [] }
          return {
            ok: true,
            status: 200,
            json: async () => body,
          }
        }),
      )
    }

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it("同房重选（无 force）→ F044 早退不 refetch，awaiting 自然保留", async () => {
      stubFetch()
      useThreadStore.setState({ activeGroupId: "g1" } as never)
      useThreadStore.getState().markAwaitingFirstOutput("m1", "claude")
      await useThreadStore.getState().selectSessionGroup("g1")
      expect(useThreadStore.getState().awaitingFirstOutput.m1).toBe("claude")
    })

    it("同房 resync + force（重连/catch-up 真实路径）→ 主路径重拉后 awaiting 保留", async () => {
      stubFetch()
      useThreadStore.setState({ activeGroupId: "g1" } as never)
      useThreadStore.getState().markAwaitingFirstOutput("m1", "claude")
      await useThreadStore.getState().selectSessionGroup("g1", { force: true })
      expect(useThreadStore.getState().awaitingFirstOutput.m1).toBe("claude")
    })

    it("真切房（groupId 变化）→ awaiting 清空", async () => {
      stubFetch()
      useThreadStore.setState({ activeGroupId: "g1" } as never)
      useThreadStore.getState().markAwaitingFirstOutput("m1", "claude")
      await useThreadStore.getState().selectSessionGroup("g2")
      expect(useThreadStore.getState().awaitingFirstOutput.m1).toBeUndefined()
    })

    it("同房 force resync：fetch 在途期间新到的 mark 不被覆盖", async () => {
      stubFetch()
      useThreadStore.setState({ activeGroupId: "g1" } as never)
      const inFlight = useThreadStore.getState().selectSessionGroup("g1", { force: true })
      // fetch 在途窗口内占位 message.created 到达
      useThreadStore.getState().markAwaitingFirstOutput("m-during-fetch", "claude")
      await inFlight
      expect(useThreadStore.getState().awaitingFirstOutput["m-during-fetch"]).toBe("claude")
    })
  })
})
