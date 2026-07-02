import assert from "node:assert/strict"
import test from "node:test"
import type { OptionVerdict, RealtimeServerEvent } from "@multi-agent/shared"
import { DecisionManager } from "./decision-manager"

/**
 * F002 P2.T5 — MCP regression: DecisionManager.request() is the path used by
 * the MCP `request_decision` tool (agent-originated blocking decisions with a
 * round-trip resolve). The new [拍板] inline Decision Board flow is purely
 * additive — it MUST NOT break this legacy request/respond contract.
 *
 * AC7: agents that need a blocking user decision (e.g. permission / step
 * gating via MCP) still see `decision.request` on the wire and still receive
 * the user's selection through the returned Promise.
 */

test("DecisionManager.request emits decision.request and the returned promise resolves via respond()", async () => {
  const emitted: RealtimeServerEvent[] = []
  const dm = new DecisionManager((e) => emitted.push(e))

  const promise = dm.request({
    kind: "inline_confirmation",
    title: "测试问题",
    options: [
      { id: "A", label: "yes" },
      { id: "B", label: "no" },
    ],
    sessionGroupId: "group-1",
    timeoutMs: 5000,
  })

  const reqEvent = emitted.find((e) => e.type === "decision.request")
  assert.ok(reqEvent, "MCP path must still emit decision.request synchronously")
  assert.equal(
    emitted.filter((e) => e.type === "decision.board_flush").length,
    0,
    "DecisionManager MUST NOT route through the Decision Board",
  )

  const requestId = (reqEvent as Extract<RealtimeServerEvent, { type: "decision.request" }>).payload
    .requestId
  dm.respond(requestId, [{ optionId: "A", verdict: "approved" }])

  const result = await promise
  assert.equal(result.decisions.length, 1)
  assert.equal(result.decisions[0].optionId, "A")

  const resolvedEvent = emitted.find((e) => e.type === "decision.resolved")
  assert.ok(resolvedEvent, "respond() must emit decision.resolved")
})

test("DecisionManager.request emitted payload carries all passthrough fields (kind, options, sessionGroupId)", () => {
  const emitted: RealtimeServerEvent[] = []
  const dm = new DecisionManager((e) => emitted.push(e))

  void dm.request({
    kind: "multi_choice",
    title: "DB 选型",
    description: "pick one",
    options: [{ id: "pg", label: "Postgres" }],
    sessionGroupId: "group-2",
    sourceProvider: "claude",
    sourceAlias: "Reviewer",
    multiSelect: false,
    timeoutMs: 5000,
  })

  const reqEvent = emitted.find((e) => e.type === "decision.request") as
    | Extract<RealtimeServerEvent, { type: "decision.request" }>
    | undefined
  assert.ok(reqEvent)
  assert.equal(reqEvent.payload.kind, "multi_choice")
  assert.equal(reqEvent.payload.sessionGroupId, "group-2")
  assert.equal(reqEvent.payload.sourceProvider, "claude")
  assert.equal(reqEvent.payload.options[0].id, "pg")
})

/**
 * F033 — 决策卡生命周期持久化 + timeout 语义 + 留痕上下文。
 */

function makeRecordsFake() {
  const inserted: Array<{ requestId: string; kind: string; title: string }> = []
  const resolved: Array<{
    requestId: string
    status: "resolved" | "timeout"
    verdicts: Array<{ optionId: string; verdict: string }>
    userInput: string
  }> = []
  return {
    inserted,
    resolved,
    facade: {
      insertPending: (record: { requestId: string; kind: string; title: string }) => {
        inserted.push({ requestId: record.requestId, kind: record.kind, title: record.title })
      },
      markResolved: (
        requestId: string,
        status: "resolved" | "timeout",
        verdicts: Array<{ optionId: string; verdict: string }>,
        userInput: string,
      ) => {
        resolved.push({ requestId, status, verdicts, userInput })
        return true
      },
    },
  }
}

