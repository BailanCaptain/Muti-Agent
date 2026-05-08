import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import {
  type AgentRunInput,
  BaseCliRuntime,
  type RuntimeCommand,
  type RuntimeDependencies,
  resolveNodeScript,
} from "./base-runtime"
import { ProcessLivenessProbe } from "./liveness-probe"

function createFakeProbeFactory(
  opts: { alive?: boolean } = {},
): RuntimeDependencies["createLivenessProbe"] {
  const alive = opts.alive ?? true
  return (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => alive,
      sampleCpuTime: async () => 0,
      // Replace timers with no-ops so the probe never schedules async work during tests.
      setInterval: (() => ({ unref: () => undefined })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
    })
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  readonly killCalls: string[] = []
  exitCode: number | null = null
  killed = false

  kill(signal: string = "SIGTERM") {
    this.killCalls.push(signal)
    this.killed = true
    return true
  }

  close(code: number | null) {
    this.exitCode = code
    this.emit("close", code)
  }
}

class TestRuntime extends BaseCliRuntime {
  readonly agentId = "test"

  protected buildCommand(_input: AgentRunInput): RuntimeCommand {
    return {
      command: "test-cli",
      args: [],
      shell: false,
    }
  }
}

function createInput(runtime?: AgentRunInput["runtime"]): AgentRunInput {
  return {
    invocationId: "invocation-1",
    threadId: "thread-1",
    agentId: "agent-1",
    prompt: "hello",
    cwd: process.cwd(),
    runtime,
  }
}

test("runStream rejects when the child stays inactive past the heartbeat timeout", async () => {
  const child = new FakeChildProcess()
  let forcedPid: number | null = null
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: (pid) => {
      forcedPid = pid
      child.close(null)
    },
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 10,
      inactivityTimeoutMs: 20,
      shutdownGracePeriodMs: 5,
    }),
  )

  await assert.rejects(handle.promise, /睡着了|重试一次/)
  assert.deepEqual(child.killCalls, ["SIGTERM"])
  assert.equal(forcedPid, child.pid)
})

test("cancel starts a graceful stop and escalates if the child does not exit", async () => {
  const child = new FakeChildProcess()
  let forcedPid: number | null = null
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: (pid) => {
      forcedPid = pid
      child.close(0)
    },
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 1000,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
    }),
  )

  handle.cancel()

  const result = await handle.promise
  assert.deepEqual(child.killCalls, ["SIGTERM"])
  assert.equal(forcedPid, child.pid)
  assert.equal(result.exitCode, 0)
})

test("cancel escalates from SIGTERM to SIGKILL on linux when the child does not exit", async () => {
  const child = new FakeChildProcess()
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "linux",
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 1000,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
    }),
  )

  handle.cancel()
  await delay(10)
  child.close(0)

  const result = await handle.promise
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"])
  assert.equal(result.exitCode, 0)
})

test("stdout activity keeps the heartbeat alive until the process closes", async () => {
  const child = new FakeChildProcess()
  const runtime = new TestRuntime({
    spawn: () => child as never,
    createLivenessProbe: createFakeProbeFactory(),
  })

  // B023: Windows setTimeout 精度 ~15.6ms，原 delay(12) 实际 15-32ms，
  // 与 inactivityTimeoutMs=25 的边界冲突导致 Windows 上稳定 fail。
  // 拉宽到 delay(30) + inactivityTimeoutMs=200 让 timer 精度抖动有充分 buffer，
  // 同时仍然测出"活动持续触发，timeout 不应该 fire"的行为。
  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 20,
      inactivityTimeoutMs: 200,
      shutdownGracePeriodMs: 5,
      livenessStallWarningMs: 10_000,
    }),
  )

  child.stdout.write('{"type":"message"}\n')
  await delay(30)
  child.stdout.write('{"type":"message"}\n')
  await delay(30)
  child.close(0)

  const result = await handle.promise
  assert.equal(result.exitCode, 0)
})

test("linux probe fast-path kills on idle-silent stall before inactivityTimeoutMs", async () => {
  const child = new FakeChildProcess()
  // Probe with real timers and a flat CPU reading — simulates a process that's alive but sleeping.
  const probeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => true,
      sampleCpuTime: async () => 42, // flat across samples → cpuGrowing = false
    })

  const runtime = new TestRuntime({
    spawn: () => child as never,
    // Win32 runtime path routes kills through forceKillProcessTree (which we override to close the
    // fake child). The probe itself is still in linux mode so its fast-path stall detection runs.
    platform: "win32",
    createLivenessProbe: probeFactory,
    forceKillProcessTree: () => child.close(null),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 5,
      inactivityTimeoutMs: 60_000, // deliberately large so only the stall path can fire
      shutdownGracePeriodMs: 5,
      livenessSampleIntervalMs: 5,
      livenessStallWarningMs: 30,
      livenessSoftWarningMs: 15,
    }),
  )

  await assert.rejects(handle.promise, /卡住/)
})

