import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createDrizzleDb } from "./drizzle-instance"
import { DrizzleSessionRepository } from "./repositories/session-repository-drizzle"
import { SessionRepository } from "./repositories/session-repository"
import { SqliteStore } from "./sqlite"

/**
 * F043 AC5 · usage 明细持久化 migration + 往返。
 * 双源 schema 必须同步加列（F026 P3.1 先例）：
 *   messages: input_tokens / output_tokens / cache_read_tokens / cache_creation_tokens（全 NULL=无数据，与 0 区分）
 *   threads:  last_used_tokens / last_window_tokens / last_usage_source（面板真值直传的落库源，AC7 消费）
 */

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // Windows WAL 句柄延迟释放，忽略
    }
  }
}

type ColInfo = { name: string; type: string; notnull: number }

const MESSAGE_COLS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"]
const THREAD_COLS = ["last_used_tokens", "last_window_tokens", "last_usage_source"]

test("F043 AC5 · sqlite.ts 建库含 messages token 四列 + threads 真值三列（全可空）", () => {
  withTempDir("f043-cols-sqlite-", (dir) => {
    const store = new SqliteStore(join(dir, "test.sqlite"))
    try {
      const msgCols = store.db.prepare("PRAGMA table_info(messages)").all() as ColInfo[]
      for (const name of MESSAGE_COLS) {
        const col = msgCols.find((c) => c.name === name)
        assert.ok(col, `messages.${name} missing in sqlite.ts path`)
        assert.equal(col?.notnull, 0, `messages.${name} 必须可空（NULL=无数据 ≠ 0）`)
      }
      const thCols = store.db.prepare("PRAGMA table_info(threads)").all() as ColInfo[]
      for (const name of THREAD_COLS) {
        const col = thCols.find((c) => c.name === name)
        assert.ok(col, `threads.${name} missing in sqlite.ts path`)
        assert.equal(col?.notnull, 0)
      }
    } finally {
      store.db.close()
    }
  })
})

test("F043 AC5 · drizzle-instance 建库含同套七列", () => {
  withTempDir("f043-cols-drizzle-", (dir) => {
    const { db, close } = createDrizzleDb(join(dir, "test.sqlite"))
    try {
      const msgCols = db.all<ColInfo>("PRAGMA table_info(messages)" as never) as unknown as ColInfo[]
      for (const name of MESSAGE_COLS) {
        assert.ok(
          msgCols.find((c) => c.name === name),
          `messages.${name} missing in drizzle path`,
        )
      }
      const thCols = db.all<ColInfo>("PRAGMA table_info(threads)" as never) as unknown as ColInfo[]
      for (const name of THREAD_COLS) {
        assert.ok(
          thCols.find((c) => c.name === name),
          `threads.${name} missing in drizzle path`,
        )
      }
    } finally {
      close()
    }
  })
})

test("F043 AC5 · raw repo：message token 四列 overwriteMessage 往返 + 旧行 NULL 保持", () => {
  withTempDir("f043-rt-raw-", (dir) => {
    const store = new SqliteStore(join(dir, "multi-agent.sqlite"))
    const repo = new SessionRepository(store)
    try {
      const groupId = repo.createSessionGroup("F043")
      repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
      const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
      assert.ok(thread)
      const msg = repo.appendMessage(thread.id, "assistant", "…", "", "final")

      // 旧行（未写 token）→ 全 null（MessageMeta 不渲染，与 0 区分）
      const before = repo.listMessages(thread.id).find((m) => m.id === msg.id)
      assert.equal(before?.inputTokens, null)
      assert.equal(before?.outputTokens, null)

      repo.overwriteMessage(msg.id, {
        content: "done",
        inputTokens: 18,
        outputTokens: 348,
        cacheReadTokens: 49_814,
        cacheCreationTokens: 7_640,
      })
      const after = repo.listMessages(thread.id).find((m) => m.id === msg.id)
      assert.equal(after?.inputTokens, 18)
      assert.equal(after?.outputTokens, 348)
      assert.equal(after?.cacheReadTokens, 49_814)
      assert.equal(after?.cacheCreationTokens, 7_640)

      // 不带 token 字段的 overwrite（流式中途 flush）不得清掉已写值
      repo.overwriteMessage(msg.id, { content: "done2" })
      const kept = repo.listMessages(thread.id).find((m) => m.id === msg.id)
      assert.equal(kept?.inputTokens, 18, "未提供字段必须保持原值")
    } finally {
      store.db.close()
      // withTempDir 兜底清理
    }
  })
})

