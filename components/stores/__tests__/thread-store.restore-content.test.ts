import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { TimelineMessage } from "@multi-agent/shared"
import { useThreadStore } from "../thread-store"

/**
 * F026 P3.1 review#2 fix · `restoreAssistantContent` 把 retry 期间被 reset 清空的
 * timeline message content 用 exhausted payload 的 finalContent 重新填回去。
 *
 * 修复路径：
 *  - retrying 触发 resetAssistantStream → timeline.content = ""
 *  - 两条 exhausted 分支后端没有新 delta，前端必须从 payload.finalContent 回填
 *  - 否则用户看到空气泡 + 红 banner，必须刷新页面才能看到兜底入库内容
 */

function makeAssistantMessage(overrides: Partial<TimelineMessage> = {}): TimelineMessage {
  return {
    id: "msg-1",
    threadId: "t-1",
    role: "assistant",
    provider: "claude",
    alias: "黄仁勋",
    content: "",
    createdAt: "2026-04-29T01:00:00Z",
    ...overrides,
  } as TimelineMessage
}

describe("thread-store.restoreAssistantContent (F026 P3.1 review#2 fix)", () => {
  beforeEach(() => {
    useThreadStore.setState({ timeline: [] })
  })

  afterEach(() => {
    useThreadStore.setState({ timeline: [] })
  })

  it("覆盖 timeline message 的 content 为 finalContent（exhausted 兜底回填）", () => {
    useThreadStore.setState({
      timeline: [makeAssistantMessage({ id: "msg-1", content: "" })],
    })
    useThreadStore.getState().restoreAssistantContent(
      "msg-1",
      "完整 final 内容：[Call: @范德彪 review F026]",
    )
    const msg = useThreadStore.getState().timeline.find((m) => m.id === "msg-1")
    expect(msg?.content).toBe("完整 final 内容：[Call: @范德彪 review F026]")
  })

  it("不在 timeline 的 messageId → 不抛错也不修改其他 message（no-op）", () => {
    useThreadStore.setState({
      timeline: [makeAssistantMessage({ id: "msg-A", content: "原内容" })],
    })
    useThreadStore.getState().restoreAssistantContent("msg-DOES-NOT-EXIST", "x")
    const msg = useThreadStore.getState().timeline.find((m) => m.id === "msg-A")
    expect(msg?.content).toBe("原内容")
  })

  it("覆盖时不影响 timeline 中其他 message", () => {
    useThreadStore.setState({
      timeline: [
        makeAssistantMessage({ id: "msg-1", content: "" }),
        makeAssistantMessage({ id: "msg-2", content: "msg-2 不该被动" }),
      ],
    })
    useThreadStore.getState().restoreAssistantContent("msg-1", "新 final")
    const m1 = useThreadStore.getState().timeline.find((m) => m.id === "msg-1")
    const m2 = useThreadStore.getState().timeline.find((m) => m.id === "msg-2")
    expect(m1?.content).toBe("新 final")
    expect(m2?.content).toBe("msg-2 不该被动")
  })
})
