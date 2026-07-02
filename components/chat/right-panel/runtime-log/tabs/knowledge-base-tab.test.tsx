/**
 * F027 Phase 3 Week 4 Day 19b-1 (AC-P3-6 入口 B) · KnowledgeBaseTab 单元测试
 *
 * 覆盖:
 *   - 默认渲染（button enabled + Phase 4 placeholder）
 *   - [+ Drop] 按钮 click → input file picker 触发
 *   - file picked .md → IngestModal open + 传 file content
 *   - file picked 非允许扩展 → picker-error 显示
 *   - file picked 超 1MB → picker-error 显示
 *   - IngestModal onClose → modalFile cleared
 */

import { usePromoteJobsStore } from "@/components/stores/promote-jobs-store"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { KnowledgeBaseTab } from "./knowledge-base-tab"

function mockOkFetch(payload: unknown) {
  globalThis.fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    } as Response),
  )
}

function makeFile(name: string, content: string, type = "text/markdown"): File {
  return new File([content], name, { type })
}

// F027 promote 后台化：module 级 jobs store 跨用例保留，每用例重置防串场
beforeEach(() => {
  usePromoteJobsStore.getState().resetAll()
})

describe("KnowledgeBaseTab 默认渲染", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("button enabled + 无 modal/error (Day 17 起 KB list 接 real /api/wiki/index)", () => {
    render(<KnowledgeBaseTab />)
    expect(screen.getByTestId("knowledge-base-tab")).toBeTruthy()
    const btn = screen.getByTestId("kb-drop-button") as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toMatch(/\+ Drop 资料/)
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
    expect(screen.queryByTestId("kb-picker-error")).toBeNull()
    // Day 17 起 KB list 不再是 placeholder, 而是 kb-empty 或 kb-index-list (取决于 fetch + enabled)
    // (此测试 activeLvl2 默认非 'knowledge-base' → enabled=false → empty fallback)
  })

  it("button 紫色 class (V16.5 wireframe 配色)", () => {
    render(<KnowledgeBaseTab />)
    const btn = screen.getByTestId("kb-drop-button")
    expect(btn.className).toMatch(/bg-violet/)
  })
})

describe("KnowledgeBaseTab Day 17 AC-P4-9 b index list (真数据)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("(P4-D17-1) activeLvl2='knowledge-base' + index 非空 → 渲染 list rows", async () => {
    const { useRuntimeLogStore } = await import("@/components/stores/runtime-log-store")
    useRuntimeLogStore.setState({ activeLvl2: "knowledge-base" })
    mockOkFetch({
      views: [
        {
          path: "wiki/index/concepts.md",
          bucket: "concepts",
          generatedAt: "2026-05-23T00:00:00Z",
          compilerVersion: "1.0.0",
          summary: "concepts view",
          mtime: "2026-05-23T00:00:00Z",
        },
        {
          path: "wiki/index/methods.md",
          bucket: "methods",
          generatedAt: "2026-05-23T00:00:00Z",
          compilerVersion: "1.0.0",
          summary: "methods view",
          mtime: "2026-05-23T00:00:00Z",
        },
      ],
      total: 2,
    })
    render(<KnowledgeBaseTab />)
    await waitFor(() => expect(screen.queryByTestId("kb-index-list")).toBeTruthy())
    expect(screen.getByTestId("kb-index-row-concepts")).toBeTruthy()
    expect(screen.getByTestId("kb-index-row-methods")).toBeTruthy()
  })

  it("(P4-D17-2) activeLvl2='knowledge-base' + index 空 → kb-empty 占位", async () => {
    const { useRuntimeLogStore } = await import("@/components/stores/runtime-log-store")
    useRuntimeLogStore.setState({ activeLvl2: "knowledge-base" })
    mockOkFetch({ views: [], total: 0 })
    render(<KnowledgeBaseTab />)
    await waitFor(() => expect(screen.queryByTestId("kb-empty")).toBeTruthy())
  })

  it("(P4-D17-3) activeLvl2 != 'knowledge-base' → fetch 不触发 (enabled gate)", async () => {
    const { useRuntimeLogStore } = await import("@/components/stores/runtime-log-store")
    useRuntimeLogStore.setState({ activeLvl2: "prompt-inspector" })
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ views: [], total: 0 }),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<KnowledgeBaseTab />)
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("KnowledgeBaseTab file picker", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("picked .md → IngestModal open + 传 file (preview 自动触发)", async () => {
    mockOkFetch({
      previewId: "preview-1",
      sanitizedContent: "# hi",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    render(<KnowledgeBaseTab />)
    const input = screen.getByTestId("kb-file-input") as HTMLInputElement
    const file = makeFile("foo.md", "# Hello")
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeTruthy())
    // Modal Header 显示 fileName
    expect(screen.getAllByText(/foo\.md/).length).toBeGreaterThan(0)
  })

  it("picked .exe → picker-error 显示 + modal 不开", async () => {
    render(<KnowledgeBaseTab />)
    const input = screen.getByTestId("kb-file-input") as HTMLInputElement
    const file = makeFile("malware.exe", "binary", "application/octet-stream")
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByTestId("kb-picker-error")).toBeTruthy())
    expect(screen.getByText(/不支持的文件类型/)).toBeTruthy()
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
  })

  it("picked > 1MB → picker-error size 提示", async () => {
    render(<KnowledgeBaseTab />)
    const input = screen.getByTestId("kb-file-input") as HTMLInputElement
    const bigContent = "x".repeat(2_000_000) // 2MB
    const file = makeFile("big.md", bigContent)
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByTestId("kb-picker-error")).toBeTruthy())
    expect(screen.getByText(/文件过大/)).toBeTruthy()
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
  })

  it("picked .json → modal open (mime accept)", async () => {
    mockOkFetch({
      previewId: "preview-2",
      sanitizedContent: "{}",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    render(<KnowledgeBaseTab />)
    const input = screen.getByTestId("kb-file-input") as HTMLInputElement
    const file = makeFile("data.json", "{}", "application/json")
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeTruthy())
  })

  it("picked .txt → modal open", async () => {
    mockOkFetch({
      previewId: "preview-3",
      sanitizedContent: "txt",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    render(<KnowledgeBaseTab />)
    const input = screen.getByTestId("kb-file-input") as HTMLInputElement
    const file = makeFile("notes.txt", "plain text", "text/plain")
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeTruthy())
  })

  it("cancel 文件 picker (files=null) → 无 modal 无 error", async () => {
    render(<KnowledgeBaseTab />)
    const input = screen.getByTestId("kb-file-input") as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
    expect(screen.queryByTestId("kb-picker-error")).toBeNull()
  })
})

describe("KnowledgeBaseTab modal close", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("IngestModal close (✕) → modal hidden + modalFile cleared", async () => {
    mockOkFetch({
      previewId: "preview-1",
      sanitizedContent: "# hi",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    render(<KnowledgeBaseTab />)
    const input = screen.getByTestId("kb-file-input") as HTMLInputElement
    const file = makeFile("foo.md", "# Hello")
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ingest-modal-close"))
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeNull())
  })
})
