import type { PendingChangePayload, Provider, TimelineMessage } from "@multi-agent/shared"
import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useThreadStore } from "../stores/thread-store"
import { ConnectorBubble } from "./connector-bubble"

/**
 * F026 P5 · ConnectorBubble 接入测试
 *
 * 验证 a2a 派发 connector message（`a2aCallId` 非空）触发 F2/F3/F4/F5/F7/F8 视觉原语；
 * 普通 multi_mention connector（`a2aCallId` 为空 / 并行思考聚合）保持 indigo 渐变全宽样式不变。
 */

function makeA2aConnector(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  const base: TimelineMessage = {
    id: "msg-a2a-1",
    provider: "codex" as Provider,
    alias: "范德彪",
    role: "assistant",
    content: "",
    messageType: "connector",
    model: null,
    createdAt: "2026-04-29T10:00:00Z",
    a2aCallId: "call-1",
    connectorSource: {
      kind: "multi_mention_result",
      label: "A2A 协助",
      fromAlias: "黄仁勋",
      toAlias: "范德彪",
      targets: ["codex" as Provider],
    },
  }
  return { ...base, ...overrides }
}

function makeMultiMention(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  const base: TimelineMessage = {
    id: "msg-mm-1",
    provider: "claude" as Provider,
    alias: "黄仁勋",
    role: "assistant",
    content: "聚合内容",
    messageType: "connector",
    model: null,
    createdAt: "2026-04-29T10:00:00Z",
    connectorSource: {
      kind: "multi_mention_result",
      label: "并行思考结果",
      targets: ["codex" as Provider, "gemini" as Provider],
    },
  }
  return { ...base, ...overrides }
}

describe("ConnectorBubble · a2a 视觉原语接入 (F2-F8)", () => {
  it("F2 · 渲染溯源胶囊当 a2aOnBehalfOf 非空", () => {
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aConvenerId: "claude:黄仁勋",
          a2aOnBehalfOf: "user:村长",
        })}
      />,
    )
    expect(screen.getByTestId("origin-capsule")).toBeTruthy()
  })

  it("F3 · 渲染超时墓碑当 a2aCallStatus='timeout'", () => {
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aConvenerId: "claude:黄仁勋",
          a2aCallStatus: "timeout",
        })}
      />,
    )
    expect(screen.getByTestId("timeout-tombstone")).toBeTruthy()
  })

  it("F4 · sub-call 时 outer wrap 加缩进半透明 className", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aParentCallId: "parent-call-1",
        })}
      />,
    )
    const outer = container.firstChild as HTMLElement
    expect(outer.className).toMatch(/ml-8/)
    expect(outer.className).toMatch(/opacity-60/)
  })

  it("F5 · display_mode=nested 时 inner card 加 border-2", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aDisplayMode: "nested",
        })}
      />,
    )
    // inner card 在 outer wrap 内部
    const innerCard = container.querySelector(
      '[data-testid="connector-bubble-card"]',
    ) as HTMLElement
    expect(innerCard).toBeTruthy()
    expect(innerCard.className).toMatch(/border-2/)
  })

  it("F7 · sub-call 时 outer wrap 加紫底 bg-purple-50/30", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aParentCallId: "parent-call-1",
        })}
      />,
    )
    const outer = container.firstChild as HTMLElement
    expect(outer.className).toMatch(/bg-purple-50/)
  })

  it("F1 · 渲染 AtPill 状态机（a2aCallStatus='working' → data-status='working' + toAlias）", () => {
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallStatus: "working",
        })}
      />,
    )
    const pill = screen.getByTestId("at-pill")
    expect(pill.dataset.status).toBe("working")
    expect(pill.textContent).toMatch(/范德彪/)
    expect(pill.textContent).toMatch(/处理中/)
  })

  it("F1 · 缺 a2aCallStatus 时 pill 显示 sending（fallback 状态）", () => {
    render(<ConnectorBubble message={makeA2aConnector()} />)
    const pill = screen.getByTestId("at-pill")
    expect(pill.dataset.status).toBe("sending")
  })

  it("F1 · a2aCallStatus='timeout' 时 pill 显示 timeout（与 F3 墓碑共存，pill 在 header）", () => {
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallStatus: "timeout",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("timeout")
    expect(screen.getByTestId("timeout-tombstone")).toBeTruthy()
  })

  it("F8 · display_mode=background 时返回 null（不渲染气泡）", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aDisplayMode: "background",
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("a2a 分支不沿用 multi_mention 的 indigo 渐变全宽样式", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aConvenerId: "claude:黄仁勋",
          a2aOnBehalfOf: "user:村长",
        })}
      />,
    )
    const innerCard = container.querySelector(
      '[data-testid="connector-bubble-card"]',
    ) as HTMLElement
    expect(innerCard).toBeTruthy()
    // a2a 分支使用 provider bubbleTheme 风格，不是 indigo gradient
    expect(innerCard.className).not.toMatch(/from-indigo-50/)
  })
})

