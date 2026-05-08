import assert from "node:assert/strict"
import { existsSync } from "node:fs"
/**
 * R-013 派发链路实测：用真实 ca57cc4d 范德彪回复 + 真实 dispatch.enqueuePublicMentions
 * 看 enqueue 是否真的产生了一个黄仁勋的 queue entry
 *
 * B023 守卫：硬编码 DB 路径指向 F026-p0 worktree 的快照 DB。该 worktree 已被
 * 清理后此 fixture 消失，整个 describe 改为 skip — 保留诊断脚本价值不阻塞 CI。
 */
import { describe, test } from "node:test"
import Database from "better-sqlite3"
import pino from "pino"
import { DispatchOrchestrator } from "../orchestrator/dispatch"

const DB_PATH =
  "C:/Users/-/Desktop/Multi-Agent/.worktrees/F026-p0/.runtime/worktree-preview/data/multi-agent.sqlite"
const MESSAGE_ID = "ca57cc4d-95ca-482e-b548-51e5efd45122"

const describeIfDbAvailable = existsSync(DB_PATH) ? describe : describe.skip

describeIfDbAvailable("R-013 dispatch.enqueuePublicMentions 实测", () => {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  const row = db
    .prepare("SELECT content, thread_id as threadId FROM messages WHERE id=?")
    .get(MESSAGE_ID) as { content: string; threadId: string } | undefined
  if (!row) {
    db.close()
    throw new Error("message ca57cc4d not found")
  }

  const sourceThread = db
    .prepare(
      "SELECT id, provider, alias, session_group_id as sessionGroupId FROM threads WHERE id=?",
    )
    .get(row.threadId) as { id: string; provider: string; alias: string; sessionGroupId: string }

  const claudeThread = db
    .prepare(
      "SELECT id, provider, alias FROM threads WHERE session_group_id=? AND provider='claude'",
    )
    .get(sourceThread.sessionGroupId) as { id: string; provider: string; alias: string } | undefined

  const allThreads = db
    .prepare("SELECT id, provider, alias FROM threads WHERE session_group_id=?")
    .all(sourceThread.sessionGroupId) as Array<{ id: string; provider: string; alias: string }>

  db.close()

  test("threads exist and aliases", () => {
    console.log("source thread:", sourceThread)
    console.log("claude thread:", claudeThread)
    console.log("all threads:", allThreads)
    assert.ok(sourceThread, "source thread should exist")
    assert.ok(claudeThread, "claude thread should exist")
  })

  // F026 方案 X 切换后：R-013 历史样本里范德彪回复无 [Call:] tag，按方案 X 不再派发
  // —— 这条 trace test 是当年用来复现"派发漏发"bug 的工具，方案 X 重新定义了"派发"语义。
  test("dispatch.enqueuePublicMentions 历史样本（无 [Call:] tag）按方案 X 不派发", () => {
    const findThreadByGroupAndProvider = (sgId: string, prov: string) => {
      if (sgId !== sourceThread.sessionGroupId) return null
      return allThreads.find((t) => t.provider === prov) ?? null
    }
    const log = pino({ level: "silent" })

    const aliases: Record<string, string> = {}
    for (const t of allThreads) aliases[t.provider] = t.alias

    const dispatch = new DispatchOrchestrator(
      { findThreadByGroupAndProvider } as any,
      aliases as any,
    )
    void log

    const result = dispatch.enqueuePublicMentions({
      messageId: MESSAGE_ID,
      sessionGroupId: sourceThread.sessionGroupId,
      sourceProvider: sourceThread.provider as any,
      sourceAlias: sourceThread.alias,
      rootMessageId: "fake-root",
      content: row.content,
      matchMode: "line-start",
      parentInvocationId: "fake-invocation",
      buildSnapshot: () => [],
      extractSnippet: (c, _alias) => c.slice(0, 100),
    })

    console.log("queued count:", result.queued.length)
    console.log(
      "queued:",
      JSON.stringify(
        result.queued.map((q) => ({ to: q.to, taskSnippet: q.taskSnippet?.slice(0, 50) })),
        null,
        2,
      ),
    )
    console.log("blocked:", JSON.stringify(result.blocked, null, 2))

    const claudeQueued = result.queued.find((q) => q.to.provider === "claude")
    assert.equal(claudeQueued, undefined, "方案 X：assistant 自由文本里的 @ 不再触发派发")
  })
})
