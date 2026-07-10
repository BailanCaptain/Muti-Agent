import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { streamMonitor } from "../ws/stream-monitor"
import { useThreadStore } from "./thread-store"

/**
 * F031 AC2/AC3 · selectSessionGroup：subscribe-before-fetch（德彪 r1 P2）+
 * 快照水位线换基线。
 */

const calls: string[] = []

vi.mock("@/components/ws/client", () => ({
  subscribeToRoom: (groupId: string) => {
    calls.push(`subscribe:${groupId}`)
  },
  connectRealtime: () => () => {},
  socketClient: {},
}))

function fakeSnapshotResponse(groupId = "g1") {
  return {
    activeGroup: {
      id: groupId,
      roomId: null,
      title: "t",
      meta: "",
      timeline: [],
      hasPendingDispatches: false,
      dispatchBarrierActive: false,
      providers: {},
    },
    timelinePage: { hasMore: true, nextCursor: `cursor-${groupId}`, limit: 100 },
    wsWatermark: { epoch: "e-test", seq: 7 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  }
}

describe("thread-store · selectSessionGroup (F031)", () => {
  beforeEach(() => {
    calls.length = 0
    useThreadStore.setState({
      activeGroupId: null,
      activeGroup: null,
      timeline: [],
      pendingGroupId: null,
      switchError: null,
      switchErrorGroupId: null,
      timelinePage: null,
      isLoadingOlder: false,
      olderTimelineError: null,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(`fetch:${String(url)}`)
        return {
          ok: true,
          json: async () =>
            String(url).includes("/api/session-groups/") ? fakeSnapshotResponse() : {},
        }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("先 subscribeToRoom 再 fetch 快照（缩窄订阅过滤丢失窗口）", async () => {
    await useThreadStore.getState().selectSessionGroup("g1")
    const subscribeIdx = calls.findIndex((c) => c === "subscribe:g1")
    const fetchIdx = calls.findIndex((c) => c.startsWith("fetch:") && c.includes("session-groups"))
    expect(subscribeIdx).toBeGreaterThanOrEqual(0)
    expect(fetchIdx).toBeGreaterThan(subscribeIdx)
  })

  it("快照 wsWatermark 换基线：seq ≤ 水位线 drop，> 水位线连续 apply", async () => {
    await useThreadStore.getState().selectSessionGroup("g1")
    const seqEvent = (seq: number) => ({
      type: "assistant_delta" as const,
      payload: { sessionGroupId: "g1", messageId: "m1", delta: "x" },
      seq,
      epoch: "e-test",
    })
    expect(streamMonitor.observe(seqEvent(7))).toBe("drop")
    expect(streamMonitor.observe(seqEvent(8))).toBe("apply")
  })

  it("F044 点击后同步设置 pending，快照完成前保留旧 active", async () => {
    const snapshot = deferred<ReturnType<typeof jsonResponse>>()
    useThreadStore.setState({
      activeGroupId: "g-old",
      activeGroup: {
        id: "g-old",
        roomId: null,
        title: "old",
        meta: "",
        hasPendingDispatches: false,
        dispatchBarrierActive: false,
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(() => snapshot.promise),
    )

    const selection = useThreadStore.getState().selectSessionGroup("g-new")
    expect(useThreadStore.getState().pendingGroupId).toBe("g-new")
    expect(useThreadStore.getState().activeGroupId).toBe("g-old")

    snapshot.resolve(jsonResponse(fakeSnapshotResponse("g-new")))
    await selection
    expect(useThreadStore.getState().activeGroupId).toBe("g-new")
    expect(useThreadStore.getState().pendingGroupId).toBeNull()
  })

  it("F044 重选当前会话不发请求", async () => {
    useThreadStore.setState({ activeGroupId: "g1" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await useThreadStore.getState().selectSessionGroup("g1")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("F044 review P1: pending 中点回当前会话会恢复当前房间订阅", async () => {
    const pendingSnapshot = deferred<ReturnType<typeof jsonResponse>>()
    useThreadStore.setState({ activeGroupId: "g-old" })
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pendingSnapshot.promise),
    )

    const selectNew = useThreadStore.getState().selectSessionGroup("g-new")
    await useThreadStore.getState().selectSessionGroup("g-old")

    expect(calls.filter((call) => call.startsWith("subscribe:")).at(-1)).toBe("subscribe:g-old")
    pendingSnapshot.resolve(jsonResponse(fakeSnapshotResponse("g-new")))
    await selectNew
  })

  it("F044 系统强制刷新当前会话仍会补拉快照且不暴露切换骨架", async () => {
    const overlappingMessage = {
      id: "m-overlap",
      provider: "codex" as const,
      alias: "范德彪",
      role: "assistant" as const,
      content: "overlap",
      messageType: "final" as const,
      model: null,
      createdAt: "2026-07-10T00:00:01Z",
    }
    useThreadStore.setState({
      activeGroupId: "g1",
      timeline: [overlappingMessage],
      timelinePage: { hasMore: true, nextCursor: "cursor-loaded-history", limit: 100 },
    })
    const snapshot = deferred<ReturnType<typeof jsonResponse>>()
    const fetchMock = vi.fn((_url: string) => snapshot.promise)
    vi.stubGlobal("fetch", fetchMock)

    const refresh = useThreadStore.getState().selectSessionGroup("g1", { force: true })

    expect(useThreadStore.getState().pendingGroupId).toBeNull()
    const freshSnapshot = fakeSnapshotResponse("g1")
    ;(freshSnapshot.activeGroup.timeline as (typeof overlappingMessage)[]).push(overlappingMessage)
    snapshot.resolve(jsonResponse(freshSnapshot))
    await refresh

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/api/session-groups/g1")),
    ).toBe(true)
    expect(useThreadStore.getState().timelinePage?.nextCursor).toBe("cursor-loaded-history")
  })

  it("F044 review r2 P2: 同房刷新零重叠时采用连续的新窗口与 cursor", async () => {
    const message = (id: string, createdAt: string) => ({
      id,
      provider: "codex" as const,
      alias: "范德彪",
      role: "assistant" as const,
      content: id,
      messageType: "final" as const,
      model: null,
      createdAt,
    })
    const oldMessage = message("m-old-window", "2026-07-10T00:00:01Z")
    const newestMessage = message("m-new-window", "2026-07-10T00:10:01Z")
    useThreadStore.setState({
      activeGroupId: "g1",
      timeline: [oldMessage],
      timelinePage: { hasMore: true, nextCursor: "cursor-old-window", limit: 100 },
    })
    const freshSnapshot = fakeSnapshotResponse("g1")
    ;(freshSnapshot.activeGroup.timeline as (typeof newestMessage)[]).push(newestMessage)
    freshSnapshot.timelinePage.nextCursor = "cursor-new-window"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(freshSnapshot)),
    )

    await useThreadStore.getState().selectSessionGroup("g1", { force: true })

    expect(useThreadStore.getState().timeline.map((item) => item.id)).toEqual(["m-new-window"])
    expect(useThreadStore.getState().timelinePage?.nextCursor).toBe("cursor-new-window")
  })

  it("F044 快速切换时旧响应不能覆盖较新的会话", async () => {
    const first = deferred<ReturnType<typeof jsonResponse>>()
    const second = deferred<ReturnType<typeof jsonResponse>>()
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).endsWith("/g1")) return first.promise
        if (String(url).endsWith("/g2")) return second.promise
        return Promise.resolve(jsonResponse({}))
      }),
    )

    const selectFirst = useThreadStore.getState().selectSessionGroup("g1")
    const selectSecond = useThreadStore.getState().selectSessionGroup("g2")
    second.resolve(jsonResponse(fakeSnapshotResponse("g2")))
    await selectSecond
    first.resolve(jsonResponse(fakeSnapshotResponse("g1")))
    await selectFirst

    expect(useThreadStore.getState().activeGroupId).toBe("g2")
    expect(useThreadStore.getState().activeGroup?.id).toBe("g2")
  })

  it("F044 切换失败保留旧会话并暴露可重试错误", async () => {
    useThreadStore.setState({
      activeGroupId: "g-old",
      activeGroup: {
        id: "g-old",
        roomId: null,
        title: "old",
        meta: "",
        hasPendingDispatches: false,
        dispatchBarrierActive: false,
      },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    )

    await expect(useThreadStore.getState().selectSessionGroup("g-new")).rejects.toThrow("offline")

    expect(useThreadStore.getState().activeGroupId).toBe("g-old")
    expect(useThreadStore.getState().activeGroup?.id).toBe("g-old")
    expect(useThreadStore.getState().pendingGroupId).toBeNull()
    expect(useThreadStore.getState().switchError).toMatch(/offline/i)
    expect(calls.filter((call) => call.startsWith("subscribe:")).at(-1)).toBe("subscribe:g-old")
  })

  it("F044 加载更早消息时去重、前插并推进 cursor", async () => {
    const existing = {
      id: "m-new",
      provider: "codex" as const,
      alias: "范德彪",
      role: "assistant" as const,
      content: "new",
      messageType: "final" as const,
      model: null,
      createdAt: "2026-07-10T00:00:02Z",
    }
    const older = {
      ...existing,
      id: "m-old",
      content: "old",
      createdAt: "2026-07-10T00:00:01Z",
    }
    useThreadStore.setState({
      activeGroupId: "g1",
      timeline: [existing],
      timelinePage: { hasMore: true, nextCursor: "cursor-1", limit: 100 },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          timeline: [older, existing],
          timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
        }),
      ),
    )

    const added = await useThreadStore.getState().loadOlderTimeline()

    expect(added).toBe(1)
    expect(useThreadStore.getState().timeline.map((message) => message.id)).toEqual([
      "m-old",
      "m-new",
    ])
    expect(useThreadStore.getState().timelinePage?.hasMore).toBe(false)
  })

  it("F044 review P2: A→B→A 后丢弃旧 cursor 的在途历史页", async () => {
    const stalePage = deferred<ReturnType<typeof jsonResponse>>()
    const staleMessage = {
      id: "m-stale",
      provider: "codex" as const,
      alias: "范德彪",
      role: "assistant" as const,
      content: "stale page",
      messageType: "final" as const,
      model: null,
      createdAt: "2026-07-10T00:00:01Z",
    }
    useThreadStore.setState({
      activeGroupId: "g-a",
      timeline: [],
      timelinePage: { hasMore: true, nextCursor: "cursor-old-a", limit: 100 },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/timeline?before=")) return stalePage.promise
        const groupId = String(url).endsWith("/g-b") ? "g-b" : "g-a"
        return Promise.resolve(jsonResponse(fakeSnapshotResponse(groupId)))
      }),
    )

    const loadingOlder = useThreadStore.getState().loadOlderTimeline()
    await useThreadStore.getState().selectSessionGroup("g-b")
    await useThreadStore.getState().selectSessionGroup("g-a")
    stalePage.resolve(
      jsonResponse({
        timeline: [staleMessage],
        timelinePage: { hasMore: true, nextCursor: "cursor-stale-page", limit: 100 },
      }),
    )

    expect(await loadingOlder).toBe(0)
    expect(useThreadStore.getState().timeline).toEqual([])
    expect(useThreadStore.getState().timelinePage?.nextCursor).toBe("cursor-g-a")
  })

  it("F044 acceptance: A→B→A 且 cursor 复用时仍不展示旧历史页请求的错误", async () => {
    const stalePage = deferred<ReturnType<typeof jsonResponse>>()
    useThreadStore.setState({
      activeGroupId: "g-a",
      timeline: [],
      timelinePage: { hasMore: true, nextCursor: "cursor-old-a", limit: 100 },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/timeline?before=")) return stalePage.promise
        const groupId = String(url).endsWith("/g-b") ? "g-b" : "g-a"
        const payload = fakeSnapshotResponse(groupId)
        if (groupId === "g-a") payload.timelinePage.nextCursor = "cursor-old-a"
        return Promise.resolve(jsonResponse(payload))
      }),
    )

    const oldLoad = useThreadStore.getState().loadOlderTimeline()
    await useThreadStore.getState().selectSessionGroup("g-b")
    await useThreadStore.getState().selectSessionGroup("g-a")
    stalePage.reject(new Error("stale offline"))

    expect(await oldLoad).toBe(0)
    expect(useThreadStore.getState().olderTimelineError).toBeNull()
  })

  it("F044 acceptance: 旧历史页 finally 不得清除新 A 页的 loading 状态", async () => {
    const oldPage = deferred<ReturnType<typeof jsonResponse>>()
    const newPage = deferred<ReturnType<typeof jsonResponse>>()
    let pageCalls = 0
    useThreadStore.setState({
      activeGroupId: "g-a",
      timeline: [],
      timelinePage: { hasMore: true, nextCursor: "cursor-old-a", limit: 100 },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/timeline?before=")) {
          pageCalls += 1
          return pageCalls === 1 ? oldPage.promise : newPage.promise
        }
        const groupId = String(url).endsWith("/g-b") ? "g-b" : "g-a"
        return Promise.resolve(jsonResponse(fakeSnapshotResponse(groupId)))
      }),
    )

    const oldLoad = useThreadStore.getState().loadOlderTimeline()
    await useThreadStore.getState().selectSessionGroup("g-b")
    await useThreadStore.getState().selectSessionGroup("g-a")
    const newLoad = useThreadStore.getState().loadOlderTimeline()
    expect(useThreadStore.getState().isLoadingOlder).toBe(true)

    oldPage.resolve(
      jsonResponse({
        timeline: [],
        timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
      }),
    )
    await oldLoad
    expect(useThreadStore.getState().isLoadingOlder).toBe(true)

    newPage.resolve(
      jsonResponse({
        timeline: [],
        timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
      }),
    )
    await newLoad
  })

  it("F044 Claude P1: pending B 时点回 A 会释放已作废的历史页 loading", async () => {
    const oldPage = deferred<ReturnType<typeof jsonResponse>>()
    const pendingB = deferred<ReturnType<typeof jsonResponse>>()
    useThreadStore.setState({
      activeGroupId: "g-a",
      timeline: [],
      timelinePage: { hasMore: true, nextCursor: "cursor-old-a", limit: 100 },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/timeline?before=")) return oldPage.promise
        if (String(url).endsWith("/g-b")) return pendingB.promise
        return Promise.resolve(jsonResponse(fakeSnapshotResponse("g-a")))
      }),
    )

    const oldLoad = useThreadStore.getState().loadOlderTimeline()
    const selectB = useThreadStore.getState().selectSessionGroup("g-b")
    await useThreadStore.getState().selectSessionGroup("g-a")

    expect(useThreadStore.getState().isLoadingOlder).toBe(false)
    expect(useThreadStore.getState().olderTimelineError).toBeNull()

    oldPage.resolve(
      jsonResponse({
        timeline: [],
        timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
      }),
    )
    pendingB.resolve(jsonResponse(fakeSnapshotResponse("g-b")))
    await Promise.all([oldLoad, selectB])
  })

  it("F044 Claude P1: 切换 B 失败留在 A 时会释放已作废的历史页 loading", async () => {
    const oldPage = deferred<ReturnType<typeof jsonResponse>>()
    useThreadStore.setState({
      activeGroupId: "g-a",
      timeline: [],
      timelinePage: { hasMore: true, nextCursor: "cursor-old-a", limit: 100 },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/timeline?before=")) return oldPage.promise
        return Promise.reject(new Error("switch offline"))
      }),
    )

    const oldLoad = useThreadStore.getState().loadOlderTimeline()
    await expect(useThreadStore.getState().selectSessionGroup("g-b")).rejects.toThrow(
      "switch offline",
    )

    expect(useThreadStore.getState().activeGroupId).toBe("g-a")
    expect(useThreadStore.getState().isLoadingOlder).toBe(false)
    expect(useThreadStore.getState().olderTimelineError).toBeNull()

    oldPage.resolve(
      jsonResponse({
        timeline: [],
        timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
      }),
    )
    await oldLoad
  })

  it("F044 takeover: 切换 B 期间新发起的 A 历史页不得被 B 失败清除 loading", async () => {
    const currentPage = deferred<ReturnType<typeof jsonResponse>>()
    const pendingB = deferred<ReturnType<typeof jsonResponse>>()
    useThreadStore.setState({
      activeGroupId: "g-a",
      timeline: [],
      timelinePage: { hasMore: true, nextCursor: "cursor-current-a", limit: 100 },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).includes("/timeline?before=")) return currentPage.promise
        if (String(url).endsWith("/g-b")) return pendingB.promise
        return Promise.resolve(jsonResponse(fakeSnapshotResponse("g-a")))
      }),
    )

    const selectB = useThreadStore.getState().selectSessionGroup("g-b")
    const currentLoad = useThreadStore.getState().loadOlderTimeline()
    pendingB.reject(new Error("switch offline"))
    await expect(selectB).rejects.toThrow("switch offline")

    expect(useThreadStore.getState().activeGroupId).toBe("g-a")
    expect(useThreadStore.getState().isLoadingOlder).toBe(true)

    currentPage.resolve(
      jsonResponse({
        timeline: [],
        timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
      }),
    )
    await currentLoad
    expect(useThreadStore.getState().isLoadingOlder).toBe(false)
  })
})
