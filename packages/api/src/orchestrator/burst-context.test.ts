import assert from "node:assert/strict"
import test from "node:test"
import {
  type BurstConfig,
  DEFAULT_BURST_CONFIG,
  buildTombstone,
  detectRecentBurst,
  formatTombstone,
} from "./burst-context"
import type { ContextMessage } from "./context-snapshot"

// ── helpers ──────────────────────────────────────────────────────────

const BASE_TS = new Date("2026-04-25T10:00:00.000Z").getTime()

function mkMsg(
  index: number,
  overrides: Partial<{
    role: "user" | "assistant"
    agentId: string
    content: string
    tsOffsetMs: number
  }> = {},
): ContextMessage {
  const tsOffset = overrides.tsOffsetMs ?? index * 60_000
  return {
    id: `msg-${index}`,
    role: overrides.role ?? "assistant",
    agentId: overrides.agentId ?? "范德彪",
    content: overrides.content ?? `message ${index} content keyword test`,
    createdAt: new Date(BASE_TS + tsOffset).toISOString(),
  }
}

const TEST_CONFIG: BurstConfig = {
  burstSilenceGapMs: 15 * 60_000, // 15 min
  minBurstMessages: 4,
  maxBurstMessages: 12,
  maxTombstoneKeywords: 5,
}

// ── detectRecentBurst ────────────────────────────────────────────────

test("F026-P3 burst · returns all when below maxBurstMessages and no big gap", () => {
  const msgs = Array.from({ length: 5 }, (_, i) => mkMsg(i + 1))
  const r = detectRecentBurst(msgs, TEST_CONFIG)
  assert.equal(r.burst.length, 5)
  assert.equal(r.omitted.length, 0)
})

test("F026-P3 burst · cuts at silence gap >= 15min", () => {
  // 50 紧密消息（每条间隔 1min），然后 60min gap，再 8 条紧密
  const msgs: ContextMessage[] = []
  for (let i = 0; i < 50; i++) msgs.push(mkMsg(i + 1, { tsOffsetMs: i * 60_000 }))
  const tailStart = 50 * 60_000 + 60 * 60_000 // 110 min
  for (let i = 0; i < 8; i++) {
    msgs.push(mkMsg(50 + i + 1, { tsOffsetMs: tailStart + i * 60_000 }))
  }
  const r = detectRecentBurst(msgs, TEST_CONFIG)
  assert.equal(r.burst.length, 8, `expected 8 burst, got ${r.burst.length}`)
  assert.equal(r.omitted.length, 50, `expected 50 omitted, got ${r.omitted.length}`)
})

test("F026-P3 burst · protects Q→A boundary (user→assistant) — does not split", () => {
  // 前 49 条 assistant，第 50 是 user，第 51-54 是 assistant burst（需 Q→A 保护把 user 拉进来）
  const msgs: ContextMessage[] = []
  for (let i = 0; i < 49; i++) msgs.push(mkMsg(i + 1, { tsOffsetMs: i * 60_000 }))
  // 大 gap 切点：第 49 条之后跳 60min，第 50 条 user 提问，紧接 4 条 assistant 回答
  const tailStart = 49 * 60_000 + 60 * 60_000
  msgs.push(mkMsg(50, { role: "user", agentId: "user", tsOffsetMs: tailStart }))
  for (let i = 0; i < 4; i++) {
    msgs.push(mkMsg(50 + i + 1, { role: "assistant", tsOffsetMs: tailStart + (i + 1) * 60_000 }))
  }
  const r = detectRecentBurst(msgs, TEST_CONFIG)
  // burst 必须包含 user 提问 (msg-50) + 4 条 assistant 回答
  assert.ok(r.burst.length >= 5, `expected ≥5 burst (user + 4 assistant), got ${r.burst.length}`)
  assert.ok(
    r.burst.some((m) => m.id === "msg-50" && m.role === "user"),
    "user msg-50 must be in burst (Q→A protect)",
  )
})

test("F026-P3 burst · caps at maxBurstMessages even within burst", () => {
  // 20 条紧密，无 gap → 走 maxBurstMessages=12 上限
  const msgs = Array.from({ length: 20 }, (_, i) => mkMsg(i + 1))
  const r = detectRecentBurst(msgs, TEST_CONFIG)
  assert.equal(r.burst.length, 12)
  assert.equal(r.omitted.length, 8)
})

