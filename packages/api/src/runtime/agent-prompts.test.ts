import assert from "node:assert/strict"
import test from "node:test"
import { buildSystemPrompt, AGENT_SYSTEM_PROMPTS } from "./agent-prompts"

test("buildSystemPrompt returns base prompt when no summary", () => {
  const result = buildSystemPrompt("claude", null)
  assert.equal(result, AGENT_SYSTEM_PROMPTS.claude)
})

test("buildSystemPrompt appends memory section when summary exists", () => {
  const summary = "上一轮讨论了 A2A 对齐方案"
  const result = buildSystemPrompt("claude", summary)
  assert.ok(result.includes(AGENT_SYSTEM_PROMPTS.claude))
  assert.ok(result.includes("上一轮会话摘要"))
  assert.ok(result.includes(summary))
  assert.ok(result.includes("请参考上述背景信息继续协作"))
})