test("F043 AC5 · raw repo：threads 真值三列 updateThread 三态（写值/清空/不动）", () => {
  withTempDir("f043-th-raw-", (dir) => {
    const store = new SqliteStore(join(dir, "multi-agent.sqlite"))
    const repo = new SessionRepository(store)
    try {
      const groupId = repo.createSessionGroup("F043")
      repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
      const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
      assert.ok(thread)

      // 写真值
      repo.updateThread(thread.id, {
        lastFillRatio: 0.14,
        lastUsedTokens: 28_904,
        lastWindowTokens: 200_000,
        lastUsageSource: "exact",
      })
      let row = repo.listThreadsByGroup(groupId).find((t) => t.id === thread.id)
      assert.equal(row?.lastUsedTokens, 28_904)
      assert.equal(row?.lastWindowTokens, 200_000)
      assert.equal(row?.lastUsageSource, "exact")

      // 不含字段的更新不动列
      repo.updateThread(thread.id, { currentModel: "claude-opus-4-8" })
      row = repo.listThreadsByGroup(groupId).find((t) => t.id === thread.id)
      assert.equal(row?.lastUsedTokens, 28_904, "未提供字段不得清列")

      // 封存复位：显式 null 清列（AC4 语义延伸到三列）
      repo.updateThread(thread.id, {
        lastFillRatio: null,
        lastUsedTokens: null,
        lastWindowTokens: null,
        lastUsageSource: null,
      })
      row = repo.listThreadsByGroup(groupId).find((t) => t.id === thread.id)
      assert.equal(row?.lastUsedTokens, null)
      assert.equal(row?.lastWindowTokens, null)
      assert.equal(row?.lastUsageSource, null)
    } finally {
      store.db.close()
    }
  })
})

test("F043 AC5 · drizzle repo：message token 往返 + threads 三态（与 raw 同契约）", () => {
  withTempDir("f043-rt-drz-", (dir) => {
    const { db, close } = createDrizzleDb(join(dir, "test.sqlite"))
    const repo = new DrizzleSessionRepository(db)
    try {
      const groupId = repo.createSessionGroup("F043")
      repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
      const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
      assert.ok(thread)
      const msg = repo.appendMessage(thread.id, "assistant", "…", "", "final")

      repo.overwriteMessage(msg.id, {
        inputTokens: 13_384,
        outputTokens: 16,
        cacheReadTokens: 13_056,
        cacheCreationTokens: 0,
      })
      const after = repo.listMessages(thread.id).find((m) => m.id === msg.id)
      assert.equal(after?.inputTokens, 13_384)
      assert.equal(after?.cacheReadTokens, 13_056)
      assert.equal(after?.cacheCreationTokens, 0, "显式 0 与 NULL 必须可区分")

      repo.updateThread(thread.id, {
        lastUsedTokens: 13_400,
        lastWindowTokens: 353_400,
        lastUsageSource: "exact",
      })
      let row = repo.listThreadsByGroup(groupId).find((t) => t.id === thread.id)
      assert.equal(row?.lastUsedTokens, 13_400)
      assert.equal(row?.lastWindowTokens, 353_400)
      assert.equal(row?.lastUsageSource, "exact")

      repo.updateThread(thread.id, {
        lastUsedTokens: null,
        lastWindowTokens: null,
        lastUsageSource: null,
      })
      row = repo.listThreadsByGroup(groupId).find((t) => t.id === thread.id)
      assert.equal(row?.lastUsedTokens, null)
    } finally {
      close()
    }
  })
})
