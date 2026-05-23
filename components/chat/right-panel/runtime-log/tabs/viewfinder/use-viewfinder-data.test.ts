/**
 * F027 Phase 3 Week 4 Day 16-17 (AC-P3-4) · use-viewfinder-data + parseA2ARefs 单元测试
 *
 * 覆盖:
 *   - parseA2ARefs 拆 markdown text → text/a2a segments
 *     * 纯文本 → 1 个 text segment
 *     * 含 1 个 a2a_call → text + a2a + text
 *     * 含多个 a2a_call → 多 segment
 *     * 含 reason (双引号字符串) / deadline / status 字段
 *     * 只有 callId 没 status (兜底 unknown)
 *     * a2a_call 在开头 / 结尾
 */

import { describe, expect, it } from "vitest"
import { parseA2ARefs } from "./use-viewfinder-data"

describe("parseA2ARefs", () => {
  it("纯文本无 a2a_call → 1 个 text segment", () => {
    const segments = parseA2ARefs("这是普通文本，没有引用")
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({ kind: "text", text: "这是普通文本，没有引用" })
  })

  it("含 1 个 a2a_call 在中间 → text + a2a + text 3 段", () => {
    const segments = parseA2ARefs(
      "等 范德彪 [a2a_call=call-abc12345, status=pending, deadline 17:30] 完成验证",
    )
    expect(segments).toHaveLength(3)
    expect(segments[0]).toEqual({ kind: "text", text: "等 范德彪 " })
    expect(segments[1]).toEqual({
      kind: "a2a",
      callId: "call-abc12345",
      status: "pending",
      deadline: "17:30",
      reason: undefined,
    })
    expect(segments[2]).toEqual({ kind: "text", text: " 完成验证" })
  })

  it("含 failed + reason (双引号 quoted)", () => {
    const segments = parseA2ARefs(
      `等 桂芬 [a2a_call=call-xyz, status=failed, reason="LLM API 30s 无响应"]`,
    )
    const a2a = segments.find((s) => s.kind === "a2a")
    expect(a2a).toMatchObject({
      callId: "call-xyz",
      status: "failed",
      reason: "LLM API 30s 无响应",
    })
  })

  it("只有 callId 没 status → status fallback 'unknown'", () => {
    const segments = parseA2ARefs("[a2a_call=call-bare]")
    expect(segments).toHaveLength(1)
    expect(segments[0]).toEqual({
      kind: "a2a",
      callId: "call-bare",
      status: "unknown",
      deadline: undefined,
      reason: undefined,
    })
  })

  it("含 2 个 a2a_call 连续 → 5 段 (前 / a2a / 中 / a2a / 后 全保留)", () => {
    const segments = parseA2ARefs(
      "等 A [a2a_call=call-1, status=pending] 和 B [a2a_call=call-2, status=failed]",
    )
    expect(segments.length).toBe(4) // text + a2a + text + a2a
    expect(segments[0]).toEqual({ kind: "text", text: "等 A " })
    expect(segments[1]).toMatchObject({ kind: "a2a", callId: "call-1", status: "pending" })
    expect(segments[2]).toEqual({ kind: "text", text: " 和 B " })
    expect(segments[3]).toMatchObject({ kind: "a2a", callId: "call-2", status: "failed" })
  })

  it("a2a_call 在开头 → segment[0] 直接是 a2a", () => {
    const segments = parseA2ARefs("[a2a_call=call-first, status=working] 在跑")
    expect(segments[0]).toMatchObject({ kind: "a2a", callId: "call-first", status: "working" })
  })

  it("a2a_call 在末尾 → 最后 segment 是 a2a", () => {
    const segments = parseA2ARefs("等 [a2a_call=call-last, status=cancelled]")
    expect(segments[segments.length - 1]).toMatchObject({
      kind: "a2a",
      callId: "call-last",
      status: "cancelled",
    })
  })

  it("含 status=timeout + deadline 多字段", () => {
    const segments = parseA2ARefs("[a2a_call=call-time, status=timeout, deadline 18:00]")
    expect(segments[0]).toMatchObject({
      kind: "a2a",
      callId: "call-time",
      status: "timeout",
      deadline: "18:00",
    })
  })
})
