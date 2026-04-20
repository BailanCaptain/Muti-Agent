import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { createHaikuRunner } from "./haiku-runner"

type FakeSpawnOpts = { code: number | null; stdout?: string; delayMs?: number; spawnError?: Error }

function fakeSpawn(opts: FakeSpawnOpts) {
  const killSpy = mock.fn()
  const spawn = () => {
    const proc: any = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.kill = killSpy
    if (opts.spawnError) {
      setImmediate(() => proc.emit("error", opts.spawnError))
      return proc as ChildProcess
    }
    setTimeout(() => {
      if (opts.stdout !== undefined) {
        proc.stdout.emit("data", Buffer.from(opts.stdout))
      }
      proc.emit("close", opts.code)
    }, opts.delayMs ?? 1)
    return proc as ChildProcess
  }
  return { spawn: spawn as any, killSpy }
}

describe("HaikuRunner", () => {
  it("AC-06: returns ok=true with trimmed stdout on exit 0", async () => {
    const { spawn } = fakeSpawn({ code: 0, stdout: "  学习 Drizzle\n" })
    const r = createHaikuRunner({ spawn })
    const res = await r.runPrompt("summarize this")
    assert.equal(res.ok, true)
    assert.equal(res.text, "学习 Drizzle")
    assert.ok(res.durationMs >= 0)
    assert.equal(res.error, undefined)
  })

  it("returns ok=false with exit-code-N on non-zero exit", async () => {
    const { spawn } = fakeSpawn({ code: 2, stdout: "" })
    const r = createHaikuRunner({ spawn })
    const res = await r.runPrompt("x")
    assert.equal(res.ok, false)
    assert.equal(res.text, "")
    assert.equal(res.error, "exit-code-2")
  })

  it("AC-08 precondition: kills process and returns error=timeout after timeoutMs", async () => {
    const { spawn, killSpy } = fakeSpawn({ code: 0, stdout: "late", delayMs: 200 })
    const r = createHaikuRunner({ spawn })
    const res = await r.runPrompt("x", { timeoutMs: 50 })
    assert.equal(res.ok, false)
    assert.equal(res.error, "timeout")
    assert.equal(killSpy.mock.calls.length, 1, "should kill the child process")
  })

  it("returns empty-output when stdout is blank on exit 0", async () => {
    const { spawn } = fakeSpawn({ code: 0, stdout: "   \n  " })
    const r = createHaikuRunner({ spawn })
    const res = await r.runPrompt("x")
    assert.equal(res.ok, false)
    assert.equal(res.error, "empty-output")
  })

  it("returns spawn-error:<msg> when child process emits error", async () => {
    const { spawn } = fakeSpawn({ code: null, spawnError: new Error("ENOENT: claude not found") })
    const r = createHaikuRunner({ spawn })
    const res = await r.runPrompt("x")
    assert.equal(res.ok, false)
    assert.match(res.error ?? "", /^spawn-error:/)
    assert.match(res.error ?? "", /ENOENT/)
  })

  it("passes --print --model claude-haiku-4-5 {prompt} to spawn", async () => {
    let capturedArgs: readonly string[] = []
    const spawn = ((_cmd: string, args: readonly string[]) => {
      capturedArgs = args
      const proc: any = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.kill = mock.fn()
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("ok"))
        proc.emit("close", 0)
      }, 1)
      return proc as ChildProcess
    }) as any
    const r = createHaikuRunner({ spawn })
    await r.runPrompt("my prompt text")
    assert.ok(capturedArgs.includes("--print"), `args should include --print, got: ${capturedArgs.join(" ")}`)
    assert.ok(capturedArgs.includes("--model"))
    const modelIdx = capturedArgs.indexOf("--model")
    assert.equal(capturedArgs[modelIdx + 1], "claude-haiku-4-5")
    assert.ok(capturedArgs.includes("my prompt text"), "prompt should be passed as an argument")
  })
})
