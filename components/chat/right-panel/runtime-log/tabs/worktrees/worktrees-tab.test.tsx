import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RUNTIME_LOG_DEFAULT_HEIGHT, useLayoutStore } from "@/components/stores/layout-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { WorktreesTab } from "./worktrees-tab"

/** F028 Task 9 · WorktreesTab（plan v5 用例 1-9，fetch 全 mock） */

const LIST = {
  worktrees: [
    { name: "main", branch: "dev", head: "aaa", path: "C:/repo", isMain: true, preview: null },
    {
      name: "F028",
      branch: "feat/F028-x",
      head: "bbb",
      path: "C:/repo/.worktrees/F028",
      isMain: false,
      preview: { apiPort: 8801, webPort: 3101, apiAlive: true, webAlive: true, ownership: "ui" },
    },
    {
      name: "F029",
      branch: "feat/F029-y",
      head: "ccc",
      path: "C:/repo/.worktrees/F029",
      isMain: false,
      preview: null,
    },
  ],
}

const SUMMARY = {
  branch: "feat/F028-x",
  head: "bbb",
  commits: [{ hash: "bbb", subject: "编排器落地", date: "2026-06-12T00:00:00+08:00" }],
  diffStat: { baseRef: "dev", files: 12, insertions: 840, deletions: 120 },
  working: { staged: 1, unstaged: 2, untracked: 3 },
}

type FetchPlan = {
  capabilities?: { control: boolean }
  action?: { status: number; body: unknown }
  list?: typeof LIST
}

let fetchCalls: string[] = []

function installFetch(plan: FetchPlan = {}) {
  fetchCalls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push(`${init?.method ?? "GET"} ${url}`)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      if (url.includes("/api/worktrees/capabilities")) return json(plan.capabilities ?? { control: true })
      if (url.match(/\/api\/worktrees\/[^/]+\/summary/)) return json(SUMMARY)
      if (url.includes("/preview/log")) return json({ lines: ["tsc done", "tsx watch ready"], logPath: "p" })
      if (url.match(/\/preview\/(compile-backend|restart|start)$/)) {
        const a = plan.action ?? { status: 200, body: { ok: true, apiPort: 8801, webPort: 3101 } }
        return json(a.body, a.status)
      }
      if (url.endsWith("/api/worktrees")) return json(plan.list ?? LIST)
      return json({ error: `unmocked ${url}` }, 500)
    }),
  )
}

function activate() {
  act(() => {
    useRuntimeLogStore.getState().setActiveLvl1("worktrees")
  })
}

