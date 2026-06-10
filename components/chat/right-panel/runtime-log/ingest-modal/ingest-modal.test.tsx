/**
 * F027 Phase 3 Week 4 Day 19a (AC-P3-6 + AC-P3-10) · IngestModal 单元测试
 *
 * 覆盖:
 *   - open=false → 不渲染
 *   - open=true + file → 渲染 header + 5 段 + footer
 *   - preview loading → ⏳ 文案
 *   - preview success (空 warnings) → ✅ clean 文案
 *   - preview warnings 含 sensitive_token → blocked (commit 禁) + 文案
 *   - commit 成功 → CommitSuccess 段 + onCommitSuccess 回调
 *   - commit 失败 → CommitError 段
 *   - 取消按钮 → onClose
 *   - close (✕) → onClose
 *   - type radio 切换
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IngestModal, type IngestModalFile } from "./ingest-modal"
import type { PostIngestCommitResponse, PreviewIngestResponse } from "./use-ingest-api"

function makeFile(overrides: Partial<IngestModalFile> = {}): IngestModalFile {
  return {
    name: "foo.md",
    content: "# hi",
    sizeBytes: 4,
    ...overrides,
  }
}

function makePreviewResponse(
  overrides: Partial<PreviewIngestResponse> = {},
): PreviewIngestResponse {
  return {
    previewId: "preview-uuid-1",
    blocked: false,
    sanitizedContent: "# Sanitized hi",
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

function mockSequence(responses: Array<{ ok: boolean; status: number; json: unknown }>) {
  let idx = 0
  globalThis.fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[idx++] ?? responses[responses.length - 1]
    return Promise.resolve({
      ok: r?.ok ?? true,
      status: r?.status ?? 200,
      statusText: r?.ok ? "OK" : "Error",
      json: () => Promise.resolve(r?.json),
    } as Response)
  })
}

describe("IngestModal 基础渲染", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("open=false → 不渲染", () => {
    render(<IngestModal open={false} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
  })

  it("open=true + file=null → 不渲染", () => {
    render(<IngestModal open={true} file={null} callerAlias="huang" onClose={vi.fn()} />)
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
  })

  it("open + file → 渲染 modal + header + 5 段 + footer", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    expect(screen.getByTestId("ingest-modal")).toBeTruthy()
    // foo.md 在 header + file section 都有，用 getAllByText
    expect(screen.getAllByText(/foo\.md/).length).toBeGreaterThan(0)
    expect(screen.getByTestId("ingest-section-file")).toBeTruthy()
    expect(screen.getByTestId("ingest-section-type")).toBeTruthy()
    expect(screen.getByTestId("ingest-section-reason")).toBeTruthy()
    expect(screen.getByTestId("ingest-section-sanitize")).toBeTruthy()
    expect(screen.getByTestId("ingest-section-compile-preview")).toBeTruthy()
    expect(screen.getByTestId("ingest-modal-cancel")).toBeTruthy()
    expect(screen.getByTestId("ingest-modal-commit")).toBeTruthy()
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
  })
})

describe("IngestModal preview/sanitize", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("preview success + 空 warnings → ✅ clean 文案 + commit 按钮 enabled", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    const commitBtn = screen.getByTestId("ingest-modal-commit") as HTMLButtonElement
    expect(commitBtn.disabled).toBe(false)
  })

  it("preview blocked=true → blocked banner + commit 按钮 disabled", async () => {
    mockSequence([
      {
        ok: true,
        status: 200,
        json: makePreviewResponse({
          blocked: true,
          previewId: "",
          sanitizedContent: "",
          llmCompiledPreview: "",
          warnings: [
            {
              kind: "sensitive_token",
              subkind: "jailbreak_template",
              message: "Detected jailbreak template",
            },
          ],
        }),
      },
    ])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.queryByTestId("ingest-sanitize-warning-sensitive_token")).toBeTruthy(),
    )
    expect(screen.getByTestId("ingest-footer-blocked")).toBeTruthy()
    const commitBtn = screen.getByTestId("ingest-modal-commit") as HTMLButtonElement
    expect(commitBtn.disabled).toBe(true)
  })

  it("德彪 batch1 P3 · blocked 字段缺失（老后端/畸形响应）→ fail-closed 禁 commit", async () => {
    const legacyResponse = makePreviewResponse() as unknown as Record<string, unknown>
    delete legacyResponse.blocked
    mockSequence([{ ok: true, status: 200, json: legacyResponse as never }])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    expect(screen.getByTestId("ingest-footer-blocked")).toBeTruthy()
    const commitBtn = screen.getByTestId("ingest-modal-commit") as HTMLButtonElement
    expect(commitBtn.disabled).toBe(true)
  })

  it("F027 续 · sensitive_token warning 但 blocked=false（隔离段非红线）→ 不误禁 commit", async () => {
    mockSequence([
      {
        ok: true,
        status: 200,
        json: makePreviewResponse({
          blocked: false,
          warnings: [
            {
              kind: "sensitive_token",
              subkind: "invisible_format_char",
              message: "[quarantine:invisible_format_char] segment isolated",
            },
          ],
        }),
      },
    ])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.queryByTestId("ingest-sanitize-warning-sensitive_token")).toBeTruthy(),
    )
    expect(screen.queryByTestId("ingest-footer-blocked")).toBeNull()
    const commitBtn = screen.getByTestId("ingest-modal-commit") as HTMLButtonElement
    expect(commitBtn.disabled).toBe(false)
  })

  it("preview 失败 → sanitize-error 显示 + commit disabled", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal",
        json: () => Promise.resolve({ error: "INTERNAL_ERROR", message: "boom" }),
      } as Response),
    )
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-error")).toBeTruthy())
    expect(screen.getByText(/boom/)).toBeTruthy()
    const commitBtn = screen.getByTestId("ingest-modal-commit") as HTMLButtonElement
    expect(commitBtn.disabled).toBe(true)
  })

  it("preview warning size_truncated 不阻 commit (黄色非红线)", async () => {
    mockSequence([
      {
        ok: true,
        status: 200,
        json: makePreviewResponse({
          warnings: [
            {
              kind: "size_truncated",
              message: "Truncated at 1MB",
            },
          ],
        }),
      },
    ])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() =>
      expect(screen.queryByTestId("ingest-sanitize-warning-size_truncated")).toBeTruthy(),
    )
    expect(screen.queryByTestId("ingest-footer-blocked")).toBeNull()
    const commitBtn = screen.getByTestId("ingest-modal-commit") as HTMLButtonElement
    expect(commitBtn.disabled).toBe(false)
  })
})

describe("IngestModal commit", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("commit 成功 → CommitSuccess + onCommitSuccess 回调", async () => {
    mockSequence([
      { ok: true, status: 200, json: makePreviewResponse() },
      { ok: true, status: 200, json: makeCommitResponse() },
    ])
    const onSuccess = vi.fn()
    render(
      <IngestModal
        open={true}
        file={makeFile()}
        callerAlias="huang"
        onClose={vi.fn()}
        onCommitSuccess={onSuccess}
      />,
    )
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ingest-modal-commit"))
    await waitFor(() => expect(screen.queryByTestId("ingest-section-commit-success")).toBeTruthy())
    expect(screen.getByText(/concepts\/draft\/_auto/)).toBeTruthy()
    expect(onSuccess).toHaveBeenCalledWith({
      finalPath: "concepts/draft/_auto/2026-05-23-foo.md",
      ingestEventId: "evt-42",
    })
  })

  it("commit 失败 (409 LEASE_FENCING_FAILED) → CommitError 显示", async () => {
    mockSequence([
      { ok: true, status: 200, json: makePreviewResponse() },
      {
        ok: false,
        status: 409,
        json: { error: "LEASE_FENCING_FAILED", message: "stale lease" },
      },
    ])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ingest-modal-commit"))
    await waitFor(() => expect(screen.queryByTestId("ingest-section-commit-error")).toBeTruthy())
    expect(screen.getByText(/stale lease/)).toBeTruthy()
  })

  it("commit 成功后 cancel 按钮文案 → '关闭'", async () => {
    mockSequence([
      { ok: true, status: 200, json: makePreviewResponse() },
      { ok: true, status: 200, json: makeCommitResponse() },
    ])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ingest-modal-commit"))
    await waitFor(() => expect(screen.queryByTestId("ingest-section-commit-success")).toBeTruthy())
    expect(screen.getByTestId("ingest-modal-cancel").textContent).toBe("关闭")
  })
})

describe("IngestModal 关闭路径", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("取消按钮 → onClose", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    const onClose = vi.fn()
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={onClose} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ingest-modal-cancel"))
    expect(onClose).toHaveBeenCalled()
  })

  it("✕ close → onClose", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    const onClose = vi.fn()
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={onClose} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ingest-modal-close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("点 overlay 背景 → onClose", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    const onClose = vi.fn()
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={onClose} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ingest-modal-overlay"))
    expect(onClose).toHaveBeenCalled()
  })
})

describe("IngestModal type radio", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("默认 concept selected", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    const conceptRadio = screen
      .getByTestId("ingest-type-radio-concept")
      .querySelector("input") as HTMLInputElement
    expect(conceptRadio.checked).toBe(true)
  })

  it("切换 type → feature radio checked", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    const featureLabel = screen.getByTestId("ingest-type-radio-feature")
    const featureRadio = featureLabel.querySelector("input") as HTMLInputElement
    fireEvent.click(featureRadio)
    expect(featureRadio.checked).toBe(true)
  })

  // 范-r1 P1-1 fix: type 改要重 preview (backend ingest-preview.ts:198 真用 targetType 写 frontmatter)
  it("范-r1 P1-1 fix: 切换 type → 新 preview body 含新 targetType", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makePreviewResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // 第一次调用 body 含 targetType="concept" (默认)
    const body1 = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))
    expect(body1.targetType).toBe("concept")

    // 切换到 feature → 重 preview
    const featureRadio = screen
      .getByTestId("ingest-type-radio-feature")
      .querySelector("input") as HTMLInputElement
    fireEvent.click(featureRadio)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const body2 = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))
    expect(body2.targetType).toBe("feature")
  })
})

describe("IngestModal Escape key (范-r1 P2 fix · a11y)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("Escape key → onClose 触发", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    const onClose = vi.fn()
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={onClose} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("非 Escape key → 不触发 onClose", async () => {
    mockSequence([{ ok: true, status: 200, json: makePreviewResponse() }])
    const onClose = vi.fn()
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={onClose} />)
    await waitFor(() => expect(screen.queryByTestId("ingest-sanitize-clean")).toBeTruthy())
    fireEvent.keyDown(document, { key: "Enter" })
    fireEvent.keyDown(document, { key: "a" })
    expect(onClose).not.toHaveBeenCalled()
  })

  it("open=false → Escape 不触发 (listener 已 unregister)", async () => {
    const onClose = vi.fn()
    render(<IngestModal open={false} file={makeFile()} callerAlias="huang" onClose={onClose} />)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("IngestModal SeriesSection (F027 P4 Day 10 AC-P4-3 e)", () => {
  beforeEach(() => {
    mockSequence([
      {
        ok: true,
        status: 200,
        json: makePreviewResponse(),
      },
    ])
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("(P4-D10-1) 渲染 SeriesSection 输入框 (空 default)", async () => {
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    const input = screen.getByTestId("ingest-series-input") as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe("")
  })

  it("(P4-D10-2) 合法 seriesId ('rag-paper-v1') 透传到 preview fetch body", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makePreviewResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    fireEvent.change(screen.getByTestId("ingest-series-input"), {
      target: { value: "rag-paper-v1" },
    })

    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)!
      const init = lastCall[1] as RequestInit
      const body = JSON.parse(init.body as string)
      expect(body.seriesId).toBe("rag-paper-v1")
    })
  })

  it("(P4-D10-3) 含空格的 seriesId → 显示 error + 不 trigger preview re-fetch", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makePreviewResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)) // initial preview

    const beforeCount = fetchMock.mock.calls.length
    fireEvent.change(screen.getByTestId("ingest-series-input"), {
      target: { value: "has space" },
    })

    expect(screen.getByTestId("ingest-series-error-chars")).toBeTruthy()
    // wait a tick to ensure invalid seriesId did NOT re-trigger preview
    await new Promise((r) => setTimeout(r, 60))
    expect(fetchMock.mock.calls.length).toBe(beforeCount)
  })

  it("(P4-D10-4) seriesId > 64 chars → 显示 'too long' error", async () => {
    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    fireEvent.change(screen.getByTestId("ingest-series-input"), {
      target: { value: "x".repeat(65) },
    })
    expect(screen.getByTestId("ingest-series-error-toolong")).toBeTruthy()
  })

  it("(P4-D10-6) codex r3 P2: invalid seriesId 时 preview 被 reset + commit 按钮 disabled (防 stale preview commit)", async () => {
    // 序列: 初始 preview (合法 file + 空 seriesId) → 成功
    //   → 用户输 invalid seriesId → preview 应被 reset → commit 按钮 disabled
    let previewCount = 0
    globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/api/wiki/ingest/preview")) {
        previewCount++
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makePreviewResponse()),
      } as Response)
    }) as unknown as typeof fetch

    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(previewCount).toBe(1)) // 初始 preview 已成功

    // 此时 commit 应可点 (合法 file + 空 seriesId + preview 成功)
    const commitBtn = screen.getByTestId("ingest-modal-commit") as HTMLButtonElement
    expect(commitBtn.disabled).toBe(false)

    // 输 invalid seriesId
    fireEvent.change(screen.getByTestId("ingest-series-input"), {
      target: { value: "has space" },
    })
    expect(screen.getByTestId("ingest-series-error-chars")).toBeTruthy()

    // P2 防御: commit 按钮 disabled (preview.reset + seriesValid 二重保护)
    await waitFor(() => {
      expect(commitBtn.disabled).toBe(true)
    })

    // 用户改回 valid → preview 重新跑 + commit 重新 enabled
    fireEvent.change(screen.getByTestId("ingest-series-input"), {
      target: { value: "valid-series" },
    })
    await waitFor(() => expect(previewCount).toBe(2)) // re-preview
    await waitFor(() => expect(commitBtn.disabled).toBe(false))
  })

  it("(P4-D10-5) 空 seriesId → preview body 不含 seriesId 字段", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makePreviewResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    render(<IngestModal open={true} file={makeFile()} callerAlias="huang" onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string)
    expect(body.seriesId).toBeUndefined()
  })
})
