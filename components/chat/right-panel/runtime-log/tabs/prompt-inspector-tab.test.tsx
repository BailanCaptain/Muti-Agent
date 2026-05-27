/**
 * F027 Phase 3 Week 4 Day 14-15 (AC-P3-3 + AC-P3-5) · PromptInspectorTab 单元测试
 *
 * 覆盖:
 *   - 7 块 section 都渲染 (data-testid 完整)
 *   - HeaderRow / InjectedPartsTable / RecallSection / AdaptiveRecallPolicy 渲染
 *   - empty state (fetch 失败 / empty response)
 *   - WS wake-trigger 优先于 API trigger
 *   - Quality Gate badge 颜色
 *   - 底部 4 按钮 disabled (Week 5 实施)
 *
 * 注：fetch 调用通过 vitest mock 全局 fetch（避免真发请求）。
 */

import type { GetCoverageResponse } from "@/components/chat/right-panel/runtime-log/tabs/prompt-inspector/use-decisions-coverage-data"
import type { GetPromptInspectorResponse } from "@/components/chat/right-panel/runtime-log/tabs/prompt-inspector/use-prompt-inspector-data"
import { useA2ADrawerStore } from "@/components/stores/a2a-drawer-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { useWakeTriggerStore } from "@/components/stores/wake-trigger-store"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PromptInspectorTab } from "./prompt-inspector-tab"

function makeResponse(
  overrides: Partial<GetPromptInspectorResponse> = {},
): GetPromptInspectorResponse {
  return {
    injectedParts: [],
    recallQueries: [],
    recallState: {
      recallRequired: false,
      recallPath: null,
      recallSatisfied: false,
      escalateReason: null,
      budgetConsumed: 0,
      budgetMax: 4000,
    },
    wakeUpTrigger: { kind: null, ref: null },
    // P4 hotfix 新 4 字段默认值
    rawText: null,
    ironLawsCount: 0,
    scenario: null,
    previousAudits: [],
    // F027 v3 G1 · V16.5 chap 20 token cap + drop reducer 新 2 字段默认值
    cap: 0,
    notInjectedParts: [],
    ...overrides,
  }
}

function makeCoverageResponse(overrides: Partial<GetCoverageResponse> = {}): GetCoverageResponse {
  return {
    broad: [],
    resolved: [],
    unresolved: [],
    coverage: null,
    status: "fail",
    generatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

/**
 * Mock fetch — 按 URL 分流 prompt-inspector vs decisions/coverage endpoint。
 * (Day 13 加 coverage section 后单一 mock response 不再适用 — coverage shape 不同)
 */
function mockFetchResponse(
  payload: GetPromptInspectorResponse,
  coverage: GetCoverageResponse = makeCoverageResponse(),
) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    const body = url.includes("/decisions/coverage") ? coverage : payload
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
    } as Response)
  })
}

function resetStores() {
  useWakeTriggerStore.setState({ latestByKey: new Map() })
  // 设 activeGroup roomId 让 PromptInspectorTab 能拿
  useThreadStore.setState({
    // biome-ignore lint/suspicious/noExplicitAny: stub minimum activeGroup
    activeGroup: { roomId: "R-201" } as any,
  })
}