describe("ConnectorBubble · multi_mention 聚合气泡（无 a2aCallId）走全宽样式", () => {
  it("不带 a2aCallId 时走暖色 surface-canvas 全宽样式", () => {
    const { container } = render(<ConnectorBubble message={makeMultiMention()} />)
    // F036 restyle：multi_mention 分支 indigo 渐变 → 暖色 surface-canvas（rounded-floating 全宽）
    const html = container.innerHTML
    expect(html).toMatch(/bg-surface-canvas/)
    expect(html).toMatch(/rounded-floating/)
  })

  it("不带 a2aCallId 时不渲染 AtPill（F1 仅对 a2a 分支生效）", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeMultiMention({ a2aCallStatus: "working" })}
      />,
    )
    expect(container.querySelector('[data-testid="at-pill"]')).toBeNull()
  })

  it("不带 a2aCallId 时不渲染溯源胶囊 / 超时墓碑", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeMultiMention({ a2aOnBehalfOf: "user:村长", a2aCallStatus: "timeout" })}
      />,
    )
    // 即使 LEFT JOIN 字段意外有值，没有 a2aCallId 视为非 a2a connector，不触发 F2/F3
    expect(container.querySelector('[data-testid="origin-capsule"]')).toBeNull()
    expect(container.querySelector('[data-testid="timeout-tombstone"]')).toBeNull()
  })

  it("不带 a2aCallId 时 display_mode=background 仍渲染（F8 仅对 a2a 分支生效）", () => {
    const { container } = render(
      <ConnectorBubble message={makeMultiMention({ a2aDisplayMode: "background" })} />,
    )
    expect(container.firstChild).not.toBeNull()
  })
})

/**
 * F026 P5 F1 follow-up · AtPill 实时反查 store
 *
 * snapshot 在 message envelope 上是冻结值；后端 status 流转只走 pending.change →
 * thread-store.pendingByRoot。这组测试验证 connector-bubble 接 store 后，AtPill
 * data-status 在 pendingByRoot mutate 时跟随刷新；entry 离开 pendingSet 时退回 snapshot。
 */
describe("ConnectorBubble · AtPill 实时反查 thread-store.pendingByRoot", () => {
  afterEach(() => {
    // store 是 module-singleton，每条测试后清干净避免互相污染
    useThreadStore.setState({ pendingByRoot: {} })
  })

  function setPending(rootCallId: string, set: PendingChangePayload["pendingSet"]) {
    act(() => {
      useThreadStore.setState({ pendingByRoot: { [rootCallId]: set } })
    })
  }

  it("snapshot=pending 但 store entry.status=working → AtPill 显示 working（实时压过快照）", () => {
    setPending("call-root-1", [
      { callId: "call-c1", alias: "范德彪", status: "working" },
    ])
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aRootCallId: "call-root-1",
          a2aCallStatus: "pending",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("working")
  })

  it("entry 离开 pendingSet（settle 后剔除）→ AtPill fallback 到 snapshot=done", () => {
    setPending("call-root-1", [
      { callId: "call-other", alias: "桂芬", status: "pending" },
    ])
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aRootCallId: "call-root-1",
          a2aCallStatus: "done",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("done")
  })

  it("rootCallId 整 key 不在 pendingByRoot（root 收口）→ AtPill fallback 到 snapshot=done", () => {
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aRootCallId: "call-root-1",
          a2aCallStatus: "done",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("done")
  })

  it("a2aRootCallId 缺失（旧 envelope 不带字段）→ AtPill fallback 到 snapshot=working", () => {
    setPending("call-root-1", [
      { callId: "call-c1", alias: "范德彪", status: "working" },
    ])
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aCallStatus: "working",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("working")
  })
})

/**
 * F026 review#4 fix · ConnectorBubble 接 settledByRoot terminal cache
 *
 * 范德彪 review#4 P1: connector message 是派发瞬间 append 的，那一刻 a2aCallStatus
 * 通常还是 pending。后端 settle/timeout 后 entry 离开 pendingSet，message envelope
 * 不重发 → AtPill fallback snapshot 仍 = pending → 卡在 ack/working 不进 done/timeout。
 *
 * A' 修复：ConnectorBubble 同时读 store.settledByRoot，AtPill 反查链路：
 *   pendingByRoot 命中 → settledByRoot 命中 → snapshot fallback。
 */