test("stderr activity does NOT keep the heartbeat alive (retry-spam protection)", async () => {
  const child = new FakeChildProcess()
  let forcedPid: number | null = null
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: (pid) => {
      forcedPid = pid
      child.close(null)
    },
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 10,
      inactivityTimeoutMs: 25,
      shutdownGracePeriodMs: 5,
      livenessStallWarningMs: 10_000,
    }),
  )

  // Spam stderr continuously — this should NOT reset the inactivity timer.
  const spammer = setInterval(() => child.stderr.write("retrying...\n"), 5)
  await assert.rejects(handle.promise, /睡着了|卡住|异常退出/)
  clearInterval(spammer)
  assert.equal(forcedPid, child.pid)
})

test("stderr fast-fail pattern kills the child immediately (Gemini 429 case)", async () => {
  // Subclass that recognises one sentinel pattern — simulates GeminiRuntime's 429 matcher.
  class FastFailRuntime extends BaseCliRuntime {
    readonly agentId = "fast-fail"
    protected buildCommand(): RuntimeCommand {
      return { command: "x", args: [], shell: false }
    }
    classifyStderrChunk(chunk: string): { reason: string } | null {
      return /RESOURCE_EXHAUSTED/i.test(chunk) ? { reason: "test-rate-limit" } : null
    }
  }

  const child = new FakeChildProcess()
  let forcedPid: number | null = null
  const runtime = new FastFailRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: (pid) => {
      forcedPid = pid
      child.close(null)
    },
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(
    createInput({
      // Long timeouts — if fast-fail wasn't working, this test would hang for seconds.
      heartbeatIntervalMs: 1000,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
    }),
  )

  // Simulate Gemini CLI printing the quota error to stderr.
  child.stderr.write("[Error: RESOURCE_EXHAUSTED] You exceeded your current quota.\n")

  await assert.rejects(handle.promise, /test-rate-limit|致命错误/)
  assert.equal(forcedPid, child.pid, "fast-fail must force-kill the process tree")
  assert.deepEqual(child.killCalls, ["SIGTERM"])
})

test("stderr without fast-fail pattern does not trigger early termination", async () => {
  class FastFailRuntime extends BaseCliRuntime {
    readonly agentId = "fast-fail"
    protected buildCommand(): RuntimeCommand {
      return { command: "x", args: [], shell: false }
    }
    classifyStderrChunk(chunk: string): { reason: string } | null {
      return /RESOURCE_EXHAUSTED/i.test(chunk) ? { reason: "rl" } : null
    }
  }

  const child = new FakeChildProcess()
  const runtime = new FastFailRuntime({
    spawn: () => child as never,
    platform: "linux",
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 1000,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
    }),
  )

  // Non-matching stderr — should be forwarded but should NOT kill the process.
  child.stderr.write("Loaded cached credentials.\n")
  child.stderr.write("Tip: press /help for commands.\n")
  await delay(10)
  child.close(0)

  const result = await handle.promise
  assert.equal(
    result.exitCode,
    0,
    "process should exit normally when no fatal stderr pattern matches",
  )
})

