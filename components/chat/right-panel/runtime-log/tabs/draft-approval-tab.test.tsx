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
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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

describe("F027 全选三件套（小孙：一个一个点好费劲）", () => {
  beforeEach(() => {
    resetStores()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("列表 fetch 带 ?limit=200（一次拉满后端上限，否则 57 篇只显示 50）", async () => {
    mockFetchResponse(makeResponse())
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-loading")).toBeNull())
    const url = String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0] ?? "")
    expect(url).toMatch(/\/api\/wiki\/drafts\?limit=200$/)
  })

  it("表头全选框：点击 → 全部勾选 + 批量按钮显示 N；再点 → 清空", async () => {
    const drafts = [
      makeDraft({ path: "wiki/concepts/draft/_auto/a.md", title: "A" }),
      makeDraft({ path: "wiki/concepts/draft/_auto/b.md", title: "B" }),
      makeDraft({ path: "wiki/concepts/draft/_auto/c.md", title: "C" }),
    ]
    mockFetchResponse(makeResponse({ drafts, total: 3 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByText("A")).toBeTruthy())

    const selectAll = screen.getByTestId("draft-approval-select-all") as HTMLInputElement
    expect(selectAll.checked).toBe(false)

    fireEvent.click(selectAll)
    expect(screen.getByTestId("draft-approval-header").textContent).toMatch(/已选 3/)
    expect(screen.getByTestId("draft-approval-batch-button").textContent).toMatch(/3 份/)
    for (const d of drafts) {
      const cb = screen.getByTestId(`draft-approval-checkbox-${d.path}`) as HTMLInputElement
      expect(cb.checked).toBe(true)
    }

    fireEvent.click(selectAll)
    expect(screen.queryByTestId("draft-approval-batch-button")).toBeNull()
    for (const d of drafts) {
      const cb = screen.getByTestId(`draft-approval-checkbox-${d.path}`) as HTMLInputElement
      expect(cb.checked).toBe(false)
    }
  })

  it("部分选中 → 全选框 indeterminate；补点全选 → 全部勾选", async () => {
    const drafts = [
      makeDraft({ path: "wiki/concepts/draft/_auto/a.md", title: "A" }),
      makeDraft({ path: "wiki/concepts/draft/_auto/b.md", title: "B" }),
    ]
    mockFetchResponse(makeResponse({ drafts, total: 2 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByText("A")).toBeTruthy())

    fireEvent.click(screen.getByTestId("draft-approval-checkbox-wiki/concepts/draft/_auto/a.md"))
    const selectAll = screen.getByTestId("draft-approval-select-all") as HTMLInputElement
    expect(selectAll.indeterminate).toBe(true)
    expect(selectAll.checked).toBe(false)

    fireEvent.click(selectAll)
    expect(screen.getByTestId("draft-approval-header").textContent).toMatch(/已选 2/)
  })

  it("⚙ 收录设置开关：点开渲染 IngestSettingsCard，再点收起", async () => {
    mockFetchResponse(makeResponse())
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-loading")).toBeNull())

    expect(screen.queryByTestId("ingest-settings-card")).toBeNull()
    fireEvent.click(screen.getByTestId("draft-approval-settings-toggle"))
    expect(screen.getByTestId("ingest-settings-card")).toBeTruthy()
    fireEvent.click(screen.getByTestId("draft-approval-settings-toggle"))
    expect(screen.queryByTestId("ingest-settings-card")).toBeNull()
  })

  it("空列表 → 不渲染全选框", async () => {
    mockFetchResponse(makeResponse())
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-loading")).toBeNull())
    expect(screen.queryByTestId("draft-approval-select-all")).toBeNull()
  })
})

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

describe("DraftApprovalTab formatRelative 边界 (范-r1 P3 fix)", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("mtime 在 future (clock skew) → 不显示 '-Ns 前'，clamp 为 '0s 前'", async () => {
    const futureIso = new Date(Date.now() + 5000).toISOString() // 5s 未来
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ mtime: futureIso })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    const row = screen.getByTestId("draft-approval-row-concepts/draft/_auto/2026-05-22-foo.md")
    expect(row.textContent).not.toMatch(/-\d+s 前/) // 不能 -5s 前
    expect(row.textContent).toMatch(/0s 前/) // clamp 0
  })

  it("mtime 30s 前 → '30s 前'", async () => {
    const iso = new Date(Date.now() - 30_000).toISOString()
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ mtime: iso })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    const row = screen.getByTestId("draft-approval-row-concepts/draft/_auto/2026-05-22-foo.md")
    expect(row.textContent).toMatch(/3\ds 前/) // 30s 或 31s (执行漂移)
  })

  it("mtime 5m 前 → 'Nm 前' (60s 边界 → 分钟)", async () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString()
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ mtime: iso })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    const row = screen.getByTestId("draft-approval-row-concepts/draft/_auto/2026-05-22-foo.md")
    expect(row.textContent).toMatch(/5m 前/)
  })

  it("mtime 3h 前 → 'Nh 前' (3600s 边界 → 小时)", async () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString()
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ mtime: iso })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    const row = screen.getByTestId("draft-approval-row-concepts/draft/_auto/2026-05-22-foo.md")
    expect(row.textContent).toMatch(/3h 前/)
  })

  it("mtime 7d 前 → 'Nd 前' (86400s 边界 → 天)", async () => {
    const iso = new Date(Date.now() - 7 * 86400_000).toISOString()
    mockFetchResponse(makeResponse({ drafts: [makeDraft({ mtime: iso })], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    const row = screen.getByTestId("draft-approval-row-concepts/draft/_auto/2026-05-22-foo.md")
    expect(row.textContent).toMatch(/7d 前/)
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
    // F027 全选三件套：路径不变 + 显式 limit=200（一次拉满）
    expect(url).toMatch(/\/api\/wiki\/drafts\?limit=200$/)
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

describe("DraftApprovalTab AC-P4-3 [Promote] 按钮 (Day 9)", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("(P4-D9-1) draft row 渲染 [Promote] 按钮", async () => {
    mockFetchResponse(makeResponse({ drafts: [makeDraft()], total: 1 }))
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    const btn = screen.getByTestId("draft-approval-promote-concepts/draft/_auto/2026-05-22-foo.md")
    expect(btn).toBeTruthy()
    expect(btn.textContent).toMatch(/Promote/)
  })

  it("(P4-D9-2) 点 [Promote] → PromoteModal 弹出并显示 src draft path", async () => {
    // First fetch: drafts list. Second fetch (preview): audit pass (mock all fetch calls).
    const fetchCalls: string[] = []
    globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push(url)
      if (url.includes("/api/wiki/drafts/promote/preview")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, audit: { passed: true } }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeResponse({ drafts: [makeDraft()], total: 1 })),
      } as Response)
    }) as unknown as typeof fetch

    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())

    // No modal initially
    expect(screen.queryByRole("dialog")).toBeNull()

    // Click [Promote]
    fireEvent.click(
      screen.getByTestId("draft-approval-promote-concepts/draft/_auto/2026-05-22-foo.md"),
    )

    // Modal opens with src draft path
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())
    expect(screen.getByText("concepts/draft/_auto/2026-05-22-foo.md")).toBeTruthy()
    // V14 preview triggered
    await waitFor(() =>
      expect(fetchCalls.some((u) => u.includes("/api/wiki/drafts/promote/preview"))).toBe(true),
    )
  })

  it("(P4-D9-3) PromoteModal 取消按钮 → modal 关闭", async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/wiki/drafts/promote/preview")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, audit: { passed: true } }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeResponse({ drafts: [makeDraft()], total: 1 })),
      } as Response)
    }) as unknown as typeof fetch

    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    fireEvent.click(
      screen.getByTestId("draft-approval-promote-concepts/draft/_auto/2026-05-22-foo.md"),
    )
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})

