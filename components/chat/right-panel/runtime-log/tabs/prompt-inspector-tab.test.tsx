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

import type { GetPromptInspectorResponse } from "@/components/chat/right-panel/runtime-log/tabs/prompt-inspector/use-prompt-inspector-data"
import { useThreadStore } from "@/components/stores/thread-store"
import { useWakeTriggerStore } from "@/components/stores/wake-trigger-store"
import { render, screen, waitFor } from "@testing-library/react"
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
    ...overrides,
  }
}

function mockFetchResponse(payload: GetPromptInspectorResponse) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(payload),
    } as Response),
  )
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

  it("底部 4 按钮全 disabled (Week 5 实施)", async () => {
    render(<PromptInspectorTab />)
    await waitFor(() => expect(screen.queryByTestId("prompt-inspector-loading")).toBeNull())
    const bar = screen.getByTestId("prompt-inspector-buttons")
    const buttons = bar.querySelectorAll("button")
    expect(buttons.length).toBe(4)
    for (const btn of buttons) {
      expect(btn.hasAttribute("disabled")).toBe(true)
    }
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
    expect(screen.getByText(/call-xyz-from-audit/)).toBeTruthy()
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