function makeRepositoryFake() {
  const appended: Array<{ threadId: string; role: string; content: string }> = []
  return {
    appended,
    facade: {
      listThreadsByGroup: () => [{ id: "thread-1", provider: "claude" }],
      appendMessage: (threadId: string, role: "user" | "assistant", content: string) => {
        appended.push({ threadId, role, content })
        return {}
      },
    },
  }
}

test("F033: request() 落 pending 行到 records", () => {
  const records = makeRecordsFake()
  const dm = new DecisionManager(() => {}, undefined, records.facade)

  void dm.request({
    kind: "multi_choice",
    title: "选一个方案",
    options: [{ id: "a", label: "A" }],
    sessionGroupId: "group-1",
    timeoutMs: 5000,
  })

  assert.equal(records.inserted.length, 1)
  assert.equal(records.inserted[0].kind, "multi_choice")
  assert.equal(records.inserted[0].title, "选一个方案")
})

test("F033: respond() markResolved(resolved) 且 verdicts 原样", async () => {
  const emitted: RealtimeServerEvent[] = []
  const records = makeRecordsFake()
  const dm = new DecisionManager((e) => emitted.push(e), undefined, records.facade)

  const promise = dm.request({
    kind: "multi_choice",
    title: "T",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    sessionGroupId: "group-1",
    timeoutMs: 5000,
  })
  const requestId = records.inserted[0].requestId
  dm.respond(requestId, [{ optionId: "b", verdict: "rejected" }], "不要 b")
  await promise

  assert.equal(records.resolved.length, 1)
  assert.equal(records.resolved[0].status, "resolved")
  assert.deepEqual(records.resolved[0].verdicts, [{ optionId: "b", verdict: "rejected" }])
  assert.equal(records.resolved[0].userInput, "不要 b")
})

test("F033: timeout inline_confirmation → 全 rejected（fail-closed）+ markResolved(timeout)", async () => {
  const records = makeRecordsFake()
  const dm = new DecisionManager(() => {}, undefined, records.facade)

  const result = await dm.request({
    kind: "inline_confirmation",
    title: "确认删除吗",
    options: [
      { id: "confirm", label: "确认" },
      { id: "cancel", label: "取消" },
    ],
    sessionGroupId: "group-1",
    timeoutMs: 5,
  })

  assert.ok(
    result.decisions.every((d) => d.verdict === "rejected"),
    "confirm 超时必须 fail-closed 全 rejected",
  )
  assert.equal(records.resolved.length, 1)
  assert.equal(records.resolved[0].status, "timeout")
})

test("F033: timeout multi_choice → 全 approved（既有行为回归保护）", async () => {
  const records = makeRecordsFake()
  const dm = new DecisionManager(() => {}, undefined, records.facade)

  const result = await dm.request({
    kind: "multi_choice",
    title: "T",
    options: [{ id: "a", label: "A" }],
    sessionGroupId: "group-1",
    timeoutMs: 5,
  })

  assert.ok(result.decisions.every((d) => d.verdict === "approved"))
  assert.equal(records.resolved[0].status, "timeout")
})

test("F033: timeout 也写审计留痕且标注超时", async () => {
  const repository = makeRepositoryFake()
  const dm = new DecisionManager(() => {}, repository.facade)

  await dm.request({
    kind: "inline_confirmation",
    title: "确认清理 worktree 吗",
    options: [
      { id: "confirm", label: "确认" },
      { id: "cancel", label: "取消" },
    ],
    sessionGroupId: "group-1",
    sourceProvider: "claude",
    timeoutMs: 5,
  })

  assert.equal(repository.appended.length, 1, "timeout 分支必须写审计消息")
  assert.ok(repository.appended[0].content.includes("超时自动处理"))
  assert.ok(repository.appended[0].content.includes("确认清理 worktree 吗"), "审计消息必须带 title")
})

