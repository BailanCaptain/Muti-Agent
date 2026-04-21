import { describe, it, expect, vi } from "vitest"
import { dispatchArchiveStateChanged } from "./archive-event-handler"
import { useThreadStore } from "./thread-store"

function makeActions() {
  return {
    bumpArchiveStateVersion: vi.fn(),
    clearActiveGroupIfMatches: vi.fn(),
  }
}

describe("dispatchArchiveStateChanged — F022 P2 regression", () => {
  it("archive event (archivedAt set, deletedAt null): bumps version + clears active when matches", () => {
    const actions = makeActions()
    dispatchArchiveStateChanged(
      { sessionGroupId: "g-1", archivedAt: "2026-04-21T03:30:00.000Z", deletedAt: null },
      actions,
    )
    expect(actions.bumpArchiveStateVersion).toHaveBeenCalledTimes(1)
    expect(actions.clearActiveGroupIfMatches).toHaveBeenCalledTimes(1)
    expect(actions.clearActiveGroupIfMatches).toHaveBeenCalledWith("g-1")
  })

  it("delete event (deletedAt set, archivedAt null): bumps version + clears active when matches", () => {
    const actions = makeActions()
    dispatchArchiveStateChanged(
      { sessionGroupId: "g-2", archivedAt: null, deletedAt: "2026-04-21T03:31:00.000Z" },
      actions,
    )
    expect(actions.bumpArchiveStateVersion).toHaveBeenCalledTimes(1)
    expect(actions.clearActiveGroupIfMatches).toHaveBeenCalledWith("g-2")
  })

  it("archive+delete event (both set): bumps version + clears active when matches", () => {
    const actions = makeActions()
    dispatchArchiveStateChanged(
      {
        sessionGroupId: "g-3",
        archivedAt: "2026-04-21T03:30:00.000Z",
        deletedAt: "2026-04-21T03:31:00.000Z",
      },
      actions,
    )
    expect(actions.clearActiveGroupIfMatches).toHaveBeenCalledWith("g-3")
  })

  it("restore event (both null): bumps version, does NOT clear active", () => {
    const actions = makeActions()
    dispatchArchiveStateChanged(
      { sessionGroupId: "g-4", archivedAt: null, deletedAt: null },
      actions,
    )
    expect(actions.bumpArchiveStateVersion).toHaveBeenCalledTimes(1)
    expect(actions.clearActiveGroupIfMatches).not.toHaveBeenCalled()
  })
})

describe("useThreadStore.clearActiveGroupIfMatches — identity guard", () => {
  it("clears activeGroup/timeline/providers/invocationStats when groupId matches activeGroupId", () => {
    useThreadStore.setState({
      activeGroupId: "g-active",
      activeGroup: {
        id: "g-active",
        title: "active",
        meta: "",
        hasPendingDispatches: false,
        dispatchBarrierActive: false,
      },
      timeline: [{ id: "m1" } as never],
      invocationStats: [{ provider: "claude" } as never],
    })

    useThreadStore.getState().clearActiveGroupIfMatches("g-active")

    const state = useThreadStore.getState()
    expect(state.activeGroupId).toBeNull()
    expect(state.activeGroup).toBeNull()
    expect(state.timeline).toEqual([])
    expect(state.invocationStats).toEqual([])
    expect(state.providers.claude.threadId).toBe("")
  })

  it("is a no-op when groupId does not match activeGroupId (defends against late websocket arrivals)", () => {
    const beforeActiveGroup = {
      id: "g-active",
      title: "still here",
      meta: "",
      hasPendingDispatches: false,
      dispatchBarrierActive: false,
    }
    useThreadStore.setState({
      activeGroupId: "g-active",
      activeGroup: beforeActiveGroup,
      timeline: [{ id: "m1" } as never],
    })

    useThreadStore.getState().clearActiveGroupIfMatches("g-stale")

    const state = useThreadStore.getState()
    expect(state.activeGroupId).toBe("g-active")
    expect(state.activeGroup).toBe(beforeActiveGroup)
    expect(state.timeline).toHaveLength(1)
  })
})

describe("useThreadStore.bumpArchiveStateVersion", () => {
  it("monotonically increments archiveStateVersion", () => {
    useThreadStore.setState({ archiveStateVersion: 0 })
    useThreadStore.getState().bumpArchiveStateVersion()
    expect(useThreadStore.getState().archiveStateVersion).toBe(1)
    useThreadStore.getState().bumpArchiveStateVersion()
    expect(useThreadStore.getState().archiveStateVersion).toBe(2)
  })
})
