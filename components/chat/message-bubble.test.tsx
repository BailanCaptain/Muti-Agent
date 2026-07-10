import { render } from "@testing-library/react"
import type { TimelineMessage } from "@multi-agent/shared"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/components/stores/settings-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { MessageBubble, buildFoldedPreview } from "./message-bubble"

vi.mock("@/components/ws/client", () => ({
  subscribeToRoom: () => {},
  connectRealtime: () => () => {},
  socketClient: {},
}))

// F030 r3 P2：折叠态预览直接对 content 做 markdown 清洗，但旧正则只认闭合围栏，
// 未闭合 cc_rich 的 ```cc_rich + JSON 会泄漏。buildFoldedPreview 须先过
// stripRichFencesForPreview 把 cc_rich 围栏剔除。
describe("buildFoldedPreview · cc_rich 不泄漏", () => {
  it("未闭合 cc_rich：折叠预览无 ```cc_rich / JSON，前导文字保留", () => {
    const out = buildFoldedPreview('结论先行\n```cc_rich\n{"kind":"card","id":"x","title":"T"')
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
    expect(out).toContain("结论先行")
  })

  it("闭合 cc_rich：折叠预览显示 [卡片] 占位而非代码块/JSON", () => {
    const out = buildFoldedPreview('```cc_rich\n{"kind":"card","id":"x","title":"标题"}\n```')
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("title")
    expect(out).toContain("卡片")
  })

  it("普通代码围栏仍折叠成 [代码块]（不被 cc_rich 清理误伤）", () => {
    const out = buildFoldedPreview("```js\nconst a = 1\n```")
    expect(out).toContain("代码块")
  })

  // r5 P2（§17 override 后修）：buildFoldedPreview 下游贪婪正则 /```...```/ 不认围栏长度，
  // 把四反引号代码块里的三反引号 cc_rich 错误配对 → 残留 JSON。e2e 全链断言（上两次假绿
  // 就是只测 sanitizer 单元没测 buildFoldedPreview 全链）。
  it("r5：四反引号代码块内的 cc_rich 示例不泄漏（下游正则 e2e）", () => {
    const content = '````\n```cc_rich\n{"kind":"card","id":"x","title":"T"}\n```\n````'
    const out = buildFoldedPreview(content)
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
    expect(out).not.toContain("kind")
  })

  it("~~~~ tilde 外层围栏内的 cc_rich 不泄漏", () => {
    const content = '~~~~\n```cc_rich\n{"kind":"card","id":"x"}\n```\n~~~~'
    const out = buildFoldedPreview(content)
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
  })

  it("未闭合普通外层围栏内的 cc_rich 不泄漏", () => {
    const content = '````\n```cc_rich\n{"kind":"card","id":"x"}'
    const out = buildFoldedPreview(content)
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
  })
})

// B026 · 轮反馈死区：占位 assistant 消息（content=""/messageType="final"）在首 delta 前
// 是纯壳卡片，且 providers[].running 直到 CLI spawn 完成（实测 +23.4s）才翻 true——
// 骨架不能绑 running。改绑 store 的 awaitingFirstOutput（message.created 占位即标记，
// +0.04s 生效），delta/终稿/轮结束收口清除。
describe("MessageBubble · B026 等待首输出骨架", () => {
  function makeMessage(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
    return {
      id: "b026-m1",
      provider: "claude",
      alias: "黄仁勋",
      role: "assistant",
      content: "",
      messageType: "final",
      model: null,
      createdAt: "2026-07-11T08:00:00.000Z",
      ...overrides,
    }
  }

  function setRunning(running: boolean) {
    useThreadStore.setState((state) => ({
      providers: {
        ...state.providers,
        claude: { ...state.providers.claude, running },
      },
    }))
  }

  afterEach(() => {
    useThreadStore.setState({ awaitingFirstOutput: {} } as never)
    setRunning(false)
  })

  function markAwaiting(messageId = "b026-m1") {
    useThreadStore.getState().markAwaitingFirstOutput(messageId, "claude")
  }

  it("空占位 + awaiting + CLI 未 spawn（running=false）→ 骨架 + 「正在启动智能体」", () => {
    markAwaiting()
    const { container } = render(<MessageBubble message={makeMessage()} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBeGreaterThan(0)
    expect(container.textContent).toContain("正在启动智能体")
  })

  it("空占位 + awaiting + CLI 已 spawn（running=true）→ 骨架 + 「正在思考」", () => {
    markAwaiting()
    setRunning(true)
    const { container } = render(<MessageBubble message={makeMessage()} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBeGreaterThan(0)
    expect(container.textContent).toContain("正在思考")
  })

  it("空消息但不在 awaiting（历史空消息/刷新后）→ 不显示骨架", () => {
    const { container } = render(<MessageBubble message={makeMessage()} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBe(0)
  })

  it("content 已开始流式 → 不显示骨架（渲染条件双保险）", () => {
    markAwaiting()
    const { container } = render(<MessageBubble message={makeMessage({ content: "第一个字" })} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBe(0)
    expect(container.textContent).toContain("第一个字")
  })

  it("content 空但已有 toolEvents（工具阶段自带反馈）→ 不显示骨架", () => {
    markAwaiting()
    const msg = makeMessage({
      toolEvents: [
        { type: "tool_use", toolName: "Read", toolInput: "a.ts", status: "started", timestamp: "2026-07-11T08:00:01.000Z" },
      ],
    })
    const { container } = render(<MessageBubble message={msg} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBe(0)
  })

  it("content 空但 thinking 可见（默认 showThinking + 干净内容）→ 不显示骨架（推理块已是反馈）", () => {
    markAwaiting()
    const msg = makeMessage({ thinking: "让我想想这个问题" })
    const { container } = render(<MessageBubble message={msg} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBe(0)
  })

  // 德彪 r1 P3：raw thinking ≠ 可见反馈——判空必须用"用户真的能看到的 thinking"，
  // 否则骨架让位后 body 仍是空壳（关心里话 / 纯噪声 thinking 两场景实测复现）。
  it("thinking 全是噪声行（cleanThinking 后为空）→ 骨架仍显示", () => {
    markAwaiting()
    const msg = makeMessage({
      thinking: "Reading prompt from stdin...\nYOLO mode is enabled. Danger!\nLoaded cached credentials.",
    })
    const { container } = render(<MessageBubble message={msg} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBeGreaterThan(0)
  })

  it("showThinking=false 时 thinking 有真内容 → 骨架仍显示（用户看不到推理块）", () => {
    markAwaiting()
    useSettingsStore.setState({ showThinking: false })
    try {
      const msg = makeMessage({ thinking: "让我想想这个问题" })
      const { container } = render(<MessageBubble message={msg} />)
      expect(container.querySelectorAll("[data-skeleton-line]").length).toBeGreaterThan(0)
    } finally {
      useSettingsStore.setState({ showThinking: true })
    }
  })

  it("user 消息永不显示骨架", () => {
    markAwaiting()
    const msg = makeMessage({ role: "user", alias: "小孙", content: "" })
    const { container } = render(<MessageBubble message={msg} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBe(0)
  })
})
