/**
 * F033 · decision-store records 轨单元测试
 *
 * 覆盖:
 *   - respond(): WS 发送 + optimistic pending→records（status=resolved，verdicts/userInput 保留）
 *   - resolveFromWs(): 他端/超时 resolve 把 pending 挪进 records；已 optimistic 的不重复
 *   - resolveFromWs(): 未知 requestId no-op
 *   - fetchRecords(): 服务端真相合并（同 requestId 服务端优先，本地 optimistic 不丢）
 */

import type { DecisionRequest } from "@multi-agent/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/ws/client", () => ({
  socketClient: { send: vi.fn() },
}))

import { socketClient } from "@/components/ws/client"
import { useDecisionStore } from "./decision-store"

const pendingRequest: DecisionRequest = {
  requestId: "req-1",
  kind: "multi_choice",
  title: "选一个",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  sessionGroupId: "group-1",
  createdAt: "2026-07-02T10:00:00.000Z",
}

function resetStore() {
  useDecisionStore.setState({ pending: [], records: [] })
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("respond", () => {
  it("发 WS + optimistic 移入 records（resolved 态含 verdicts/userInput）", () => {
    useDecisionStore.getState().addRequest(pendingRequest)
    useDecisionStore
      .getState()
      .respond("req-1", [{ optionId: "a", verdict: "approved" }], "备注")

    expect(socketClient.send).toHaveBeenCalledWith({
      type: "decision.respond",
      payload: {
        requestId: "req-1",
        decisions: [{ optionId: "a", verdict: "approved" }],
        userInput: "备注",
      },
    })
    const state = useDecisionStore.getState()
    expect(state.pending).toHaveLength(0)
    expect(state.records).toHaveLength(1)
    expect(state.records[0].status).toBe("resolved")
    expect(state.records[0].verdicts).toEqual([{ optionId: "a", verdict: "approved" }])
    expect(state.records[0].userInput).toBe("备注")
    expect(state.records[0].title).toBe("选一个")
  })
})

describe("resolveFromWs", () => {
  it("pending 中的请求被他端 resolve → 移入 records", () => {
    useDecisionStore.getState().addRequest(pendingRequest)
    useDecisionStore.getState().resolveFromWs("req-1", [{ optionId: "b", verdict: "approved" }])

    const state = useDecisionStore.getState()
    expect(state.pending).toHaveLength(0)
    expect(state.records).toHaveLength(1)
    expect(state.records[0].verdicts).toEqual([{ optionId: "b", verdict: "approved" }])
  })

  it("已 optimistic 进 records 的不重复", () => {
    useDecisionStore.getState().addRequest(pendingRequest)
    useDecisionStore.getState().respond("req-1", [{ optionId: "a", verdict: "approved" }])
    // 服务端广播回来（本端也会收到 decision.resolved）
    useDecisionStore.getState().resolveFromWs("req-1", [{ optionId: "a", verdict: "approved" }])

    expect(useDecisionStore.getState().records).toHaveLength(1)
  })

  it("未知 requestId no-op", () => {
    useDecisionStore.getState().resolveFromWs("ghost", [])
    expect(useDecisionStore.getState().records).toHaveLength(0)
  })
})

describe("fetchRecords", () => {
  it("拉服务端 records；同 requestId 服务端优先，本地 optimistic 不丢", async () => {
    useDecisionStore.getState().addRequest(pendingRequest)
    useDecisionStore.getState().respond("req-1", [{ optionId: "a", verdict: "approved" }])
    // 本地还有一条 server 尚未返回的 optimistic（模拟竞态）
    useDecisionStore.getState().addRequest({ ...pendingRequest, requestId: "req-2" })
    useDecisionStore.getState().respond("req-2", [{ optionId: "b", verdict: "approved" }])

    const serverRecord = {
      requestId: "req-1",
      sessionGroupId: "group-1",
      kind: "multi_choice",
      title: "选一个",
      options: pendingRequest.options,
      status: "resolved",
      verdicts: [{ optionId: "a", verdict: "approved" }],
      userInput: "服务端版",
      createdAt: "2026-07-02T10:00:00.000Z",
      resolvedAt: "2026-07-02T10:01:00.000Z",
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ records: [serverRecord] }),
      })),
    )

    await useDecisionStore.getState().fetchRecords("group-1")

    const records = useDecisionStore.getState().records
    expect(records).toHaveLength(2)
    const byId = new Map(records.map((r) => [r.requestId, r]))
    expect(byId.get("req-1")?.userInput).toBe("服务端版")
    expect(byId.get("req-2")?.status).toBe("resolved")
  })

  it("fetchRecords 清掉其他房间的 local-only 残留（P3 卫生：服务端有账，切回可找回）", async () => {
    // 房间 B 的 optimistic 残留
    useDecisionStore.getState().addRequest({ ...pendingRequest, requestId: "req-b", sessionGroupId: "group-b" })
    useDecisionStore.getState().respond("req-b", [{ optionId: "a", verdict: "approved" }])
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ records: [] }) })),
    )

    await useDecisionStore.getState().fetchRecords("group-1")

    expect(useDecisionStore.getState().records).toHaveLength(0)
  })

  it("fetch 失败不清空已有 records", async () => {
    useDecisionStore.getState().addRequest(pendingRequest)
    useDecisionStore.getState().respond("req-1", [{ optionId: "a", verdict: "approved" }])
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      }),
    )

    await useDecisionStore.getState().fetchRecords("group-1")

    expect(useDecisionStore.getState().records).toHaveLength(1)
  })
})
