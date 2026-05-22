/**
 * F027 Phase 3 Week 4 Day 18-19 (AC-P3-2 子需求) · DraftApprovalTab 单元测试
 *
 * 覆盖:
 *   - empty / loading / error 三态
 *   - drafts 渲染 (title / type badge / origin badge / mtime / summary)
 *   - API_BASE_URL fetch (Day 14-15 r1 P1 同款防御)
 *   - enabled wire activeLvl2 === "draft-approval" (Day 14-15 r2 P2 同款)
 *   - type/origin 颜色 class
 *   - truncate summary 100 字
 */

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DraftApprovalTab } from "./draft-approval-tab"
import type { DraftSummary, ListDraftsResponse } from "./draft-approval/use-drafts-data"

function makeResponse(overrides: Partial<ListDraftsResponse> = {}): ListDraftsResponse {
  return {
    drafts: [],
    total: 0,
    limit: 50,
    offset: 0,
    ...overrides,
  }
}

function makeDraft(overrides: Partial<DraftSummary> = {}): DraftSummary {
  return {
    path: "concepts/draft/_auto/2026-05-22-foo.md",
    type: "concept",
    title: "Foo",
    mtime: "2026-05-22T17:00:00Z",
    summary: "foo summary",
    origin: "auto",
    ...overrides,
  }
}

function mockFetchResponse(payload: ListDraftsResponse) {
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
    activeLvl2: "draft-approval", // 让 enabled=true 触发 fetch
    collapsed: false,
  })
}

describe("DraftApprovalTab 基础渲染", () => {
  beforeEach(() => {
    resetStores()
    mockFetchResponse(makeResponse())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("空 drafts → empty 占位 + total=0", async () => {
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-loading")).toBeNull())
    expect(screen.getByTestId("draft-approval-tab")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-empty")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-header").textContent).toMatch(/0 draft/)
  })

  it("1 draft → list 渲染 row + title / type badge / origin badge / summary", async () => {
    mockFetchResponse(
      makeResponse({
        drafts: [
          makeDraft({
            title: "F999 test feature",
            type: "feature",
            origin: "user-drop",
            path: "concepts/draft/2026-05-22-F999.md",
            summary: "this is a test feature draft summary",
          }),
        ],
        total: 1,
      }),
    )
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByText("F999 test feature")).toBeTruthy())
    expect(screen.getByTestId("draft-approval-list")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-row-concepts/draft/2026-05-22-F999.md")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-badge-type-feature")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-badge-origin-user-drop")).toBeTruthy()
    expect(screen.getByText(/this is a test feature draft summary/)).toBeTruthy()
    expect(screen.getByTestId("draft-approval-header").textContent).toMatch(/1 draft/)
  })

  it("多 draft → 全部 row 渲染", async () => {
    mockFetchResponse(
      makeResponse({
        drafts: [
          makeDraft({ path: "p1.md", title: "P1" }),
          makeDraft({ path: "p2.md", title: "P2", type: "bug", origin: "user-drop" }),
          makeDraft({ path: "p3.md", title: "P3", type: "lesson", origin: "expired" }),
        ],
        total: 3,
      }),
    )
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByText("P1")).toBeTruthy())
    expect(screen.getByText("P2")).toBeTruthy()
    expect(screen.getByText("P3")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-badge-type-bug")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-badge-type-lesson")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-badge-origin-expired")).toBeTruthy()
  })

  it("type=bug badge → 红色 class", async () => {
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ type: "bug" })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-badge-type-bug")).toBeTruthy())
    const badge = screen.getByTestId("draft-approval-badge-type-bug")
    expect(badge.className).toMatch(/text-red/)
  })

  it("origin=expired badge → 橙色 class", async () => {
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ origin: "expired" })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() =>
      expect(screen.queryByTestId("draft-approval-badge-origin-expired")).toBeTruthy(),
    )
    const badge = screen.getByTestId("draft-approval-badge-origin-expired")
    expect(badge.className).toMatch(/text-orange/)
  })

  it("summary 超 100 字 → truncate + 省略号", async () => {
    const long = "a".repeat(150)
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ summary: long })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    const row = screen.getByTestId("draft-approval-row-concepts/draft/_auto/2026-05-22-foo.md")
    expect(row.textContent).toMatch(/…/)
    // 截断后总文本不会含完整 150 个 a (mtime/title/summary 共占)
    // 只要 summary div 不超 101 字（100 + …）
  })
})

describe("DraftApprovalTab error 态", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("fetch 500 → error 显示", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({}),
      } as Response),
    )
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-error")).toBeTruthy())
  })
})

describe("DraftApprovalTab API base + enabled wire", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("fetch URL 用 API_BASE_URL (http://localhost:8787/api/wiki/drafts)", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makeResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<DraftApprovalTab />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toMatch(/^http:\/\/localhost:8787\//)
    expect(url).toMatch(/\/api\/wiki\/drafts$/)
  })

  it("activeLvl2 != draft-approval → fetch 不触发 (Day 14-15 r2 P2 同款)", async () => {
    useRuntimeLogStore.setState({ activeLvl2: "prompt-inspector" })
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makeResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<DraftApprovalTab />)
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
