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
  // F026 P2 v2 Step 7: 旧 a2a_handoff / a2a_handoff_mcp 入参已退役
  // (appendAssistantMessage 签名收窄到 progress | final)；DB schema MessageType
  // 仍保留旧标识符兼容历史行 (sqlite.ts:23-25 / mapTimelineMessage)。
  messageType:
    | "final"
    | "progress"
    | "a2a_handoff"
    | "a2a_handoff_mcp"
    | "connector"
    | "system_notice"
  connectorSource: string | null
  groupId: string | null
  groupRole: string | null
  toolEvents: string
  contentBlocks: string
}

function createMockRepository(
  threads: ThreadRecord[],
  messages: MessageRow[],
  groupOverrides: { roomId?: string | null } = {},
) {
  return {
    reconcileLegacyDefaultModels: () => {},
    getSessionGroupById: (groupId: string) => ({
      id: groupId,
      title: "Test",
      updatedAt: "2026-01-01T00:00:00Z",
      projectTag: null,
      roomId: groupOverrides.roomId ?? null,
    }),
    listThreadsByGroup: (groupId: string) => threads.filter((t) => t.sessionGroupId === groupId),
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
  messageType: MessageRow["messageType"] = "final",
): MessageRow {
  return {
    id,
    threadId,
    role,
    content,
    thinking: "",
    createdAt,
    messageType,
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
  assert.deepEqual(
    ids,
    ["m1", "m2", "m3", "m4", "m5"],
    "newMessages should be sorted by createdAt, not grouped by provider",
  )
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
  assert.deepEqual(
    ids,
    ["m3", "m4"],
    "second delta should only contain messages newer than first delta's latest",
  )
})

// --- F2 (P1): Provider preview must not be empty when there are no new messages ---

test("F2: getActiveGroupDelta preview truncates to 80 chars", () => {
  const threads = [makeThread("codex")]
  const longContent = "A".repeat(200)
  const messages = [makeMessage("thread-codex", "m1", longContent, "2026-01-01T00:00:01Z")]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.providers.codex?.preview?.length, 80)
})

// F030 r3 P2：侧栏 last-message 摘要直接 slice 原始 content，未闭合 cc_rich 的
// ```cc_rich + JSON 会泄漏到 UI。preview 必须复用 stripRichFencesForPreview 清理。
test("F030 r3 P2: getActiveGroupDelta preview 不泄漏未闭合 cc_rich", () => {
  const threads = [makeThread("codex")]
  const leaky = '结论先行\n```cc_rich\n{"kind":"card","id":"x","title":"T"'
  const messages = [makeMessage("thread-codex", "m1", leaky, "2026-01-01T00:00:01Z")]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const preview = service.getActiveGroupDelta("group-1", new Set(), undefined).providers.codex
    ?.preview
  assert.ok(preview !== undefined)
  assert.ok(!preview.includes("cc_rich"), `preview 不应含 cc_rich，实际: "${preview}"`)
  assert.ok(!preview.includes("{"), `preview 不应含原始 JSON，实际: "${preview}"`)
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
  assert.ok(codexPreview.length > 0, `codex preview should not be empty, got: "${codexPreview}"`)
  assert.ok(claudePreview.length > 0, `claude preview should not be empty, got: "${claudePreview}"`)
})

// --- F3 (P2): isFirstSnapshot + delta timestamp tracking ---

test("isFirstSnapshot returns true before first call, false after", () => {
  const threads = [makeThread("codex")]
  const messages = [makeMessage("thread-codex", "m1", "hello", "2026-01-01T00:00:01Z")]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  assert.equal(service.isFirstSnapshot("group-1"), true)
  service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(service.isFirstSnapshot("group-1"), false)
})

