import assert from "node:assert/strict"
import { describe, it, mock } from "node:test"
import type { Provider } from "@multi-agent/shared"
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

type AppendArgs = {
  threadId: string
  role: "user" | "assistant"
  content: string
  thinking: string
  messageType: string
  connectorSource: unknown
  groupId: string | null
  groupRole: string | null
  toolEvents: string
  contentBlocks: string
  model: string | null
}

function makeThread(): ThreadRecord {
  return {
    id: "thread-claude",
    sessionGroupId: "group-1",
    provider: "claude",
    alias: "黄仁勋",
    currentModel: "claude-opus-4-7",
    nativeSessionId: null,
    sopBookmark: null,
    lastFillRatio: null,
    updatedAt: "2026-04-25T00:00:00Z",
  }
}

function makeRepo(thread: ThreadRecord, capture: AppendArgs[]) {
  return {
    reconcileLegacyDefaultModels: () => {},
    getThreadById: (id: string) => (id === thread.id ? thread : undefined),
    listMessages: () => [],
    appendMessage: mock.fn(
      (
        threadId: string,
        role: "user" | "assistant",
        content: string,
        thinking = "",
        messageType = "final",
        connectorSource: unknown = null,
        groupId: string | null = null,
        groupRole: string | null = null,
        toolEvents = "[]",
        contentBlocks = "[]",
        model: string | null = null,
      ) => {
        capture.push({
          threadId,
          role,
          content,
          thinking,
          messageType,
          connectorSource,
          groupId,
          groupRole,
          toolEvents,
          contentBlocks,
          model,
        })
        return {
          id: "notice-1",
          threadId,
          role,
          content,
          thinking,
          messageType,
          connectorSource: null,
          groupId,
          groupRole,
          toolEvents,
          contentBlocks,
          createdAt: "2026-04-25T08:00:00Z",
          model,
        }
      },
    ),
    touchThread: () => {},
  }
}

describe("F021-P6 AC-32: SessionService.appendSystemNoticeMessage", () => {
  it("persists a system_notice message with role=assistant and given content", () => {
    const thread = makeThread()
    const capture: AppendArgs[] = []
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock repository
    const repo = makeRepo(thread, capture) as any
    const service = new SessionService(repo, [])

    const result = service.appendSystemNoticeMessage(
      thread.id,
      "⚠ Claude 上下文已封存（45%），下一轮重启 native session",
    )

    assert.equal(repo.appendMessage.mock.callCount(), 1)
    assert.equal(capture[0]?.threadId, thread.id)
    assert.equal(capture[0]?.role, "assistant")
    assert.equal(capture[0]?.messageType, "system_notice")
    assert.match(capture[0]?.content ?? "", /已封存/)
    assert.equal(result.messageType, "system_notice")
  })

  it("toTimelineMessage round-trips a system_notice message back as messageType=system_notice", () => {
    const thread = makeThread()
    const noticeRow = {
      id: "notice-1",
      threadId: thread.id,
      role: "assistant" as const,
      content: "⚠ Claude 上下文已封存（45%）",
      thinking: "",
      createdAt: "2026-04-25T08:00:00Z",
      messageType: "system_notice" as const,
      connectorSource: null,
      groupId: null,
      groupRole: null,
      toolEvents: "[]",
      contentBlocks: "[]",
      model: null,
    }
    const repo = {
      reconcileLegacyDefaultModels: () => {},
      getThreadById: () => thread,
      listMessages: () => [noticeRow],
    }
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock repository
    const service = new SessionService(repo as any, [])

    const tl = service.toTimelineMessage(thread.id, "notice-1")
    assert.ok(tl)
    assert.equal(tl?.messageType, "system_notice")
    assert.equal(tl?.role, "assistant")
    assert.equal(tl?.provider, "claude")
    assert.match(tl?.content ?? "", /已封存/)
  })
})
