/**
 * F027 Phase 3 Week 4 Day 18-19 (AC-P3-2 子需求) · use-drafts-data 单元测试
 *
 * 覆盖（同 use-viewfinder-data.test 简化版 + hook 行为）：
 *   - fetch URL = ${API_BASE_URL}/api/wiki/drafts (Day 14-15 r1 P1 同款防御)
 *   - enabled=false → 不 fetch (空数据)
 *   - enabled=true → fetch + 写入 data
 *   - fetch 失败 → error + fail-soft empty
 *   - refetch → 触发新 fetch
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type ListDraftsResponse, useDraftsData } from "./use-drafts-data"

function makeResponse(overrides: Partial<ListDraftsResponse> = {}): ListDraftsResponse {
  return {
    drafts: [],
    total: 0,
    limit: 50,
    offset: 0,
    ...overrides,
  }
}

function mockOkFetch(payload: ListDraftsResponse) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    } as Response),
  )
  globalThis.fetch = fetchMock
  return fetchMock
}

describe("useDraftsData", () => {
  beforeEach(() => {
    mockOkFetch(makeResponse())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("enabled=false → 不触发 fetch", async () => {
    const fetchMock = mockOkFetch(makeResponse())
    renderHook(() => useDraftsData({ enabled: false }))
    await new Promise((r) => setTimeout(r, 30))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("enabled=true (默认) → fetch + 拿到 drafts", async () => {
    const payload = makeResponse({
      drafts: [
        {
          path: "concepts/draft/_auto/2026-05-22-foo.md",
          type: "concept",
          title: "Foo",
          mtime: "2026-05-22T17:00:00Z",
          summary: "foo summary",
          origin: "auto",
        },
      ],
      total: 1,
    })
    mockOkFetch(payload)
    const { result } = renderHook(() => useDraftsData())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data.drafts).toHaveLength(1)
    expect(result.current.data.drafts[0]?.title).toBe("Foo")
    expect(result.current.error).toBeNull()
  })

  it("fetch URL 用 API_BASE_URL (http://localhost:8787) + /api/wiki/drafts", async () => {
    const fetchMock = mockOkFetch(makeResponse())
    renderHook(() => useDraftsData())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toMatch(/^http:\/\/localhost:8787\//)
    expect(url).toMatch(/\/api\/wiki\/drafts$/)
  })

  it("fetch 失败 → error 显示 + fail-soft empty", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({}),
      } as Response),
    )
    const { result } = renderHook(() => useDraftsData())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toMatch(/HTTP 500/)
    expect(result.current.data.drafts).toHaveLength(0)
    expect(result.current.data.total).toBe(0)
  })

  it("refetch() → 触发新 fetch", async () => {
    const fetchMock = mockOkFetch(makeResponse())
    const { result } = renderHook(() => useDraftsData())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      result.current.refetch()
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})
