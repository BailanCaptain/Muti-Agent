import type { TimelineMessage } from "@multi-agent/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useThreadStore } from "./thread-store"

vi.mock("@/components/ws/client", () => ({
  subscribeToRoom: () => {},
  connectRealtime: () => () => {},
  socketClient: {},
}))

/**
 * F043 P1-1（德彪 r1）· applyMessageUpdate：turn 收尾 message.updated 事件 → 已在
 * timeline 里的占位/流式气泡就地替换为落库终稿（token 明细随之点亮）。
 * 病灶：占位消息 message.created 先到（无 token），收尾只写 DB；catch-up 查询
 * `created_at > since` 天然漏更新行、store 按 id 去重不替换 → 不刷新永远看不到胶囊。
 */

const msg = (over: Partial<TimelineMessage>): TimelineMessage => ({
  id: "m-assistant",
  provider: "claude",
  alias: "黄仁勋",
  role: "assistant",
  content: "",
  messageType: "final",
  model: "claude-opus-4-8",
  createdAt: "2026-07-10T12:00:00.000Z",
  ...over,
})

function seedTimeline() {
  useThreadStore.setState({
    timeline: [
      msg({ id: "m-user", role: "user", content: "问题", model: null }),
      msg({ id: "m-assistant", content: "流式已拼好的正文" }),
    ],
  } as never)
}

describe("F043 P1-1 applyMessageUpdate", () => {
  beforeEach(() => {
    seedTimeline()
  })

  it("就地替换同 id 消息：token 胶囊字段点亮，顺序不动", () => {
    useThreadStore.getState().applyMessageUpdate(
      msg({
        id: "m-assistant",
        content: "落库终稿",
        inputTokens: 57_053,
        outputTokens: 14,
        cachedPercent: 50,
      }),
    )
    const timeline = useThreadStore.getState().timeline
    expect(timeline).toHaveLength(2)
    expect(timeline[1].id).toBe("m-assistant")
    expect(timeline[1].content).toBe("落库终稿")
    expect(timeline[1].inputTokens).toBe(57_053)
    expect(timeline[1].outputTokens).toBe(14)
    expect(timeline[1].cachedPercent).toBe(50)
    // 邻座消息不受影响
    expect(timeline[0].content).toBe("问题")
  })

  it("id 不在 timeline（catch-up 竞态）→ upsert 追加，不丢终稿", () => {
    useThreadStore.getState().applyMessageUpdate(
      msg({ id: "m-other", content: "迟到的终稿", inputTokens: 13_384, cachedPercent: 98 }),
    )
    const timeline = useThreadStore.getState().timeline
    expect(timeline).toHaveLength(3)
    expect(timeline[2].id).toBe("m-other")
    expect(timeline[2].inputTokens).toBe(13_384)
  })
})
