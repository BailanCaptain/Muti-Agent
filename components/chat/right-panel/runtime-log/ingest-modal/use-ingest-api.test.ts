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
