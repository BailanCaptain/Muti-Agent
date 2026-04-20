import { strict as assert } from "node:assert"
import { test } from "node:test"
import type { SessionGroupSummary } from "./realtime"
import { applyMessageToSessionGroup, applyMessageToSessionGroups } from "./session-groups"

const makeGroup = (over: Partial<SessionGroupSummary> = {}): SessionGroupSummary => ({
  id: "g1",
  roomId: null,
  title: "T",
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedAtLabel: "old",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdAtLabel: "c",
  participants: [],
  messageCount: 0,
  previews: [],
  ...over,
})

const msg = (over: Partial<{ provider: "claude" | "codex" | "gemini"; alias: string; content: string; createdAt: string }> = {}) => ({
  provider: "claude" as const,
  alias: "黄仁勋",
  content: "hi",
  createdAt: "2026-04-20T12:00:00.000Z",
  ...over,
})

test("adds new provider to participants and bumps counters", () => {
  const out = applyMessageToSessionGroup(makeGroup(), msg())
  assert.deepEqual(out.participants, ["claude"])
  assert.equal(out.messageCount, 1)
  assert.equal(out.updatedAt, "2026-04-20T12:00:00.000Z")
  assert.equal(out.previews.length, 1)
  assert.equal(out.previews[0]?.provider, "claude")
  assert.equal(out.previews[0]?.text, "hi")
  assert.notEqual(out.updatedAtLabel, "old")
})

test("does not duplicate existing provider but replaces preview + bumps count", () => {
  const g = makeGroup({
    participants: ["claude"],
    previews: [{ provider: "claude", alias: "黄仁勋", text: "prev" }],
    messageCount: 1,
  })
  const out = applyMessageToSessionGroup(g, msg({ content: "new" }))
  assert.deepEqual(out.participants, ["claude"])
  assert.equal(out.messageCount, 2)
  assert.equal(out.previews.length, 1)
  assert.equal(out.previews[0]?.text, "new")
})

test("appends second distinct provider", () => {
  const g = makeGroup({ participants: ["claude"], messageCount: 1 })
  const out = applyMessageToSessionGroup(g, msg({ provider: "codex", alias: "范德彪" }))
  assert.deepEqual(out.participants, ["claude", "codex"])
})

test("truncates preview text to 80 chars", () => {
  const out = applyMessageToSessionGroup(makeGroup(), msg({ content: "a".repeat(200) }))
  assert.equal(out.previews[0]?.text.length, 80)
})

test("keeps target group at original index and leaves others untouched", () => {
  const g1 = makeGroup({ id: "g1" })
  const g2 = makeGroup({ id: "g2" })
  const g3 = makeGroup({ id: "g3" })
  const out = applyMessageToSessionGroups([g1, g2, g3], "g2", msg())
  assert.equal(out[0]?.id, "g1")
  assert.equal(out[1]?.id, "g2")
  assert.equal(out[2]?.id, "g3")
  assert.deepEqual(out[1]?.participants, ["claude"])
  assert.deepEqual(out[0]?.participants, [])
  assert.deepEqual(out[2]?.participants, [])
})

test("returns same array reference when group id not found", () => {
  const g1 = makeGroup({ id: "g1" })
  const input = [g1]
  const out = applyMessageToSessionGroups(input, "missing", msg())
  assert.equal(out, input)
})
