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

function makeThread(id: string, groupId: string, provider: Provider = "claude"): ThreadRecord {
  return {
    id,
    sessionGroupId: groupId,
    provider,
    alias: "Reviewer",
    currentModel: null,
    nativeSessionId: null,
    sopBookmark: null,
    lastFillRatio: null,
    updatedAt: "2026-04-20T00:00:00Z",
  }
}

function makeRepo(threads: ThreadRecord[]) {
  return {
    reconcileLegacyDefaultModels: () => {},
    getThreadById: (id: string) => threads.find((t) => t.id === id),
    appendMessage: mock.fn(() => ({
      id: "msg-1",
      threadId: "",
      role: "assistant",
      content: "",
      thinking: "",
      createdAt: "2026-04-20T00:00:00Z",
      messageType: "final",
      connectorSource: null,
      groupId: null,
      groupRole: null,
      toolEvents: "[]",
      contentBlocks: "[]",
    })),
  }
}

const THREAD = "thread-claude"
const GROUP = "group-1"

describe("SessionService titler hook (F022-P2)", () => {
  it("appendAssistantMessage with messageType=final triggers titler.schedule(sessionGroupId)", () => {
    const repo = makeRepo([makeThread(THREAD, GROUP)])
    const schedule = mock.fn((_id: string) => {})
    const svc = new SessionService(repo as never, [], { schedule })
    svc.appendAssistantMessage(THREAD, "hi", "", "final")
    assert.equal(schedule.mock.calls.length, 1)
    assert.equal(schedule.mock.calls[0].arguments[0], GROUP)
  })

  it("appendAssistantMessage with messageType=progress does NOT trigger titler", () => {
    const repo = makeRepo([makeThread(THREAD, GROUP)])
    const schedule = mock.fn((_id: string) => {})
    const svc = new SessionService(repo as never, [], { schedule })
    svc.appendAssistantMessage(THREAD, "hi", "", "progress")
    assert.equal(schedule.mock.calls.length, 0)
  })

  it("appendAssistantMessage with messageType=a2a_handoff does NOT trigger titler", () => {
    const repo = makeRepo([makeThread(THREAD, GROUP)])
    const schedule = mock.fn((_id: string) => {})
    const svc = new SessionService(repo as never, [], { schedule })
    svc.appendAssistantMessage(THREAD, "hi", "", "a2a_handoff")
    assert.equal(schedule.mock.calls.length, 0)
  })

  it("appendUserMessage does NOT trigger titler", () => {
    const repo = makeRepo([makeThread(THREAD, GROUP)])
    const schedule = mock.fn((_id: string) => {})
    const svc = new SessionService(repo as never, [], { schedule })
    svc.appendUserMessage(THREAD, "hi")
    assert.equal(schedule.mock.calls.length, 0)
  })

  it("appendConnectorMessage does NOT trigger titler", () => {
    const repo = makeRepo([makeThread(THREAD, GROUP)])
    const schedule = mock.fn((_id: string) => {})
    const svc = new SessionService(repo as never, [], { schedule })
    svc.appendConnectorMessage(THREAD, "hi", {
      kind: "multi_mention_result",
      label: "x",
      targets: ["claude"],
    })
    assert.equal(schedule.mock.calls.length, 0)
  })

  it("no titler injected → appendAssistantMessage(final) is a no-op for titling", () => {
    const repo = makeRepo([makeThread(THREAD, GROUP)])
    const svc = new SessionService(repo as never, [])
    assert.doesNotThrow(() => svc.appendAssistantMessage(THREAD, "hi", "", "final"))
  })

  it("final with unknown threadId does not throw and does not schedule", () => {
    const repo = makeRepo([makeThread(THREAD, GROUP)])
    const schedule = mock.fn((_id: string) => {})
    const svc = new SessionService(repo as never, [], { schedule })
    svc.appendAssistantMessage("no-such-thread", "hi", "", "final")
    assert.equal(schedule.mock.calls.length, 0)
  })
})
