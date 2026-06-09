/**
 * F027 P4 Week 4 Day 17 (AC-P4-9 a) · WarningsTab 单元测试
 *
 * 覆盖:
 *   - empty/loading/error 三态
 *   - 渲染 list + severity badge 配色
 *   - enabled wire (activeLvl2 === "warnings" 才 fetch)
 *   - 按 detectedAt DESC 显示 (依赖 backend sort)
 */

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { WarningsTab } from "./warnings-tab"
import type { ListWarningsResponse, WarningSummary } from "./wiki-meta/use-wiki-meta-data"

function makeWarning(overrides: Partial<WarningSummary> = {}): WarningSummary {
  return {
    path: "wiki/warnings/sample.md",
    type: "warning",
    subtype: "drift_detected",
    severity: "warn",
    source: "viewfinder",
    detectedAt: "2026-04-10T08:45:00Z",
    raisedBy: "room-compiler",
    summary: "sample warning body",
    mtime: "2026-04-10T08:45:00Z",
    hasContent: true,
    ...overrides,
  }
}

function mockFetchResponse(payload: ListWarningsResponse) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    } as Response),
  )
}

function activateWarningsTab() {
  useRuntimeLogStore.setState({
    activeLvl1: "system-prompt",
    activeLvl2: "warnings",
    collapsed: false,
  })
}

describe("WarningsTab", () => {
  beforeEach(() => {
    activateWarningsTab()
    mockFetchResponse({ warnings: [], total: 0 })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("(1) 空 list → empty 占位 + total 0", async () => {
    render(<WarningsTab />)
    await waitFor(() => expect(screen.queryByTestId("warnings-loading")).toBeNull())
    expect(screen.getByTestId("warnings-empty")).toBeTruthy()
    expect(screen.getByTestId("warnings-header").textContent).toMatch(/0 条/)
  })

  it("(2) 2 份 warning → list 渲染 + severity badge + subtype + raisedBy 显示", async () => {
    mockFetchResponse({
      warnings: [
        makeWarning({
          path: "wiki/warnings/a.md",
          subtype: "tainted_source",
          severity: "high",
          source: "v14",
          raisedBy: "V14",
          summary: "tainted source detected",
        }),
        makeWarning({
          path: "wiki/warnings/b.md",
          subtype: "chained_suspect",
          severity: "warn",
          source: "ingest",
          raisedBy: "黄仁勋",
          summary: "chained suspect detected",
        }),
      ],
      total: 2,
    })
    render(<WarningsTab />)
    await waitFor(() => expect(screen.queryByTestId("warnings-list")).toBeTruthy())
    expect(screen.getByText(/2 条/)).toBeTruthy()
    expect(screen.getByText(/tainted_source/)).toBeTruthy()
    expect(screen.getByText(/chained_suspect/)).toBeTruthy()
    expect(screen.getByTestId("warnings-severity-high").textContent).toBe("HIGH")
    expect(screen.getByTestId("warnings-severity-warn").textContent).toBe("WARN")
    expect(screen.getByText(/by V14/)).toBeTruthy()
    expect(screen.getByText(/by 黄仁勋/)).toBeTruthy()
  })

  it("(3) severity=critical row 红色 class", async () => {
    mockFetchResponse({
      warnings: [makeWarning({ severity: "critical" })],
      total: 1,
    })
    render(<WarningsTab />)
    await waitFor(() => expect(screen.queryByTestId("warnings-list")).toBeTruthy())
    const row = screen.getByTestId("warnings-row-wiki/warnings/sample.md")
    expect(row.className).toMatch(/bg-red-50/)
  })

  it("(4) fetch 500 → error 显示", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({}),
      } as Response),
    )
    render(<WarningsTab />)
    await waitFor(() => expect(screen.queryByTestId("warnings-error")).toBeTruthy())
  })

  it("(6) hasContent=true → 渲染「展开看全文」按钮", async () => {
    mockFetchResponse({
      warnings: [makeWarning({ path: "wiki/warnings/file.md", hasContent: true })],
      total: 1,
    })
    render(<WarningsTab />)
    await waitFor(() => expect(screen.queryByTestId("warnings-list")).toBeTruthy())
    expect(screen.getByTestId("expand-toggle-wiki/warnings/file.md")).toBeTruthy()
  })

  it("(7) hasContent=false (event-only) → 不渲染展开按钮 (防 404)", async () => {
    // 合成 path 也以 wiki/warnings/ 开头：靠 hasContent 而非 path 前缀判别 (原 bug 回归守卫)
    mockFetchResponse({
      warnings: [
        makeWarning({
          path: "wiki/warnings/2026-05-23-chained-suspect.md",
          source: "wiki_events",
          hasContent: false,
        }),
      ],
      total: 1,
    })
    render(<WarningsTab />)
    await waitFor(() => expect(screen.queryByTestId("warnings-list")).toBeTruthy())
    expect(
      screen.queryByTestId("expand-toggle-wiki/warnings/2026-05-23-chained-suspect.md"),
    ).toBeNull()
  })

  it("(5) activeLvl2 != warnings → fetch 不触发", async () => {
    useRuntimeLogStore.setState({ activeLvl2: "prompt-inspector" })
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ warnings: [], total: 0 }),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<WarningsTab />)
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
