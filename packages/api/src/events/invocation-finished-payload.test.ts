import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { AppEvent } from "./event-types"

/**
 * F040 T9 / D16：invocation.finished / invocation.failed 加法扩展
 * assistantMessageId + rootMessageId（出站账本 key + D15 溯源需要）。
 * 类型层断言 —— 保证字段存在且为 string | null；行为集成在 message-service 测试与 e2e。
 */

describe("D16 invocation event payload 扩展", () => {
  it("invocation.finished 携带 assistantMessageId + rootMessageId", () => {
    const ev: Extract<AppEvent, { type: "invocation.finished" }> = {
      type: "invocation.finished",
      invocationId: "inv1",
      threadId: "t1",
      agentId: "黄仁勋",
      status: "idle",
      exitCode: 0,
      assistantMessageId: "am_1",
      rootMessageId: "um_1",
      createdAt: "2026-07-03T00:00:00.000Z",
    }
    assert.equal(ev.assistantMessageId, "am_1")
    assert.equal(ev.rootMessageId, "um_1")
  })

  it("invocation.failed 携带 assistantMessageId + rootMessageId（错误终态也要能溯源投递回执）", () => {
    const ev: Extract<AppEvent, { type: "invocation.failed" }> = {
      type: "invocation.failed",
      invocationId: "inv2",
      threadId: "t1",
      agentId: "黄仁勋",
      status: "error",
      error: "boom",
      exitCode: null,
      assistantMessageId: "am_2",
      rootMessageId: "um_1",
      createdAt: "2026-07-03T00:00:00.000Z",
    }
    assert.equal(ev.assistantMessageId, "am_2")
    assert.equal(ev.rootMessageId, "um_1")
  })

  it("两字段可为 null（无外部来源/无终稿占位时）", () => {
    const ev: Extract<AppEvent, { type: "invocation.finished" }> = {
      type: "invocation.finished",
      invocationId: "inv3",
      threadId: "t1",
      agentId: "黄仁勋",
      status: "idle",
      exitCode: 0,
      assistantMessageId: null,
      rootMessageId: null,
      createdAt: "2026-07-03T00:00:00.000Z",
    }
    assert.equal(ev.assistantMessageId, null)
    assert.equal(ev.rootMessageId, null)
  })
})
