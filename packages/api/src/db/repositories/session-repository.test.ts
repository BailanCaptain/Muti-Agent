import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { SqliteStore } from "../sqlite"
import { SessionRepository } from "./session-repository"

function createRepository() {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "session-repo-test-"))
  const sqlitePath = path.join(tempDir, "multi-agent.sqlite")
  const store = new SqliteStore(sqlitePath)
  const repository = new SessionRepository(store)

  return {
    repository,
    store,
    cleanup: () => {
      store.db.close()
      fs.rmSync(tempDir, { recursive: true, force: true })
    },
  }
}

test("connector messages persist connectorSource JSON round-trip", () => {
  const { repository, cleanup } = createRepository()

  try {
    const groupId = repository.createSessionGroup("Test Room")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId).find((item) => item.provider === "codex")
    assert.ok(thread)

    const msg = repository.appendMessage(
      thread.id,
      "assistant",
      "## 并行思考结果汇总\n\n### Claude\nA\n\n### Gemini\nB",
      "",
      "connector",
      {
        kind: "multi_mention_result",
        label: "并行思考结果",
        targets: ["claude", "gemini"],
      },
    )

    const restored = repository.listMessages(thread.id).find((m) => m.id === msg.id)
    assert.equal(restored?.messageType, "connector")
    assert.ok(restored?.connectorSource)
    assert.equal(restored?.connectorSource?.kind, "multi_mention_result")
    assert.deepEqual(restored?.connectorSource?.targets, ["claude", "gemini"])
    assert.equal(restored?.connectorSource?.label, "并行思考结果")
  } finally {
    cleanup()
  }
})

// F021 Phase 5: messages.model column — chat bubble pill needs the resolved
// per-message snapshot so historical bubbles don't shift when global/session
// runtime config later changes.
test("F021: appendMessage persists model snapshot and listMessages restores it", () => {
  const { repository, cleanup } = createRepository()

  try {
    const groupId = repository.createSessionGroup("Test Room")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId).find((item) => item.provider === "gemini")
    assert.ok(thread)

    const withModel = repository.appendMessage(
      thread.id,
      "assistant",
      "answer one",
      "",
      "final",
      null,
      null,
      null,
      "[]",
      "[]",
      "gemini-2.5-pro",
    )
    assert.equal(withModel.model, "gemini-2.5-pro")

    const legacy = repository.appendMessage(thread.id, "assistant", "answer two")
    assert.equal(legacy.model, null)

    const restored = repository.listMessages(thread.id)
    assert.equal(restored.find((m) => m.id === withModel.id)?.model, "gemini-2.5-pro")
    assert.equal(restored.find((m) => m.id === legacy.id)?.model, null)
  } finally {
    cleanup()
  }
})

test("non-connector messages have connectorSource=null", () => {
  const { repository, cleanup } = createRepository()

  try {
    const groupId = repository.createSessionGroup("Test Room")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId).find((item) => item.provider === "codex")
    assert.ok(thread)

    const msg = repository.appendMessage(thread.id, "assistant", "regular reply")
    const restored = repository.listMessages(thread.id).find((m) => m.id === msg.id)
    assert.equal(restored?.messageType, "final")
    assert.equal(restored?.connectorSource ?? null, null)
  } finally {
    cleanup()
  }
})

test("contentBlocks round-trip: images persist and restore on listMessages", () => {
  const { repository, cleanup } = createRepository()

  try {
    const groupId = repository.createSessionGroup("Test Room")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId).find((item) => item.provider === "codex")
    assert.ok(thread)

    const blocks = JSON.stringify([
      { type: "image", url: "http://localhost:8787/uploads/test.png", alt: "screenshot" },
    ])
    const msg = repository.appendMessage(
      thread.id,
      "user",
      "看看这张图",
      "",
      "final",
      null,
      null,
      null,
      "[]",
      blocks,
    )

    const restored = repository.listMessages(thread.id).find((m) => m.id === msg.id)
    assert.ok(restored, "message should be found in listMessages")
    const parsed = JSON.parse(restored.contentBlocks)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0].type, "image")
    assert.equal(parsed[0].url, "http://localhost:8787/uploads/test.png")
    assert.equal(parsed[0].alt, "screenshot")

    const recent = repository.listRecentMessages(thread.id, 10).find((m) => m.id === msg.id)
    assert.ok(recent, "message should be found in listRecentMessages")
    const parsedRecent = JSON.parse(recent.contentBlocks)
    assert.equal(parsedRecent.length, 1)
    assert.equal(parsedRecent[0].type, "image")
  } finally {
    cleanup()
  }
})

