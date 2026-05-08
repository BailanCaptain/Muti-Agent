import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { CallRow } from "./call-registry"
import { isSiblingCrossCall } from "./sibling-guard"
import type { WorklistRow } from "./worklist-registry"

/**
 * F026 P3 · sibling-guard 纯函数：caller 派发 [Call: @T] 时，T 是否
 * 在 caller 的 sibling 集合内（同 parent fan-out 的另一兄弟）？
 *
 * 判定路径：
 *   1. caller.parentCallId 为 null（user-root 直派）→ 总是 false
 *   2. parent worklist 不存在（已 settled / 不存在 fan-out）→ false
 *   3. parent worklist.items 含 target alias 且 ≠ callerAlias → true
 *
 * 反向接力（child → parent）不在范围内：parent 不出现在 sibling 集合里。
 */

function makeCall(overrides: Partial<CallRow> & Pick<CallRow, "callId">): CallRow {
  return {
    parentCallId: null,
    rootCallId: overrides.callId,
    issuerId: "user",
    convenerId: "user",
    onBehalfOf: null,
    replyTo: "claude:黄仁勋",
    deadlineAt: "2026-05-05T18:00:00.000Z",
    joinSetId: null,
    status: "working",
    envelopeVersion: "v1",
    sessionGroupId: "sg-1",
    createdAt: "2026-05-05T17:00:00.000Z",
    updatedAt: "2026-05-05T17:00:00.000Z",
    ...overrides,
  }
}

function makeWorklist(items: Array<{ alias: string }>, parentCallId: string): WorklistRow {
  return {
    worklistId: `wl-${parentCallId}`,
    parentWorklistId: null,
    parentCallId,
    rootCallId: parentCallId,
    sessionGroupId: "sg-1",
    items: items.map((it) => ({ alias: it.alias, status: "pending" })),
    currentIndex: 0,
    status: "active",
    createdAt: "2026-05-05T17:00:00.000Z",
    updatedAt: "2026-05-05T17:00:00.000Z",
  }
}

describe("sibling-guard isSiblingCrossCall", () => {
  it("caller 不存在 → false", () => {
    const result = isSiblingCrossCall(
      {
        callRegistry: { get: () => null },
        worklistRegistry: { findActiveByParentCallId: () => null },
      },
      { callerCallId: "call-missing", callerAlias: "桂芬", targetAlias: "德彪" },
    )
    assert.equal(result, false)
  })

  it("caller.parentCallId 为 null（user-root 直派）→ false", () => {
    const callerCall = makeCall({ callId: "call-root", parentCallId: null })
    const result = isSiblingCrossCall(
      {
        callRegistry: { get: () => callerCall },
        worklistRegistry: { findActiveByParentCallId: () => null },
      },
      { callerCallId: "call-root", callerAlias: "黄仁勋", targetAlias: "桂芬" },
    )
    assert.equal(result, false)
  })

  it("parent worklist 不存在（fan-out 已 settled）→ false", () => {
    const callerCall = makeCall({
      callId: "call-桂芬",
      parentCallId: "call-仁勋-root",
      rootCallId: "call-root",
    })
    const result = isSiblingCrossCall(
      {
        callRegistry: { get: () => callerCall },
        worklistRegistry: { findActiveByParentCallId: () => null },
      },
      { callerCallId: "call-桂芬", callerAlias: "桂芬", targetAlias: "德彪" },
    )
    assert.equal(result, false)
  })

  it("R-096 桂芬派 [@德彪]：target 是 sibling → true", () => {
    const callerCall = makeCall({
      callId: "call-3fc48e3b",
      parentCallId: "call-501e548b",
      rootCallId: "call-501e548b",
    })
    const parentWorklist = makeWorklist([{ alias: "桂芬" }, { alias: "德彪" }], "call-501e548b")
    const result = isSiblingCrossCall(
      {
        callRegistry: { get: () => callerCall },
        worklistRegistry: { findActiveByParentCallId: () => parentWorklist },
      },
      { callerCallId: "call-3fc48e3b", callerAlias: "桂芬", targetAlias: "德彪" },
    )
    assert.equal(result, true)
  })

  it("target = caller 自己（自派）→ false", () => {
    const callerCall = makeCall({
      callId: "call-3fc",
      parentCallId: "call-501",
      rootCallId: "call-501",
    })
    const parentWorklist = makeWorklist([{ alias: "桂芬" }, { alias: "德彪" }], "call-501")
    const result = isSiblingCrossCall(
      {
        callRegistry: { get: () => callerCall },
        worklistRegistry: { findActiveByParentCallId: () => parentWorklist },
      },
      { callerCallId: "call-3fc", callerAlias: "桂芬", targetAlias: "桂芬" },
    )
    assert.equal(result, false)
  })

  it("target 不在 sibling 集合（嵌套深派 fresh agent）→ false", () => {
    const callerCall = makeCall({
      callId: "call-3fc",
      parentCallId: "call-501",
      rootCallId: "call-501",
    })
    const parentWorklist = makeWorklist([{ alias: "桂芬" }], "call-501")
    const result = isSiblingCrossCall(
      {
        callRegistry: { get: () => callerCall },
        worklistRegistry: { findActiveByParentCallId: () => parentWorklist },
      },
      { callerCallId: "call-3fc", callerAlias: "桂芬", targetAlias: "德彪" },
    )
    assert.equal(result, false)
  })

  it("反向接力 child→parent 不在 sibling 集合 → false", () => {
    // 德彪派 [@仁勋]：仁勋是德彪的 grandparent，不是 sibling
    const callerCall = makeCall({
      callId: "call-097db445",
      parentCallId: "call-3fc48e3b",
      rootCallId: "call-501",
    })
    // 桂芬的 worklist items = [德彪]（桂芬派给德彪）
    const parentWorklist = makeWorklist([{ alias: "德彪" }], "call-3fc48e3b")
    const result = isSiblingCrossCall(
      {
        callRegistry: { get: () => callerCall },
        worklistRegistry: { findActiveByParentCallId: () => parentWorklist },
      },
      { callerCallId: "call-097db445", callerAlias: "德彪", targetAlias: "黄仁勋" },
    )
    // 仁勋 ∉ 桂芬的 worklist items → false
    assert.equal(result, false)
  })
})