describe("ConnectorBubble · AtPill 反查 thread-store.settledByRoot terminal cache (review#4 fix)", () => {
  afterEach(() => {
    useThreadStore.setState({ pendingByRoot: {}, settledByRoot: {} })
  })

  it("snapshot=pending（envelope 冻结） + store.settledByRoot[root][callId]='done' → AtPill 显示 done", () => {
    act(() => {
      useThreadStore.setState({
        pendingByRoot: {},
        settledByRoot: { "call-root-1": { "call-c1": "done" } },
      })
    })
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aRootCallId: "call-root-1",
          a2aCallStatus: "pending", // envelope 冻结值
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("done")
  })

  it("snapshot=pending + store.settledByRoot[root][callId]='timeout' → AtPill 显示 timeout（关键 P1 场景）", () => {
    act(() => {
      useThreadStore.setState({
        pendingByRoot: {},
        settledByRoot: { "call-root-1": { "call-c1": "timeout" } },
      })
    })
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aRootCallId: "call-root-1",
          a2aCallStatus: "pending",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("timeout")
  })

  it("pendingByRoot 命中 working 压过 settledByRoot（race 防御）", () => {
    act(() => {
      useThreadStore.setState({
        pendingByRoot: {
          "call-root-1": [{ callId: "call-c1", alias: "范德彪", status: "working" }],
        },
        settledByRoot: { "call-root-1": { "call-c1": "done" } },
      })
    })
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aRootCallId: "call-root-1",
          a2aCallStatus: "pending",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("working")
  })

  it("两个 cache 都命不中 → fallback snapshot=pending → 'ack'（向后兼容）", () => {
    render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-c1",
          a2aRootCallId: "call-root-1",
          a2aCallStatus: "pending",
        })}
      />,
    )
    expect(screen.getByTestId("at-pill").dataset.status).toBe("ack")
  })
})

describe("thread-store.applyPendingChange · settled 字段写入 settledByRoot (review#4 fix)", () => {
  afterEach(() => {
    useThreadStore.setState({ pendingByRoot: {}, settledByRoot: {} })
  })

  it("payload.settled=[{callId,alias,status:'done'}] → settledByRoot[root][callId]='done'", () => {
    act(() => {
      useThreadStore.getState().applyPendingChange({
        sessionGroupId: "g1",
        rootCallId: "r1",
        parentCallId: "r1",
        pendingSet: [],
        settled: [{ callId: "c1", alias: "桂芬", status: "done" }],
        occurredAt: "2026-04-29T13:00:00Z",
      })
    })
    expect(useThreadStore.getState().settledByRoot).toEqual({
      r1: { c1: "done" },
    })
  })

  it("同 root 多次 settle emit → settledByRoot 累加（不覆盖前面的 entry）", () => {
    act(() => {
      useThreadStore.getState().applyPendingChange({
        sessionGroupId: "g1",
        rootCallId: "r1",
        parentCallId: "r1",
        pendingSet: [],
        settled: [{ callId: "c1", alias: "桂芬", status: "done" }],
        occurredAt: "2026-04-29T13:00:00Z",
      })
      useThreadStore.getState().applyPendingChange({
        sessionGroupId: "g1",
        rootCallId: "r1",
        parentCallId: "r1",
        pendingSet: [],
        settled: [{ callId: "c2", alias: "范德彪", status: "timeout" }],
        occurredAt: "2026-04-29T13:00:01Z",
      })
    })
    expect(useThreadStore.getState().settledByRoot).toEqual({
      r1: { c1: "done", c2: "timeout" },
    })
  })

  it("payload.pendingSet 空 删 pendingByRoot[root] 但 settledByRoot[root] 保留（A' 关键约束）", () => {
    act(() => {
      // 先有一个 pending entry
      useThreadStore.getState().applyPendingChange({
        sessionGroupId: "g1",
        rootCallId: "r1",
        parentCallId: "r1",
        pendingSet: [{ callId: "c1", alias: "桂芬", status: "pending" }],
        occurredAt: "2026-04-29T13:00:00Z",
      })
      // settle: pendingSet 空 + settled 含 c1
      useThreadStore.getState().applyPendingChange({
        sessionGroupId: "g1",
        rootCallId: "r1",
        parentCallId: "r1",
        pendingSet: [],
        settled: [{ callId: "c1", alias: "桂芬", status: "done" }],
        occurredAt: "2026-04-29T13:00:01Z",
      })
    })
    const state = useThreadStore.getState()
    // pendingByRoot 删 key（旧约定）
    expect(state.pendingByRoot.r1).toBeUndefined()
    // settledByRoot 保留（A' 关键：root 收口不清 terminal cache，
    // 否则单 child settle 场景 AtPill 立刻 fallback snapshot=pending = ack）
    expect(state.settledByRoot.r1).toEqual({ c1: "done" })
  })

  it("空 settled 数组 / 缺省 settled → 不影响 settledByRoot", () => {
    act(() => {
      useThreadStore.setState({ settledByRoot: { r1: { c0: "done" } } })
      useThreadStore.getState().applyPendingChange({
        sessionGroupId: "g1",
        rootCallId: "r1",
        parentCallId: "r1",
        pendingSet: [{ callId: "c1", alias: "桂芬", status: "pending" }],
        // settled 缺省
        occurredAt: "2026-04-29T13:00:00Z",
      })
    })
    expect(useThreadStore.getState().settledByRoot).toEqual({ r1: { c0: "done" } })
  })
})

