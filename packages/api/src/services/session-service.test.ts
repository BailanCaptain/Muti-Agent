import assert from "node:assert/strict"
import test from "node:test"
import type { Provider, RealtimeServerEvent } from "@multi-agent/shared"
import { SessionService } from "./session-service"

type ThreadRecord = {
  id: string
  sessionGroupId: string
  provider: Provider
  alias: string
  currentModel: string | null
  nativeSessionId: string | null
  sopBookmark: string | null
  lastFillRatio: number | null
  updatedAt: string
}

type MessageRow = {
  id: string
  threadId: string
  role: "user" | "assistant"
  content: string
  thinking: string
  createdAt: string
  messageType: "final" | "progress" | "a2a_handoff" | "connector"
  connectorSource: string | null
  groupId: string | null
  groupRole: string | null
  toolEvents: string
  contentBlocks: string
}

function createMockRepository(threads: ThreadRecord[], messages: MessageRow[]) {
  return {
    reconcileLegacyDefaultModels: () => {},
    getSessionGroupById: (groupId: string) => ({
      id: groupId,
      title: "Test",
      updatedAt: "2026-01-01T00:00:00Z",
      projectTag: null,
    }),
    listThreadsByGroup: (groupId: string) =>
      threads.filter((t) => t.sessionGroupId === groupId),
    listMessages: (threadId: string) =>
      messages
        .filter((m) => m.threadId === threadId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    listMessagesSince: (threadId: string, since: string) =>
      messages
        .filter((m) => m.threadId === threadId && m.createdAt > since)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    listRecentMessages: (threadId: string, limit: number) =>
      messages
        .filter((m) => m.threadId === threadId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit),
    createSessionGroup: () => "group-1",
    ensureDefaultThreads: () => {},
    listSessionGroups: () => [],
  }
}

function makeThread(provider: Provider, groupId = "group-1"): ThreadRecord {
  return {
    id: `thread-${provider}`,
    sessionGroupId: groupId,
    provider,
    alias: provider === "codex" ? "Coder" : provider === "claude" ? "Reviewer" : "Designer",
    currentModel: null,
    nativeSessionId: null,
    sopBookmark: null,
    lastFillRatio: null,
    updatedAt: "2026-01-01T00:00:00Z",
  }
}

function makeMessage(
  threadId: string,
  id: string,
  content: string,
  createdAt: string,
  role: "user" | "assistant" = "assistant",
): MessageRow {
  return {
    id,
    threadId,
    role,
    content,
    thinking: "",
    createdAt,
    messageType: "final",
    connectorSource: null,
    groupId: null,
    groupRole: null,
    toolEvents: "[]",
    contentBlocks: "[]",
  }
}

// --- F1 (P1): Delta newMessages must be sorted by createdAt, not by provider order ---

test("F1: getActiveGroupDelta returns newMessages sorted by createdAt across providers", () => {
  const threads = [makeThread("codex"), makeThread("claude"), makeThread("gemini")]
  const messages = [
    makeMessage("thread-codex", "m1", "codex first", "2026-01-01T00:00:01Z"),
    makeMessage("thread-claude", "m2", "claude second", "2026-01-01T00:00:02Z"),
    makeMessage("thread-codex", "m3", "codex third", "2026-01-01T00:00:03Z"),
    makeMessage("thread-gemini", "m4", "gemini fourth", "2026-01-01T00:00:04Z"),
    makeMessage("thread-claude", "m5", "claude fifth", "2026-01-01T00:00:05Z"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)

  const ids = delta.newMessages.map((m) => m.id)
  assert.deepEqual(ids, ["m1", "m2", "m3", "m4", "m5"],
    "newMessages should be sorted by createdAt, not grouped by provider")
})

test("F1: second delta only includes messages after the first delta's latest timestamp", () => {
  const threads = [makeThread("codex"), makeThread("claude")]
  const messages = [
    makeMessage("thread-codex", "m1", "old codex", "2026-01-01T00:00:01Z"),
    makeMessage("thread-claude", "m2", "old claude", "2026-01-01T00:00:02Z"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta1 = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta1.newMessages.length, 2)

  messages.push(
    makeMessage("thread-codex", "m3", "new codex", "2026-01-01T00:00:03Z"),
    makeMessage("thread-claude", "m4", "new claude", "2026-01-01T00:00:04Z"),
  )

  const delta2 = service.getActiveGroupDelta("group-1", new Set(), undefined)
  const ids = delta2.newMessages.map((m) => m.id)
  assert.deepEqual(ids, ["m3", "m4"],
    "second delta should only contain messages newer than first delta's latest")
})

// --- F2 (P1): Provider preview must not be empty when there are no new messages ---

test("F2: getActiveGroupDelta preview truncates to 80 chars", () => {
  const threads = [makeThread("codex")]
  const longContent = "A".repeat(200)
  const messages = [
    makeMessage("thread-codex", "m1", longContent, "2026-01-01T00:00:01Z"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.providers.codex?.preview?.length, 80)
})

test("F2: getActiveGroupDelta preview shows latest message even when no new messages since last delta", () => {
  const threads = [makeThread("codex"), makeThread("claude")]
  const messages = [
    makeMessage("thread-codex", "m1", "codex message content", "2026-01-01T00:00:01Z"),
    makeMessage("thread-claude", "m2", "claude message content", "2026-01-01T00:00:02Z"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  service.getActiveGroupDelta("group-1", new Set(), undefined)

  const delta2 = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta2.newMessages.length, 0, "no new messages in second delta")

  const codexPreview = delta2.providers.codex?.preview ?? ""
  const claudePreview = delta2.providers.claude?.preview ?? ""
  assert.ok(codexPreview.length > 0,
    `codex preview should not be empty, got: "${codexPreview}"`)
  assert.ok(claudePreview.length > 0,
    `claude preview should not be empty, got: "${claudePreview}"`)
})

// --- F3 (P2): isFirstSnapshot + delta timestamp tracking ---

test("isFirstSnapshot returns true before first call, false after", () => {
  const threads = [makeThread("codex")]
  const messages = [
    makeMessage("thread-codex", "m1", "hello", "2026-01-01T00:00:01Z"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  assert.equal(service.isFirstSnapshot("group-1"), true)
  service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(service.isFirstSnapshot("group-1"), false)
})

test("getActiveGroupDelta with empty thread returns empty newMessages and empty preview", () => {
  const threads = [makeThread("codex")]
  const messages: MessageRow[] = []
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.newMessages.length, 0)
  assert.equal(delta.providers.codex?.preview, "")
})

test("getActiveGroupDelta running flag reflects runningThreadIds", () => {
  const threads = [makeThread("codex"), makeThread("claude")]
  const messages = [
    makeMessage("thread-codex", "m1", "msg", "2026-01-01T00:00:01Z"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta(
    "group-1",
    new Set(["thread-codex"]),
    undefined,
  )
  assert.equal(delta.providers.codex?.running, true)
  assert.equal(delta.providers.claude?.running, false)
})

test("F022-P3 AC-11/12: SessionService.listSessionGroups 透传 roomId + participants + messageCount + createdAtLabel", () => {
  const repo = {
    ...createMockRepository([], []),
    listSessionGroups: () => [
      {
        id: "g1",
        roomId: "R-042",
        title: "学习 TDD",
        projectTag: null,
        createdAt: "2026-04-18T06:30:00.000Z",
        updatedAt: "2026-04-20T06:00:00.000Z",
        previews: [],
        participants: ["claude", "codex"] as Provider[],
        messageCount: 12,
      },
    ],
  }
  const service = new SessionService(repo as never, [])
  const [row] = service.listSessionGroups()
  assert.ok(row)
  assert.equal(row.roomId, "R-042")
  assert.deepEqual(row.participants, ["claude", "codex"])
  assert.equal(row.messageCount, 12)
  assert.match(row.createdAtLabel, /2026/)
  assert.match(row.updatedAtLabel, /2026/)
})

test("F022-P3.5 AC-14a: SessionService.listSessionGroups 透传 updatedAt（ISO，供前端时间分桶）", () => {
  const repo = {
    ...createMockRepository([], []),
    listSessionGroups: () => [
      {
        id: "g1",
        roomId: "R-001",
        title: "t",
        projectTag: null,
        createdAt: "2026-04-18T06:30:00.000Z",
        updatedAt: "2026-04-20T06:00:00.000Z",
        previews: [],
        participants: ["claude"] as Provider[],
        messageCount: 1,
      },
    ],
  }
  const service = new SessionService(repo as never, [])
  const [row] = service.listSessionGroups()
  assert.ok(row)
  assert.equal(row.updatedAt, "2026-04-20T06:00:00.000Z")
})

// --- review P2-3: archive/softDelete/restore 广播 session.archive_state_changed ---

function makeArchiveRepo(initial: {
  archivedAt?: string | null
  deletedAt?: string | null
} = {}) {
  const state = {
    archivedAt: initial.archivedAt ?? null,
    deletedAt: initial.deletedAt ?? null,
  }
  const calls: { op: string; id: string }[] = []
  return {
    repo: {
      reconcileLegacyDefaultModels: () => {},
      getSessionGroupById: (groupId: string) => ({
        id: groupId,
        title: "t",
        updatedAt: "2026-04-20T06:00:00Z",
        projectTag: null,
        archivedAt: state.archivedAt,
        deletedAt: state.deletedAt,
      }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
      listMessagesSince: () => [],
      listRecentMessages: () => [],
      createSessionGroup: () => "g",
      ensureDefaultThreads: () => {},
      listSessionGroups: () => [],
      archiveSessionGroup: (id: string) => {
        calls.push({ op: "archive", id })
        state.archivedAt = "2026-04-20T07:00:00Z"
      },
      softDeleteSessionGroup: (id: string) => {
        calls.push({ op: "softDelete", id })
        state.deletedAt = "2026-04-20T08:00:00Z"
      },
      restoreSessionGroup: (id: string) => {
        calls.push({ op: "restore", id })
        state.archivedAt = null
        state.deletedAt = null
      },
    },
    calls,
    state,
  }
}

test("review P2-3: archiveSessionGroup 广播 session.archive_state_changed（archivedAt 非空）", () => {
  const { repo } = makeArchiveRepo()
  const service = new SessionService(repo as never, [])
  const events: RealtimeServerEvent[] = []
  service.setBroadcaster((e) => events.push(e))

  service.archiveSessionGroup("g1")

  const archiveEvents = events.filter((e) => e.type === "session.archive_state_changed")
  assert.equal(archiveEvents.length, 1)
  assert.equal(archiveEvents[0]!.payload.sessionGroupId, "g1")
  assert.ok(archiveEvents[0]!.payload.archivedAt, "archivedAt 应为非空时间戳")
  assert.equal(archiveEvents[0]!.payload.deletedAt, null)
})

test("review P2-3: softDeleteSessionGroup 广播 session.archive_state_changed（deletedAt 非空）", () => {
  const { repo } = makeArchiveRepo()
  const service = new SessionService(repo as never, [])
  const events: RealtimeServerEvent[] = []
  service.setBroadcaster((e) => events.push(e))

  service.softDeleteSessionGroup("g1")

  const archiveEvents = events.filter((e) => e.type === "session.archive_state_changed")
  assert.equal(archiveEvents.length, 1)
  assert.equal(archiveEvents[0]!.payload.sessionGroupId, "g1")
  assert.ok(archiveEvents[0]!.payload.deletedAt, "deletedAt 应为非空时间戳")
})

test("review P2-3: restoreSessionGroup 广播 session.archive_state_changed（两个时间戳都清零）", () => {
  const { repo } = makeArchiveRepo({
    archivedAt: "2026-04-20T07:00:00Z",
    deletedAt: "2026-04-20T08:00:00Z",
  })
  const service = new SessionService(repo as never, [])
  const events: RealtimeServerEvent[] = []
  service.setBroadcaster((e) => events.push(e))

  service.restoreSessionGroup("g1")

  const archiveEvents = events.filter((e) => e.type === "session.archive_state_changed")
  assert.equal(archiveEvents.length, 1)
  assert.equal(archiveEvents[0]!.payload.archivedAt, null)
  assert.equal(archiveEvents[0]!.payload.deletedAt, null)
})

test("review P2-3: 未 setBroadcaster 时 archive 不抛异常", () => {
  const { repo } = makeArchiveRepo()
  const service = new SessionService(repo as never, [])
  // 不调用 setBroadcaster — 模拟 API server 还没 wire 上的启动窗口。
  assert.doesNotThrow(() => service.archiveSessionGroup("g1"))
})

test("F022-P3 AC-15: SessionService.listSessionGroups 对缺失 participants/messageCount 提供默认值", () => {
  const repo = {
    ...createMockRepository([], []),
    listSessionGroups: () =>
      [
        {
          id: "g-empty",
          roomId: null,
          title: "未命名",
          projectTag: null,
          createdAt: "2026-04-20T06:00:00.000Z",
          updatedAt: "2026-04-20T06:00:00.000Z",
          previews: [],
        },
      ] as never,
  }
  const service = new SessionService(repo as never, [])
  const [row] = service.listSessionGroups()
  assert.ok(row)
  assert.equal(row.roomId, null)
  assert.deepEqual(row.participants, [])
  assert.equal(row.messageCount, 0)
})
