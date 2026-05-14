/**
 * F027 P13.4 · Level 5 escalate sinks 单元测试
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  ConsoleWarnLevel5Sink,
  NoopLevel5Sink,
  RecordingLevel5Sink,
} from "./level5-escalate-sink"
import type { EscalateInfo } from "./types"

function info(over: Partial<EscalateInfo> = {}): EscalateInfo {
  return {
    roomId: "R-201",
    alias: "桂芬",
    trigger: "history_keyword",
    query: "F011 drizzle",
    visitedLevels: [1, 2, 3],
    reason: "levels_exhausted_no_satisfaction",
    totalMs: 4200,
    critiqueCalls: 3,
    ...over,
  }
}

describe("F027 P13.4 · NoopLevel5Sink", () => {
  it("escalate resolves without effect", async () => {
    const sink = new NoopLevel5Sink()
    await sink.escalate(info())
    // 无断言，只要不抛
  })
})

describe("F027 P13.4 · ConsoleWarnLevel5Sink", () => {
  it("escalate 调注入的 log 函数 + 含 room/alias/trigger/visited", async () => {
    const logs: Array<{ msg: string; info: EscalateInfo }> = []
    const sink = new ConsoleWarnLevel5Sink((msg, info) => logs.push({ msg, info }))
    await sink.escalate(info())
    assert.equal(logs.length, 1)
    assert.match(logs[0].msg, /R-201/)
    assert.match(logs[0].msg, /桂芬/)
    assert.match(logs[0].msg, /history_keyword/)
    assert.match(logs[0].msg, /\[1,2,3\]/)
    assert.match(logs[0].msg, /levels_exhausted_no_satisfaction/)
  })
})

describe("F027 P13.4 · RecordingLevel5Sink", () => {
  it("记录每次 escalate 完整 info 到 calls[]", async () => {
    const sink = new RecordingLevel5Sink()
    await sink.escalate(info({ roomId: "R-201", reason: "first" }))
    await sink.escalate(info({ roomId: "R-202", reason: "second" }))
    assert.equal(sink.calls.length, 2)
    assert.equal(sink.calls[0].roomId, "R-201")
    assert.equal(sink.calls[0].reason, "first")
    assert.equal(sink.calls[1].roomId, "R-202")
    assert.equal(sink.calls[1].reason, "second")
  })
})
