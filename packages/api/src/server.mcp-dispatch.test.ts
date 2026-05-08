import assert from "node:assert/strict"
import test from "node:test"
import { buildMcpDispatchPayload } from "./server"
import { resolveCallTagMentions } from "./orchestrator/mention-router"
import type { ProviderAliases } from "./orchestrator/mention-router"

/**
 * F026 R-073 · MCP triggerMention 不派发根因修复
 *
 * 根因：MCP `trigger_mention` callback 在 server.ts 内把入参拼成 `@<alias> <snippet>`
 * 后调 `handleAgentPublicMessage`，进 dispatch.ts assistant 路径只认 `[Call: @X 描述]`
 * 严协议（F026-P3 方案 X / commit 99d7d9e），content 没有 `[Call:]` → mentions=[]
 * → 静默丢弃 → 桂芬 thread 0 新消息（R-073 现场）。
 *
 * 修复（F026 P2 v2 Step 7 clean-cut 后）：
 *   - content 改 `[Call: @<alias> <snippet>]` 通过严协议关卡
 *   - messageType 统一为 `final` —— 旧的 `a2a_handoff_mcp` 标签已退役（DB
 *     schema 保留作历史兼容 Q2=[B]）。titler 不被派发指令污染由
 *     `session-service.appendAssistantMessage` 内容前缀判定保证。
 *
 * 本测覆盖三条断言：
 *   1. payload.content 为 [Call: @X 描述] 字面格式
 *   2. payload.messageType 为 "final"（Step 7 clean-cut）
 *   3. 集成闭环：payload.content 必须被 resolveCallTagMentions 识别 → dispatch 不再丢
 */

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

test("F026 R-073 · buildMcpDispatchPayload returns [Call:] tag content", () => {
  const payload = buildMcpDispatchPayload("桂芬", "诗歌评价请帮忙看一下")
  assert.equal(payload.content, "[Call: @桂芬 诗歌评价请帮忙看一下]")
})

test("F026 P2 v2 Step 7 · buildMcpDispatchPayload returns messageType=final (clean-cut)", () => {
  const payload = buildMcpDispatchPayload("桂芬", "任务 X")
  assert.equal(payload.messageType, "final")
})

test("F026 R-073 · payload content survives resolveCallTagMentions (dispatch 闭环)", () => {
  const payload = buildMcpDispatchPayload("桂芬", "任务 X")
  const matches = resolveCallTagMentions(payload.content, aliases)
  assert.equal(
    matches.length,
    1,
    "MCP 拼出的 content 必须被 [Call:] 严协议识别 — 否则 dispatch 静默丢弃 (R-073 复现)",
  )
  assert.equal(matches[0].alias, "桂芬")
  assert.equal(matches[0].provider, "gemini")
  assert.equal(matches[0].description, "任务 X")
})

test("F026 R-073 · empty taskSnippet still produces a valid [Call:] tag", () => {
  const payload = buildMcpDispatchPayload("桂芬", "")
  assert.equal(payload.content, "[Call: @桂芬 ]")
  const matches = resolveCallTagMentions(payload.content, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].alias, "桂芬")
})