test("F033: 审计消息带 title + description + 所选 label", async () => {
  const repository = makeRepositoryFake()
  const dm = new DecisionManager(() => {}, repository.facade)

  const promise = dm.request({
    kind: "multi_choice",
    title: "DB 选型",
    description: "只上一个",
    options: [
      { id: "pg", label: "Postgres" },
      { id: "sq", label: "SQLite" },
    ],
    sessionGroupId: "group-1",
    sourceProvider: "claude",
    timeoutMs: 5000,
  })
  const pendingReq = dm.getPendingRequests("group-1")[0]
  dm.respond(pendingReq.requestId, [{ optionId: "sq", verdict: "approved" }], "轻量优先")
  await promise

  const content = repository.appended[0].content
  assert.ok(content.includes("DB 选型"), "必须带 title")
  assert.ok(content.includes("只上一个"), "必须带 description")
  assert.ok(content.includes("SQLite"), "必须带所选 label")
  assert.ok(content.includes("轻量优先"), "必须带补充说明")
})

/**
 * F033 德彪 r1 P1-1 · decision.respond payload 运行时校验（WS 边界 fail-closed）。
 * 非法 respond 不 resolve、不出终态事件、请求保持 pending（真人仍可继续响应或等超时）。
 */

function makeLiveRequest(
  dm: DecisionManager,
  overrides: Partial<{
    kind: "multi_choice" | "inline_confirmation"
    multiSelect: boolean
  }> = {},
) {
  const promise = dm.request({
    kind: overrides.kind ?? "multi_choice",
    title: "T",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    sessionGroupId: "group-v",
    multiSelect: overrides.multiSelect,
    timeoutMs: 5000,
  })
  const requestId = dm.getPendingRequests("group-v")[0].requestId
  return { promise, requestId }
}

test("P1-1: 未知 optionId → 拒收，保持 pending，无 resolved 事件", () => {
  const emitted: RealtimeServerEvent[] = []
  const dm = new DecisionManager((e) => emitted.push(e))
  const { requestId } = makeLiveRequest(dm)

  dm.respond(requestId, [{ optionId: "ghost", verdict: "approved" }])

  assert.equal(dm.getPendingRequests("group-v").length, 1, "必须保持 pending")
  assert.equal(emitted.filter((e) => e.type === "decision.resolved").length, 0)
})

test("P1-1: 重复 optionId → 拒收", () => {
  const dm = new DecisionManager(() => {})
  const { requestId } = makeLiveRequest(dm)
  dm.respond(requestId, [
    { optionId: "a", verdict: "approved" },
    { optionId: "a", verdict: "rejected" },
  ])
  assert.equal(dm.getPendingRequests("group-v").length, 1)
})

test("P1-1: 非法 verdict 枚举 → 拒收", () => {
  const dm = new DecisionManager(() => {})
  const { requestId } = makeLiveRequest(dm)
  dm.respond(requestId, [
    { optionId: "a", verdict: "yolo" as unknown as OptionVerdict },
  ])
  assert.equal(dm.getPendingRequests("group-v").length, 1)
})

test("P1-1: 单选（multiSelect=false）批两个 → 拒收", () => {
  const dm = new DecisionManager(() => {})
  const { requestId } = makeLiveRequest(dm, { multiSelect: false })
  dm.respond(requestId, [
    { optionId: "a", verdict: "approved" },
    { optionId: "b", verdict: "approved" },
  ])
  assert.equal(dm.getPendingRequests("group-v").length, 1)
})

test("P1-1: 多选批两个 → 接受", async () => {
  const dm = new DecisionManager(() => {})
  const { promise, requestId } = makeLiveRequest(dm, { multiSelect: true })
  dm.respond(requestId, [
    { optionId: "a", verdict: "approved" },
    { optionId: "b", verdict: "approved" },
  ])
  const result = await promise
  assert.equal(result.decisions.length, 2)
})

test("P1-1: confirm 双批（confirm+cancel 都 approved）→ 拒收", () => {
  const dm = new DecisionManager(() => {})
  const { requestId } = makeLiveRequest(dm, { kind: "inline_confirmation" })
  dm.respond(requestId, [
    { optionId: "a", verdict: "approved" },
    { optionId: "b", verdict: "approved" },
  ])
  assert.equal(dm.getPendingRequests("group-v").length, 1)
})

