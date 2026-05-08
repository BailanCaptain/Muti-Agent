import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
/**
 * R-013 场景3 诊断: 范德彪实际回复 → resolveMentions / classifyMention 实测
 * 不改源码,只是验证 preview DB 里 ca57cc4d 这条消息在两条派发路径下各自会不会识别出 @黄仁勋
 *
 * B023 守卫：硬编码 DB 路径指向 F026-p0 worktree 快照。该 worktree 已被
 * 清理后此 fixture 消失，整个 describe 改为 skip — 保留诊断脚本价值不阻塞 CI。
 */
import { describe, test } from "node:test"
import Database from "better-sqlite3"
import { resolveMentions, resolveMentionsClassified } from "../orchestrator/mention-router"

const DB_PATH =
  "C:/Users/-/Desktop/Multi-Agent/.worktrees/F026-p0/.runtime/worktree-preview/data/multi-agent.sqlite"
const MESSAGE_ID = "ca57cc4d-95ca-482e-b548-51e5efd45122"

const ALIASES = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
} as const

const describeIfDbAvailable = existsSync(DB_PATH) ? describe : describe.skip

describeIfDbAvailable("R-013 范德彪回复派发诊断", () => {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  const row = db.prepare("SELECT content FROM messages WHERE id=?").get(MESSAGE_ID) as
    | { content: string }
    | undefined
  db.close()

  test("消息确实存在", () => {
    assert.ok(row, "message ca57cc4d should exist")
  })

  if (!row) return

  const content = row.content

  test("line-start resolveMentions 是否识别到 @黄仁勋", () => {
    const mentions = resolveMentions(content, ALIASES, "line-start")
    console.log("  [resolveMentions line-start] →", JSON.stringify(mentions))
    const claudeHits = mentions.filter((m) => m.provider === "claude")
    console.log("  claude 匹配数:", claudeHits.length)
    if (claudeHits.length === 0) {
      // 打印行首带 @黄仁勋 的位置,帮助诊断
      const idx = content.indexOf("\n@黄仁勋")
      console.log("  content.indexOf('\\n@黄仁勋') =", idx)
      console.log("  前后 40 字节:", JSON.stringify(content.slice(Math.max(0, idx - 5), idx + 20)))
    }
  })

  test("classified 三层 resolveMentionsClassified 会派发吗", () => {
    const classified = resolveMentionsClassified(content, ALIASES)
    console.log("  [classified] →", JSON.stringify(classified, null, 2))
  })

  test("assistant role guard 会短路吗", () => {
    const mentions = resolveMentions(content, ALIASES, "line-start", { role: "assistant" })
    console.log("  [role=assistant] resolveMentions →", JSON.stringify(mentions))
    assert.equal(mentions.length, 0, "assistant role guard should return []")
  })
})
