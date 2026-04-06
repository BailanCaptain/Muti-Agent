import assert from "node:assert/strict"
import test from "node:test"
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts"

test("AGENT_SYSTEM_PROMPTS contains prompts for all providers", () => {
  assert.ok(AGENT_SYSTEM_PROMPTS.claude.length > 0)
  assert.ok(AGENT_SYSTEM_PROMPTS.codex.length > 0)
  assert.ok(AGENT_SYSTEM_PROMPTS.gemini.length > 0)
})

test("AGENT_SYSTEM_PROMPTS.claude contains identity and rules", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.claude
  assert.ok(prompt.includes("黄仁勋"))
  assert.ok(prompt.includes("家规"))
})

test("AGENT_SYSTEM_PROMPTS.codex includes Callback API section", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.codex
  assert.ok(prompt.includes("Callback API"))
})

test("AGENT_SYSTEM_PROMPTS.gemini includes Callback API section", () => {
  const prompt = AGENT_SYSTEM_PROMPTS.gemini
  assert.ok(prompt.includes("Callback API"))
})