/**
 * F026 P5 R-107 fix · ConnectorBubble 拒绝渲染 placeholder envelope
 *
 * 现象（小孙在 R-107 房间发现）：房间最顶端窜出一个 connector bubble，
 * label="A2A ??" / fromAlias="???" / toAlias="??"，targetAlias 被原样塞进 AtPill。
 *
 * 根因：DB 里有一条 fixture row（手写 id 前缀 `msg-ag-f026-` + a2a_calls.issuer_id="???"），
 * 仓库代码主路径不会写出这种数据，但既然 envelope 已经在 DB 里，前端是渲染最后一道关。
 * 当前 `connector-bubble.tsx` 只对 null/undefined 兜底，对 placeholder 字符串
 * （"??"/"???"）直接当真值渲染。
 *
 * 修复：placeholder envelope 整体不渲染（return null）。判定规则：
 *   - label 含连续 "??" 双问号
 *   - fromAlias 或 toAlias trim 后全是 "?" 字符
 */
describe("ConnectorBubble · 拒绝渲染 placeholder envelope (R-107 fix)", () => {
  it("a2a 分支 · label 含 '??' → 不渲染", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          connectorSource: {
            kind: "multi_mention_result",
            label: "A2A ??",
            fromAlias: "黄仁勋",
            toAlias: "范德彪",
            targets: ["codex" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("a2a 分支 · fromAlias='???' → 不渲染", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          connectorSource: {
            kind: "multi_mention_result",
            label: "A2A 协助",
            fromAlias: "???",
            toAlias: "范德彪",
            targets: ["codex" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("a2a 分支 · toAlias='??' → 不渲染", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          connectorSource: {
            kind: "multi_mention_result",
            label: "A2A 协助",
            fromAlias: "黄仁勋",
            toAlias: "??",
            targets: ["codex" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("R-107 完整复现 · label='A2A ??' + fromAlias='???' + toAlias='??' → 不渲染", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          a2aCallId: "call-ag-f026-cd76296d",
          connectorSource: {
            kind: "multi_mention_result",
            label: "A2A ??",
            fromAlias: "???",
            toAlias: "??",
            targets: ["gemini" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("multi_mention 分支 · label 含 '??' → 不渲染（C1 对两个分支都生效）", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeMultiMention({
          connectorSource: {
            kind: "multi_mention_result",
            label: "并行思考 ??",
            targets: ["codex" as Provider, "gemini" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("正常 envelope · label='A2A 协助' + fromAlias='黄仁勋' + toAlias='范德彪' → 正常渲染", () => {
    const { container } = render(<ConnectorBubble message={makeA2aConnector()} />)
    expect(container.firstChild).not.toBeNull()
  })

  it("正常 envelope · label 含单个 '?' 不算 placeholder（仅 '??' 触发） → 正常渲染", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          connectorSource: {
            kind: "multi_mention_result",
            label: "确认派发?",
            fromAlias: "黄仁勋",
            toAlias: "范德彪",
            targets: ["codex" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it("fromAlias / toAlias 缺省（undefined） → 不算 placeholder，正常渲染", () => {
    // 旧 envelope 不带 from/to 字段 — 这是合法的，不是占位字符串
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          connectorSource: {
            kind: "multi_mention_result",
            label: "A2A 协助",
            targets: ["codex" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).not.toBeNull()
  })

  it("fromAlias / toAlias 空字符串 → 不算 placeholder，正常渲染（空和 '???' 不同语义）", () => {
    const { container } = render(
      <ConnectorBubble
        message={makeA2aConnector({
          connectorSource: {
            kind: "multi_mention_result",
            label: "A2A 协助",
            fromAlias: "",
            toAlias: "",
            targets: ["codex" as Provider],
          },
        })}
      />,
    )
    expect(container.firstChild).not.toBeNull()
  })
})
