/**
 * F027 Phase 3 Week 4 Day 19b-2 (AC-P3-6 入口 A) · Composer dragover/drop 单元测试
 *
 * 覆盖:
 *   - 默认渲染 (无 drag-hint, 无 ingest-modal)
 *   - dragEnter Files → dragOver=true + drag-hint 显示 (V16.5 chap 25 line 2533 紫色边框)
 *   - dragLeave → dragOver=false
 *   - drop .md → IngestModal open
 *   - drop 图片 → pendingImages addFile (不开 modal)
 *   - drop 混合 (.md + .png) → 都处理
 *   - drop .exe → drop-error 显示 (拒收)
 *   - drop > 1MB → drop-error size
 *   - drop 多 .md → 取第一个 + 警告其他 Phase 4
 *
 * 不覆盖（依赖现有 chat-store / thread-store 复杂初始化）：
 *   - mention / queue / send 既有行为 (本批不动这些, regression 在 typecheck + 全套 test 验)
 */

import { useChatStore } from "@/components/stores/chat-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer"

function resetStores() {
  // chat-store 默认 state 重置
  useChatStore.setState({
    drafts: {},
    pendingImages: {},
    status: "",
  })
  // thread-store 最小 stub 让 Composer 渲染不崩
  useThreadStore.setState({
    activeGroupId: "G-1",
    // biome-ignore lint/suspicious/noExplicitAny: stub
    activeGroup: { id: "G-1", roomId: "R-1", hasPendingDispatches: false } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    providers: {
      claude: { running: false, threadId: null },
      codex: { running: false, threadId: null },
      gemini: { running: false, threadId: null },
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    buildSendPayload: () => ({} as any),
  })
}

function makeFile(name: string, content: string, type = "text/markdown"): File {
  return new File([content], name, { type })
}

function makeDataTransfer(files: File[]): DataTransfer {
  const dt = {
    files: files as unknown as FileList,
    types: ["Files"],
    items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  }
  return dt as unknown as DataTransfer
}

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

describe("Composer 默认渲染", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("无 drag → 无 drag-hint + 无 ingest-modal + 无 drop-error", () => {
    render(<Composer />)
    const form = screen.getByTestId("composer-form")
    expect(form.getAttribute("data-drag-over")).toBe("false")
    expect(screen.queryByTestId("composer-drag-hint")).toBeNull()
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
    expect(screen.queryByTestId("composer-ingest-drop-error")).toBeNull()
  })
})

describe("Composer dragEnter / dragLeave", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("dragEnter Files → dragOver=true + drag-hint 显示 + 紫色边框 class", () => {
    render(<Composer />)
    const form = screen.getByTestId("composer-form")
    fireEvent.dragEnter(form, { dataTransfer: makeDataTransfer([makeFile("foo.md", "x")]) })
    expect(form.getAttribute("data-drag-over")).toBe("true")
    expect(screen.getByTestId("composer-drag-hint")).toBeTruthy()
    expect(form.className).toMatch(/border-violet/)
  })

  it("dragLeave → dragOver=false (counter 归 0 后)", () => {
    render(<Composer />)
    const form = screen.getByTestId("composer-form")
    fireEvent.dragEnter(form, { dataTransfer: makeDataTransfer([makeFile("foo.md", "x")]) })
    fireEvent.dragLeave(form, { dataTransfer: makeDataTransfer([]) })
    expect(form.getAttribute("data-drag-over")).toBe("false")
    expect(screen.queryByTestId("composer-drag-hint")).toBeNull()
  })

  it("dragEnter 不带 Files (text drag) → dragOver 不变", () => {
    render(<Composer />)
    const form = screen.getByTestId("composer-form")
    const dtNoFiles = { files: [] as unknown as FileList, types: ["text/plain"] }
    fireEvent.dragEnter(form, { dataTransfer: dtNoFiles })
    expect(form.getAttribute("data-drag-over")).toBe("false")
  })
})

