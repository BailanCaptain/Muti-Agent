/**
 * F027 Phase 3 Week 4 Day 16-17 (AC-P3-4) · ViewfinderTab 单元测试
 *
 * 覆盖:
 *   - 渲染 header + body
 *   - empty / loading / error 状态
 *   - viewfinder=null → "尚未编译" 占位
 *   - markdown 渲染 (H1/H2/p/li)
 *   - a2a 引用 → AtPillRef 渲染 (callId/status/color)
 *   - coverage status color (pass/warn/fail)
 *   - API_BASE_URL fetch (Day 14-15 r1 P1 同款防御)
 *   - enabled flag wire activeLvl2 === "viewfinder"
 */

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ViewfinderTab } from "./viewfinder-tab"
import type { GetViewfinderResponse } from "./viewfinder/use-viewfinder-data"

function makeResponse(overrides: Partial<GetViewfinderResponse> = {}): GetViewfinderResponse {
  return {
    viewfinder: null,
    coverage: { broad: 0, resolved: 0, unresolved: 0, coverage: null, status: "pass" },
    lastCompiledAt: null,
    ledger: { activeCount: 0, latestDecisionId: null },
    ...overrides,
  }
}

function mockFetchResponse(payload: GetViewfinderResponse) {
  globalThis.fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    } as Response),
  )
}

function resetStores() {
  useRuntimeLogStore.setState({
    activeLvl1: "system-prompt",
    activeLvl2: "viewfinder", // 让 enabled=true 触发 fetch
    collapsed: false,
  })
  useThreadStore.setState({
    // biome-ignore lint/suspicious/noExplicitAny: stub
    activeGroup: { roomId: "R-201" } as any,
  })
}

describe("ViewfinderTab 基础渲染", () => {
  beforeEach(() => {
    resetStores()
    mockFetchResponse(makeResponse())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("渲染 header + empty body (viewfinder=null)", async () => {
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByTestId("viewfinder-loading")).toBeNull())
    expect(screen.getByTestId("viewfinder-tab")).toBeTruthy()
    expect(screen.getByTestId("viewfinder-header")).toBeTruthy()
    expect(screen.getByTestId("viewfinder-empty")).toBeTruthy()
    expect(screen.getByText(/尚未编译/)).toBeTruthy()
  })

  it("header 显示 roomId + coverage + ledger", async () => {
    mockFetchResponse(
      makeResponse({
        coverage: { broad: 10, resolved: 9, unresolved: 1, coverage: 0.9, status: "pass" },
        lastCompiledAt: "2026-05-22T17:00:00Z",
        ledger: { activeCount: 23, latestDecisionId: "22" },
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByTestId("viewfinder-loading")).toBeNull())
    const header = screen.getByTestId("viewfinder-header")
    expect(header.textContent).toMatch(/R-201/)
    expect(header.textContent).toMatch(/coverage 90%/)
    expect(header.textContent).toMatch(/ledger 23 active/)
    expect(header.textContent).toMatch(/D-22/)
  })

  it("coverage status warn → 黄色", async () => {
    mockFetchResponse(
      makeResponse({
        coverage: { broad: 10, resolved: 5, unresolved: 5, coverage: 0.5, status: "warn" },
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByText("warn")).toBeTruthy())
    expect(screen.getByText("warn").className).toMatch(/text-amber/)
  })

  it("coverage status fail → 红色", async () => {
    mockFetchResponse(
      makeResponse({
        coverage: { broad: 10, resolved: 1, unresolved: 9, coverage: 0.1, status: "fail" },
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByText("fail")).toBeTruthy())
    expect(screen.getByText("fail").className).toMatch(/text-red/)
  })
})

describe("ViewfinderTab markdown 渲染", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("渲染 H1 + H2 + paragraph", async () => {
    mockFetchResponse(
      makeResponse({
        viewfinder:
          "# R-201 Viewfinder\n\n## 1. 当前主题\n\nV14 plan 推到可立项状态\n\n## 2. 当前进度\n\nP14 验证矩阵 50% 完成",
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByText("R-201 Viewfinder")).toBeTruthy())
    expect(screen.getByText("1. 当前主题")).toBeTruthy()
    expect(screen.getByText("2. 当前进度")).toBeTruthy()
    expect(screen.getByText(/V14 plan 推到可立项状态/)).toBeTruthy()
  })

  it("a2a 引用 → AtPillRef 渲染含 callId + status", async () => {
    mockFetchResponse(
      makeResponse({
        viewfinder:
          "## 4. 等谁 / blocker\n\n等 范德彪 [a2a_call=call-abc12345, status=pending, deadline 17:30]",
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByText("4. 等谁 / blocker")).toBeTruthy())
    const pill = screen.getByTestId("viewfinder-a2a-ref-call-abc12345")
    expect(pill).toBeTruthy()
    expect(pill.getAttribute("data-call-id")).toBe("call-abc12345")
    expect(pill.getAttribute("data-status")).toBe("pending")
    expect(pill.textContent).toMatch(/call-abc12345·pending/)
    // tooltip 含完整信息
    expect(pill.getAttribute("title")).toMatch(/call=call-abc12345/)
    expect(pill.getAttribute("title")).toMatch(/status=pending/)
    expect(pill.getAttribute("title")).toMatch(/deadline 17:30/)
  })

  it("a2a 引用 status=failed → 红色 pill class", async () => {
    mockFetchResponse(
      makeResponse({
        viewfinder: "[a2a_call=call-fail, status=failed]",
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByTestId("viewfinder-a2a-ref-call-fail")).toBeTruthy())
    const pill = screen.getByTestId("viewfinder-a2a-ref-call-fail")
    expect(pill.className).toMatch(/bg-red/)
  })

  it("a2a 引用 status=done → 绿色 pill class", async () => {
    mockFetchResponse(
      makeResponse({
        viewfinder: "[a2a_call=call-done, status=done]",
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByTestId("viewfinder-a2a-ref-call-done")).toBeTruthy())
    expect(screen.getByTestId("viewfinder-a2a-ref-call-done").className).toMatch(/bg-green/)
  })

  it("无 a2a 引用的 paragraph 正常渲染纯文本", async () => {
    mockFetchResponse(
      makeResponse({
        viewfinder: "## 1. 当前主题\n\n纯文本主题，没有 a2a_call 引用",
      }),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByText(/纯文本主题/)).toBeTruthy())
  })
})

describe("ViewfinderTab loading / error", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("fetch 失败 → error 显示", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({}),
      } as Response),
    )
    render(<ViewfinderTab />)
    await waitFor(() => expect(screen.queryByTestId("viewfinder-error")).toBeTruthy())
    expect(screen.getByText(/加载失败/)).toBeTruthy()
  })
})

describe("ViewfinderTab API base + enabled wire", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("fetch URL 用 API_BASE_URL (http://localhost:8787)", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makeResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<ViewfinderTab />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toMatch(/^http:\/\/localhost:8787\//)
    expect(url).toMatch(/\/api\/rooms\/R-201\/viewfinder$/)
  })

  // r1 P3 修：加 enabled wire 负 case (mirror Day 14-15 P2 测试)
  // 确认 activeLvl2 != "viewfinder" 时 fetch 不触发

  it("activeLvl2 != viewfinder → fetch 不触发 (enabled=false)", async () => {
    useRuntimeLogStore.setState({ activeLvl2: "prompt-inspector" }) // 不是 viewfinder
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve(makeResponse()),
        } as Response),
    )
    globalThis.fetch = fetchMock
    render(<ViewfinderTab />)
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