test("assistant thinking is persisted with the message and restored on reload", () => {
  const { repository, cleanup } = createRepository()

  try {
    const groupId = repository.createSessionGroup("Test Room")
    repository.ensureDefaultThreads(groupId, {
      codex: null,
      claude: null,
      gemini: null,
    })

    const thread = repository.listThreadsByGroup(groupId).find((item) => item.provider === "codex")
    assert.ok(thread, "Expected a codex thread to exist")

    const message = repository.appendMessage(thread.id, "assistant", "Final answer")
    repository.overwriteMessage(message.id, {
      content: "Final answer",
      thinking: "First thought\nSecond thought",
    })

    const restored = repository.listMessages(thread.id).find((item) => item.id === message.id)
    assert.equal(restored?.content, "Final answer")
    assert.equal(restored?.thinking, "First thought\nSecond thought")
  } finally {
    cleanup()
  }
})

// F018 P3 AC3.5 wiring prerequisites — SessionRepository 扩展

test("F018: getThreadMemory returns null when unset", () => {
  const { repository, cleanup } = createRepository()
  try {
    const groupId = repository.createSessionGroup("R")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId)[0]
    assert.equal(repository.getThreadMemory(thread.id), null)
  } finally {
    cleanup()
  }
})

test("F018: setThreadMemory + getThreadMemory round-trip", () => {
  const { repository, cleanup } = createRepository()
  try {
    const groupId = repository.createSessionGroup("R")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId)[0]
    const memory = {
      summary: "Session #2 (09:00-09:15, 15min): edit. Files: a.ts. 0 errors.",
      sessionCount: 2,
      lastUpdatedAt: "2026-04-17T09:15:00Z",
    }
    repository.setThreadMemory(thread.id, memory)
    const loaded = repository.getThreadMemory(thread.id)
    assert.deepEqual(loaded, memory)
  } finally {
    cleanup()
  }
})

test("F018: getSessionChainIndex defaults to 1 for fresh thread", () => {
  const { repository, cleanup } = createRepository()
  try {
    const groupId = repository.createSessionGroup("R")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId)[0]
    assert.equal(repository.getSessionChainIndex(thread.id), 1)
  } finally {
    cleanup()
  }
})

test("F018: incrementSessionChainIndex advances counter", () => {
  const { repository, cleanup } = createRepository()
  try {
    const groupId = repository.createSessionGroup("R")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId)[0]
    assert.equal(repository.getSessionChainIndex(thread.id), 1)
    repository.incrementSessionChainIndex(thread.id)
    assert.equal(repository.getSessionChainIndex(thread.id), 2)
    repository.incrementSessionChainIndex(thread.id)
    assert.equal(repository.getSessionChainIndex(thread.id), 3)
  } finally {
    cleanup()
  }
})

test("F018: getSessionChainIndex returns 1 for non-existent thread", () => {
  const { repository, cleanup } = createRepository()
  try {
    assert.equal(repository.getSessionChainIndex("nonexistent-thread-id"), 1)
  } finally {
    cleanup()
  }
})