describe("Composer drop ingest files", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("drop .md → IngestModal open + drop-error 不显示", async () => {
    mockOkFetch({
      previewId: "p-1",
      sanitizedContent: "# hi",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    render(<Composer />)
    const form = screen.getByTestId("composer-form")
    fireEvent.drop(form, {
      dataTransfer: makeDataTransfer([makeFile("foo.md", "# hi")]),
    })
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeTruthy())
    expect(form.getAttribute("data-drag-over")).toBe("false")
    expect(screen.queryByTestId("composer-ingest-drop-error")).toBeNull()
  })

  it("drop .json → IngestModal open", async () => {
    mockOkFetch({
      previewId: "p-2",
      sanitizedContent: "{}",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    render(<Composer />)
    fireEvent.drop(screen.getByTestId("composer-form"), {
      dataTransfer: makeDataTransfer([makeFile("data.json", "{}", "application/json")]),
    })
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeTruthy())
  })

  it("drop .exe → drop-error + 无 modal", async () => {
    render(<Composer />)
    fireEvent.drop(screen.getByTestId("composer-form"), {
      dataTransfer: makeDataTransfer([
        makeFile("malware.exe", "x", "application/octet-stream"),
      ]),
    })
    await waitFor(() => expect(screen.queryByTestId("composer-ingest-drop-error")).toBeTruthy())
    expect(screen.getByText(/拒收/)).toBeTruthy()
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
  })

  it("drop > 1MB .md → drop-error size 提示", async () => {
    render(<Composer />)
    const big = "x".repeat(2_000_000)
    fireEvent.drop(screen.getByTestId("composer-form"), {
      dataTransfer: makeDataTransfer([makeFile("big.md", big)]),
    })
    await waitFor(() => expect(screen.queryByTestId("composer-ingest-drop-error")).toBeTruthy())
    expect(screen.getByText(/文件过大/)).toBeTruthy()
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
  })

  it("drop 多 .md → 取第一个 + 警告其他 Phase 4", async () => {
    mockOkFetch({
      previewId: "p-1",
      sanitizedContent: "# A",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    render(<Composer />)
    fireEvent.drop(screen.getByTestId("composer-form"), {
      dataTransfer: makeDataTransfer([
        makeFile("a.md", "# A"),
        makeFile("b.md", "# B"),
      ]),
    })
    await waitFor(() => expect(screen.queryByTestId("composer-ingest-drop-error")).toBeTruthy())
    expect(screen.getByText(/多文件 ingest Phase 4/)).toBeTruthy()
    expect(screen.queryByTestId("ingest-modal")).toBeTruthy()
  })
})

describe("Composer drop 图片走原路径", () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("drop .png → pendingImages addFile (无 modal)", async () => {
    render(<Composer />)
    const png = new File(["fake"], "img.png", { type: "image/png" })
    // jsdom URL.createObjectURL stub
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake")
    fireEvent.drop(screen.getByTestId("composer-form"), {
      dataTransfer: makeDataTransfer([png]),
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId("ingest-modal")).toBeNull()
    // pendingImages 写入 chat-store
    const state = useChatStore.getState()
    expect(state.pendingImages["G-1"]?.length).toBe(1)
  })

  it("drop .md + .png 混合 → 图片走附件 + .md 开 modal", async () => {
    mockOkFetch({
      previewId: "p-mix",
      sanitizedContent: "# mix",
      llmCompiledPreview: "stub",
      warnings: [],
      expiresAt: "2026-05-23T01:00:00Z",
    })
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mix")
    render(<Composer />)
    const png = new File(["fake"], "p.png", { type: "image/png" })
    fireEvent.drop(screen.getByTestId("composer-form"), {
      dataTransfer: makeDataTransfer([makeFile("a.md", "# A"), png]),
    })
    await waitFor(() => expect(screen.queryByTestId("ingest-modal")).toBeTruthy())
    expect(useChatStore.getState().pendingImages["G-1"]?.length).toBe(1)
  })
})
