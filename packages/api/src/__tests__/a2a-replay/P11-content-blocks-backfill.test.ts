/**
 * F026 P11 · LLM 文本流回填 content_blocks 契约测试
 *
 * 症状根源（spec line 141 + finishing-line plan v4 line 145）：assistant final 入库时
 * `messages.content_blocks` 硬编码 `'[]'` —— 95% 的 LLM 文本响应没有结构化 block，前端
 * 不分 thinking / text，replay 拿不到原始块序列。
 *
 * 本契约测试锁三条不变量：
 *   I1. 仅 text → 派生 [{type: "text", text: ...}]
 *   I2. text + thinking → 派生 [{type: "thinking", ...}, {type: "text", ...}]
 *   I3. 与已有 image block merge — 不丢图片块
 *   I4. 空内容（空字符串 / 仅空白）→ 派生 []（不引入空白污染）
 *   I5. 端到端：appendAssistantMessage + overwriteMessage(contentBlocks=...) 落库后
 *       listMessages 能 round-trip 恢复
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  deriveContentBlocks,
  mergeDerivedWithExistingBlocks,
} from "../../services/content-blocks-derive"
import { SessionRepository } from "../../db/repositories/session-repository"
import { SqliteStore } from "../../db/sqlite"

test("F026 P11 · I1 仅 text → 派生单 text block", () => {
  const blocks = deriveContentBlocks({ content: "hello world", thinking: "" })
  assert.deepEqual(blocks, [{ type: "text", text: "hello world" }])
})

test("F026 P11 · I2 text + thinking → 派生 thinking 在前 / text 在后", () => {
  const blocks = deriveContentBlocks({
    content: "答：是的",
    thinking: "推理过程...",
  })
  assert.deepEqual(blocks, [
    { type: "thinking", thinking: "推理过程..." },
    { type: "text", text: "答：是的" },
  ])
})

test("F026 P11 · I3 与已有 image block merge — 不丢图片块", () => {
  const existing = JSON.stringify([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
    { type: "text", text: "old text" },
  ])
  const derived = deriveContentBlocks({ content: "new text", thinking: "new thinking" })
  const merged = mergeDerivedWithExistingBlocks(existing, derived)
  assert.equal(merged.length, 3, "image preserved + new thinking + new text")
  assert.equal(merged[0].type, "image", "image block stays first (preserved)")
  assert.equal(merged[1].type, "thinking")
  const textBlock = merged[2]
  assert.equal(textBlock.type, "text")
  if (textBlock.type === "text") {
    assert.equal(textBlock.text, "new text", "text replaced by latest derive")
  }
})

test("F026 P11 · I4 空内容 → 派生 []（不引入空白污染）", () => {
  assert.deepEqual(deriveContentBlocks({ content: "", thinking: "" }), [])
  assert.deepEqual(deriveContentBlocks({ content: "   \n\n  ", thinking: "" }), [])
  assert.deepEqual(deriveContentBlocks({ content: "", thinking: "  \t " }), [])
})

test("F026 P11 · I4-edge null/undefined existing → 派生 derived 原样", () => {
  const derived = deriveContentBlocks({ content: "x", thinking: "" })
  assert.deepEqual(mergeDerivedWithExistingBlocks(null, derived), derived)
  assert.deepEqual(mergeDerivedWithExistingBlocks(undefined, derived), derived)
  assert.deepEqual(mergeDerivedWithExistingBlocks("", derived), derived)
  // 损坏 JSON → fallback 到 derived
  assert.deepEqual(mergeDerivedWithExistingBlocks("not-json{[", derived), derived)
})

test("F026 P11 · I5 端到端 round-trip — overwriteMessage(contentBlocks) 写库后 listMessages 恢复", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p11-rt-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  const repo = new SessionRepository(store)
  try {
    const groupId = repo.createSessionGroup("P11 round-trip")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    // 模拟 message-service 流：先 appendAssistantMessage 建空壳，再 overwriteMessage 落 final
    const msg = repo.appendMessage(thread.id, "assistant", "", "", "final")
    assert.equal(msg.contentBlocks, "[]", "initial baseline = []")

    const finalContent = "这是 LLM 流式输出的最终回答"
    const finalThinking = "（先想了想再答）"
    const blocks = deriveContentBlocks({ content: finalContent, thinking: finalThinking })
    repo.overwriteMessage(msg.id, {
      content: finalContent,
      thinking: finalThinking,
      contentBlocks: JSON.stringify(blocks),
    })

    const restored = repo.listMessages(thread.id).find((m) => m.id === msg.id)
    assert.ok(restored)
    const parsed = JSON.parse(restored.contentBlocks) as unknown[]
    assert.equal(parsed.length, 2, "thinking + text blocks restored")
    assert.deepEqual(parsed[0], { type: "thinking", thinking: finalThinking })
    assert.deepEqual(parsed[1], { type: "text", text: finalContent })
  } finally {
    store.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
