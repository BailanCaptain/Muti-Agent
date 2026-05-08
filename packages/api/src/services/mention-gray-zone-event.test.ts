import assert from "node:assert/strict"
import test from "node:test"
import type { MentionGrayZonePayload } from "@multi-agent/shared"
import {
  MENTION_GRAY_ZONE_EVENT_TYPE,
  buildMentionGrayZoneRealtimeEvent,
  clipContentSample,
  isMentionGrayZonePayload,
  parseMentionGrayZonePayload,
} from "./mention-gray-zone-event"

const goodPayload: MentionGrayZonePayload = {
  sessionGroupId: "g1",
  threadId: "t1",
  traceId: "trace-abc",
  source: "user:小孙",
  sourceMessageId: "msg-1",
  target: "桂芬",
  targetProvider: "gemini",
  contentSample: "@桂芬 这个不行",
  decision: "skip",
  occurredAt: "2026-04-29T07:30:00.000Z",
}

test("F026 P5 T2: type guard accepts well-formed payload", () => {
  assert.equal(isMentionGrayZonePayload(goodPayload), true)
})

test("F026 P5 T2: type guard rejects missing required fields", () => {
  for (const key of Object.keys(goodPayload) as Array<keyof MentionGrayZonePayload>) {
    if (key === "threadId") continue
    const clone = { ...goodPayload } as Record<string, unknown>
    delete clone[key]
    assert.equal(
      isMentionGrayZonePayload(clone),
      false,
      `expected reject when missing '${String(key)}'`,
    )
  }
})

test("F026 P5 T2: type guard accepts missing optional threadId", () => {
  const { threadId: _omit, ...rest } = goodPayload
  assert.equal(isMentionGrayZonePayload(rest), true)
})

test("F026 P5 T2: type guard rejects non-skip decision", () => {
  assert.equal(isMentionGrayZonePayload({ ...goodPayload, decision: "dispatch" } as unknown), false)
})

test("F026 P5 T2: type guard rejects empty traceId", () => {
  assert.equal(isMentionGrayZonePayload({ ...goodPayload, traceId: "" }), false)
})

test("F026 P5 T2: parse throws helpful error on missing field", () => {
  const { traceId: _omit, ...partial } = goodPayload
  assert.throws(() => parseMentionGrayZonePayload(partial), /missing field 'traceId'/)
})

test("F026 P5 T2: parse throws on bad decision", () => {
  assert.throws(
    () => parseMentionGrayZonePayload({ ...goodPayload, decision: "fire" }),
    /invalid decision/,
  )
})

test("F026 P5 T2: build realtime event wraps payload with correct type", () => {
  const ev = buildMentionGrayZoneRealtimeEvent(goodPayload)
  assert.equal(ev.type, "mention.gray_zone")
  assert.deepEqual(ev.payload, goodPayload)
})

test("F026 P5 T2: db event-type literal stays mention_gray_zone (snake)", () => {
  // 跟 dispatch_validation_retry 同款约定：DB 列字面量用 snake_case，WS event type 用 dotted。
  assert.equal(MENTION_GRAY_ZONE_EVENT_TYPE, "mention_gray_zone")
})

test("F026 P5 T2: clipContentSample under threshold returns original", () => {
  assert.equal(clipContentSample("hello", 200), "hello")
})

test("F026 P5 T2: clipContentSample over threshold appends ellipsis", () => {
  const long = "x".repeat(250)
  const out = clipContentSample(long, 200)
  assert.equal(out.length, 201) // 200 chars + 1 ellipsis
  assert.ok(out.endsWith("…"))
})
