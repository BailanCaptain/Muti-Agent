import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  RUNTIME_LOG_LVL1_ITEMS,
  useRuntimeLogStore,
} from "@/components/stores/runtime-log-store"
import { ProjectTreeTab } from "./project-tree-tab"

/** F028 Task 15 · ProjectTreeTab（plan v5：根切换/懒加载+缓存/只读内容/truncated/错误条/懒 fetch） */

let fetchCalls: string[] = []

function installFetch(opts: { contentStatus?: number; truncated?: boolean } = {}) {
  fetchCalls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      fetchCalls.push(url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      if (url.includes("/api/project-tree/roots")) {
        return json({ roots: [{ id: "main", label: "主仓" }, { id: "wt:F028", label: "F028" }] })
      }
      if (url.includes("/api/project-tree/list")) {
        const dir = new URL(url).searchParams.get("dir") ?? ""
        if (dir === "") {
          return json({ entries: [{ name: "src", type: "dir", size: null }, { name: "README.md", type: "file", size: 4 }], truncated: false })
        }
        return json({ entries: [{ name: "a.ts", type: "file", size: 9 }], truncated: false })
      }
      if (url.includes("/api/project-tree/content")) {
        if (opts.contentStatus && opts.contentStatus !== 200) {
          return json({ error: "boom", code: "PATH_INVALID" }, opts.contentStatus)
        }
        return json({ content: "export const x = 1", mtime: "2026-06-12T00:00:00Z", truncated: opts.truncated ?? false })
      }
      return json({ error: `unmocked ${url}` }, 500)
    }),
  )
}

function activate() {
  act(() => {
    useRuntimeLogStore.getState().setActiveLvl1("project-tree")
  })
}

beforeEach(() => {
  useRuntimeLogStore.setState({ activeLvl1: "system-prompt", collapsed: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("F028 T15 · ProjectTreeTab", () => {
  it("store registers project-tree as enabled LVL1 item", () => {
    const item = RUNTIME_LOG_LVL1_ITEMS.find((i) => i.key === "project-tree")
    expect(item?.enabled).toBe(true)
    expect(item?.label).toBe("项目目录")
  })

  // 懒 fetch：切到才 roots
  it("fetches roots only after activeLvl1 = project-tree", async () => {
    installFetch()
    render(<ProjectTreeTab />)
    expect(fetchCalls.length).toBe(0)
    activate()
    await waitFor(() => expect(fetchCalls.some((c) => c.includes("/roots"))).toBe(true))
  })

  // 根切换器 + 顶层列表
  it("renders root switcher and top-level entries", async () => {
    installFetch()
    render(<ProjectTreeTab />)
    activate()
    const switcher = await screen.findByTestId("pt-root-switcher")
    expect(switcher.textContent).toContain("主仓")
    expect(switcher.textContent).toContain("F028")
    await screen.findByTestId("pt-entry-src")
    await screen.findByTestId("pt-entry-README.md")
  })

  // 懒加载展开 + 子目录缓存（再次展开不重 fetch）
  it("expands dir lazily and caches children", async () => {
    installFetch()
    render(<ProjectTreeTab />)
    activate()
    fireEvent.click(await screen.findByTestId("pt-entry-src"))
    await screen.findByTestId("pt-entry-src/a.ts")
    const listCalls = () => fetchCalls.filter((c) => c.includes("dir=src")).length
    const before = listCalls()
    fireEvent.click(screen.getByTestId("pt-entry-src")) // 收起
    fireEvent.click(screen.getByTestId("pt-entry-src")) // 再展开（缓存，不重 fetch）
    await screen.findByTestId("pt-entry-src/a.ts")
    expect(listCalls()).toBe(before)
  })

  // 点文件 → <pre> 内容 + mtime
  it("clicking a file shows read-only content with mtime", async () => {
    installFetch()
    render(<ProjectTreeTab />)
    activate()
    fireEvent.click(await screen.findByTestId("pt-entry-README.md"))
    const pre = await screen.findByTestId("pt-content")
    expect(pre.textContent).toContain("export const x = 1")
    expect(screen.getByTestId("pt-content-meta").textContent).toContain("2026-06-12")
  })

  // truncated 提示条
  it("shows truncated banner when content is clipped", async () => {
    installFetch({ truncated: true })
    render(<ProjectTreeTab />)
    activate()
    fireEvent.click(await screen.findByTestId("pt-entry-README.md"))
    await screen.findByTestId("pt-truncated-banner")
  })

  // 400/404 错误条不崩
  it("shows error banner on 400/404 without crashing", async () => {
    installFetch({ contentStatus: 400 })
    render(<ProjectTreeTab />)
    activate()
    fireEvent.click(await screen.findByTestId("pt-entry-README.md"))
    const err = await screen.findByTestId("pt-error")
    expect(err.textContent?.length).toBeGreaterThan(0)
  })
})
