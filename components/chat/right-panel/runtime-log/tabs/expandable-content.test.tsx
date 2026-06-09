/**
 * F027 · ExpandableContent（KB tab「展开看全文」共享组件）单测
 *
 * 覆盖：
 *   - 默认收起：只有展开按钮，无 panel，未 fetch（lazy）
 *   - 点展开 → 命中对应 content 端点（draft / warning）+ encode path → 渲染全文 <pre>
 *   - 收起再展开不重复 fetch（缓存）
 *   - fetch 非 200 → 错误态，不渲染 <pre>
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ExpandableContent } from "./expandable-content"

function mockContentFetch(content: string) {
  const spy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve({ content, mtime: "2026-06-07T00:00:00Z" }),
    } as Response),
  )
  // 德彪 codex P3：用 stubGlobal（unstubAllGlobals 可恢复），别直接赋值 globalThis.fetch
  // —— restoreAllMocks 恢复不了直接赋值，会污染共享 worker 里后续测试。
  vi.stubGlobal("fetch", spy)
  return spy
}

describe("ExpandableContent", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("默认收起：只有展开按钮，无 panel，未 fetch（lazy）", () => {
    const spy = mockContentFetch("FULL")
    render(<ExpandableContent contentPath="wiki/concepts/draft/_auto/x.md" kind="draft" />)
    const toggle = screen.getByTestId("expand-toggle-wiki/concepts/draft/_auto/x.md")
    expect(toggle.textContent).toMatch(/展开看全文/)
    expect(screen.queryByTestId("expand-panel-wiki/concepts/draft/_auto/x.md")).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it("点展开 → 命中 draft content 端点 + encode path → 渲染全文 <pre>", async () => {
    const spy = mockContentFetch("---\ntitle: X\n---\nFULL BODY HERE")
    render(<ExpandableContent contentPath="wiki/concepts/draft/_auto/x.md" kind="draft" />)
    fireEvent.click(screen.getByTestId("expand-toggle-wiki/concepts/draft/_auto/x.md"))
    await waitFor(() =>
      expect(screen.getByTestId("expand-content-wiki/concepts/draft/_auto/x.md")).toBeTruthy(),
    )
    expect(
      screen.getByTestId("expand-content-wiki/concepts/draft/_auto/x.md").textContent,
    ).toMatch(/FULL BODY HERE/)
    const calledUrl = String(spy.mock.calls[0]?.[0])
    expect(calledUrl).toMatch(/\/api\/wiki\/drafts\/content\?path=/)
    expect(calledUrl).toMatch(/x\.md/)
  })

  it("warning kind → 命中 warnings content 端点", async () => {
    const spy = mockContentFetch("WARN FULL BODY")
    render(<ExpandableContent contentPath="wiki/warnings/acl.md" kind="warning" />)
    fireEvent.click(screen.getByTestId("expand-toggle-wiki/warnings/acl.md"))
    await waitFor(() =>
      expect(screen.getByTestId("expand-content-wiki/warnings/acl.md")).toBeTruthy(),
    )
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/\/api\/wiki\/warnings\/content\?path=/)
  })

  it("收起再展开不重复 fetch（缓存）", async () => {
    const spy = mockContentFetch("CACHED")
    render(<ExpandableContent contentPath="wiki/warnings/a.md" kind="warning" />)
    const toggle = screen.getByTestId("expand-toggle-wiki/warnings/a.md")
    fireEvent.click(toggle) // 展开 → fetch
    await waitFor(() =>
      expect(screen.getByTestId("expand-content-wiki/warnings/a.md")).toBeTruthy(),
    )
    fireEvent.click(toggle) // 收起
    fireEvent.click(toggle) // 再展开
    await waitFor(() =>
      expect(screen.getByTestId("expand-content-wiki/warnings/a.md")).toBeTruthy(),
    )
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("fetch 非 200 → 错误态，不渲染 <pre>", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 404, statusText: "Not Found" } as Response),
      ),
    )
    render(<ExpandableContent contentPath="wiki/warnings/missing.md" kind="warning" />)
    fireEvent.click(screen.getByTestId("expand-toggle-wiki/warnings/missing.md"))
    await waitFor(() =>
      expect(screen.getByTestId("expand-error-wiki/warnings/missing.md")).toBeTruthy(),
    )
    expect(screen.queryByTestId("expand-content-wiki/warnings/missing.md")).toBeNull()
  })
})
