/** F027 promote 后台化 · promote-jobs-store 单测（fetch 全 mock，store 生命周期独立于组件）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePromoteJobsStore } from "./promote-jobs-store"

function mockFetchOnce(status: number, json: unknown) {
  ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(json),
  } as unknown as Response)
}

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch
  usePromoteJobsStore.getState().resetAll()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const BODY = {
  srcDraftPath: "wiki/concepts/draft/_auto/a.md",
  destWikiPath: "wiki/concepts/a.md",
  callerAlias: "小孙",
  reason: "test",
}

describe("promote-jobs-store · startPromote", () => {
  it("成功 → job ok + finalPath + settledUnconsumed", async () => {
    mockFetchOnce(200, { ok: true, finalPath: "/abs/wiki/concepts/a.md", eventId: 1 })
    await usePromoteJobsStore.getState().startPromote(BODY)
    const s = usePromoteJobsStore.getState()
    expect(s.jobs[BODY.srcDraftPath]?.status).toBe("ok")
    expect(s.jobs[BODY.srcDraftPath]?.finalPath).toBe("/abs/wiki/concepts/a.md")
    expect(s.settledUnconsumed).toBe(true)
  })

  it("422 审计拒绝 → job failed + rejectReason，不置 settledUnconsumed", async () => {
    mockFetchOnce(422, {
      ok: false,
      code: "AUDIT_REJECTED",
      audit: { layer: "prompt_structure", matchedPatterns: ["system: 行"], hint: "改写" },
    })
    await usePromoteJobsStore.getState().startPromote(BODY)
    const s = usePromoteJobsStore.getState()
    expect(s.jobs[BODY.srcDraftPath]?.status).toBe("failed")
    expect(s.jobs[BODY.srcDraftPath]?.rejectReason?.layer).toBe("prompt_structure")
    expect(s.settledUnconsumed).toBe(false)
  })

  it("网络异常 → job failed + error 文案", async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"))
    await usePromoteJobsStore.getState().startPromote(BODY)
    expect(usePromoteJobsStore.getState().jobs[BODY.srcDraftPath]?.error).toContain("boom")
  })

  it("同 src running 时重复 startPromote → no-op（不发第二个请求）", async () => {
    let resolveFirst: (v: unknown) => void = () => {}
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r
      }),
    )
    const first = usePromoteJobsStore.getState().startPromote(BODY)
    await usePromoteJobsStore.getState().startPromote(BODY)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    resolveFirst({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, finalPath: "x", eventId: 1 }),
    })
    await first
  })
})

describe("promote-jobs-store · startBatch", () => {
  it("单分片成功 → batch done + 每项落 jobs（success→ok / failed→failed）+ settledUnconsumed", async () => {
    mockFetchOnce(200, {
      ok: true,
      total: 2,
      success: [
        {
          srcDraftPath: "wiki/concepts/draft/_auto/x.md",
          destWikiPath: "wiki/concepts/x.md",
          finalPath: "/abs/x.md",
          eventId: 2,
        },
      ],
      failed: [
        {
          srcDraftPath: "wiki/concepts/draft/_auto/y.md",
          destWikiPath: "wiki/concepts/y.md",
          status: "audit_rejected",
          error: "rejected",
          auditReject: { layer: "prompt_structure", matchedPatterns: ["p"], hint: "h" },
        },
      ],
    })
    await usePromoteJobsStore.getState().startBatch({
      items: [
        { srcDraftPath: "wiki/concepts/draft/_auto/x.md", destWikiPath: "wiki/concepts/x.md" },
        { srcDraftPath: "wiki/concepts/draft/_auto/y.md", destWikiPath: "wiki/concepts/y.md" },
      ],
      callerAlias: "小孙",
      reason: "batch",
    })
    const s = usePromoteJobsStore.getState()
    expect(s.batch?.status).toBe("done")
    expect(s.batch?.summary?.success.length).toBe(1)
    expect(s.jobs["wiki/concepts/draft/_auto/x.md"]?.status).toBe("ok")
    expect(s.jobs["wiki/concepts/draft/_auto/y.md"]?.status).toBe("failed")
    expect(s.jobs["wiki/concepts/draft/_auto/y.md"]?.rejectReason?.layer).toBe("prompt_structure")
    expect(s.settledUnconsumed).toBe(true)
  })

  it("分片整体失败 → 未提交项退回 failed（不留 running 假象）+ batch.error 置位", async () => {
    mockFetchOnce(500, { ok: false, code: "INTERNAL_ERROR", error: "boom" })
    await usePromoteJobsStore.getState().startBatch({
      items: [
        { srcDraftPath: "wiki/concepts/draft/_auto/z.md", destWikiPath: "wiki/concepts/z.md" },
      ],
      callerAlias: "小孙",
      reason: "batch",
    })
    const s = usePromoteJobsStore.getState()
    expect(s.batch?.status).toBe("done")
    expect(s.batch?.error).toContain("INTERNAL_ERROR")
    expect(s.jobs["wiki/concepts/draft/_auto/z.md"]?.status).toBe("failed")
    expect(s.jobs["wiki/concepts/draft/_auto/z.md"]?.error).toContain("未提交")
  })

  it(">50 items 按 50 切片顺序提交 + 进度累加", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      srcDraftPath: `wiki/concepts/draft/_auto/n${i}.md`,
      destWikiPath: `wiki/concepts/n${i}.md`,
    }))
    mockFetchOnce(200, { ok: true, total: 50, success: [], failed: [] })
    mockFetchOnce(200, { ok: true, total: 10, success: [], failed: [] })
    await usePromoteJobsStore.getState().startBatch({ items, callerAlias: "小孙", reason: "b" })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(usePromoteJobsStore.getState().batch?.progress).toEqual({ done: 60, total: 60 })
  })
})

describe("promote-jobs-store · 消费/清理", () => {
  it("markSettledConsumed 清标记；clearJob 删单项；dismissBatch 清横幅", async () => {
    mockFetchOnce(200, { ok: true, finalPath: "/abs/a.md", eventId: 1 })
    await usePromoteJobsStore.getState().startPromote(BODY)
    usePromoteJobsStore.getState().markSettledConsumed()
    expect(usePromoteJobsStore.getState().settledUnconsumed).toBe(false)
    usePromoteJobsStore.getState().clearJob(BODY.srcDraftPath)
    expect(usePromoteJobsStore.getState().jobs[BODY.srcDraftPath]).toBeUndefined()
    usePromoteJobsStore.getState().dismissBatch()
    expect(usePromoteJobsStore.getState().batch).toBeNull()
  })
})

// ─── 德彪 r1 · P1/P2 修复回归 ───

describe("promote-jobs-store · 德彪 r1 修复", () => {
  it("P1 · startBatch 过滤同 src running/ok 项（不重复 promote）", async () => {
    // 先造一个 running（单篇在跑）和一个 ok（已转正待消行）
    let resolveFirst: (v: unknown) => void = () => {}
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((r) => {
        resolveFirst = r
      }),
    )
    const running = usePromoteJobsStore.getState().startPromote({
      srcDraftPath: "wiki/concepts/draft/_auto/r.md",
      destWikiPath: "wiki/concepts/r.md",
      callerAlias: "小孙",
      reason: "x",
    })
    usePromoteJobsStore.setState((s) => ({
      jobs: {
        ...s.jobs,
        "wiki/concepts/draft/_auto/o.md": {
          srcDraftPath: "wiki/concepts/draft/_auto/o.md",
          destWikiPath: "wiki/concepts/o.md",
          status: "ok",
          finalPath: "/abs/o.md",
        },
      },
    }))
    mockFetchOnce(200, { ok: true, total: 1, success: [], failed: [] })
    await usePromoteJobsStore.getState().startBatch({
      items: [
        { srcDraftPath: "wiki/concepts/draft/_auto/r.md", destWikiPath: "wiki/methods/r.md" },
        { srcDraftPath: "wiki/concepts/draft/_auto/o.md", destWikiPath: "wiki/methods/o.md" },
        {
          srcDraftPath: "wiki/concepts/draft/_auto/fresh.md",
          destWikiPath: "wiki/concepts/fresh.md",
        },
      ],
      callerAlias: "小孙",
      reason: "batch",
    })
    // 只有 fresh 一项被提交（第 2 次 fetch 调用即 batch 请求）
    const batchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
    const sent = JSON.parse((batchCall[1] as RequestInit).body as string)
    expect(sent.items).toHaveLength(1)
    expect(sent.items[0].srcDraftPath).toBe("wiki/concepts/draft/_auto/fresh.md")
    // running 项的 job 没被 batch 覆盖
    expect(usePromoteJobsStore.getState().jobs["wiki/concepts/draft/_auto/r.md"]?.status).toBe(
      "running",
    )
    resolveFirst({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, finalPath: "/abs/r.md", eventId: 9 }),
    })
    await running
  })

  it("P1 · 全部项被过滤 → 不发请求，batch done 带提示", async () => {
    usePromoteJobsStore.setState({
      jobs: {
        "wiki/concepts/draft/_auto/o.md": {
          srcDraftPath: "wiki/concepts/draft/_auto/o.md",
          destWikiPath: "wiki/concepts/o.md",
          status: "ok",
          finalPath: "/abs/o.md",
        },
      },
    })
    await usePromoteJobsStore.getState().startBatch({
      items: [
        { srcDraftPath: "wiki/concepts/draft/_auto/o.md", destWikiPath: "wiki/methods/o.md" },
      ],
      callerAlias: "小孙",
      reason: "batch",
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(usePromoteJobsStore.getState().batch?.status).toBe("done")
    expect(usePromoteJobsStore.getState().batch?.error).toContain("未提交")
  })

  it("P2/r2 · 对账式 GC：消失的 ok 清掉，仍在列表的 ok 保留护栏，running/failed 不动", () => {
    usePromoteJobsStore.setState({
      jobs: {
        gone: { srcDraftPath: "gone", destWikiPath: "x", status: "ok", finalPath: "/g" },
        stuck: { srcDraftPath: "stuck", destWikiPath: "x2", status: "ok", finalPath: "/s" },
        b: { srcDraftPath: "b", destWikiPath: "y", status: "failed", error: "e" },
        c: { srcDraftPath: "c", destWikiPath: "z", status: "running" },
      },
    })
    // 当前列表：stuck（unlink-fail 留盘）+ b + c；gone 已消行
    usePromoteJobsStore.getState().pruneOkJobsMissingFrom(["stuck", "b", "c"])
    const jobs = usePromoteJobsStore.getState().jobs
    expect(jobs.gone).toBeUndefined()
    expect(jobs.stuck?.status).toBe("ok")
    expect(jobs.b?.status).toBe("failed")
    expect(jobs.c?.status).toBe("running")
  })

  it("r2 · startPromote 挡 ok（unlink-fail 留盘时禁同 src 再 promote）", async () => {
    usePromoteJobsStore.setState({
      jobs: {
        [BODY.srcDraftPath]: {
          srcDraftPath: BODY.srcDraftPath,
          destWikiPath: "wiki/concepts/a.md",
          status: "ok",
          finalPath: "/abs/a.md",
        },
      },
    })
    await usePromoteJobsStore
      .getState()
      .startPromote({ ...BODY, destWikiPath: "wiki/methods/a.md" })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(usePromoteJobsStore.getState().jobs[BODY.srcDraftPath]?.destWikiPath).toBe(
      "wiki/concepts/a.md",
    )
  })
})