test("F026-P3 burst · empty input returns empty", () => {
  const r = detectRecentBurst([], TEST_CONFIG)
  assert.equal(r.burst.length, 0)
  assert.equal(r.omitted.length, 0)
})

// ── buildTombstone + formatTombstone ────────────────────────────────

test("F026-P3 tombstone · returns null on empty omitted", () => {
  const t = buildTombstone([], "test thread", TEST_CONFIG)
  assert.equal(t, null)
})

test("F026-P3 tombstone · includes participants by alias and id range hint", () => {
  const omitted: ContextMessage[] = [
    mkMsg(1, { role: "assistant", agentId: "黄仁勋", content: "架构 review feedback A2A" }),
    mkMsg(2, { role: "user", agentId: "user", content: "继续" }),
    mkMsg(3, { role: "assistant", agentId: "范德彪", content: "review 完毕 A2A 协议" }),
    mkMsg(10, { role: "assistant", agentId: "桂芬", content: "前端样式 review 完成" }),
  ]
  const t = buildTombstone(omitted, "Q-A2A 架构问题", TEST_CONFIG)
  assert.ok(t, "tombstone should be non-null")
  // participants 用 alias（user 不算 participant — 只统计 assistant agentId）
  assert.deepEqual(t!.participants.sort(), ["桂芬", "范德彪", "黄仁勋"])
  const formatted = formatTombstone(t!, { headMsgId: "msg-1", tailMsgId: "msg-10" })
  assert.match(formatted, /MCP get_room_context/)
  assert.match(formatted, /msg_id=msg-1.*msg-10/)
  assert.match(formatted, /\[Tombstone\]/)
  assert.match(formatted, /\[\/Tombstone\]/)
})

test("F026-P3 tombstone · keywords cap at maxTombstoneKeywords", () => {
  const omitted: ContextMessage[] = Array.from({ length: 5 }, (_, i) =>
    mkMsg(i + 1, {
      content: `keyword${i + 1} repeated keyword${i + 1} keyword${i + 1} keyword${i + 1}`,
    }),
  )
  const t = buildTombstone(omitted, "title", { ...TEST_CONFIG, maxTombstoneKeywords: 3 })
  assert.ok(t)
  assert.ok(t!.keywords.length <= 3, `expected ≤3 keywords, got ${t!.keywords.length}`)
})

// ── DEFAULT_BURST_CONFIG ────────────────────────────────────────────

test("F026-P3 · DEFAULT_BURST_CONFIG matches plan (gap=15min, min=4, max=12)", () => {
  assert.equal(DEFAULT_BURST_CONFIG.burstSilenceGapMs, 15 * 60_000)
  assert.equal(DEFAULT_BURST_CONFIG.minBurstMessages, 4)
  assert.equal(DEFAULT_BURST_CONFIG.maxBurstMessages, 12)
  assert.equal(DEFAULT_BURST_CONFIG.maxTombstoneKeywords, 5)
})

// ── formatBurstSection ────────────────────────────────────────────────

test("F026-P3 formatBurstSection · empty input returns empty string", async () => {
  const { formatBurstSection } = await import("./burst-context")
  assert.equal(formatBurstSection([]), "")
})

test("F026-P3 formatBurstSection · wraps with [Burst]/[/Burst] and one line per msg", async () => {
  const { formatBurstSection } = await import("./burst-context")
  const burst: ContextMessage[] = [
    mkMsg(1, { role: "user", agentId: "user", content: "你好" }),
    mkMsg(2, { role: "assistant", agentId: "范德彪", content: "review 完毕" }),
  ]
  const s = formatBurstSection(burst)
  assert.match(s, /\[Burst — 最近 2 条相关讨论\]/)
  assert.match(s, /\[\/Burst\]/)
  assert.match(s, /\[user·user·\d{2}:\d{2}\] 你好/)
  assert.match(s, /\[assistant·范德彪·\d{2}:\d{2}\] review 完毕/)
})

test("F026-P3 formatBurstSection · per-msg content cap default 1500", async () => {
  const { formatBurstSection } = await import("./burst-context")
  const burst: ContextMessage[] = [mkMsg(1, { content: "x".repeat(5000) })]
  const s = formatBurstSection(burst)
  assert.match(s, /…\(超出截断\)/)
  assert.ok(s.length < 5000, `expected truncated, got len=${s.length}`)
})
