import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  BaseCliRuntime,
  type AgentRunInput,
  type RuntimeCommand
} from "./base-runtime";

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
    runtime
  };
}

test("runStream rejects when the child stays inactive past the heartbeat timeout", async () => {
  const child = new FakeChildProcess();
  let forcedPid: number | null = null;
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: (pid) => {
      forcedPid = pid;
      child.close(null);
    }
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 10,
      inactivityTimeoutMs: 20,
      shutdownGracePeriodMs: 5
    })
  );

  await assert.rejects(handle.promise, /睡着了|重试一次/);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(forcedPid, child.pid);
});

test("cancel starts a graceful stop and escalates if the child does not exit", async () => {
  const child = new FakeChildProcess();
  let forcedPid: number | null = null;
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "win32",
    forceKillProcessTree: (pid) => {
      forcedPid = pid;
      child.close(0);
    }
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 1000,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5
    })
  );

  handle.cancel();

  const result = await handle.promise;
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(forcedPid, child.pid);
  assert.equal(result.exitCode, 0);
});

test("cancel escalates from SIGTERM to SIGKILL on linux when the child does not exit", async () => {
  const child = new FakeChildProcess();
  const runtime = new TestRuntime({
    spawn: () => child as never,
    platform: "linux"
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 1000,
      inactivityTimeoutMs: 60_000,
      shutdownGracePeriodMs: 5
    })
  );

  handle.cancel();
  await delay(10);
  child.close(0);

  const result = await handle.promise;
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.exitCode, 0);
});

test("stdout and stderr activity keep the heartbeat alive until the process closes", async () => {
  const child = new FakeChildProcess();
  const runtime = new TestRuntime({
    spawn: () => child as never
  });

  const handle = runtime.runStream(
    createInput({
      heartbeatIntervalMs: 10,
      inactivityTimeoutMs: 25,
      shutdownGracePeriodMs: 5
    })
  );

  child.stdout.write("{\"type\":\"message\"}\n");
  await delay(12);
  child.stderr.write("thinking...\n");
  await delay(12);
  child.close(0);

  const result = await handle.promise;
  assert.equal(result.exitCode, 0);
});