describe("PromptInspectorTab 7 块渲染", () => {
  beforeEach(() => {
    resetStores()
    mockFetchResponse(makeResponse())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("渲染 7 块 + data-testid 完整", async () => {
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("prompt-inspector-loading")).toBeNull())
    expect(screen.getByTestId("prompt-inspector-tab")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-header")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-injected")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-not-injected")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-recall")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-policy")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-agent-session")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-wake-trigger")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-buttons")).toBeTruthy()
  })

  it("空 response → 显示 '暂无 part 数据' / '暂无召回 query' 占位", async () => {
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("prompt-inspector-loading")).toBeNull())
    expect(screen.getByText(/暂无 part 数据/)).toBeTruthy()
    expect(screen.getByText(/暂无召回 query/)).toBeTruthy()
  })

  it("底部 4 按钮：空 audit 时全 disabled，rawText 在时'查看原文/复制全文'可点", async () => {
    // 空 response（rawText=null）→ 全 disabled
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("prompt-inspector-loading")).toBeNull())
    const bar = screen.getByTestId("prompt-inspector-buttons")
    const buttons = bar.querySelectorAll("button")
    expect(buttons.length).toBe(4)
    for (const btn of buttons) {
      expect(btn.hasAttribute("disabled")).toBe(true)
    }
  })

  it("rawText 非空 → '查看原文' + '复制全文' enabled，另两个仍 disabled (F028)", async () => {
    mockFetchResponse(
      makeResponse({
        rawText: "SYSTEM: 你是黄仁勋\n\n---\n\n[task] 你好",
        ironLawsCount: 1,
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("prompt-inspector-buttons")).toBeTruthy())
    const bar = screen.getByTestId("prompt-inspector-buttons")
    const buttons = bar.querySelectorAll("button")
    expect(buttons.length).toBe(4)
    // 头两个 enabled (查看原文 + 复制全文)
    expect(buttons[0].hasAttribute("disabled")).toBe(false)
    expect(buttons[1].hasAttribute("disabled")).toBe(false)
    // 后两个 disabled (对比上次 + 追溯 wiki)
    expect(buttons[2].hasAttribute("disabled")).toBe(true)
    expect(buttons[3].hasAttribute("disabled")).toBe(true)
    // 点击 "查看原文" → pre 出现
    fireEvent.click(buttons[0])
    await waitFor(() =>
      expect(screen.queryByTestId("prompt-inspector-raw-text")).toBeTruthy(),
    )
    expect(screen.getByTestId("prompt-inspector-raw-text").textContent).toMatch(/黄仁勋/)
    // Iron Laws 检测显示
    expect(bar.textContent).toMatch(/Iron Laws 检测/)
  })
})

