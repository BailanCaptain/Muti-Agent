import assert from "node:assert/strict"
import test from "node:test"
import { GeminiRuntime } from "./gemini-runtime"

const runtime = new GeminiRuntime()

// F004/B006 第三版：Gemini runtime 不再对 RESOURCE_EXHAUSTED / 429 做 fast-fail。
// 实测（Codex 2026-04-11 6/6 PowerShell 直跑）证实 Gemini CLI 内置 retry 循环
// 可以跨越 2+ 次连续 429 自行恢复，任何有限 threshold 都会提前砍掉本可恢复的请求。
// classifyStderrChunk 对所有 Gemini stderr 一律返回 null —— 相信 CLI 的 retry
// 循环，由 liveness probe 兜底真正卡死的场景（B002 原始症状）。
test("classifyStderrChunk returns null for RESOURCE_EXHAUSTED (Gemini CLI self-recovers)", () => {
  assert.equal(
    runtime.classifyStderrChunk("[API Error] RESOURCE_EXHAUSTED: you exceeded your quota"),
    null,
  )
})

test("classifyStderrChunk returns null for MODEL_CAPACITY_EXHAUSTED (transient preview-model blip)", () => {
  assert.equal(runtime.classifyStderrChunk("MODEL_CAPACITY_EXHAUSTED"), null)
})

test("classifyStderrChunk returns null for 429 Too Many Requests (CLI retry handles it)", () => {
  assert.equal(
    runtime.classifyStderrChunk("Attempt #3 failed: 429 Too Many Requests, retrying in 15s..."),
    null,
  )
})

test("classifyStderrChunk returns null for benign Gemini stderr lines", () => {
  assert.equal(runtime.classifyStderrChunk("YOLO mode is enabled\n"), null)
  assert.equal(runtime.classifyStderrChunk("Tip: press /help for commands\n"), null)
  assert.equal(runtime.classifyStderrChunk(""), null)
})

test("parseAssistantDelta reads assistant text from Gemini content parts payloads", () => {
  const delta = runtime.parseAssistantDelta({
    type: "message",
    role: "assistant",
    content: {
      parts: [{ text: "你好，" }, { text: "这是 Gemini。" }],
    },
  })

  assert.equal(delta, "你好，这是 Gemini。")
})

test("parseAssistantDelta reads assistant text from Gemini candidate payloads", () => {
  const delta = runtime.parseAssistantDelta({
    candidates: [
      {
        content: {
          parts: [{ text: "从 candidates 返回的内容" }],
        },
      },
    ],
  })

  assert.equal(delta, "从 candidates 返回的内容")
})
