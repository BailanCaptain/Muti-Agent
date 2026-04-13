import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StopReason } from "./base-runtime";
import type { RunTurnResult } from "./cli-orchestrator";
import type { TokenUsageSnapshot } from "@multi-agent/shared";
import { runContinuationLoop } from "./continuation-loop";

type ScriptedStep = {
  content: string;
  stopReason: StopReason | null;
  seal?: boolean;
};

function makeResult(step: ScriptedStep): RunTurnResult {
  const usage: TokenUsageSnapshot | null = step.seal
    ? { usedTokens: 999, windowTokens: 1000, source: "approx" }
    : null;
  return {
    content: step.content,
    nativeSessionId: "sess-1",
    currentModel: "model-x",
    stopped: false,
    rawStdout: "",
    rawStderr: "",
    exitCode: 0,
    usage,
    sealDecision: step.seal
      ? { shouldSeal: true, reason: "threshold", fillRatio: 0.99, usage: usage! }
      : null,
    stopReason: step.stopReason,
    toolEvents: [],
  };
}

function scriptedCreateRun(steps: ScriptedStep[]) {
  const calls: string[] = [];
  let index = 0;
  const createRun = (userMessage: string) => {
    calls.push(userMessage);
    const step = steps[index++];
    if (!step) {
      throw new Error(`createRun called ${index} times but only ${steps.length} steps scripted`);
    }
    return {
      cancel: () => undefined,
      promise: Promise.resolve(makeResult(step)),
    };
  };
  return { createRun, calls };
}

describe("runContinuationLoop", () => {
  it("single-shot complete returns content and stops after one call", async () => {
    const { createRun, calls } = scriptedCreateRun([
      { content: "done.", stopReason: "complete" },
    ]);
    const statuses: string[] = [];
    const result = await runContinuationLoop({
      initialUserMessage: "hello",
      createRun,
      emitStatus: (m) => statuses.push(m),
      onIterationContent: () => undefined,
    });
    assert.equal(result.accumulatedContent, "done.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0], "hello");
    assert.equal(result.lastResult.stopReason, "complete");
    assert.equal(result.stoppedReason, "complete");
  });

  it("truncated then complete appends both parts and uses continuation prompt on 2nd call", async () => {
    const { createRun, calls } = scriptedCreateRun([
      { content: "part A ", stopReason: "truncated" },
      { content: "and part B — done.", stopReason: "complete" },
    ]);
    const statuses: string[] = [];
    const result = await runContinuationLoop({
      initialUserMessage: "请写一个长回答",
      createRun,
      emitStatus: (m) => statuses.push(m),
      onIterationContent: () => undefined,
    });
    assert.equal(result.accumulatedContent, "part A and part B — done.");
    assert.equal(calls.length, 2);
    assert.equal(calls[0], "请写一个长回答");
    assert.match(calls[1]!, /截断|续写|stop_reason/);
    assert.equal(result.stoppedReason, "complete");
    assert.ok(statuses.some((s) => s.includes("续写")));
  });

  it("stops after 2 consecutive short continuations", async () => {
    const { createRun, calls } = scriptedCreateRun([
      { content: "first long content ".repeat(10), stopReason: "truncated" },
      { content: "x", stopReason: "truncated" },
      { content: "y", stopReason: "truncated" },
    ]);
    const result = await runContinuationLoop({
      initialUserMessage: "start",
      createRun,
      emitStatus: () => undefined,
      onIterationContent: () => undefined,
    });
    // 3 calls total: initial (long) + 2 short → guard blocks 4th continuation
    assert.equal(calls.length, 3);
    assert.equal(result.stoppedReason, "guard_exhausted");
  });

  it("stops when sealDecision.shouldSeal fires", async () => {
    const { createRun, calls } = scriptedCreateRun([
      { content: "part A", stopReason: "truncated", seal: true },
    ]);
    const statuses: string[] = [];
    const result = await runContinuationLoop({
      initialUserMessage: "start",
      createRun,
      emitStatus: (m) => statuses.push(m),
      onIterationContent: () => undefined,
    });
    assert.equal(calls.length, 1);
    assert.equal(result.stoppedReason, "sealed");
    assert.ok(statuses.some((s) => s.includes("封存") || s.includes("seal")));
  });

  it("aborted on first call continues into a second call", async () => {
    const { createRun, calls } = scriptedCreateRun([
      { content: "initial ", stopReason: "aborted" },
      { content: "recovered tail", stopReason: "complete" },
    ]);
    const result = await runContinuationLoop({
      initialUserMessage: "task",
      createRun,
      emitStatus: () => undefined,
      onIterationContent: () => undefined,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.accumulatedContent, "initial recovered tail");
    assert.equal(result.stoppedReason, "complete");
  });

  it("invokes onIterationContent after each turn so caller can overwrite message", async () => {
    const { createRun } = scriptedCreateRun([
      { content: "part A ", stopReason: "truncated" },
      { content: "part B", stopReason: "complete" },
    ]);
    const snapshots: string[] = [];
    await runContinuationLoop({
      initialUserMessage: "hi",
      createRun,
      emitStatus: () => undefined,
      onIterationContent: (acc) => snapshots.push(acc),
    });
    assert.deepEqual(snapshots, ["part A ", "part A part B"]);
  });

  it("null stopReason with content treated as complete (no continuation)", async () => {
    const { createRun, calls } = scriptedCreateRun([
      { content: "looks fine", stopReason: null },
    ]);
    const result = await runContinuationLoop({
      initialUserMessage: "hi",
      createRun,
      emitStatus: () => undefined,
      onIterationContent: () => undefined,
    });
    assert.equal(calls.length, 1);
    assert.equal(result.stoppedReason, "complete");
  });

  it("null stopReason with empty content + exit0 still stops (not aborted loop)", async () => {
    const { createRun, calls } = scriptedCreateRun([
      { content: "", stopReason: null },
    ]);
    const result = await runContinuationLoop({
      initialUserMessage: "hi",
      createRun,
      emitStatus: () => undefined,
      onIterationContent: () => undefined,
    });
    assert.equal(calls.length, 1);
    assert.equal(result.stoppedReason, "complete");
  });
});
