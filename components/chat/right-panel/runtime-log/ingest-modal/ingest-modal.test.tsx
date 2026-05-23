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

  it("preview warnings 含 sensitive_token → blocked + commit 按钮 disabled", async () => {
    mockSequence([
      {
        ok: true,
        status: 200,
        json: makePreviewResponse({
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
