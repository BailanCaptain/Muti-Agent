/**
 * F027 Phase 3 Week 4 Day 20 (AC-P3-5/4) · A2ACallDrawer 单元测试
 *
 * 覆盖:
 *   - callId=null → 不渲染
 *   - callId set → fetch + render A2ATreeView
 *   - loading / error / empty 三态
 *   - close (✕ / overlay / Escape) → store.closeDrawer 触发
 *   - source 'viewfinder' vs 'prompt-inspector' 在 footer 显示
 *   - URL 用 API_BASE_URL + /debug/a2a?root=...
 */

import { useA2ADrawerStore } from "@/components/stores/a2a-drawer-store"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { A2ACallDrawer } from "./a2a-call-drawer"

function makeTreeResponse(callId: string, calls: unknown[] = []) {
  return {
    kind: "tree",
    rootCallId: callId,
    calls: calls.length > 0
      ? calls
      : [
          {
            callId,
            parentCallId: null,
            sessionGroupId: "g-1",
            issuerId: "黄仁勋",
            convenerId: "范德彪",
            status: "pending",
            createdAt: "2026-05-23T01:00:00Z",
            deadlineAt: "2026-05-23T01:01:30Z",
          },
        ],
  }
}

function mockOkFetch(payload: unknown) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    } as Response),
  )
}

function resetStore() {
  useA2ADrawerStore.setState({ callId: null, source: null })
}

describe("A2ACallDrawer 默认", () => {
  beforeEach(() => resetStore())
  afterEach(() => {
    vi.restoreAllMocks()
    resetStore()
  })

  it("callId=null → 不渲染", () => {
    render(<A2ACallDrawer />)
    expect(screen.queryByTestId("a2a-drawer")).toBeNull()
  })
})

describe("A2ACallDrawer 渲染 + fetch", () => {
  beforeEach(() => resetStore())
  afterEach(() => {
    vi.restoreAllMocks()
    resetStore()
  })

  it("callId set → drawer 显示 + fetch + tree 渲染", async () => {
    mockOkFetch(makeTreeResponse("call-1"))
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-1", "viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer")).toBeTruthy())
    expect(screen.getByTestId("a2a-drawer").getAttribute("data-call-id")).toBe("call-1")
    expect(screen.getByTestId("a2a-drawer").getAttribute("data-source")).toBe("viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer-tree")).toBeTruthy())
  })

  it("fetch URL 用 API_BASE_URL + /debug/a2a?root=...", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makeTreeResponse("call-X")),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-X", "prompt-inspector")
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toMatch(/^http:\/\/localhost:8787\//)
    expect(url).toMatch(/\/debug\/a2a\?root=call-X$/)
  })

  it("fetch 失败 → error 显示", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: () => Promise.resolve({}),
      } as Response),
    )
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-missing", "viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer-error")).toBeTruthy())
    expect(screen.getByText(/HTTP 404/)).toBeTruthy()
  })

  it("空 calls → empty 占位", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve({ kind: "tree", rootCallId: "call-Y", calls: [] }),
      } as Response),
    )
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-Y", "viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer-empty")).toBeTruthy())
  })
})

describe("A2ACallDrawer 关闭路径", () => {
  beforeEach(() => resetStore())
  afterEach(() => {
    vi.restoreAllMocks()
    resetStore()
  })

  it("✕ close → store.closeDrawer", async () => {
    mockOkFetch(makeTreeResponse("call-1"))
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-1", "viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer")).toBeTruthy())
    fireEvent.click(screen.getByTestId("a2a-drawer-close"))
    expect(useA2ADrawerStore.getState().callId).toBeNull()
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer")).toBeNull())
  })

  it("overlay click → close", async () => {
    mockOkFetch(makeTreeResponse("call-1"))
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-1", "viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer")).toBeTruthy())
    fireEvent.click(screen.getByTestId("a2a-drawer-overlay"))
    expect(useA2ADrawerStore.getState().callId).toBeNull()
  })

  it("Escape → close", async () => {
    mockOkFetch(makeTreeResponse("call-1"))
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-1", "viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer")).toBeTruthy())
    fireEvent.keyDown(document, { key: "Escape" })
    expect(useA2ADrawerStore.getState().callId).toBeNull()
  })

  it("非 Escape key → 不 close", async () => {
    mockOkFetch(makeTreeResponse("call-1"))
    render(<A2ACallDrawer />)
    useA2ADrawerStore.getState().openDrawer("call-1", "viewfinder")
    await waitFor(() => expect(screen.queryByTestId("a2a-drawer")).toBeTruthy())
    fireEvent.keyDown(document, { key: "Enter" })
    expect(useA2ADrawerStore.getState().callId).toBe("call-1")
  })
})