beforeEach(() => {
  useRuntimeLogStore.setState({ activeLvl1: "system-prompt", collapsed: false })
  useLayoutStore.setState({ runtimeLogHeight: RUNTIME_LOG_DEFAULT_HEIGHT })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("F028 T9 · WorktreesTab", () => {
  // (8) 懒加载：lvl1 未切到不 fetch
  it("does not fetch until activeLvl1 = worktrees", async () => {
    installFetch()
    render(<WorktreesTab />)
    expect(fetchCalls.length).toBe(0)
    activate()
    await waitFor(() => expect(fetchCalls.some((c) => c.endsWith("/api/worktrees"))).toBe(true))
  })

  // (1) 列表：端口/双活/ownership；主仓行无操作钮
  it("renders rows with ports, alive badges, ownership; main row has no action buttons", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    await screen.findByTestId("worktree-row-F028")
    expect(screen.getByTestId("worktree-row-F028").textContent).toContain("8801")
    expect(screen.getByTestId("worktree-row-F028").textContent).toContain("3101")
    expect(screen.getByTestId("worktree-row-F028").textContent).toContain("UI 管理")
    const mainRow = screen.getByTestId("worktree-row-main")
    expect(mainRow.querySelectorAll("button").length).toBe(0)
  })

  // (2) 选中 → summary
  it("selecting a row loads summary with diffstat and working counts", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    const summary = await screen.findByTestId("worktree-summary")
    expect(summary.textContent).toContain("+840")
    expect(summary.textContent).toContain("-120")
    expect(summary.textContent).toContain("12")
    expect(summary.textContent).toContain("未提交")
    expect(summary.textContent).toContain("编排器落地")
  })

  // (3) 编译后端 happy：pending → 成功 + 列表刷新
  it("compile-backend shows pending then success and refetches list", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    const btn = await screen.findByTestId("wt-compile-btn")
    const listCallsBefore = fetchCalls.filter((c) => c.endsWith("/api/worktrees")).length
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId("wt-action-status").textContent).toContain("成功"))
    const listCallsAfter = fetchCalls.filter((c) => c.endsWith("/api/worktrees")).length
    expect(listCallsAfter).toBeGreaterThan(listCallsBefore)
  })

  // (4) occupied-foreign → 失败条 + message + 日志尾部自动展开
  it("occupied-foreign failure shows error and auto-expands log tail", async () => {
    installFetch({
      action: { status: 200, body: { ok: false, stage: "occupied-foreign", message: "port 8801 foreign" } },
    })
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    fireEvent.click(await screen.findByTestId("wt-compile-btn"))
    const err = await screen.findByTestId("wt-action-error")
    expect(err.textContent).toContain("port 8801 foreign")
    const log = await screen.findByTestId("wt-log-tail")
    expect(log.textContent).toContain("tsx watch ready")
  })

  // (5) 409 → 操作进行中
  it("409 shows in-progress message", async () => {
    installFetch({ action: { status: 409, body: { ok: false, stage: "in-progress", message: "busy" } } })
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    fireEvent.click(await screen.findByTestId("wt-compile-btn"))
    const err = await screen.findByTestId("wt-action-error")
    expect(err.textContent).toContain("操作进行中")
  })

  // (6) 按钮按运行态分布
  it("running row has compile/restart/open, stopped row has start only", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    await screen.findByTestId("wt-compile-btn")
    expect(screen.getByTestId("wt-restart-btn")).toBeTruthy()
    expect(screen.getByTestId("wt-open-btn")).toBeTruthy()
    expect(screen.queryByTestId("wt-start-btn")).toBeNull()

    fireEvent.click(screen.getByTestId("worktree-row-F029"))
    await screen.findByTestId("wt-start-btn")
    expect(screen.queryByTestId("wt-compile-btn")).toBeNull()
    expect(screen.queryByTestId("wt-open-btn")).toBeNull()
  })

  // (7) 打开前端 → 接管式内嵌 iframe（小孙验收反馈 ×2：不开新网页 + 嵌入要占满面板别只露一条缝）
  it("open-frontend takes over the tab with an embedded iframe and grows the panel", async () => {
    installFetch()
    const openSpy = vi.fn()
    vi.stubGlobal("open", openSpy)
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    fireEvent.click(await screen.findByTestId("wt-open-btn"))

    // 接管：iframe 出现且占据 tab，列表行隐藏；不开新窗口
    const frame = await screen.findByTestId("wt-embedded-frame")
    expect(frame.getAttribute("src")).toBe("http://localhost:3101")
    expect(screen.queryByTestId("worktree-row-F028")).toBeNull()
    expect(openSpy).not.toHaveBeenCalled()
    // 面板自动调高到 ≥600（clamp 内），默认 320 太矮只露一条缝
    expect(useLayoutStore.getState().runtimeLogHeight).toBeGreaterThanOrEqual(600)

    // 收起 → 回到列表视图，iframe 卸载
    fireEvent.click(screen.getByTestId("wt-embed-close"))
    expect(screen.queryByTestId("wt-embedded-frame")).toBeNull()
    await screen.findByTestId("worktree-row-F028")
  })

  // (9) capabilities control:false → 全禁 + 提示（德彪 r1 P2-4：打开前端同样受 control
  //     门禁——D12 "全钮禁用"，且防 preview 实例自嵌递归套娃）
  it("control:false disables all action buttons with hint", async () => {
    installFetch({ capabilities: { control: false } })
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    const btn = await screen.findByTestId("wt-compile-btn")
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("wt-restart-btn") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("wt-open-btn") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("wt-control-hint").textContent).toContain("主 UI")
  })

  // 德彪 r1 P2-4：webAlive=false（web 死、api 活）→ 打开前端不渲染（嵌死端口无意义）
  it("open-frontend button hidden when web port not alive", async () => {
    const list = {
      worktrees: LIST.worktrees.map((w) =>
        w.name === "F028" && w.preview ? { ...w, preview: { ...w.preview, webAlive: false } } : w,
      ),
    }
    installFetch({ list: list as typeof LIST })
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    await screen.findByTestId("wt-compile-btn") // api 活 → running 钮组仍在
    expect(screen.queryByTestId("wt-open-btn")).toBeNull()
  })
})