describe("DraftApprovalTab AC-P4-4 multi-select 批量审批 (Day 12)", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("(P4-D12-1) 每 row 渲染 checkbox; 0 selected → 无 [批量审批] 按钮", async () => {
    mockFetchResponse(
      makeResponse({
        drafts: [
          makeDraft({ path: "p1.md", title: "P1" }),
          makeDraft({ path: "p2.md", title: "P2" }),
        ],
        total: 2,
      }),
    )
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())
    expect(screen.getByTestId("draft-approval-checkbox-p1.md")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-checkbox-p2.md")).toBeTruthy()
    expect(screen.queryByTestId("draft-approval-batch-button")).toBeNull()
    expect(screen.getByTestId("draft-approval-header").textContent).toMatch(
      /勾选或点左侧全选后可批量审批/,
    )
  })

  it("(P4-D12-2) 勾 2 份 → header 显示 '已选 2' + [批量审批 2 份] 按钮启用", async () => {
    mockFetchResponse(
      makeResponse({
        drafts: [
          makeDraft({ path: "p1.md", title: "P1" }),
          makeDraft({ path: "p2.md", title: "P2" }),
          makeDraft({ path: "p3.md", title: "P3" }),
        ],
        total: 3,
      }),
    )
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())

    fireEvent.click(screen.getByTestId("draft-approval-checkbox-p1.md"))
    fireEvent.click(screen.getByTestId("draft-approval-checkbox-p2.md"))

    expect(screen.getByTestId("draft-approval-header").textContent).toMatch(/已选 2/)
    const btn = screen.getByTestId("draft-approval-batch-button")
    expect(btn.textContent).toMatch(/批量审批 2 份/)
  })

  it("(P4-D12-4) codex mid-r1 P1: submit 成功后 modal 仍开 + 显示 report (不被 selectedPaths 清触发重置)", async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/wiki/drafts/batch-promote")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              total: 2,
              success: [
                {
                  srcDraftPath: "wiki/concepts/draft/_auto/p1.md",
                  destWikiPath: "wiki/concepts/p1.md",
                  finalPath: "/tmp/wiki/concepts/p1.md",
                  eventId: 1,
                },
                {
                  srcDraftPath: "wiki/concepts/draft/_auto/p2.md",
                  destWikiPath: "wiki/concepts/p2.md",
                  finalPath: "/tmp/wiki/concepts/p2.md",
                  eventId: 2,
                },
              ],
              failed: [],
            }),
        } as Response)
      }
      // drafts list endpoint
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            makeResponse({
              drafts: [
                makeDraft({ path: "wiki/concepts/draft/_auto/p1.md", title: "P1" }),
                makeDraft({ path: "wiki/concepts/draft/_auto/p2.md", title: "P2" }),
              ],
              total: 2,
            }),
          ),
      } as Response)
    }) as unknown as typeof fetch

    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())

    fireEvent.click(screen.getByTestId("draft-approval-checkbox-wiki/concepts/draft/_auto/p1.md"))
    fireEvent.click(screen.getByTestId("draft-approval-checkbox-wiki/concepts/draft/_auto/p2.md"))
    fireEvent.click(screen.getByTestId("draft-approval-batch-button"))
    await waitFor(() => screen.getByText(/批量审批 2 份 draft → wiki/))

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "首批" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))

    // 关键: submit 成功后 report view 应仍可见，不被立即关闭/重置
    await waitFor(() => expect(screen.getByTestId("batch-promote-report")).toBeTruthy())
    expect(screen.getByText("✅ Success: 2 份")).toBeTruthy()
    // 关闭按钮仍可点
    expect(screen.getByTestId("batch-promote-close")).toBeTruthy()
  })

  it("(P4-D12-3) 点 [批量审批] → BatchPromoteModal 弹出含 2 行 src", async () => {
    mockFetchResponse(
      makeResponse({
        drafts: [
          makeDraft({ path: "wiki/concepts/draft/_auto/p1.md", title: "P1" }),
          makeDraft({ path: "wiki/concepts/draft/_auto/p2.md", title: "P2" }),
        ],
        total: 2,
      }),
    )
    render(<DraftApprovalTab />)
    await waitFor(() => expect(screen.queryByTestId("draft-approval-list")).toBeTruthy())

    fireEvent.click(screen.getByTestId("draft-approval-checkbox-wiki/concepts/draft/_auto/p1.md"))
    fireEvent.click(screen.getByTestId("draft-approval-checkbox-wiki/concepts/draft/_auto/p2.md"))
    fireEvent.click(screen.getByTestId("draft-approval-batch-button"))

    // BatchPromoteModal opens, displays 2 rows with P1/P2 title
    await waitFor(() => expect(screen.getByText(/批量审批 2 份 draft → wiki/)).toBeTruthy())
    expect(screen.getByTestId("batch-promote-row-wiki/concepts/draft/_auto/p1.md")).toBeTruthy()
    expect(screen.getByTestId("batch-promote-row-wiki/concepts/draft/_auto/p2.md")).toBeTruthy()
    // dest input 默认 suggestDestWikiPath
    const dest1 = screen.getByLabelText(
      "dest path for wiki/concepts/draft/_auto/p1.md",
    ) as HTMLInputElement
    expect(dest1.value).toBe("wiki/concepts/p1.md")
  })
})
