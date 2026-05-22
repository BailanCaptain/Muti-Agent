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

describe("KnowledgeBaseTab 默认渲染", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("button enabled + Phase 4 placeholder 文案 + 无 modal/error", () => {
    render(<KnowledgeBaseTab />)
    expect(screen.getByTestId("knowledge-base-tab")).toBeTruthy()
    const btn = screen.getByTestId("kb-drop-button") as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toMatch(/\+ Drop 资料/)
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
    expect(screen.queryByTestId("kb-picker-error")).toBeNull()
    expect(screen.getByText(/Phase 4 上线/)).toBeTruthy()
  })

  it("button 紫色 class (V16.5 wireframe 配色)", () => {
    render(<KnowledgeBaseTab />)
    const btn = screen.getByTestId("kb-drop-button")
    expect(btn.className).toMatch(/bg-violet/)
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
