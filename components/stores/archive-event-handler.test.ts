import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { dispatchArchiveStateChanged, useArchiveStateReloader } from "./archive-event-handler"
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
        roomId: null,
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
      roomId: null,
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

describe("useArchiveStateReloader — F022 P2 sidebar reload regression", () => {
  it("initial mount: does NOT call reload (avoid spurious bootstrap refetch)", () => {
    const reloadSessionGroups = vi.fn()
    const reloadArchived = vi.fn()
    renderHook(() =>
      useArchiveStateReloader(0, reloadSessionGroups, reloadArchived, false),
    )
    expect(reloadSessionGroups).not.toHaveBeenCalled()
    expect(reloadArchived).not.toHaveBeenCalled()
  })

  it("archiveStateVersion bump with archivedOpen=false: reloads main list only", () => {
    const reloadSessionGroups = vi.fn()
    const reloadArchived = vi.fn()
    const { rerender } = renderHook(
      ({ version }: { version: number }) =>
        useArchiveStateReloader(version, reloadSessionGroups, reloadArchived, false),
      { initialProps: { version: 0 } },
    )
    rerender({ version: 1 })
    expect(reloadSessionGroups).toHaveBeenCalledTimes(1)
    expect(reloadArchived).not.toHaveBeenCalled()
  })

  it("archiveStateVersion bump with archivedOpen=true: reloads both main + archived lists", () => {
    const reloadSessionGroups = vi.fn()
    const reloadArchived = vi.fn()
    const { rerender } = renderHook(
      ({ version, archivedOpen }: { version: number; archivedOpen: boolean }) =>
        useArchiveStateReloader(version, reloadSessionGroups, reloadArchived, archivedOpen),
      { initialProps: { version: 0, archivedOpen: true } },
    )
    rerender({ version: 1, archivedOpen: true })
    expect(reloadSessionGroups).toHaveBeenCalledTimes(1)
    expect(reloadArchived).toHaveBeenCalledTimes(1)
  })

  it("archivedOpen toggled from false to true without version bump: reloads both (deps changed)", () => {
    // 用户手动打开归档抽屉时，effect 会重跑一次。确保此时 UI 能看到最新快照。
    const reloadSessionGroups = vi.fn()
    const reloadArchived = vi.fn()
    const { rerender } = renderHook(
      ({ archivedOpen }: { archivedOpen: boolean }) =>
        useArchiveStateReloader(0, reloadSessionGroups, reloadArchived, archivedOpen),
      { initialProps: { archivedOpen: false } },
    )
    rerender({ archivedOpen: true })
    expect(reloadSessionGroups).toHaveBeenCalledTimes(1)
    expect(reloadArchived).toHaveBeenCalledTimes(1)
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
