import assert from "node:assert/strict"
import test from "node:test"
import { GeminiRuntime } from "./gemini-runtime"

const runtime = new GeminiRuntime()

test("classifyStderrChunk catches RESOURCE_EXHAUSTED (Gemini 429 spin)", () => {
  const result = runtime.classifyStderrChunk(
    "[API Error] RESOURCE_EXHAUSTED: you exceeded your quota",
  )
  assert.ok(result, "should return a fast-fail reason")
  assert.match(result!.reason, /RESOURCE_EXHAUSTED/)
})

test("classifyStderrChunk catches MODEL_CAPACITY_EXHAUSTED variant", () => {
  const result = runtime.classifyStderrChunk("MODEL_CAPACITY_EXHAUSTED")
  assert.ok(result)
  assert.match(result!.reason, /容量/)
})

test("classifyStderrChunk catches 429 Too Many Requests plain text", () => {
  const result = runtime.classifyStderrChunk(
    "Attempt #3 failed: 429 Too Many Requests, retrying in 15s...",
  )
  assert.ok(result)
  assert.match(result!.reason, /429/)
})

test("classifyStderrChunk returns null for benign Gemini stderr lines", () => {
  assert.equal(
    runtime.classifyStderrChunk("YOLO mode is enabled\n"),
    null,
  )
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
