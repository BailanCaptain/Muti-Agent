/** F027 promote 后台化 · tab 层共用件单测（badge 三态 / banner 两态 / auto-refetch 消费协议）。 */
import { usePromoteJobsStore } from "@/components/stores/promote-jobs-store"
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BatchPromoteBanner,
  PromoteJobBadge,
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