test("stdinContent: spawn receives stdio[0]='pipe' and stdin.end is called with the content", async () => {
  // TDD Red: verifies that when buildCommand returns stdinContent,
  // the spawn call uses stdio[0]="pipe" and child.stdin.end is called.

  class StdinRuntime extends BaseCliRuntime {
    readonly agentId = "stdin-test"
    protected buildCommand(_input: AgentRunInput): RuntimeCommand {
      return {
        command: "test-cli",
        args: [],
        shell: false,
        stdinContent: "hello from stdin",
      }
    }
  }

  let capturedStdioOption: unknown = null
  const stdinEndCalls: string[] = []

  const child = new FakeChildProcess()
  // Attach a writable stdin mock with an end() recorder
  const stdinMock = {
    end: (content: string, encoding: string) => {
      stdinEndCalls.push(`${content}|${encoding}`)
    },
  }
  ;(child as never as Record<string, unknown>).stdin = stdinMock

  const runtime = new StdinRuntime({
    spawn: (cmd, args, opts) => {
      capturedStdioOption = (opts as { stdio?: unknown }).stdio
      return child as never
    },
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(createInput())

  // Let the child finish immediately.
  child.close(0)

  await handle.promise

  // stdio[0] must be "pipe" when stdinContent is set
  assert.ok(Array.isArray(capturedStdioOption), "stdio must be an array")
  assert.equal(
    (capturedStdioOption as string[])[0],
    "pipe",
    "stdio[0] must be 'pipe' when stdinContent is provided",
  )

  // stdin.end must have been called with the content and utf-8 encoding
  assert.equal(stdinEndCalls.length, 1, "stdin.end must be called exactly once")
  assert.equal(stdinEndCalls[0], "hello from stdin|utf-8")
})

test("stdinContent absent: spawn keeps stdio[0]='ignore' (no regression)", async () => {
  let capturedStdioOption: unknown = null

  const child = new FakeChildProcess()
  const runtime = new TestRuntime({
    spawn: (cmd, args, opts) => {
      capturedStdioOption = (opts as { stdio?: unknown }).stdio
      return child as never
    },
    createLivenessProbe: createFakeProbeFactory(),
  })

  const handle = runtime.runStream(createInput())
  child.close(0)
  await handle.promise

  assert.ok(Array.isArray(capturedStdioOption), "stdio must be an array")
  assert.equal(
    (capturedStdioOption as string[])[0],
    "ignore",
    "stdio[0] must remain 'ignore' when stdinContent is absent",
  )
})

test("resolveNodeScript selects the first existing script from multiple candidate paths", () => {
  const originalAppData = process.env.APPDATA
  const originalUserProfile = process.env.USERPROFILE
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "multi-agent-runtime-"))
  const npmRoot = path.join(tempRoot, "npm")
  const bundleDir = path.join(npmRoot, "node_modules", "@google", "gemini-cli", "bundle")

  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(path.join(bundleDir, "gemini.js"), "console.log('ok');")
  process.env.APPDATA = tempRoot
  process.env.USERPROFILE = "Z:\\multi-agent-missing-userprofile"

  try {
    const runtime = resolveNodeScript(
      "@google/gemini-cli",
      [
        ["dist", "index.js"],
        ["bundle", "gemini.js"],
      ],
      "gemini",
    )

    assert.equal(runtime.command, process.execPath)
    assert.ok(
      runtime.prefixArgs[0]?.endsWith(path.join("@google", "gemini-cli", "bundle", "gemini.js")),
    )
    assert.equal(runtime.shell, false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })

    if (typeof originalAppData === "undefined") {
      delete process.env.APPDATA
    } else {
      process.env.APPDATA = originalAppData
    }

    if (typeof originalUserProfile === "undefined") {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }
  }
})

test("resolveNodeScript falls back to the executable name when no candidate script exists", () => {
  const originalAppData = process.env.APPDATA
  const originalUserProfile = process.env.USERPROFILE

  process.env.APPDATA = "Z:\\multi-agent-missing-appdata"
  process.env.USERPROFILE = "Z:\\multi-agent-missing-userprofile"

  try {
    const runtime = resolveNodeScript(
      "@google/gemini-cli",
      [
        ["dist", "index.js"],
        ["bundle", "gemini.js"],
      ],
      "gemini",
    )

    assert.equal(runtime.command, "gemini")
    assert.deepEqual(runtime.prefixArgs, [])
    assert.equal(runtime.shell, true)
  } finally {
    if (typeof originalAppData === "undefined") {
      delete process.env.APPDATA
    } else {
      process.env.APPDATA = originalAppData
    }

    if (typeof originalUserProfile === "undefined") {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }
  }
})

// B010-fix regression test: stall fast-kill must not fire while stderr (429 retries) is active.
// Before the fix, Gemini got killed mid-retry-cycle because stderr didn't update lastActivityMs.
test("stall fast-kill deferred while stderr is active (B010-fix: 429 retry protection)", async () => {
  const child = new FakeChildProcess()
  const probeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => true,
      sampleCpuTime: async () => 42, // flat CPU — Gemini sleeping between retries
    })

  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    createLivenessProbe: probeFactory,
    forceKillProcessTree: () => child.close(null),
  })

  // B023: Windows setTimeout 精度 ~15.6ms，原 30ms stall threshold + 10ms stderr
  // setInterval 在 Windows 上稳定 fail（30ms < 32ms 两次精度抖动）。
  // 拉宽到 200ms threshold + 30ms stderr interval + 500ms wait，让 timer 精度
  // 抖动有 buffer，测试逻辑不变（stderr 持续活动时 stall 不 fire）。
  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 20,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
      livenessSampleIntervalMs: 20,
      livenessStallWarningMs: 200,
      livenessSoftWarningMs: 100,
    }),
  )

  // Emit stdout once to start the activity clock, then go silent on stdout.
  child.stdout.write(
    JSON.stringify({ type: "message", role: "assistant", content: "working...", delta: false }) +
      "\n",
  )

  // Keep spamming stderr every 30ms (simulates 429 retries).
  // With the fix, this should keep the stall clock from firing.
  const retrySpammer = setInterval(() => {
    child.stderr.write("Attempt N failed with status 429. Retrying...\n")
  }, 30)

  // Wait longer than the stall threshold (200ms) — process should NOT be killed.
  await delay(500)
  clearInterval(retrySpammer)

  // Now let the process complete normally.
  child.stdout.write(JSON.stringify({ type: "turn_complete" }) + "\n")
  child.close(0)

  const result = await handle.promise
  assert.equal(
    result.exitCode,
    0,
    "Gemini should NOT be killed while 429 retries are active on stderr",
  )
})

