/**
 * F027 Phase 3 Week 4 Day 19a (AC-P3-6/10) · use-ingest-api 单元测试
 *
 * 覆盖:
 *   - useIngestPreview: preview() 成功 / 失败 / 错误 body 解析 / reset
 *   - useIngestCommit: commit() 成功 / 失败 / 错误 body 解析 / reset
 *   - URL 用 API_BASE_URL (http://localhost:8787) Day 14-15 r1 P1 同款防御
 *   - detectIngestMime: 4 边界 (md / json / txt / no ext)
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type PostIngestCommitResponse,
  type PreviewIngestResponse,
  detectIngestMime,
  useIngestCommit,
  useIngestPreview,
} from "./use-ingest-api"

function makePreviewResponse(
  overrides: Partial<PreviewIngestResponse> = {},
): PreviewIngestResponse {
  return {
    previewId: "preview-uuid-1",
    blocked: false,
    sanitizedContent: "# Sanitized",
    llmCompiledPreview: "---\ntype: concept\n---\n# Stub",
    warnings: [],
    expiresAt: "2026-05-23T01:00:00Z",
    ...overrides,
  }
}

function makeCommitResponse(
  overrides: Partial<PostIngestCommitResponse> = {},
): PostIngestCommitResponse {
  return {
    ingestEventId: "evt-42",
    finalPath: "concepts/draft/_auto/2026-05-23-foo.md",
    committedAt: "2026-05-23T01:00:00Z",
    fencingToken: "token-7",
    ...overrides,
  }
}

function mockOkFetch<T>(payload: T) {
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

describe("useIngestPreview", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("preview() 成功 → data 写入 + URL 用 API_BASE_URL + body 序列化", async () => {
    const fetchMock = mockOkFetch(makePreviewResponse())
    const { result } = renderHook(() => useIngestPreview())
    await act(async () => {
      await result.current.preview({
        sourcePath: "foo.md",
        content: "# hi",
        mimeType: "text/markdown",
        targetType: "concept",
      })
    })
    expect(result.current.data?.previewId).toBe("preview-uuid-1")
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toMatch(/^http:\/\/localhost:8787\//)
    expect(String(url)).toMatch(/\/api\/wiki\/ingest\/preview$/)
    expect((init as RequestInit | undefined)?.method).toBe("POST")
    const body = JSON.parse(String((init as RequestInit | undefined)?.body))
    expect(body).toEqual({
      sourcePath: "foo.md",
      content: "# hi",
      mimeType: "text/markdown",
      targetType: "concept",
    })
  })

  it("preview() 500 + 错误 body 含 message → error 显示 backend message", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () =>
          Promise.resolve({
            error: "INTERNAL_ERROR",
            message: "sanitize segfault",
          }),
      } as Response),
    )
    const { result } = renderHook(() => useIngestPreview())
    await act(async () => {
      await result.current.preview({
        sourcePath: "foo.md",
        content: "x",
        mimeType: "text/markdown",
      })
    })
    expect(result.current.error).toBe("sanitize segfault")
    expect(result.current.data).toBeNull()
  })

  it("preview() 错误 body 解析失败 → fallback HTTP N statusText", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: () => Promise.reject(new Error("not json")),
      } as Response),
    )
    const { result } = renderHook(() => useIngestPreview())
    await act(async () => {
      await result.current.preview({
        sourcePath: "x",
        content: "x",
        mimeType: "text/plain",
      })
    })
    expect(result.current.error).toMatch(/HTTP 502/)
  })

  it("reset() → data/error/isLoading 全清", async () => {
    mockOkFetch(makePreviewResponse())
    const { result } = renderHook(() => useIngestPreview())
    await act(async () => {
      await result.current.preview({
        sourcePath: "x",
        content: "x",
        mimeType: "text/plain",
      })
    })
    expect(result.current.data).not.toBeNull()
    act(() => {
      result.current.reset()
    })
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })

  it("范-r1 P1-2 fix: preview() 开始立即清旧 data (防 stale UI 仍 commit-enabled)", async () => {
    // 先发起 preview A 拿到 data
    mockOkFetch(makePreviewResponse({ previewId: "preview-A" }))
    const { result } = renderHook(() => useIngestPreview())
    await act(async () => {
      await result.current.preview({
        sourcePath: "A.md",
        content: "A",
        mimeType: "text/markdown",
      })
    })
    expect(result.current.data?.previewId).toBe("preview-A")

    // 再发起 preview B (用 deferred mock) — 第一帧应该已 data=null
    let resolveB: (v: Response) => void = () => {}
    const deferredB = new Promise<Response>((r) => {
      resolveB = r
    })
    globalThis.fetch = vi.fn(() => deferredB)
    act(() => {
      void result.current.preview({
        sourcePath: "B.md",
        content: "B",
        mimeType: "text/markdown",
      })
    })
    // preview B 还没 resolve, 但 data 已立即清 (防 stale A 仍 commit-enabled)
    expect(result.current.data).toBeNull()
    expect(result.current.isLoading).toBe(true)

    // resolve B 后 data 是 B
    await act(async () => {
      resolveB({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makePreviewResponse({ previewId: "preview-B" })),
      } as Response)
      await deferredB
    })
    expect(result.current.data?.previewId).toBe("preview-B")
  })

  it("范-r1 P1-2 fix: stale race A 慢 + B 快 → A 响应不覆盖 B (monotonic reqId)", async () => {
    let resolveA: (v: Response) => void = () => {}
    const deferredA = new Promise<Response>((r) => {
      resolveA = r
    })
    const aborted = false
    globalThis.fetch = vi
      .fn()
      .mockImplementationOnce(() => deferredA) // A 慢
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => Promise.resolve(makePreviewResponse({ previewId: "preview-B" })),
        } as Response),
      ) // B 快

    const { result } = renderHook(() => useIngestPreview())
    // 启动 A (慢) — 不 await
    act(() => {
      void result.current.preview({
        sourcePath: "A.md",
        content: "A",
        mimeType: "text/markdown",
      })
    })
    // 启动 B (快) — await 让 B 跑完
    await act(async () => {
      await result.current.preview({
        sourcePath: "B.md",
        content: "B",
        mimeType: "text/markdown",
      })
    })
    expect(result.current.data?.previewId).toBe("preview-B")

    // 现在让 A 后到 (用 A 的 stale previewId) — reqId 守护应丢弃 A 响应
    await act(async () => {
      resolveA({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makePreviewResponse({ previewId: "preview-A-stale" })),
      } as Response)
      await deferredA
      // 等下一个 microtask
      await new Promise((r) => setTimeout(r, 10))
    })
    // data 仍是 B (A stale 被丢)
    expect(result.current.data?.previewId).toBe("preview-B")
    // suppress unused var lint
    void aborted
  })
})

describe("useIngestCommit", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("commit() 成功 → data 写入 + URL 用 API_BASE_URL + body 包 previewId+callerAlias", async () => {
    const fetchMock = mockOkFetch(makeCommitResponse())
    const { result } = renderHook(() => useIngestCommit())
    await act(async () => {
      await result.current.commit({
        previewId: "preview-uuid-1",
        callerAlias: "黄仁勋",
      })
    })
    expect(result.current.data?.ingestEventId).toBe("evt-42")
    expect(result.current.data?.finalPath).toMatch(/^concepts\/draft\/_auto/)

    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(String(url)).toMatch(/^http:\/\/localhost:8787\//)
    expect(String(url)).toMatch(/\/api\/wiki\/ingest\/commit$/)
    expect((init as RequestInit | undefined)?.method).toBe("POST")
    const body = JSON.parse(String((init as RequestInit | undefined)?.body))
    expect(body).toEqual({ previewId: "preview-uuid-1", callerAlias: "黄仁勋" })
  })

  it("commit() 409 LEASE_FENCING_FAILED → error 显示 backend message", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 409,
        statusText: "Conflict",
        json: () =>
          Promise.resolve({
            error: "LEASE_FENCING_FAILED",
            message: "lease token stale, please retry",
          }),
      } as Response),
    )
    const { result } = renderHook(() => useIngestCommit())
    await act(async () => {
      await result.current.commit({ previewId: "p", callerAlias: "a" })
    })
    expect(result.current.error).toBe("lease token stale, please retry")
    expect(result.current.data).toBeNull()
  })

  it("reset() → data/error 全清", async () => {
    mockOkFetch(makeCommitResponse())
    const { result } = renderHook(() => useIngestCommit())
    await act(async () => {
      await result.current.commit({ previewId: "p", callerAlias: "a" })
    })
    expect(result.current.data).not.toBeNull()
    act(() => {
      result.current.reset()
    })
    expect(result.current.data).toBeNull()
  })
})

describe("detectIngestMime", () => {
  it("'.md' → text/markdown", () => {
    expect(detectIngestMime("foo.md")).toBe("text/markdown")
  })
  it("'.markdown' → text/markdown", () => {
    expect(detectIngestMime("foo.markdown")).toBe("text/markdown")
  })
  it("'.json' → application/json", () => {
    expect(detectIngestMime("data.json")).toBe("application/json")
  })
  it("'.txt' → text/plain", () => {
    expect(detectIngestMime("notes.txt")).toBe("text/plain")
  })
  it("无后缀 → text/plain fallback", () => {
    expect(detectIngestMime("README")).toBe("text/plain")
  })
  it("大写后缀 → text/markdown (case-insensitive)", () => {
    expect(detectIngestMime("FOO.MD")).toBe("text/markdown")
  })
})