// F026 P5 T0 · messages.a2a_call_id 关联键 — appendMessage 接 a2aCallId opt
// + listMessages 在 hydratedRow 上回返字段 + LEFT JOIN a2a_calls 取协议字段。
// 老 message（不传 a2aCallId / 没有 a2a 派发）所有 a2a 字段为 null。
test("F026 P5 T0: appendMessage persists a2aCallId and listMessages restores it via LEFT JOIN", () => {
  const { repository, store, cleanup } = createRepository()

  try {
    const groupId = repository.createSessionGroup("T0 LEFT JOIN")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId).find((item) => item.provider === "claude")
    assert.ok(thread)

    // 1. raw SQL 插 a2a_calls 两行 (parent + child)，不用 CallRegistry 避免引入额外依赖。
    const rootCallId = "test-root-call-T0"
    const childCallId = "test-child-call-T0"
    const now = new Date().toISOString()
    const insertA2ACall = store.db.prepare(
      `INSERT INTO a2a_calls (call_id, parent_call_id, root_call_id, issuer_id, convener_id, on_behalf_of, reply_to, deadline_at, join_set_id, status, envelope_version, session_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1', ?, ?, ?)`,
    )
    insertA2ACall.run(
      rootCallId,
      null,
      rootCallId,
      "claude:claude-1",
      "claude:claude-1",
      null,
      thread.id,
      new Date(Date.now() + 60_000).toISOString(),
      null,
      "pending",
      groupId,
      now,
      now,
    )
    insertA2ACall.run(
      childCallId,
      rootCallId,
      rootCallId,
      "claude:claude-1",
      "gemini:gemini-1",
      "user:村长",
      thread.id,
      new Date(Date.now() + 60_000).toISOString(),
      null,
      "working",
      groupId,
      now,
      now,
    )

    // 2. appendMessage 带 a2aCallId
    const a2aMsg = repository.appendMessage(
      thread.id,
      "assistant",
      "A2A connector body",
      "",
      "connector",
      { kind: "multi_mention_result", label: "A2A 协助", targets: ["gemini"] },
      null,
      "header",
      "[]",
      "[]",
      null,
      childCallId,
    )
    assert.equal(
      a2aMsg.a2aCallId,
      childCallId,
      "appendMessage should return record with a2aCallId set",
    )

    // 3. 老 message 不传 → a2aCallId null
    const plainMsg = repository.appendMessage(thread.id, "assistant", "no-a2a")
    assert.equal(plainMsg.a2aCallId, null, "non-a2a message should have a2aCallId=null")

    // 4. listMessages LEFT JOIN 后字段填充
    const restored = repository.listMessages(thread.id)
    const a2aRestored = restored.find((m) => m.id === a2aMsg.id)
    assert.ok(a2aRestored)
    assert.equal(a2aRestored.a2aCallId, childCallId)
    assert.equal(a2aRestored.a2aParentCallId, rootCallId, "LEFT JOIN should fill parent_call_id")
    assert.equal(a2aRestored.a2aRootCallId, rootCallId)
    assert.equal(a2aRestored.a2aOnBehalfOf, "user:村长")
    assert.equal(a2aRestored.a2aConvenerId, "gemini:gemini-1")
    assert.equal(a2aRestored.a2aCallStatus, "working")

    const plainRestored = restored.find((m) => m.id === plainMsg.id)
    assert.ok(plainRestored)
    assert.equal(plainRestored.a2aCallId, null)
    assert.equal(plainRestored.a2aParentCallId, null)
    assert.equal(plainRestored.a2aCallStatus, null)
  } finally {
    cleanup()
  }
})

// F026 acceptance-guardian R-204 · SessionService.appendAssistantMessage 必须把
// 第 9 个参数 a2aCallId 透传给 repository.appendMessage —— message-service.ts
// runThreadTurn 写 final 占位 message 时的 P5 视觉原语链路入口。
// 修复前：DB 实测 messages.a2a_call_id 0/689 写入 (target final 全 NULL),
// 因为 SessionService.appendAssistantMessage wrapper 没接 a2aCallId 参数,
// 导致 P5 ConnectorBubble / Visual Silo / 折叠群组等条件渲染永远 false。
test("F026 acceptance-guardian R-204: appendAssistantMessage propagates a2aCallId to repository", async () => {
  const { repository, store, cleanup } = createRepository()
  const { SessionService } = await import("../../services/session-service")

  try {
    const groupId = repository.createSessionGroup("R-204 wrapper test")
    repository.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repository.listThreadsByGroup(groupId).find((item) => item.provider === "codex")
    assert.ok(thread)

    // raw SQL 插一行 a2a_calls 模拟 dispatch 已开 call
    const callId = "call-R204-wrapper-test"
    const now = new Date().toISOString()
    store.db
      .prepare(
        `INSERT INTO a2a_calls (call_id, parent_call_id, root_call_id, issuer_id, convener_id, on_behalf_of, reply_to, deadline_at, join_set_id, status, envelope_version, session_group_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'v1', ?, ?, ?)`,
      )
      .run(
        callId,
        null,
        callId,
        "claude:claude-1",
        "claude:claude-1",
        null,
        thread.id,
        new Date(Date.now() + 60_000).toISOString(),
        null,
        "working",
        groupId,
        now,
        now,
      )

    const sessions = new SessionService(repository as never, [])
    // appendAssistantMessage 第 9 参数 = a2aCallId（修复前不存在，wrapper 默认丢弃）
    const msg = sessions.appendAssistantMessage(
      thread.id,
      "target final body",
      "",
      "final",
      null,
      null,
      "[]",
      null,
      callId,
    )
    assert.equal(msg.a2aCallId, callId, "wrapper must persist a2aCallId on the returned record")

    const restored = sessions.listThreadMessages(thread.id).find((m) => m.id === msg.id)
    assert.ok(restored)
    assert.equal(restored.a2aCallId, callId, "listMessages should restore a2aCallId from DB")
  } finally {
    cleanup()
  }
})
