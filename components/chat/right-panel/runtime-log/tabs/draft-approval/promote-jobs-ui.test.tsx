/** F027 promote 后台化 · tab 层共用件单测（badge 三态 / banner 两态 / auto-refetch 消费协议）。 */
import { usePromoteJobsStore } from "@/components/stores/promote-jobs-store"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BatchPromoteBanner,
  PartialSupersedeBanner,
  PromoteJobBadge,
  PromoteRowButton,
  usePromoteJobsAutoRefetch,
  usePromoteOkJobsGc,
} from "./promote-jobs-ui"

beforeEach(() => {
  usePromoteJobsStore.getState().resetAll()
})

const P = "wiki/concepts/draft/_auto/a.md"

function seedJob(status: "running" | "ok" | "failed") {
  act(() => {
    usePromoteJobsStore.setState((s) => ({
      jobs: {
        ...s.jobs,
        [P]: {
          srcDraftPath: P,
          destWikiPath: "wiki/concepts/a.md",
          status,
          finalPath: status === "ok" ? "/abs/a.md" : undefined,
          error: status === "failed" ? "INTERNAL_ERROR: boom" : undefined,
        },
      },
    }))
  })
}

describe("PromoteJobBadge", () => {
  it("无任务 → 不渲染", () => {
    const { container } = render(<PromoteJobBadge path={P} />)
    expect(container.firstChild).toBeNull()
  })

  it("running → 审核中；failed → ❌ 且 title 带原因；ok → ✅", () => {
    seedJob("running")
    const { rerender } = render(<PromoteJobBadge path={P} />)
    expect(screen.getByTestId(`promote-job-badge-${P}`).textContent).toContain("审核中")
    seedJob("failed")
    rerender(<PromoteJobBadge path={P} />)
    expect(screen.getByTestId(`promote-job-badge-${P}`).getAttribute("title")).toContain("boom")
    seedJob("ok")
    rerender(<PromoteJobBadge path={P} />)
    expect(screen.getByTestId(`promote-job-badge-${P}`).textContent).toContain("已转正")
  })
})

describe("PromoteRowButton", () => {
  it("r3 F2 · partial job 禁止再次 Promote", () => {
    usePromoteJobsStore.setState({
      jobs: {
        [P]: {
          srcDraftPath: P,
          destWikiPath: "wiki/concepts/a.md",
          status: "partial",
          supersedeFailures: [{ path: "wiki/concepts/old.md", error: "EPERM" }],
        },
      },
    })
    const onPromote = vi.fn()
    render(
      <PromoteRowButton draft={{ path: P }} onPromote={onPromote} testIdPrefix="probe" />,
    )
    const button = screen.getByTestId(`probe-promote-${P}`)
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onPromote).not.toHaveBeenCalled()
  })
})

describe("BatchPromoteBanner", () => {
  it("running → 进度；done → 汇总 + 知道了 dismiss", () => {
    act(() => {
      usePromoteJobsStore.setState({
        batch: { status: "running", progress: { done: 3, total: 10 }, summary: null, error: null },
      })
    })
    const { rerender } = render(<BatchPromoteBanner />)
    expect(screen.getByTestId("batch-promote-banner").textContent).toContain("3/10")
    act(() => {
      usePromoteJobsStore.setState({
        batch: {
          status: "done",
          progress: { done: 10, total: 10 },
          summary: {
            ok: true,
            total: 10,
            success: new Array(8).fill(null),
            failed: new Array(2).fill(null),
          },
          error: null,
        },
      })
    })
    rerender(<BatchPromoteBanner />)
    expect(screen.getByTestId("batch-promote-banner").textContent).toContain("8 成功")
    fireEvent.click(screen.getByTestId("batch-promote-banner-dismiss"))
    expect(usePromoteJobsStore.getState().batch).toBeNull()
  })
})

describe("usePromoteJobsAutoRefetch", () => {
  it("settledUnconsumed=true → refetch 一次 + 消费标记", () => {
    const refetch = vi.fn()
    renderHook(() => usePromoteJobsAutoRefetch(refetch))
    expect(refetch).not.toHaveBeenCalled()
    act(() => {
      usePromoteJobsStore.setState({ settledUnconsumed: true })
    })
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(usePromoteJobsStore.getState().settledUnconsumed).toBe(false)
  })
})

