import assert from "node:assert/strict"
import test from "node:test"
import type { RealtimeServerEvent } from "@multi-agent/shared"
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

  const requestId = (reqEvent as Extract<RealtimeServerEvent, { type: "decision.request" }>)
    .payload.requestId
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
