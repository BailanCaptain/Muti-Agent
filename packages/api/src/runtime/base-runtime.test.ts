import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  BaseCliRuntime,
  resolveNodeScript,
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

test("resolveNodeScript selects the first existing script from multiple candidate paths", () => {
  const originalAppData = process.env.APPDATA;
  const originalUserProfile = process.env.USERPROFILE;
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "multi-agent-runtime-"));
  const npmRoot = path.join(tempRoot, "npm");
  const bundleDir = path.join(npmRoot, "node_modules", "@google", "gemini-cli", "bundle");

  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(path.join(bundleDir, "gemini.js"), "console.log('ok');");
  process.env.APPDATA = tempRoot;
  process.env.USERPROFILE = "Z:\\multi-agent-missing-userprofile";

  try {
    const runtime = resolveNodeScript(
      "@google/gemini-cli",
      [["dist", "index.js"], ["bundle", "gemini.js"]],
      "gemini"
    );

    assert.equal(runtime.command, process.execPath);
    assert.ok(runtime.prefixArgs[0]?.endsWith(path.join("@google", "gemini-cli", "bundle", "gemini.js")));
    assert.equal(runtime.shell, false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });

    if (typeof originalAppData === "undefined") {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }

    if (typeof originalUserProfile === "undefined") {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("resolveNodeScript falls back to the executable name when no candidate script exists", () => {
  const originalAppData = process.env.APPDATA;
  const originalUserProfile = process.env.USERPROFILE;

  process.env.APPDATA = "Z:\\multi-agent-missing-appdata";
  process.env.USERPROFILE = "Z:\\multi-agent-missing-userprofile";

  try {
    const runtime = resolveNodeScript(
      "@google/gemini-cli",
      [["dist", "index.js"], ["bundle", "gemini.js"]],
      "gemini"
    );

    assert.equal(runtime.command, "gemini");
    assert.deepEqual(runtime.prefixArgs, []);
    assert.equal(runtime.shell, true);
  } finally {
    if (typeof originalAppData === "undefined") {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }

    if (typeof originalUserProfile === "undefined") {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});