describe("PromptInspectorTab 注入 part 表渲染", () => {
  beforeEach(() => {
    resetStores()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("含 parts → 渲染 table 行 + token 总账", async () => {
    mockFetchResponse(
      makeResponse({
        injectedParts: [
          { name: "IronLaws", bytes: 600, tokensEstimated: 150, source: "shared-rules" },
          { name: "Viewfinder", bytes: 4720, tokensEstimated: 1180, source: "P12 ledger" },
        ],
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByText(/IronLaws/)).toBeTruthy())
    expect(screen.getByText("Viewfinder")).toBeTruthy()
    // 总账：150 + 1180 = 1330
    expect(screen.getByText(/总计 1330 tok/)).toBeTruthy()
  })

  // F027 P4-A5 · 追溯按钮扩接 capability-digest + handbook-agent-actions
  it("P4-A5: viewfinder / capability-digest / handbook-agent-actions part 都显示追溯按钮（其他 part —）", async () => {
    mockFetchResponse(
      makeResponse({
        injectedParts: [
          { name: "viewfinder", bytes: 100, tokensEstimated: 25, source: "viewfinder.md" },
          {
            name: "capability-digest",
            bytes: 200,
            tokensEstimated: 50,
            source: "agent-capabilities.yaml",
          },
          {
            name: "handbook-agent-actions",
            bytes: 300,
            tokensEstimated: 75,
            source: "agent-wiki-handbook.md",
          },
          { name: "rolling-summary", bytes: 400, tokensEstimated: 100, source: "summary" },
        ],
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("trace-btn-viewfinder")).toBeTruthy())
    expect(screen.getByTestId("trace-btn-capability-digest")).toBeTruthy()
    expect(screen.getByTestId("trace-btn-handbook-agent-actions")).toBeTruthy()
    // rolling-summary 不应有追溯按钮（动态派生 part 无固定 wiki 源）
    expect(screen.queryByTestId("trace-btn-rolling-summary")).toBeNull()
  })
})

describe("PromptInspectorTab Recall Quality Gate badges", () => {
  beforeEach(() => {
    resetStores()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("高/中/低 gate 计数正确", async () => {
    mockFetchResponse(
      makeResponse({
        recallQueries: [
          { query: "F011 drizzle", hits: 3, gate: "high", topScore: 0.87 },
          { query: "context", hits: 2, gate: "high", topScore: 0.81 },
          { query: "memory 防漂", hits: 1, gate: "mid", topScore: 0.66 },
          { query: "noop reranker", hits: 0, gate: "low", topScore: 0.42 },
        ],
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("recall-gate-high")).toBeTruthy())
    expect(screen.getByTestId("recall-gate-high").textContent).toMatch(/高 2/)
    expect(screen.getByTestId("recall-gate-mid").textContent).toMatch(/中 1/)
    expect(screen.getByTestId("recall-gate-low").textContent).toMatch(/低 1/)
  })
})

describe("PromptInspectorTab Adaptive Recall Policy", () => {
  beforeEach(() => {
    resetStores()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("recallRequired=true + Level 2 + satisfied 渲染", async () => {
    mockFetchResponse(
      makeResponse({
        recallState: {
          recallRequired: true,
          recallPath: 2,
          recallSatisfied: true,
          escalateReason: null,
          budgetConsumed: 180,
          budgetMax: 4000,
        },
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByText(/Level 2/)).toBeTruthy())
    const policy = screen.getByTestId("prompt-inspector-policy")
    expect(policy.textContent).toMatch(/recallRequired:.*✅/)
    expect(policy.textContent).toMatch(/recallSatisfied:.*✅/)
    expect(policy.textContent).toMatch(/budget: 180 \/ 4000/)
  })

  it("escalate Level 5 → 显示 escalate reason 红色", async () => {
    mockFetchResponse(
      makeResponse({
        recallState: {
          recallRequired: true,
          recallPath: 5,
          recallSatisfied: false,
          escalateReason: "Level 4 strict path 不存在",
          budgetConsumed: 3800,
          budgetMax: 4000,
        },
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByText(/escalate/)).toBeTruthy())
    expect(screen.getByText(/Level 4 strict path 不存在/)).toBeTruthy()
  })
})

describe("PromptInspectorTab WakeTrigger (WS 优先 / API fallback)", () => {
  beforeEach(() => {
    resetStores()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("WS store 有 trigger → 显示 WS data (data-testid wake-trigger-ws)", async () => {
    mockFetchResponse(makeResponse())
    useWakeTriggerStore.getState().recordTrigger({
      threadId: "t1",
      sessionGroupId: "g1",
      roomId: "R-201",
      alias: "黄仁勋",
      scenario: "a2a_handoff",
      a2aCallId: "call-abc",
      triggeredAt: "2026-05-22T17:23:45Z",
    })
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("wake-trigger-ws")).toBeTruthy())
    const ws = screen.getByTestId("wake-trigger-ws")
    expect(ws.textContent).toMatch(/黄仁勋/)
    expect(ws.textContent).toMatch(/call-abc/)
    expect(ws.textContent).toMatch(/a2a_handoff/)
  })

  it("WS store 空 + API trigger 有 → 显示 API snapshot (wake-trigger-api)", async () => {
    mockFetchResponse(
      makeResponse({
        wakeUpTrigger: { kind: "a2a_call", ref: "call-xyz-from-audit" },
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("wake-trigger-api")).toBeTruthy())
    // Day 20: a2a_call kind ref 走 WakeTriggerA2APill (data-call-id 保留 full id)
    const pill = screen.getByTestId("wake-trigger-a2a-pill-call-xyz-from")
    expect(pill.getAttribute("data-call-id")).toBe("call-xyz-from-audit")
  })

  // Day 20 r1 P3 fix (范-r1): wake-trigger pill click → store glue
  it("Day 20 P3 fix: WS trigger pill click → openDrawer('prompt-inspector')", async () => {
    useA2ADrawerStore.setState({ callId: null, source: null })
    mockFetchResponse(makeResponse())
    useWakeTriggerStore.getState().recordTrigger({
      threadId: "T-1",
      sessionGroupId: "G-1",
      roomId: "R-201",
      alias: "黄仁勋",
      scenario: "a2a_handoff",
      a2aCallId: "call-ws-click-test",
      triggeredAt: "2026-05-23T01:00:00Z",
    })
    render(<PromptInspectorTab />)
    await waitFor(() =>
      expect(screen.queryByTestId("wake-trigger-a2a-pill-call-ws-click")).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId("wake-trigger-a2a-pill-call-ws-click"))
    const drawerState = useA2ADrawerStore.getState()
    expect(drawerState.callId).toBe("call-ws-click-test")
    expect(drawerState.source).toBe("prompt-inspector")
    useA2ADrawerStore.setState({ callId: null, source: null })
  })

  it("WS 跨房间不串 — 只渲染当前 roomId 的 trigger", async () => {
    mockFetchResponse(makeResponse())
    // 注一个其他 room 的 trigger
    useWakeTriggerStore.getState().recordTrigger({
      threadId: "t1",
      sessionGroupId: "g999",
      roomId: "R-999",
      alias: "桂芬",
      scenario: "wake_up",
      a2aCallId: null,
      triggeredAt: "2026-05-22T17:00:00Z",
    })
    render(<PromptInspectorTab />)
    // 当前 R-201 → 不该看到 R-999 的 trigger
    await waitFor(() => expect(screen.queryByTestId("prompt-inspector-tab")).toBeTruthy())
    expect(screen.queryByTestId("wake-trigger-ws")).toBeNull()
  })

  it("WS + API 都空 → 显示 '暂无 trigger' 占位", async () => {
    mockFetchResponse(makeResponse())
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByText(/暂无 trigger/)).toBeTruthy())
  })
})

// ─── r2 范-r1 P1 + P2 wire fix tests ──────────────────────────────

describe("PromptInspectorTab r2 P1: fetch 用 API_BASE_URL (not same-origin)", () => {
  beforeEach(() => {
    resetStores()
    // 默认 activeLvl2 = prompt-inspector → enabled=true → fetch 会触发
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("fetch URL 含 http://localhost:8787 (不是 same-origin /api/...)", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.resolve(makeResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<PromptInspectorTab />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const url = fetchMock.mock.calls[0]?.[0]
    expect(url).toBeTruthy()
    // 必须含 http://localhost:8787 (env 默认 fallback) — 防 P1 regression
    expect(String(url)).toMatch(/^http:\/\/localhost:8787\//)
    // P4 hotfix · 加 ?limit=N 参数支持"对比上次"按钮
    expect(String(url)).toMatch(/\/api\/rooms\/R-201\/prompt-inspector(\?|$)/)
  })
})

describe("PromptInspectorTab r2 P2: enabled flag wired to activeLvl2", () => {
  beforeEach(() => {
    resetStores()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("activeLvl2=prompt-inspector → fetch 触发 (prompt-inspector + decisions/coverage 各 1)", async () => {
    const { useRuntimeLogStore } = await import("@/components/stores/runtime-log-store")
    useRuntimeLogStore.setState({ activeLvl2: "prompt-inspector" })
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      const body = url.includes("/decisions/coverage") ? makeCoverageResponse() : makeResponse()
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as Response)
    })
    globalThis.fetch = fetchMock
    render(<PromptInspectorTab />)
    // Day 13 加 coverage section → fetch 改成 2 个 (prompt-inspector + decisions/coverage)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    // P4 hotfix · prompt-inspector URL 现在带 ?limit=2
    expect(urls.some((u) => /\/prompt-inspector(\?|$)/.test(u))).toBe(true)
    expect(urls.some((u) => u.endsWith("/decisions/coverage"))).toBe(true)
  })

  it("activeLvl2=viewfinder → fetch 不触发 (enabled=false)", async () => {
    const { useRuntimeLogStore } = await import("@/components/stores/runtime-log-store")
    useRuntimeLogStore.setState({ activeLvl2: "viewfinder" })
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeResponse()),
      } as Response),
    )
    globalThis.fetch = fetchMock
    render(<PromptInspectorTab />)
    // 等一点时间让任何 fetch 触发，然后断言确实没 fetch
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("PromptInspectorTab AC-P4-9 c Coverage section (Day 13)", () => {
  beforeEach(async () => {
    resetStores()
    const { useRuntimeLogStore } = await import("@/components/stores/runtime-log-store")
    useRuntimeLogStore.setState({ activeLvl2: "prompt-inspector" })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("(P4-D13-1) empty coverage → empty 占位 + fail status badge", async () => {
    mockFetchResponse(makeResponse(), makeCoverageResponse())
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("prompt-inspector-coverage")).toBeTruthy())
    expect(screen.getByTestId("coverage-empty")).toBeTruthy()
    expect(screen.getByText(/FAIL/)).toBeTruthy()
  })

  it("(P4-D13-2) unresolved 2 份 + 88% coverage → 列表 + WARN badge", async () => {
    mockFetchResponse(
      makeResponse(),
      makeCoverageResponse({
        broad: Array.from({ length: 10 }, (_, i) => ({
          decisionId: `${i}`,
          summary: `b${i}`,
          state: "active",
          decisionType: "spec",
          decidedBy: "alice",
          decidedAt: "2026-05-23T00:00:00Z",
        })),
        resolved: Array.from({ length: 8 }, (_, i) => ({
          decisionId: `r${i}`,
          summary: `r${i}`,
          state: "completed",
          decisionType: "commit",
          decidedBy: "bob",
          decidedAt: "2026-05-23T00:00:00Z",
        })),
        unresolved: [
          {
            decisionId: "u1",
            summary: "未闭环的 spec — RAG 召回 budget 上限",
            state: "active",
            decisionType: "spec",
            decidedBy: "小孙",
            decidedAt: "2026-05-23T03:00:00Z",
          },
          {
            decisionId: "u2",
            summary: "未闭环的 pivot — V14 三步检测顺序",
            state: "active",
            decisionType: "pivot",
            decidedBy: "黄仁勋",
            decidedAt: "2026-05-23T05:00:00Z",
          },
        ],
        coverage: 0.8,
        status: "warn",
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("coverage-unresolved-list")).toBeTruthy())
    expect(screen.getByText(/WARN/)).toBeTruthy()
    expect(screen.getByText(/80%/)).toBeTruthy()
    expect(screen.getByText(/8 resolved \/ 10 broad, 2 unresolved/)).toBeTruthy()
    expect(screen.getByTestId("coverage-unresolved-u1")).toBeTruthy()
    expect(screen.getByTestId("coverage-unresolved-u2")).toBeTruthy()
    expect(screen.getByTestId("coverage-decision-type-u1").textContent).toMatch(/spec/)
    expect(screen.getByText(/RAG 召回 budget 上限/)).toBeTruthy()
  })

  it("(P4-D13-3) click [Confirm] → DecisionSupersedeRejectModal 弹出 (final-vision P1-1)", async () => {
    mockFetchResponse(
      makeResponse(),
      makeCoverageResponse({
        broad: [
          {
            decisionId: "u1",
            summary: "test",
            state: "active",
            decisionType: "spec",
            decidedBy: "小孙",
            decidedAt: "2026-05-23T00:00:00Z",
          },
        ],
        resolved: [],
        unresolved: [
          {
            decisionId: "u1",
            summary: "test",
            state: "active",
            decisionType: "spec",
            decidedBy: "小孙",
            decidedAt: "2026-05-23T00:00:00Z",
          },
        ],
        coverage: 0,
        status: "warn",
      }),
    )
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("coverage-confirm-button-u1")).toBeTruthy())
    // modal 默认 closed (window.alert 占位已撤; final-vision P1-1)
    expect(screen.queryByTestId("decision-supersede-reject-modal")).toBeNull()
    fireEvent.click(screen.getByTestId("coverage-confirm-button-u1"))
    // click → modal 弹出，target id/type 显示
    await waitFor(() =>
      expect(screen.queryByTestId("decision-supersede-reject-modal")).toBeTruthy(),
    )
    const modal = screen.getByTestId("decision-supersede-reject-modal")
    expect(modal.textContent).toContain("u1")
    expect(modal.textContent).toContain("spec")
    // 取消 → modal 关闭
    fireEvent.click(screen.getByTestId("decision-supersede-reject-cancel"))
    await waitFor(() =>
      expect(screen.queryByTestId("decision-supersede-reject-modal")).toBeNull(),
    )
  })

  it("(P4-D13-4) coverage fetch 失败 → coverage-error 显示", async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/decisions/coverage")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: () => Promise.resolve({}),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(makeResponse()),
      } as Response)
    })
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("coverage-error")).toBeTruthy())
    expect(screen.getByTestId("coverage-error").textContent).toMatch(/coverage 加载失败/)
  })
})
