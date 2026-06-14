import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RUNTIME_LOG_DEFAULT_HEIGHT, useLayoutStore } from "@/components/stores/layout-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { WorktreesTab } from "./worktrees-tab"

/** F028 Task 9 · WorktreesTab（plan v5 用例 1-9，fetch 全 mock） */

const LIST = {
  worktrees: [
    { name: "main", branch: "dev", head: "aaa", path: "C:/repo", isMain: true, preview: null, mergeStatus: null },
    {
      name: "F028",
      branch: "feat/F028-x",
      head: "bbb",
      path: "C:/repo/.worktrees/F028",
      isMain: false,
      preview: { apiPort: 8801, webPort: 3101, apiAlive: true, webAlive: true, ownership: "ui" },
      mergeStatus: { ahead: 0, behind: 2, mergedHint: true }, // 已含 dev → 可清理
    },
    {
      name: "F029",
      branch: "feat/F029-y",
      head: "ccc",
      path: "C:/repo/.worktrees/F029",
      isMain: false,
      preview: null,
      mergeStatus: { ahead: 5, behind: 0, mergedHint: false }, // 未含 → 不可清理
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
  cleanup?: unknown
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
      if (url.endsWith("/cleanup")) {
        return json(
          plan.cleanup ?? {
            ok: true,
            steps: [
              { name: "safety-gate", ok: true },
              { name: "worktree-remove", ok: true },
            ],
          },
        )
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

// ── 续作 AC11 · 列表合并状态 + 可清理标记 ──────────────────────────────────
describe("F028 续作 AC11 · 合并状态", () => {
  it("mergedHint=true 行显示「本地 dev 已包含提交」+「可清理」", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    const f028 = await screen.findByTestId("worktree-row-F028")
    expect(f028.textContent).toContain("本地 dev 已包含提交")
    expect(screen.getByTestId("wt-cleanable-F028")).toBeTruthy()
  })

  it("mergedHint=false 行不显示已包含徽标、不可清理，但显示 ahead/behind", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    const f029 = await screen.findByTestId("worktree-row-F029")
    expect(f029.textContent).not.toContain("本地 dev 已包含提交")
    expect(screen.queryByTestId("wt-cleanable-F029")).toBeNull()
    expect(f029.textContent).toMatch(/↑\s*5|ahead 5|\+5/) // ahead 计数可见
  })

  it("mergeStatus=null（主仓/降级）不崩、不显示可清理", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    const main = await screen.findByTestId("worktree-row-main")
    expect(main.textContent).not.toContain("本地 dev 已包含提交")
    expect(screen.queryByTestId("wt-cleanable-main")).toBeNull()
  })
})

// ── 续作 AC12 · 清理按钮 ────────────────────────────────────────────────────
describe("F028 续作 AC12 · 清理 worktree", () => {
  it("可清理行（mergedHint=true）选中后 ActionBar 出现「清理」按钮", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    expect(await screen.findByTestId("wt-cleanup-btn")).toBeTruthy()
  })

  // 德彪愿景 review P0：mergedHint 只是 advisory 徽标，绝不作清理按钮硬门——merge-gate 走
  // squash，feature 做完 squash 合 dev 后 is-ancestor=false → mergedHint=false，若按它硬门
  // 则恰好在小孙要清理的时刻按钮消失。故 mergedHint=false 的非主仓行仍必须有「清理」按钮。
  it("未含 dev 的行（mergedHint=false，模拟 squash 合并后）仍有「清理」按钮，但无「已包含提交」徽标", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F029"))
    await screen.findByTestId("wt-start-btn") // 未运行 → 启动钮在
    expect(await screen.findByTestId("wt-cleanup-btn")).toBeTruthy() // 清理按钮在（后端安全门兜底）
    expect(screen.queryByTestId("wt-cleanable-F029")).toBeNull() // 但 advisory 徽标不在
  })

  // 主仓**绝不**出现清理按钮（Iron Law / 安全不变量），无论 mergeStatus 如何
  it("主仓行无「清理」按钮（never cleanable）", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-main"))
    // 等列表就绪
    await screen.findByTestId("worktree-row-F028")
    expect(screen.queryByTestId("wt-cleanup-btn")).toBeNull()
  })

  it("清理需二次确认：点「清理」→ 确认钮出现；点「确认清理」→ 调 /cleanup + 渲染 steps", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    fireEvent.click(await screen.findByTestId("wt-cleanup-btn"))
    // 二次确认出现，且此时还没调 /cleanup
    const confirm = await screen.findByTestId("wt-cleanup-confirm")
    expect(fetchCalls.some((c) => c.includes("/cleanup"))).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(fetchCalls.some((c) => c.startsWith("POST") && c.includes("/cleanup"))).toBe(true),
    )
    // steps 结果可见
    await waitFor(() => expect(screen.getByTestId("wt-cleanup-result")).toBeTruthy())
    expect(screen.getByTestId("wt-cleanup-result").textContent).toContain("worktree-remove")
  })

  it("清理成功后刷新列表（再次 GET /api/worktrees）", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    fireEvent.click(await screen.findByTestId("wt-cleanup-btn"))
    const before = fetchCalls.filter((c) => c.endsWith("/api/worktrees")).length
    fireEvent.click(await screen.findByTestId("wt-cleanup-confirm"))
    await waitFor(() => {
      const after = fetchCalls.filter((c) => c.endsWith("/api/worktrees")).length
      expect(after).toBeGreaterThan(before)
    })
  })

  // 德彪 code-r4 P2：git worktree remove 非原子——「已注销但有残留」后端返 ok:false，
  // 但 worktree 已从 git 消失。前端必须**始终**刷新 inventory（不能只在 ok 时刷），否则
  // 已注销的行会赖在列表里，违反 AC12「即时从列表消失」。
  it("清理已注销但残留（ok:false）仍刷新列表（AC12 即时消失）", async () => {
    installFetch({
      cleanup: {
        ok: false,
        steps: [
          { name: "safety-gate", ok: true },
          { name: "stop-preview", ok: true },
          { name: "rm-artifacts", ok: true },
          {
            name: "worktree-remove",
            ok: false,
            message: "git worktree remove 中途失败但 worktree 已注销，残留目录需人工删",
          },
          { name: "branch-delete", ok: true },
          { name: "release-ports", ok: true },
          { name: "delete-state", ok: true },
        ],
      },
    })
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    fireEvent.click(await screen.findByTestId("wt-cleanup-btn"))
    const before = fetchCalls.filter((c) => c.endsWith("/api/worktrees")).length
    fireEvent.click(await screen.findByTestId("wt-cleanup-confirm"))
    // 结果展示「清理未完成」+ 残留提示
    const result = await screen.findByTestId("wt-cleanup-result")
    expect(result.textContent).toContain("清理未完成")
    expect(result.textContent).toContain("残留")
    // 关键：ok:false 也必须刷新列表（worktree 已注销）
    await waitFor(() => {
      const after = fetchCalls.filter((c) => c.endsWith("/api/worktrees")).length
      expect(after).toBeGreaterThan(before)
    })
  })
})

