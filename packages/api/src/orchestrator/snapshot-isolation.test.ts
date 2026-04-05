import assert from "node:assert/strict"
import test from "node:test"
import type { Provider } from "@multi-agent/shared"
import type { ContextMessage } from "./context-snapshot"
import { DispatchOrchestrator } from "./dispatch"

/**
 * Phase 1 isolation guarantee: when user @s N agents, all queued entries
 * freeze their contextSnapshot at enqueue time. Agent A's later reply MUST
 * NOT leak into agent B's prompt snapshot — otherwise "independent thinking"
 * collapses into "echo chamber".
 *
 * This pairs with thread-per-provider (each CLI only sees its own thread)
 * to make Mode B isolation structural, not prompt-hope.
 */

type ThreadRecord = {
  id: string
  sessionGroupId: string
  provider: Provider
  alias: string
  currentModel: string | null
  nativeSessionId: string | null
}

function buildSessionsStub(threads: ThreadRecord[]) {
  return {
    findThread: (id: string) => threads.find((t) => t.id === id) ?? null,
    findThreadByGroupAndProvider: (groupId: string, provider: Provider) =>
      threads.find((t) => t.sessionGroupId === groupId && t.provider === provider) ?? null,
    listGroupThreads: (groupId: string) =>
      threads.filter((t) => t.sessionGroupId === groupId),
  }
}

function makeThreads(): ThreadRecord[] {
  return [
    { id: "t-codex", sessionGroupId: "g1", provider: "codex", alias: "Coder", currentModel: null, nativeSessionId: null },
    { id: "t-claude", sessionGroupId: "g1", provider: "claude", alias: "Reviewer", currentModel: null, nativeSessionId: null },
    { id: "t-gemini", sessionGroupId: "g1", provider: "gemini", alias: "Designer", currentModel: null, nativeSessionId: null },
  ]
}

test("enqueue-time snapshot freeze isolates peers in a parallel fan-out", () => {
  const threads = makeThreads()
  const sessions = buildSessionsStub(threads)
  const dispatch = new DispatchOrchestrator(sessions as never, {
    codex: "Coder",
    claude: "Reviewer",
    gemini: "Designer",
  })

  // Simulate a mutable timeline the snapshot builder reads from.
  const timeline: ContextMessage[] = [
    {
      id: "u1",
      role: "user",
      agentId: "user",
      content: "@Reviewer @Designer please think independently",
      createdAt: new Date("2026-04-05T10:00:00Z").toISOString(),
    },
  ]
  const buildSnapshot = () => [...timeline]

  dispatch.registerUserRoot("u1", "g1")
  const result = dispatch.enqueuePublicMentions({
    messageId: "u1",
    sessionGroupId: "g1",
    sourceProvider: "codex",
    sourceAlias: "user",
    rootMessageId: "u1",
    content: "@Reviewer @Designer please think independently",
    matchMode: "anywhere",
    buildSnapshot,
  })

  assert.equal(result.queued.length, 2, "two mentions → two queued entries")

  // Simulate agent A (Reviewer) replying AFTER enqueue — timeline mutates.
  timeline.push({
    id: "a1",
    role: "assistant",
    agentId: "Reviewer",
    content: "my independent answer X",
    createdAt: new Date("2026-04-05T10:00:05Z").toISOString(),
  })

  // Both queued entries' snapshots must still reflect enqueue-time state.
  for (const entry of result.queued) {
    const peerContents = entry.contextSnapshot.map((m) => m.content).join(" | ")
    assert.ok(
      !peerContents.includes("my independent answer X"),
      `entry to ${entry.to.provider} must not see peer reply (got: ${peerContents})`,
    )
    assert.equal(entry.contextSnapshot.length, 1, "snapshot contains only the user trigger")
  }
})

test("snapshot is a per-entry value copy, not a shared reference", () => {
  const threads = makeThreads()
  const sessions = buildSessionsStub(threads)
  const dispatch = new DispatchOrchestrator(sessions as never, {
    codex: "Coder",
    claude: "Reviewer",
    gemini: "Designer",
  })

  const timeline: ContextMessage[] = [
    {
      id: "u1",
      role: "user",
      agentId: "user",
      content: "@Reviewer @Designer go",
      createdAt: new Date("2026-04-05T10:00:00Z").toISOString(),
    },
  ]

  dispatch.registerUserRoot("u1", "g1")
  const result = dispatch.enqueuePublicMentions({
    messageId: "u1",
    sessionGroupId: "g1",
    sourceProvider: "codex",
    sourceAlias: "user",
    rootMessageId: "u1",
    content: "@Reviewer @Designer go",
    matchMode: "anywhere",
    buildSnapshot: () => [...timeline],
  })

  assert.equal(result.queued.length, 2)
  // Even if we mutate the timeline AFTER enqueue, entries are unaffected.
  timeline.length = 0
  timeline.push({
    id: "post",
    role: "assistant",
    agentId: "Designer",
    content: "poisoned",
    createdAt: new Date("2026-04-05T10:01:00Z").toISOString(),
  })

  for (const entry of result.queued) {
    const contents = entry.contextSnapshot.map((m) => m.content)
    assert.ok(!contents.includes("poisoned"))
    assert.equal(entry.contextSnapshot[0]?.id, "u1")
  }
})
