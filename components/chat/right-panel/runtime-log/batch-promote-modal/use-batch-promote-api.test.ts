/**
 * F027 全选三件套 · useBatchPromote 分批提交单测
 *
 * 背景：后端 batch-promote 单次上限 50 items（>50 → 400）。全选 57+ 篇后单次提交必撞墙。
 * 契约：
 *   - items ≤ 50 → 单次 POST（既有行为不变）
 *   - items > 50 → 按 50 切片顺序 POST，合并 summary（total=Σ，success/failed concat）
 *   - 中途整体失败（网络/4xx/5xx）→ 已完成分片的结果保留进 data（promote 是已发生事实），error 同时置位
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BatchPromoteItem, BatchPromoteSummary } from "./use-batch-promote-api"
import { useBatchPromote } from "./use-batch-promote-api"

function makeItems(n: number): BatchPromoteItem[] {
  return Array.from({ length: n }, (_, i) => ({
    srcDraftPath: `wiki/concepts/draft/_auto/d${i}.md`,
    destWikiPath: `wiki/concepts/d${i}.md`,
  }))
}

function okSummaryFor(items: BatchPromoteItem[]): BatchPromoteSummary {
  return {
    ok: true,
    total: items.length,
    success: items.map((it, i) => ({
      srcDraftPath: it.srcDraftPath,
      destWikiPath: it.destWikiPath,
      finalPath: it.destWikiPath,
      eventId: i,
    })),
    failed: [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useBatchPromote 分批提交", () => {
  it("≤50 items → 单次 POST（既有行为）", async () => {
    const bodies: { items: BatchPromoteItem[] }[] = []
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { items: BatchPromoteItem[] }
      bodies.push(body)
      return {
        ok: true,
        status: 200,
        json: async () => okSummaryFor(body.items),
      } as Response
    }) as typeof fetch

    const { result } = renderHook(() => useBatchPromote())
    await act(async () => {
      await result.current.submit({
        items: makeItems(50),
        callerAlias: "小孙",
        reason: "整理",
      })
    })

    expect(bodies.length).toBe(1)
    expect(bodies[0].items.length).toBe(50)
    await waitFor(() => expect(result.current.data?.total).toBe(50))
    expect(result.current.error).toBeNull()
  })

  it("补丁#3 · 分批进度：progress 起始 {0,total}，每片累加，终值 = total（小孙进度条）", async () => {
    const releases: ((s: BatchPromoteSummary) => void)[] = []
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { items: BatchPromoteItem[] }
      return new Promise<Response>((resolve) => {
        releases.push((summary) => resolve({ ok: true, status: 200, json: async () => summary } as Response))
        // 记录该片大小供 release 用
        ;(releases as unknown as { sizes: number[] }).sizes ??= []
        ;(releases as unknown as { sizes: number[] }).sizes.push(body.items.length)
      })
    }) as typeof fetch

    const { result } = renderHook(() => useBatchPromote())
    let submitDone!: Promise<void>
    act(() => {
      submitDone = result.current.submit({
        items: makeItems(120),
        callerAlias: "小孙",
        reason: "整理",
      })
    })

    // 第 1 片在飞 → progress 起始 {done:0, total:120}
    await waitFor(() => expect(releases.length).toBe(1))
    expect(result.current.progress).toEqual({ done: 0, total: 120 })

    await act(async () => {
      releases[0](okSummaryFor(makeItems(50)))
    })
    await waitFor(() => expect(result.current.progress?.done).toBe(50))

    await waitFor(() => expect(releases.length).toBe(2))
    await act(async () => {
      releases[1](okSummaryFor(makeItems(50)))
    })
    await waitFor(() => expect(result.current.progress?.done).toBe(100))

    await waitFor(() => expect(releases.length).toBe(3))
    await act(async () => {
      releases[2](okSummaryFor(makeItems(20)))
      await submitDone
    })
    expect(result.current.progress).toEqual({ done: 120, total: 120 })
  })

  it(">50 items → 按 50 切片顺序提交并合并 summary（120 → 50/50/20）", async () => {
    const bodies: { items: BatchPromoteItem[] }[] = []
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { items: BatchPromoteItem[] }
      bodies.push(body)
      return {
        ok: true,
        status: 200,
        json: async () => okSummaryFor(body.items),
      } as Response
    }) as typeof fetch

    const { result } = renderHook(() => useBatchPromote())
    await act(async () => {
      await result.current.submit({
        items: makeItems(120),
        callerAlias: "小孙",
        reason: "全选整理",
      })
    })

    expect(bodies.map((b) => b.items.length)).toEqual([50, 50, 20])
    await waitFor(() => expect(result.current.data?.total).toBe(120))
    expect(result.current.data?.success.length).toBe(120)
    expect(result.current.data?.failed.length).toBe(0)
    expect(result.current.error).toBeNull()
    // 顺序提交：第二片首 item 是全局第 50 个
    expect(bodies[1].items[0].srcDraftPath).toBe("wiki/concepts/draft/_auto/d50.md")
  })

  it("第二片整体失败 → 已完成第一片结果保留 + error 置位（promote 是已发生事实）", async () => {
    let call = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      const body = JSON.parse(String(init?.body)) as { items: BatchPromoteItem[] }
      if (call === 2) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ ok: false, code: "INTERNAL_ERROR", error: "boom" }),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => okSummaryFor(body.items),
      } as Response
    }) as typeof fetch

    const { result } = renderHook(() => useBatchPromote())
    await act(async () => {
      await result.current.submit({
        items: makeItems(70),
        callerAlias: "小孙",
        reason: "整理",
      })
    })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    // 第一片 50 条已成功 promote —— 结果必须如实保留展示
    expect(result.current.data?.success.length).toBe(50)
    expect(result.current.data?.total).toBe(50)
  })

  it("部分失败（HTTP 200 含 failed）跨片合并", async () => {
    let call = 0
    globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      call += 1
      const body = JSON.parse(String(init?.body)) as { items: BatchPromoteItem[] }
      const summary = okSummaryFor(body.items)
      if (call === 1) {
        // 第一片里 1 条 audit_rejected
        const [first, ...rest] = summary.success
        summary.success = rest
        summary.failed = [
          {
            srcDraftPath: first.srcDraftPath,
            destWikiPath: first.destWikiPath,
            status: "audit_rejected",
            error: "V14 reject",
          },
        ]
      }
      return { ok: true, status: 200, json: async () => summary } as Response
    }) as typeof fetch

    const { result } = renderHook(() => useBatchPromote())
    await act(async () => {
      await result.current.submit({
        items: makeItems(60),
        callerAlias: "小孙",
        reason: "整理",
      })
    })

    await waitFor(() => expect(result.current.data?.total).toBe(60))
    expect(result.current.data?.success.length).toBe(59)
    expect(result.current.data?.failed.length).toBe(1)
    expect(result.current.error).toBeNull()
  })
})