// ── 续作 AC12 · 德彪 code-r1 P2 加固 ───────────────────────────────────────
describe("F028 续作 AC12 · P2 加固", () => {
  // P2-2：后端异常（无 steps 的体，如 500）→ UI 不崩，展示失败
  it("清理响应畸形（无 steps）→ 不崩 + 展示失败", async () => {
    installFetch({ cleanup: { error: "INTERNAL_ERROR", message: "boom" } }) // 无 ok/steps
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    fireEvent.click(await screen.findByTestId("wt-cleanup-btn"))
    fireEvent.click(await screen.findByTestId("wt-cleanup-confirm"))
    const result = await screen.findByTestId("wt-cleanup-result")
    expect(result.textContent).toContain("清理未完成") // 合成失败，没有 .steps.map 崩溃
  })

  // P2-1：cleanup 二次确认期间，preview 操作钮禁用（防在将删的 worktree 上起操作）
  it("cleanup 确认中 → preview 操作钮禁用", async () => {
    installFetch()
    render(<WorktreesTab />)
    activate()
    fireEvent.click(await screen.findByTestId("worktree-row-F028"))
    const compile = (await screen.findByTestId("wt-compile-btn")) as HTMLButtonElement
    expect(compile.disabled).toBe(false)
    fireEvent.click(screen.getByTestId("wt-cleanup-btn")) // 进 confirming
    await screen.findByTestId("wt-cleanup-confirm")
    expect((screen.getByTestId("wt-compile-btn") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId("wt-restart-btn") as HTMLButtonElement).disabled).toBe(true)
  })
})
