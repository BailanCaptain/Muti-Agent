import assert from "node:assert/strict"
import test from "node:test"
import type { AgentRunInput, RuntimeCommand } from "./base-runtime"
import { ClaudeRuntime } from "./claude-runtime"
import { CodexRuntime } from "./codex-runtime"
import { GeminiRuntime } from "./gemini-runtime"

// buildCommand is protected on BaseCliRuntime; expose via subclasses for inspection.
class InspectableClaude extends ClaudeRuntime {
  inspect(input: AgentRunInput): RuntimeCommand {
    return this.buildCommand(input)
  }
}
class InspectableCodex extends CodexRuntime {
  inspect(input: AgentRunInput): RuntimeCommand {
    return this.buildCommand(input)
  }
}
class InspectableGemini extends GeminiRuntime {
  inspect(input: AgentRunInput): RuntimeCommand {
    return this.buildCommand(input)
  }
}

function makeInput(env: Record<string, string>): AgentRunInput {
  return {
    invocationId: "inv-1",
    threadId: "thr-1",
    agentId: "a",
    prompt: "hello",
    cwd: process.cwd(),
    env,
  }
}

test("claude-runtime injects --effort <level> when MULTI_AGENT_EFFORT is set", () => {
  const runtime = new InspectableClaude()
  const { args } = runtime.inspect(makeInput({ MULTI_AGENT_EFFORT: "high" }))
  const idx = args.indexOf("--effort")
  assert.ok(idx >= 0, "expected --effort flag in args")
  assert.equal(args[idx + 1], "high")
})

test("claude-runtime omits --effort when MULTI_AGENT_EFFORT is empty", () => {
  const runtime = new InspectableClaude()
  const { args } = runtime.inspect(makeInput({ MULTI_AGENT_EFFORT: "" }))
  assert.equal(args.indexOf("--effort"), -1)
})

test("claude-runtime still injects --model alongside --effort", () => {
  const runtime = new InspectableClaude()
  const { args } = runtime.inspect(
    makeInput({ MULTI_AGENT_MODEL: "claude-opus-4-6", MULTI_AGENT_EFFORT: "max" }),
  )
  const modelIdx = args.indexOf("--model")
  const effortIdx = args.indexOf("--effort")
  assert.ok(modelIdx >= 0 && effortIdx >= 0, "both flags must be present")
  assert.equal(args[modelIdx + 1], "claude-opus-4-6")
  assert.equal(args[effortIdx + 1], "max")
})

test("codex-runtime injects --config model_reasoning_effort when set", () => {
  const runtime = new InspectableCodex()
  const { args } = runtime.inspect(makeInput({ MULTI_AGENT_EFFORT: "xhigh" }))
  // Expect two consecutive args: "--config" then 'model_reasoning_effort="xhigh"'.
  const hit = args.some(
    (flag, i) => flag === "--config" && args[i + 1] === 'model_reasoning_effort="xhigh"',
  )
  assert.ok(hit, `expected --config model_reasoning_effort="xhigh" in ${JSON.stringify(args)}`)
})

test("codex-runtime omits model_reasoning_effort when empty", () => {
  const runtime = new InspectableCodex()
  const { args } = runtime.inspect(makeInput({ MULTI_AGENT_EFFORT: "" }))
  const has = args.some((a) => a.startsWith("model_reasoning_effort"))
  assert.equal(has, false)
})

test("codex-runtime keeps approval_policy and uses danger-full-access sandbox", () => {
  const runtime = new InspectableCodex()
  const { args } = runtime.inspect(makeInput({ MULTI_AGENT_EFFORT: "medium" }))
  assert.ok(args.includes('approval_policy="on-request"'))
  assert.ok(args.includes("danger-full-access"))
})

test("gemini-runtime ignores MULTI_AGENT_EFFORT (CLI has no effort flag)", () => {
  const runtime = new InspectableGemini()
  const { args } = runtime.inspect(
    makeInput({ MULTI_AGENT_MODEL: "gemini-3.1-pro-preview", MULTI_AGENT_EFFORT: "high" }),
  )
  assert.equal(args.indexOf("--effort"), -1)
  assert.equal(args.indexOf("--reasoning"), -1)
  const hasEffortConfig = args.some((a) => a.includes("reasoning_effort"))
  assert.equal(hasEffortConfig, false)
  // But --model should still be injected
  const modelIdx = args.indexOf("--model")
  assert.ok(modelIdx >= 0)
  assert.equal(args[modelIdx + 1], "gemini-3.1-pro-preview")
})
