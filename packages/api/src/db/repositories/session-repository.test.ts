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