// B023 AC5 (review P1-2): idle-silent 期间 inactivityTimeoutMs 不应先于 stallWarningMs 触发杀进程。
// 范德彪 review: 即使 livenessStallWarningMs 改到 20min，默认 inactivityTimeoutMs=5min 仍会先杀
// idle-silent 进程（line 520-526 只 busy-silent 走延长分支）。Codex idle-silent 5+ min 是正常的
// thinking budget 行为，必须由 stallWarningMs 主导杀决定，inactivityTimeoutMs 退化为 probe 不可用
// 时的兜底。
test("B023 AC5: idle-silent 在 inactivityTimeoutMs 之后但 stallWarningMs 之前不应被杀", async () => {
  const child = new FakeChildProcess()
  const probeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => true,
      sampleCpuTime: async () => 42, // flat CPU 两次后 → cpuGrowing=false → idle-silent
    })

  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    createLivenessProbe: probeFactory,
    forceKillProcessTree: () => child.close(null),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 20,
      // inactivityTimeoutMs 故意设短：模拟生产 .env 里的 5min 配置占位
      inactivityTimeoutMs: 200,
      shutdownGracePeriodMs: 5,
      // probe 频繁采样以便快速进入 idle-silent
      livenessSampleIntervalMs: 20,
      livenessSoftWarningMs: 50,
      // stallWarningMs 远大于 inactivityTimeoutMs：这是 B023 现场比例（1200s vs 300s）
      livenessStallWarningMs: 2_000,
    }),
  )

  // 等到 inactivity (200ms) 已过、stall (2000ms) 还远：进程不应被杀
  await delay(500)
  child.close(0)

  const result = await handle.promise
  assert.equal(
    result.exitCode,
    0,
    "idle-silent 期间 inactivityTimeoutMs 不应主导 kill — 必须等 stallWarningMs",
  )
})

// B023 AC5: 当 stallWarningMs 真正到达，idle-silent 仍必须被杀（兜底没失效）。
test("B023 AC5: idle-silent 超过 stallWarningMs 仍会被杀（杀路径未被绕掉）", async () => {
  const child = new FakeChildProcess()
  const probeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => true,
      sampleCpuTime: async () => 42, // flat CPU → idle-silent
    })

  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    createLivenessProbe: probeFactory,
    forceKillProcessTree: () => child.close(null),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 10,
      inactivityTimeoutMs: 100,
      shutdownGracePeriodMs: 5,
      livenessSampleIntervalMs: 10,
      livenessSoftWarningMs: 30,
      livenessStallWarningMs: 80, // < inactivityTimeoutMs，让 stall 路径主导
    }),
  )

  await assert.rejects(handle.promise, /卡住/)
})

// B023 AC5 (review P1-2 残余风险): stall 杀进程时 reject error message 必须使用
// livenessStallWarningMs 的秒数，否则用户看到"无新输出 ≥ 0/5 秒"（来自 inactivityTimeoutMs=100/300_000）
// 而实际是 stall 阈值才触发，文案严重误导。范德彪复审残余风险。
test("B023 AC5: stall reject error message 使用 livenessStallWarningMs 而非 inactivityTimeoutMs", async () => {
  const child = new FakeChildProcess()
  const probeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => true,
      sampleCpuTime: async () => 42, // flat CPU → idle-silent
    })

  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    createLivenessProbe: probeFactory,
    forceKillProcessTree: () => child.close(null),
  })

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 10,
      // 选 1234ms：四位数 stall 秒在文案里是 "1 秒"（Math.round），但关键是不和 inactivity 重合
      inactivityTimeoutMs: 100,
      shutdownGracePeriodMs: 5,
      livenessSampleIntervalMs: 10,
      livenessSoftWarningMs: 30,
      livenessStallWarningMs: 1500, // = 2 秒（Math.round），与 inactivityTimeoutMs=100 (=0 秒) 区分
    }),
  )

  // 期望文案里出现 stall 阈值的秒数（2），而不是 inactivity 阈值的秒数（0）
  await assert.rejects(handle.promise, /卡住.*≥\s*2\s*秒/)
})
