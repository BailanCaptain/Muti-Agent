/**
 * F033 · splitDecisionsForTimeline 纯函数单测
 *
 * 覆盖:
 *   - 按 activeGroupId 过滤（pending 与 records 各自）
 *   - anchorMessageId 有无 → inline map / standalone 分轨
 *   - 同 requestId 同时出现在 pending 与 records → pending 优先（live 卡可点）
 *   - standalone records 按 createdAt 升序
 */

import type { DecisionRecord, DecisionRequest } from "@multi-agent/shared"
import { describe, expect, it } from "vitest"
import { splitDecisionsForTimeline } from "./decision-timeline"

function req(id: string, overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: id,
    kind: "multi_choice",
    title: `T-${id}`,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    sessionGroupId: "group-1",
    createdAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  }
}

function rec(id: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    requestId: id,
    sessionGroupId: "group-1",
    kind: "multi_choice",
    title: `T-${id}`,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    status: "resolved",
    verdicts: [{ optionId: "a", verdict: "approved" }],
    createdAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  }
}

describe("splitDecisionsForTimeline", () => {
  it("按 activeGroupId 过滤 pending 与 records", () => {
    const out = splitDecisionsForTimeline(
      [req("p1"), req("p2", { sessionGroupId: "group-other" })],
      [rec("r1"), rec("r2", { sessionGroupId: "group-other" })],
      "group-1",
    )
    expect(out.standAloneDecisions.map((d) => d.requestId)).toEqual(["p1"])
    expect(out.standaloneRecords.map((r) => r.requestId)).toEqual(["r1"])
  })

  it("anchorMessageId 分轨：inline map / standalone", () => {
    const out = splitDecisionsForTimeline(
      [req("p1", { anchorMessageId: "msg-1" }), req("p2")],
      [rec("r1", { anchorMessageId: "msg-1" }), rec("r2")],
      "group-1",
    )
    expect(out.inlineDecisionsByMsgId.get("msg-1")?.map((d) => d.requestId)).toEqual(["p1"])
    expect(out.standAloneDecisions.map((d) => d.requestId)).toEqual(["p2"])
    expect(out.inlineRecordsByMsgId.get("msg-1")?.map((r) => r.requestId)).toEqual(["r1"])
    expect(out.standaloneRecords.map((r) => r.requestId)).toEqual(["r2"])
  })

  it("同 requestId pending 优先，record 不重复渲染", () => {
    const out = splitDecisionsForTimeline([req("x")], [rec("x")], "group-1")
    expect(out.standAloneDecisions.map((d) => d.requestId)).toEqual(["x"])
    expect(out.standaloneRecords).toHaveLength(0)
  })

  it("standalone records 按 createdAt 升序", () => {
    const out = splitDecisionsForTimeline(
      [],
      [
        rec("late", { createdAt: "2026-07-02T12:00:00.000Z" }),
        rec("early", { createdAt: "2026-07-02T09:00:00.000Z" }),
      ],
      "group-1",
    )
    expect(out.standaloneRecords.map((r) => r.requestId)).toEqual(["early", "late"])
  })

  it("activeGroupId 为 null → 全空", () => {
    const out = splitDecisionsForTimeline([req("p1")], [rec("r1")], null)
    expect(out.standAloneDecisions).toHaveLength(0)
    expect(out.standaloneRecords).toHaveLength(0)
    expect(out.inlineDecisionsByMsgId.size).toBe(0)
    expect(out.inlineRecordsByMsgId.size).toBe(0)
  })
})
