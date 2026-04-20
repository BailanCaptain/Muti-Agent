import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  BaseCliRuntime,
  type AgentRunInput,
  type RuntimeCommand,
  type RuntimeDependencies
} from "./base-runtime";
import { ProcessLivenessProbe } from "./liveness-probe";

// ---------------------------------------------------------------------------
// Shared helpers (mirrors base-runtime.test.ts)
// ---------------------------------------------------------------------------

function createFakeProbeFactory(opts: { alive?: boolean } = {}): RuntimeDependencies["createLivenessProbe"] {
  const alive = opts.alive ?? true;
  return (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => alive,
      sampleCpuTime: async () => 0,
      setInterval: (() => ({ unref: () => undefined })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval
    });
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  readonly killCalls: string[] = [];
  exitCode: number | null = null;
  killed = false;

  kill(signal: string = "SIGTERM") {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }

  close(code: number | null) {
    this.exitCode = code;
    this.emit("close", code);
  }
}

class TestRuntime extends BaseCliRuntime {
  readonly agentId = "test";

  protected buildCommand(_input: AgentRunInput): RuntimeCommand {
    return {
      command: "test-cli",
      args: [],
      shell: false
    };
  }
}

function createInput(runtime?: AgentRunInput["runtime"]): AgentRunInput {
  return {
    invocationId: "invocation-1",
    threadId: "thread-1",
    agentId: "agent-1",
    prompt: "hello",
    cwd: process.cwd(),
    runtime
  };
}

// ---------------------------------------------------------------------------
// B009-B: dead-after-turn tests
// ---------------------------------------------------------------------------

test("B009-B: deadProcess + turnCompleted → resolves with the agent's response", async () => {
  // Simulate: agent emits turn.completed, then the process dies (probe detects dead).
  // The runtime should resolve instead of rejecting.

  const child = new FakeChildProcess();

  // Probe that immediately reports "dead" — simulates OOM / cleanup crash
  const deadProbeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => false, // process is dead
      sampleCpuTime: async () => 0,
    });

  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: () => child.close(null),
    createLivenessProbe: deadProbeFactory
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 5,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
      livenessSampleIntervalMs: 5,
      livenessStallWarningMs: 10_000,
      livenessSoftWarningMs: 5_000
    })
  );

  // Agent produces output including a turn.completed event (like Codex does).
  child.stdout.write('{"type":"message","content":"review looks good"}\n');
  child.stdout.write('{"type":"turn.completed"}\n');

  // Give the heartbeat timer time to fire and detect the dead process.
  const result = await handle.promise;

  assert.equal(result.stopReason, "complete", "stopReason must be 'complete' when turn finished before death");
  assert.equal(result.exitCode, null, "exitCode should be null (killed process)");
  assert.ok(result.rawStdout.includes("turn.completed"), "rawStdout must contain the turn.completed line");
});

test("B009-B: deadProcess without turnCompleted → still rejects", async () => {
  // Same setup but without turn.completed — the runtime should still reject.

  const child = new FakeChildProcess();

  const deadProbeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => false,
      sampleCpuTime: async () => 0,
    });

  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: () => child.close(null),
    createLivenessProbe: deadProbeFactory
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 5,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
      livenessSampleIntervalMs: 5,
      livenessStallWarningMs: 10_000,
      livenessSoftWarningMs: 5_000
    })
  );

  // Agent produces output but does NOT emit turn.completed.
  child.stdout.write('{"type":"message","content":"partial work"}\n');

  await assert.rejects(handle.promise, /异常退出|dead/i, "must reject when process dies without turn.completed");
});

test("B009-B: turnCompleted flag ignores non-JSON stdout lines", async () => {
  // Verify that plain-text lines don't accidentally set turnCompleted.

  const child = new FakeChildProcess();

  const deadProbeFactory: RuntimeDependencies["createLivenessProbe"] = (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => false,
      sampleCpuTime: async () => 0,
    });

  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: () => child.close(null),
    createLivenessProbe: deadProbeFactory
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 5,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5,
      livenessSampleIntervalMs: 5,
      livenessStallWarningMs: 10_000,
      livenessSoftWarningMs: 5_000
    })
  );

  // Non-JSON lines that mention turn.completed should NOT trigger the flag.
  child.stdout.write("turn.completed is a cool event name\n");
  child.stdout.write("some other output\n");

  await assert.rejects(handle.promise, /异常退出|dead/i, "non-JSON turn.completed text must not trigger resolve");
});

test("B009-B: timeout/stall without turnCompleted still rejects (no regression)", async () => {
  // Ensure that the timeout path still rejects when turnCompleted is false.

  const child = new FakeChildProcess();
  let forcedPid: number | null = null;
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: (pid) => {
      forcedPid = pid;
      child.close(null);
    },
    createLivenessProbe: createFakeProbeFactory()
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 10,
      inactivityTimeoutMs: 20,
      shutdownGracePeriodMs: 5
    })
  );

  await assert.rejects(handle.promise, /睡着了|重试一次/, "timeout without turnCompleted must still reject");
  assert.equal(forcedPid, child.pid);
});