describe("usePromoteOkJobsGc（德彪 r2/r3 P2 · 对账式 GC 门禁）", () => {
  function seedOk(path: string) {
    act(() => {
      usePromoteJobsStore.setState((s) => ({
        jobs: {
          ...s.jobs,
          [path]: {
            srcDraftPath: path,
            destWikiPath: "wiki/concepts/x.md",
            status: "ok",
            finalPath: "/x",
          },
        },
      }))
    })
  }

  it("enabled=false（tab 隐藏 disabled 空列表）→ 不清任何护栏", () => {
    seedOk("wiki/concepts/draft/_auto/stuck.md")
    renderHook(() => usePromoteOkJobsGc([], false))
    expect(usePromoteJobsStore.getState().jobs["wiki/concepts/draft/_auto/stuck.md"]?.status).toBe(
      "ok",
    )
  })

  it("enabled=true → 消失的清、在列的留", () => {
    seedOk("wiki/concepts/draft/_auto/gone.md")
    seedOk("wiki/concepts/draft/_auto/stuck.md")
    renderHook(() => usePromoteOkJobsGc([{ path: "wiki/concepts/draft/_auto/stuck.md" }], true))
    const jobs = usePromoteJobsStore.getState().jobs
    expect(jobs["wiki/concepts/draft/_auto/gone.md"]).toBeUndefined()
    expect(jobs["wiki/concepts/draft/_auto/stuck.md"]?.status).toBe("ok")
  })
})

describe("德彪 r2 P1-1 · partial 半态持久生命周期", () => {
  it("ok+supersedeFailures → status=partial；ok-GC 不清 partial；横幅显示且可下架/忽略", async () => {
    // 直接种 store：模拟 startPromote ok 分支产出的 partial job
    usePromoteJobsStore.setState({
      jobs: {
        "wiki/concepts/draft/_auto/v2.md": {
          srcDraftPath: "wiki/concepts/draft/_auto/v2.md",
          destWikiPath: "wiki/concepts/v2.md",
          status: "partial",
          finalPath: "/x/wiki/concepts/v2.md",
          eventId: 9,
          supersedeFailures: [{ path: "wiki/concepts/v1.md", error: "EPERM" }],
        },
      },
    })

    // GC 免疫：draft 行已消失（presentPaths 空）——partial 必须存活
    usePromoteJobsStore.getState().pruneOkJobsMissingFrom([])
    expect(usePromoteJobsStore.getState().jobs["wiki/concepts/draft/_auto/v2.md"]?.status).toBe(
      "partial",
    )

    // 横幅渲染 + 下架按钮发 demote fetch
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, rejectedPath: "wiki/_rejected/v1.md", eventId: 10 }),
      }),
    ) as unknown as typeof fetch
    globalThis.fetch = fetchMock
    render(<PartialSupersedeBanner callerAlias="黄仁勋" />)
    expect(screen.getByTestId("partial-supersede-banner")).toBeTruthy()
    fireEvent.click(screen.getByTestId("partial-supersede-demote-wiki/concepts/v1.md"))
    await waitFor(() => {
      const job = usePromoteJobsStore.getState().jobs["wiki/concepts/draft/_auto/v2.md"]
      expect(job?.status).toBe("ok") // 全部失败清零 → 转 ok（随后可被 GC）
    })
    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/api/wiki/drafts/demote")
    expect(JSON.parse(String(init.body)).srcWikiPath).toBe("wiki/concepts/v1.md")
  })

  it("下架失败 → 保留 partial + 该项 error 更新（可再试）", async () => {
    usePromoteJobsStore.setState({
      jobs: {
        "wiki/concepts/draft/_auto/v3.md": {
          srcDraftPath: "wiki/concepts/draft/_auto/v3.md",
          destWikiPath: "wiki/concepts/v3.md",
          status: "partial",
          supersedeFailures: [{ path: "wiki/concepts/old3.md", error: "EPERM" }],
        },
      },
    })
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ ok: false, code: "LEASE_HELD", error: "lease busy" }),
      }),
    ) as unknown as typeof fetch
    const okResult = await usePromoteJobsStore
      .getState()
      .resolvePartialSupersede("wiki/concepts/draft/_auto/v3.md", "wiki/concepts/old3.md", "黄仁勋")
    expect(okResult).toBe(false)
    const job = usePromoteJobsStore.getState().jobs["wiki/concepts/draft/_auto/v3.md"]
    expect(job?.status).toBe("partial")
    expect(job?.supersedeFailures?.[0]?.error).toContain("下架失败")
  })

  it("r3 F3 · 正在下架的 path 按钮 disabled，防重复提交", () => {
    usePromoteJobsStore.setState({
      jobs: {
        "wiki/concepts/draft/_auto/v4.md": {
          srcDraftPath: "wiki/concepts/draft/_auto/v4.md",
          destWikiPath: "wiki/concepts/v4.md",
          status: "partial",
          supersedeFailures: [{ path: "wiki/concepts/old4.md", error: "EPERM" }],
          pendingSupersedePaths: ["wiki/concepts/old4.md"],
        },
      },
    })
    render(<PartialSupersedeBanner callerAlias="黄仁勋" />)
    expect(screen.getByTestId("partial-supersede-demote-wiki/concepts/old4.md")).toBeDisabled()
  })
})