test("F021-P6 AC-32: getActiveGroupDelta sets sealed=true when last system_notice is newer than last user msg", () => {
  const threads = [makeThread("claude")]
  const messages = [
    makeMessage("thread-claude", "u1", "hello", "2026-04-25T08:00:00Z", "user", "final"),
    makeMessage("thread-claude", "a1", "hi", "2026-04-25T08:00:01Z", "assistant", "final"),
    makeMessage(
      "thread-claude",
      "n1",
      "封存通知",
      "2026-04-25T08:00:02Z",
      "assistant",
      "system_notice",
    ),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.providers.claude?.sealed, true)
})

test("F021-P6 AC-32: getActiveGroupDelta sealed=false when user msg arrives after system_notice", () => {
  const threads = [makeThread("claude")]
  const messages = [
    makeMessage("thread-claude", "u1", "hello", "2026-04-25T08:00:00Z", "user", "final"),
    makeMessage(
      "thread-claude",
      "n1",
      "封存通知",
      "2026-04-25T08:00:01Z",
      "assistant",
      "system_notice",
    ),
    makeMessage("thread-claude", "u2", "续命", "2026-04-25T08:00:02Z", "user", "final"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.providers.claude?.sealed, false)
})

test("F021-P6 AC-32: getActiveGroupDelta sealed=false when no system_notice exists", () => {
  const threads = [makeThread("claude")]
  const messages = [
    makeMessage("thread-claude", "u1", "hello", "2026-04-25T08:00:00Z", "user", "final"),
    makeMessage("thread-claude", "a1", "hi", "2026-04-25T08:00:01Z", "assistant", "final"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.providers.claude?.sealed, false)
})

// AC-32 review fix: full snapshot 也要派生 sealed，否则刷新页面/重选会话 badge 消失。
test("F021-P6 AC-32 (review fix): getActiveGroup sets sealed=true when last system_notice is newer than last user msg", () => {
  const threads = [makeThread("claude")]
  const messages = [
    makeMessage("thread-claude", "u1", "hello", "2026-04-25T08:00:00Z", "user", "final"),
    makeMessage("thread-claude", "a1", "hi", "2026-04-25T08:00:01Z", "assistant", "final"),
    makeMessage(
      "thread-claude",
      "n1",
      "封存通知",
      "2026-04-25T08:00:02Z",
      "assistant",
      "system_notice",
    ),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const view = service.getActiveGroup("group-1", new Set(), undefined)
  assert.equal(view.providers.claude?.sealed, true)
})

test("F021-P6 AC-32 (review fix): getActiveGroup sealed=false when user msg arrives after system_notice", () => {
  const threads = [makeThread("claude")]
  const messages = [
    makeMessage("thread-claude", "u1", "hello", "2026-04-25T08:00:00Z", "user", "final"),
    makeMessage(
      "thread-claude",
      "n1",
      "封存通知",
      "2026-04-25T08:00:01Z",
      "assistant",
      "system_notice",
    ),
    makeMessage("thread-claude", "u2", "续命", "2026-04-25T08:00:02Z", "user", "final"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const view = service.getActiveGroup("group-1", new Set(), undefined)
  assert.equal(view.providers.claude?.sealed, false)
})

test("F021-P6 AC-32 (review fix): getActiveGroup sealed=false when no system_notice exists", () => {
  const threads = [makeThread("claude")]
  const messages = [
    makeMessage("thread-claude", "u1", "hello", "2026-04-25T08:00:00Z", "user", "final"),
    makeMessage("thread-claude", "a1", "hi", "2026-04-25T08:00:01Z", "assistant", "final"),
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const view = service.getActiveGroup("group-1", new Set(), undefined)
  assert.equal(view.providers.claude?.sealed, false)
})

test("F044 getActiveGroupPage exposes an opaque cursor and restores it for older timeline pages", () => {
  const threads = [makeThread("codex"), makeThread("claude")]
  const pageMessages = [
    makeMessage("thread-codex", "m1", "first", "2026-07-10T00:00:01Z"),
    makeMessage("thread-claude", "m2", "second", "2026-07-10T00:00:02Z"),
  ]
  const rawCursor = { createdAt: "2026-07-10T00:00:01Z", rowid: 17 }
  const receivedBefore: Array<typeof rawCursor | null | undefined> = []
  const repo = {
    ...createMockRepository(threads, pageMessages),
    listGroupMessagesPage: (
      _groupId: string,
      options: { limit: number; before?: typeof rawCursor | null },
    ) => {
      receivedBefore.push(options.before)
      return {
        messages: pageMessages,
        hasMore: true,
        nextCursor: rawCursor,
      }
    },
  }
  const service = new SessionService(repo as never, [])

  const initial = service.getActiveGroupPage("group-1", new Set(), undefined, 100)
  assert.deepEqual(
    initial.activeGroup.timeline.map((message) => message.id),
    ["m1", "m2"],
  )
  assert.equal(initial.timelinePage.hasMore, true)
  assert.equal(initial.timelinePage.limit, 100)
  assert.ok(initial.timelinePage.nextCursor)
  assert.equal(initial.timelinePage.nextCursor.includes("createdAt"), false)
  assert.deepEqual(receivedBefore, [null])
  assert.equal(
    service.isFirstSnapshot("group-1"),
    false,
    "HTTP page snapshot should seed the WS delta baseline instead of triggering a full replay",
  )

  const older = service.getActiveGroupTimelinePage("group-1", initial.timelinePage.nextCursor, 100)
  assert.deepEqual(
    older.timeline.map((message) => message.id),
    ["m1", "m2"],
  )
  assert.deepEqual(receivedBefore, [null, rawCursor])
})

test("F044 review P1: page snapshot must not advance delta beyond an in-flight assistant row", () => {
  const threads = [makeThread("codex")]
  const messages = [
    makeMessage("thread-codex", "u1", "question", "2026-07-10T00:00:02Z", "user"),
    makeMessage("thread-codex", "a1", "partial", "2026-07-10T00:00:02Z", "assistant"),
  ]
  const repo = {
    ...createMockRepository(threads, messages),
    listGroupMessagesPage: () => ({
      messages,
      hasMore: false,
      nextCursor: null,
    }),
  }
  const service = new SessionService(repo as never, [])

  service.getActiveGroupPage("group-1", new Set(["thread-codex"]), undefined, 100)
  messages[1] = { ...messages[1], content: "final answer" }

  const finalDelta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.deepEqual(
    finalDelta.newMessages.find((message) => message.id === "a1")?.content,
    "final answer",
  )
})

test("F044 getActiveGroupTimelinePage rejects malformed opaque cursors", () => {
  const repo = createMockRepository([makeThread("codex")], [])
  const service = new SessionService(repo as never, [])

  assert.throws(
    () => service.getActiveGroupTimelinePage("group-1", "not-a-valid-cursor", 100),
    /invalid timeline cursor/i,
  )
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
  const messages = [makeMessage("thread-codex", "m1", "msg", "2026-01-01T00:00:01Z")]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(["thread-codex"]), undefined)
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

function makeArchiveRepo(
  initial: {
    archivedAt?: string | null
    deletedAt?: string | null
  } = {},
) {
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

// --- review 2nd round P1: 服务端 send guard — 归档/软删会话拒收消息 ---

test("review P1: isSessionGroupSendable — 活跃会话 sendable=true", () => {
  const { repo } = makeArchiveRepo()
  const service = new SessionService(repo as never, [])
  assert.deepEqual(service.isSessionGroupSendable("g1"), { sendable: true })
})

test("review P1: isSessionGroupSendable — 归档会话 sendable=false reason=archived", () => {
  const { repo } = makeArchiveRepo({ archivedAt: "2026-04-21T02:00:00Z" })
  const service = new SessionService(repo as never, [])
  assert.deepEqual(service.isSessionGroupSendable("g1"), {
    sendable: false,
    reason: "archived",
  })
})

test("review P1: isSessionGroupSendable — 软删会话 sendable=false reason=deleted（优先于 archived）", () => {
  const { repo } = makeArchiveRepo({
    archivedAt: "2026-04-21T02:00:00Z",
    deletedAt: "2026-04-21T02:10:00Z",
  })
  const service = new SessionService(repo as never, [])
  assert.deepEqual(service.isSessionGroupSendable("g1"), {
    sendable: false,
    reason: "deleted",
  })
})

test("review P1: isSessionGroupSendable — 不存在会话视作 deleted", () => {
  const repo = {
    getSessionGroupById: () => undefined,
    reconcileLegacyDefaultModels: () => {},
  }
  const service = new SessionService(repo as never, [])
  assert.deepEqual(service.isSessionGroupSendable("missing"), {
    sendable: false,
    reason: "deleted",
  })
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

// ─── F027 Phase 3 Week 2 r2 (范-r1 P1) — getRoomId 解析 ──────────────

test("r2 P1 · SessionService · getRoomId 返回 group.roomId (R-###)", () => {
  const repo = createMockRepository([], [], { roomId: "R-201" })
  const service = new SessionService(repo as never, [])
  assert.equal(service.getRoomId("group-1"), "R-201")
})

test("r2 P1 · SessionService · getRoomId 无 roomId 字段 → null", () => {
  const repo = createMockRepository([], [], { roomId: null })
  const service = new SessionService(repo as never, [])
  assert.equal(service.getRoomId("group-1"), null)
})

test("r2 P1 · SessionService · getRoomId group 不存在 → null", () => {
  const repo = {
    reconcileLegacyDefaultModels: () => {},
    getSessionGroupById: () => undefined,
    listThreadsByGroup: () => [],
    listMessages: () => [],
    listMessagesSince: () => [],
    listRecentMessages: () => [],
    createSessionGroup: () => "group-1",
    ensureDefaultThreads: () => {},
    listSessionGroups: () => [],
  }
  const service = new SessionService(repo as never, [])
  assert.equal(service.getRoomId("nonexistent"), null)
})

// --- F040 P2 T11: 群桥接归因真名（sender_display_name → timeline alias，:689 硬编码替换）---

test("F040 T11: user 消息带 senderDisplayName → alias 真名；缺省/NULL → 村长（零回归）", () => {
  const threads = [makeThread("claude")]
  const messages = [
    {
      ...makeMessage("thread-claude", "u1", "群成员的话", "2026-01-01T00:00:01Z", "user"),
      senderDisplayName: "小李",
    },
    makeMessage("thread-claude", "u2", "web 村长的话", "2026-01-01T00:00:02Z", "user"),
    makeMessage("thread-claude", "a1", "agent 的话", "2026-01-01T00:00:03Z", "assistant"),
  ]
  const repo = createMockRepository(threads, messages as never)
  const service = new SessionService(repo as never, [])

  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  const byId = new Map(delta.newMessages.map((m) => [m.id, m]))
  assert.equal(byId.get("u1")?.alias, "小李", "持久化真名进 timeline")
  assert.equal(byId.get("u2")?.alias, "村长", "无名 user 消息回落村长（历史/web 零回归）")
  assert.equal(byId.get("a1")?.alias, "Reviewer", "assistant alias 不受影响")
})

// --- F043 AC6/AC7 · token 真值直传 + MessageMeta 点亮 ---

test("F043 AC7: provider view passes through thread usage true values", () => {
  const thread = {
    ...makeThread("claude"),
    lastFillRatio: 0.14,
    lastUsedTokens: 28_904,
    lastWindowTokens: 200_000,
    lastUsageSource: "exact" as const,
  }
  const repo = createMockRepository([thread], [])
  const service = new SessionService(repo as never, [])
  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.providers.claude?.usedTokens, 28_904)
  assert.equal(delta.providers.claude?.windowTokens, 200_000)
  assert.equal(delta.providers.claude?.usageSource, "exact")
})

test("F043 AC7: legacy thread without usage columns → null passthrough (前端显示占位不编造)", () => {
  const repo = createMockRepository([makeThread("gemini")], [])
  const service = new SessionService(repo as never, [])
  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  assert.equal(delta.providers.gemini?.usedTokens, null)
  assert.equal(delta.providers.gemini?.windowTokens, null)
  assert.equal(delta.providers.gemini?.usageSource, null)
})

test("F043 AC6: timeline message lights token capsule fields from message columns", () => {
  const threads = [makeThread("claude")]
  // 探针实测数值（claude-multicall result）：in 18 / out 348 / cr 49,814 / cc 7,640
  const messages = [
    {
      ...makeMessage("thread-claude", "m1", "done", "2026-01-01T00:00:01Z"),
      inputTokens: 18,
      outputTokens: 348,
      cacheReadTokens: 49_814,
      cacheCreationTokens: 7_640,
    },
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])
  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  const tl = delta.newMessages.find((m) => m.id === "m1")
  // wire 语义：inputTokens = 输入侧全量 18+49,814+7,640 = 57,472（用户感知的本次消耗）
  assert.equal(tl?.inputTokens, 57_472)
  assert.equal(tl?.outputTokens, 348)
  // cachedPercent = round(49,814 / 57,472 × 100) = 87
  assert.equal(tl?.cachedPercent, 87)
})

test("F043 AC6: legacy message without token columns → fields undefined (MessageMeta 不渲染)", () => {
  const threads = [makeThread("claude")]
  const messages = [makeMessage("thread-claude", "m1", "old row", "2026-01-01T00:00:01Z")]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])
  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  const tl = delta.newMessages.find((m) => m.id === "m1")
  assert.equal(tl?.inputTokens, undefined)
  assert.equal(tl?.outputTokens, undefined)
  assert.equal(tl?.cachedPercent, undefined)
})

test("F043 AC6: user messages never carry token capsule (只有 assistant 轮有聚合值)", () => {
  const threads = [makeThread("claude")]
  const messages = [
    {
      ...makeMessage("thread-claude", "m1", "hi", "2026-01-01T00:00:01Z", "user"),
      inputTokens: 999, // 防御：即便列被误写，user 轮也不点亮
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])
  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  const tl = delta.newMessages.find((m) => m.id === "m1")
  assert.equal(tl?.inputTokens, undefined)
})

test("F043 P1-2 回归锁: codex 归一化明细 → 胶囊不双计缓存（真值 13,384 / 98%）", () => {
  const threads = [makeThread("codex")]
  // codex rollout 探针末条经 adapter 归一化后的落库形态：
  // inputTokens=328（13,384−13,056 非缓存输入）/ cacheRead=13,056 / cc=0 / out=16。
  // 归一化前旧列（in=13,384 原值）会让映射层 input+cacheRead 求和 = 26,440 双计。
  const messages = [
    {
      ...makeMessage("thread-codex", "m1", "done", "2026-01-01T00:00:01Z"),
      inputTokens: 328,
      outputTokens: 16,
      cacheReadTokens: 13_056,
      cacheCreationTokens: 0,
    },
  ]
  const repo = createMockRepository(threads, messages)
  const service = new SessionService(repo as never, [])
  const delta = service.getActiveGroupDelta("group-1", new Set(), undefined)
  const tl = delta.newMessages.find((m) => m.id === "m1")
  assert.equal(tl?.inputTokens, 13_384, "输入侧 = 328+13,056 = 原生 input_tokens，无双计")
  // cachedPercent = round(13,056 / 13,384 × 100) = 98（德彪 r1 P1-2 期望值）
  assert.equal(tl?.cachedPercent, 98)
})