test("P1-1: confirm 零 approved → 拒收（确认卡必须有唯一明确选择）", () => {
  const dm = new DecisionManager(() => {})
  const { requestId } = makeLiveRequest(dm, { kind: "inline_confirmation" })
  dm.respond(requestId, [
    { optionId: "a", verdict: "rejected" },
    { optionId: "b", verdict: "rejected" },
  ])
  assert.equal(dm.getPendingRequests("group-v").length, 1)
})

test("P1-1: confirm 正常单批 → 接受", async () => {
  const dm = new DecisionManager(() => {})
  const { promise, requestId } = makeLiveRequest(dm, { kind: "inline_confirmation" })
  dm.respond(requestId, [
    { optionId: "a", verdict: "approved" },
    { optionId: "b", verdict: "rejected" },
  ])
  const result = await promise
  assert.equal(result.decisions[0].verdict, "approved")
})

test("P1-1: multi_choice 零 decisions + userInput（纯文字回答）→ 接受（存量行为回归锚）", async () => {
  const dm = new DecisionManager(() => {})
  const { promise, requestId } = makeLiveRequest(dm)
  dm.respond(requestId, [], "以上都不选，走方案丙")
  const result = await promise
  assert.equal(result.decisions.length, 0)
  assert.equal(result.userInput, "以上都不选，走方案丙")
})

/**
 * F033 德彪 r1 P1-2 · DB/审计副作用异常隔离：终态事件必达，timer/WS 路径不外抛。
 */

function throwingRecords() {
  return {
    insertPending: () => {},
    markResolved: () => {
      throw new Error("db down")
    },
  }
}

function throwingRepository() {
  return {
    listThreadsByGroup: () => [{ id: "thread-1", provider: "claude" }],
    appendMessage: () => {
      throw new Error("db down")
    },
  }
}

test("P1-2: respond 时 records 落库抛异常 → promise 照常 resolve + resolved 事件必达 + 不外抛", async () => {
  const emitted: RealtimeServerEvent[] = []
  const dm = new DecisionManager((e) => emitted.push(e), throwingRepository(), throwingRecords())

  const promise = dm.request({
    kind: "multi_choice",
    title: "T",
    options: [{ id: "a", label: "A" }],
    sessionGroupId: "group-v",
    sourceProvider: "claude",
    timeoutMs: 5000,
  })
  const requestId = dm.getPendingRequests("group-v")[0].requestId
  dm.respond(requestId, [{ optionId: "a", verdict: "approved" }])

  const result = await promise
  assert.equal(result.decisions[0].optionId, "a")
  assert.equal(emitted.filter((e) => e.type === "decision.resolved").length, 1)
})

test("P1-2: timeout 时 records/审计抛异常 → 事件必达 + 异常不逃出 setTimeout", async () => {
  const emitted: RealtimeServerEvent[] = []
  const dm = new DecisionManager((e) => emitted.push(e), throwingRepository(), throwingRecords())

  const result = await dm.request({
    kind: "inline_confirmation",
    title: "T",
    options: [
      { id: "confirm", label: "确认" },
      { id: "cancel", label: "取消" },
    ],
    sessionGroupId: "group-v",
    sourceProvider: "claude",
    timeoutMs: 5,
  })

  assert.ok(result.decisions.every((d) => d.verdict === "rejected"))
  assert.equal(emitted.filter((e) => e.type === "decision.resolved").length, 1)
})

test("F033: respond 先到，timeout 不再二次落库/二次留痕", async () => {
  const records = makeRecordsFake()
  const repository = makeRepositoryFake()
  const dm = new DecisionManager(() => {}, repository.facade, records.facade)

  const promise = dm.request({
    kind: "multi_choice",
    title: "T",
    options: [{ id: "a", label: "A" }],
    sessionGroupId: "group-1",
    sourceProvider: "claude",
    timeoutMs: 20,
  })
  const requestId = records.inserted[0].requestId
  dm.respond(requestId, [{ optionId: "a", verdict: "approved" }])
  await promise
  // 等 timeout 时刻过去，确认 timer 已被 clear
  await new Promise((r) => setTimeout(r, 60))

  assert.equal(records.resolved.length, 1)
  assert.equal(records.resolved[0].status, "resolved")
  assert.equal(repository.appended.length, 1)
})
