import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, it, mock } from "node:test"
import { createHaikuRunner, createSonnetRunner } from "./haiku-runner"

type FakeSpawnOpts = { code: number | null; stdout?: string; delayMs?: number; spawnError?: Error }

function fakeSpawn(opts: FakeSpawnOpts) {
  const killSpy = mock.fn()
  const stdinEndSpy = mock.fn()
  const spawn = () => {
    const proc: any = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = { end: stdinEndSpy }
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
  return { spawn: spawn as any, killSpy, stdinEndSpy }
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

  it("closes child process stdin immediately after spawn (prevents claude CLI stdin-EOF hang on Windows)", async () => {
    const { spawn, stdinEndSpy } = fakeSpawn({ code: 0, stdout: "ok" })
    const r = createHaikuRunner({ spawn })
    await r.runPrompt("x")
    assert.equal(stdinEndSpy.mock.calls.length, 1, "proc.stdin.end() must be called to signal EOF")
  })

  it("default timeout gives claude CLI cold start enough headroom (>= 10000ms)", async () => {
    // Haiku local cold start measured ~8.4s on Windows; 5s default caused every call to timeout.
    const { spawn, killSpy } = fakeSpawn({ code: 0, stdout: "done", delayMs: 6000 })
    const r = createHaikuRunner({ spawn })
    const res = await r.runPrompt("x")
    assert.equal(
      res.ok,
      true,
      `should not timeout at 6s; default must be >= 10000ms. got error=${res.error}`,
    )
    assert.equal(killSpy.mock.calls.length, 0, "should not kill when response arrives at 6s")
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
    assert.ok(
      capturedArgs.includes("--print"),
      `args should include --print, got: ${capturedArgs.join(" ")}`,
    )
    assert.ok(capturedArgs.includes("--model"))
    const modelIdx = capturedArgs.indexOf("--model")
    assert.equal(capturedArgs[modelIdx + 1], "claude-haiku-4-5")
    assert.ok(capturedArgs.includes("my prompt text"), "prompt should be passed as an argument")
  })
})

describe("SonnetRunner (F027 P12 decision extractor — 小孙拍 sonnet-4-6)", () => {
  it("passes --model claude-sonnet-4-6 to spawn", async () => {
    let capturedArgs: readonly string[] = []
    const spawn = ((_cmd: string, args: readonly string[]) => {
      capturedArgs = args
      const proc: any = new EventEmitter()
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.stdin = { end: mock.fn() }
      proc.kill = mock.fn()
      setTimeout(() => {
        proc.stdout.emit("data", Buffer.from("ok"))
        proc.emit("close", 0)
      }, 1)
      return proc as ChildProcess
    }) as any
    const r = createSonnetRunner({ spawn })
    await r.runPrompt("decide if this is a decision")
    const modelIdx = capturedArgs.indexOf("--model")
    assert.equal(
      capturedArgs[modelIdx + 1],
      "claude-sonnet-4-6",
      "Sonnet runner 必须传 claude-sonnet-4-6 模型 ID（小孙 2026-05-13 拍）",
    )
  })

  it("shares the same HaikuRunner shape (interchangeable for HaikuLike consumers)", async () => {
    // P12 decision-extractor 的 HaikuLike interface 接受任一 runner，
    // 这个测试确保两个 runner 接口签名兼容（编译期 + 运行期均兼容）
    const { spawn } = fakeSpawn({ code: 0, stdout: "yes" })
    const haiku = createHaikuRunner({ spawn })
    const sonnet = createSonnetRunner({ spawn })
    // 同样调用方式，同样返回 shape
    const haikuRes = await haiku.runPrompt("x")
    const sonnetRes = await sonnet.runPrompt("x")
    assert.equal(typeof haikuRes.ok, "boolean")
    assert.equal(typeof sonnetRes.ok, "boolean")
    assert.equal(typeof haikuRes.text, "string")
    assert.equal(typeof sonnetRes.text, "string")
    assert.equal(typeof haikuRes.durationMs, "number")
    assert.equal(typeof sonnetRes.durationMs, "number")
  })
})
