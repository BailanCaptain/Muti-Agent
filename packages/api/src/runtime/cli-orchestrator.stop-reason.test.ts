import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  BaseCliRuntime,
  type AgentRunInput,
  type RuntimeCommand,
  type RuntimeDependencies,
  type StopReason,
} from "./base-runtime";
import { ProcessLivenessProbe } from "./liveness-probe";
import { runTurn } from "./cli-orchestrator";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  readonly killCalls: string[] = [];
  exitCode: number | null = null;
  killed = false;

  kill(signal: string = "SIGTERM") {
    this.killCalls.push(signal);
    this.killed = true;
    return true;
  }

  writeLine(obj: unknown) {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  close(code: number | null) {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
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
    });
}

/**
 * Scripted runtime: emits whatever the test stages and maps stream-json events
 * to the StopReason we want to verify.
 */
class ScriptedRuntime extends BaseCliRuntime {
  readonly agentId = "scripted";

  constructor(
    private readonly events: Array<Record<string, unknown>>,
    private readonly mapper: (event: Record<string, unknown>) => StopReason | null,
    private readonly exitCode: number = 0,
  ) {
    super({
      spawn: () => {
        const child = new FakeChildProcess();
        // Schedule events and close on the next tick so the readline pipe is ready.
        setImmediate(() => {
          for (const ev of events) {
            child.writeLine(ev);
          }
          setImmediate(() => child.close(exitCode));
        });
        return child as never;
      },
      platform: "linux",
      createLivenessProbe: fakeProbeFactory(),
    });
  }

  protected buildCommand(_input: AgentRunInput): RuntimeCommand {
    return { command: "scripted", args: [], shell: false };
  }

  parseStopReason(event: Record<string, unknown>): StopReason | null {
    return this.mapper(event);
  }

  parseAssistantDelta(event: Record<string, unknown>): string {
    if (event.type === "text" && typeof event.value === "string") {
      return event.value as string;
    }
    return "";
  }
}

function baseRunTurnOptions(runtime: BaseCliRuntime) {
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
  };
}

describe("runTurn stopReason propagation", () => {
  it("propagates last non-null stopReason (truncated) from runtime events", async () => {
    const runtime = new ScriptedRuntime(
      [
        { type: "text", value: "part A" },
        { type: "result", stop_reason: "max_tokens" },
      ],
      (event) => {
        if (event.type === "result" && event.stop_reason === "max_tokens") {
          return "truncated";
        }
        return null;
      },
    );

    const result = await runTurn(baseRunTurnOptions(runtime)).promise;
    assert.equal(result.stopReason, "truncated");
    assert.equal(result.content, "part A");
    assert.equal(result.exitCode, 0);
  });

  it("propagates 'complete' stopReason", async () => {
    const runtime = new ScriptedRuntime(
      [
        { type: "text", value: "done" },
        { type: "result", stop_reason: "end_turn" },
      ],
      (event) => {
        if (event.type === "result" && event.stop_reason === "end_turn") {
          return "complete";
        }
        return null;
      },
    );

    const result = await runTurn(baseRunTurnOptions(runtime)).promise;
    assert.equal(result.stopReason, "complete");
    assert.equal(result.content, "done");
  });

  it("leaves stopReason null when no terminal event ever seen", async () => {
    const runtime = new ScriptedRuntime(
      [{ type: "text", value: "only deltas" }],
      () => null,
    );

    const result = await runTurn(baseRunTurnOptions(runtime)).promise;
    assert.equal(result.stopReason, null);
    assert.equal(result.content, "only deltas");
  });

  it("keeps the last terminal value when multiple events arrive", async () => {
    // Some providers may emit both a mid-stream message_delta(stop_reason)
    // and a final `result` event. Last wins.
    const runtime = new ScriptedRuntime(
      [
        { type: "text", value: "x" },
        { type: "marker", reason: "truncated" },
        { type: "marker", reason: "complete" },
      ],
      (event) => {
        if (event.type === "marker") {
          return (event.reason as StopReason) ?? null;
        }
        return null;
      },
    );

    const result = await runTurn(baseRunTurnOptions(runtime)).promise;
    assert.equal(result.stopReason, "complete");
  });
});
