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

describe("F023 Task 7 — cli-orchestrator 必须为 runtime 显式传 cwd = process.cwd()", () => {
  it("AgentRunInput.cwd 等于 process.cwd()（Claude）", async () => {
    const rt = new CapturingRuntime()
    await runTurn({ ...baseOpts(rt), provider: "claude" }).promise
    assert.ok(rt.capturedInput, "buildCommand must have captured an input")
    assert.equal(
      rt.capturedInput?.cwd,
      process.cwd(),
      "cli-orchestrator must forward process.cwd() as AgentRunInput.cwd — 相对路径 .mcp.json 才会解析到当前 worktree dist"
    )
  })

  it("三家 provider 全部拿到 cwd=process.cwd()", async () => {
    for (const provider of ["claude", "codex", "gemini"] as const) {
      const rt = new CapturingRuntime()
      await runTurn({ ...baseOpts(rt), provider }).promise
      assert.equal(
        rt.capturedInput?.cwd,
        process.cwd(),
        `provider=${provider} must receive cwd=process.cwd()`
      )
    }
  })
})
