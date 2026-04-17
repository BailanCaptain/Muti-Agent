import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import {
  BaseCliRuntime,
  type AgentRunInput,
  type RuntimeCommand,
  type RuntimeDependencies,
} from "./base-runtime"
import { ProcessLivenessProbe } from "./liveness-probe"
import { runTurn } from "./cli-orchestrator"
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts"

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 1234
  exitCode: number | null = null

  kill() {
    return true
  }

  close(code: number | null) {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit("close", code)
  }
}

function fakeProbeFactory(): RuntimeDependencies["createLivenessProbe"] {
  return (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => true,
      sampleCpuTime: async () => 0,
      setInterval: (() => ({ unref: () => undefined })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
    })
}

/** Captures the AgentRunInput that cli-orchestrator passes to runStream. */
class CapturingRuntime extends BaseCliRuntime {
  readonly agentId = "capturing"
  capturedInput: AgentRunInput | null = null

  constructor() {
    super({
      spawn: () => {
        const child = new FakeChildProcess()
        setImmediate(() => child.close(0))
        return child as never
      },
      platform: "linux",
      createLivenessProbe: fakeProbeFactory(),
    })
  }

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    this.capturedInput = input
    return { command: "capturing", args: [], shell: false }
  }

  parseStopReason(): null {
    return null
  }

  parseAssistantDelta(): string {
    return ""
  }
}

function baseOpts(runtime: BaseCliRuntime) {
  return {
    threadId: "t1",
    provider: "claude" as const,
    model: null,
    effort: null,
    nativeSessionId: null,
    userMessage: "hi",
    onAssistantDelta: () => undefined,
    onSession: () => undefined,
    onModel: () => undefined,
    runtime,
  }
}

describe("runTurn — sopStageHint injection into MULTI_AGENT_SYSTEM_PROMPT", () => {
  it("when sopStageHint is provided, env.MULTI_AGENT_SYSTEM_PROMPT ends with the SOP one-liner", async () => {
    const rt = new CapturingRuntime()
    const handle = runTurn({
      ...baseOpts(rt),
      sopStageHint: { featureId: "F019", stage: "impl", suggestedSkill: "tdd" },
    })
    await handle.promise
    assert.ok(rt.capturedInput)
    const sp = rt.capturedInput?.env?.MULTI_AGENT_SYSTEM_PROMPT ?? ""
    assert.ok(
      sp.endsWith("\n\nSOP: F019 stage=impl → load skill: tdd"),
      `expected prompt to end with SOP line, got tail: ${JSON.stringify(sp.slice(-120))}`,
    )
    assert.ok(sp.startsWith(AGENT_SYSTEM_PROMPTS.claude), "base prompt preserved at start")
  })

  it("when sopStageHint is absent, env.MULTI_AGENT_SYSTEM_PROMPT preserves legacy '' (runtime falls back to base)", async () => {
    const rt = new CapturingRuntime()
    await runTurn(baseOpts(rt)).promise
    const sp = rt.capturedInput?.env?.MULTI_AGENT_SYSTEM_PROMPT
    // Legacy behavior: no hint → empty string passed through, runtime adapter
    // falls back to AGENT_SYSTEM_PROMPTS[provider] on its own.
    assert.equal(sp, "")
  })

  it("sopStageHint is additive to caller-provided systemPrompt (not overriding)", async () => {
    const rt = new CapturingRuntime()
    await runTurn({
      ...baseOpts(rt),
      systemPrompt: "caller base prompt with its own content",
      sopStageHint: { featureId: "F019", stage: "impl", suggestedSkill: "tdd" },
    }).promise
    const sp = rt.capturedInput?.env?.MULTI_AGENT_SYSTEM_PROMPT ?? ""
    assert.ok(sp.startsWith("caller base prompt with its own content"), "caller base preserved as prefix")
    assert.ok(sp.endsWith("\n\nSOP: F019 stage=impl → load skill: tdd"), "hint appended")
  })

  it("sopStageHint with null suggestedSkill omits '→ load skill' suffix (with caller systemPrompt)", async () => {
    const rt = new CapturingRuntime()
    await runTurn({
      ...baseOpts(rt),
      systemPrompt: "caller base",
      sopStageHint: { featureId: "F019", stage: "completion", suggestedSkill: null },
    }).promise
    const sp = rt.capturedInput?.env?.MULTI_AGENT_SYSTEM_PROMPT ?? ""
    assert.ok(sp.endsWith("\n\nSOP: F019 stage=completion"))
    assert.ok(!sp.includes("→ load skill"))
  })
})
