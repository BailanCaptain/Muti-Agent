import assert from "node:assert/strict"
import test from "node:test"
import { GeminiRuntime } from "./gemini-runtime"

const runtime = new GeminiRuntime()

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
