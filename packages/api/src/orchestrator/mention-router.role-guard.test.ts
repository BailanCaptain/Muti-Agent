import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveDispatchMentions, resolveMentions } from "./mention-router"

/**
 * F026 P0 Task6 · mention-router assistant role guard（2026-04-22 两次房间 A2A 误派发止血）
 *
 * 语义：agent 正文里的 @xxx 一律不派发 —— 要派发必须调 trigger_mention MCP 工具。
 *   - P0 接受副作用：agent 暂时失去"正文 @ 交接"能力
 *   - P1 补 agent prompt 教育"派发必须调工具"
 *
 * 作用域：user → agent 路径（resolveMentions / resolveDispatchMentions）保持原逻辑，
 *        agent → agent 路径 role="assistant" 时短路。
 */

const aliases = { claude: "黄仁勋", codex: "范德彪", gemini: "桂芬" } as const

describe("mention-router · assistant role guard (F026 P0 Task6)", () => {
  it("Red Case 1 · assistant 代码块里的 @ 不派发（2026-04-22 15:30 场景）", () => {
    const text = "下面是示例：\n```\n@范德彪 请接手 P0 Task 3\n@桂芬 请看视觉稿\n```"
    assert.deepEqual(resolveMentions(text, aliases, "line-start", { role: "assistant" }), [])
  })

  it("Red Case 2 · assistant 粗体装饰 **@xxx** 不派发（2026-04-22 16:05 场景）", () => {
    const text = "**@范德彪** 刚才的任务你接得挺快嘛"
    assert.deepEqual(resolveMentions(text, aliases, "line-start", { role: "assistant" }), [])
  })

  it("Red Case 3 · assistant 反问式『需要我 @xxx 吗』不派发", () => {
    const text = "小孙，需要我 @范德彪 @桂芬 吗？"
    assert.deepEqual(resolveMentions(text, aliases, "anywhere", { role: "assistant" }), [])
  })

  it("Red Case 4 · assistant 段落起行 @ 也不派发（根治新行为）", () => {
    const text = "先说结论。\n\n@范德彪 你觉得这个方案 ok 吗？"
    assert.deepEqual(resolveMentions(text, aliases, "line-start", { role: "assistant" }), [])
  })

  it("Red Case 5 · resolveDispatchMentions 同样短路 assistant", () => {
    const text = "@范德彪 做 X\n@桂芬 审阅"
    assert.deepEqual(resolveDispatchMentions(text, aliases, { role: "assistant" }), [])
  })

  it("Green Case 1 · user 消息正文 @ 照常派发（anywhere 模式）", () => {
    const text = "@范德彪 看下这个 bug"
    const mentions = resolveMentions(text, aliases, "anywhere", { role: "user" })
    assert.equal(mentions.length, 1)
    assert.equal(mentions[0].provider, "codex")
  })

  it("Green Case 2 · role 缺省回退到原行为（向后兼容）", () => {
    const text = "@范德彪 test"
    const mentions = resolveMentions(text, aliases, "line-start")
    assert.equal(mentions.length, 1)
    assert.equal(mentions[0].provider, "codex")
  })

  it("Green Case 3 · user role + line-start 正常派发", () => {
    const text = "@范德彪 请"
    const mentions = resolveMentions(text, aliases, "line-start", { role: "user" })
    assert.equal(mentions.length, 1)
  })
})
