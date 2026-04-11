import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BaseCliRuntime,
  type AgentRunInput,
  type AgentRunOutput,
  type RuntimeCommand,
  type StopReason,
} from "./base-runtime";

class TestRuntime extends BaseCliRuntime {
  readonly agentId = "test";

  protected buildCommand(_input: AgentRunInput): RuntimeCommand {
    return { command: "echo", args: [], shell: false };
  }
}

describe("BaseCliRuntime.parseStopReason (default)", () => {
  it("returns null for unclassified events", () => {
    const runtime = new TestRuntime();
    assert.equal(runtime.parseStopReason({ type: "unknown" }), null);
  });

  it("returns null for empty events", () => {
    const runtime = new TestRuntime();
    assert.equal(runtime.parseStopReason({}), null);
  });
});

describe("AgentRunOutput.stopReason", () => {
  it("accepts null as a valid StopReason value (type-level)", () => {
    const output: AgentRunOutput = {
      rawStdout: "",
      rawStderr: "",
      exitCode: 0,
      stopReason: null,
    };
    assert.equal(output.stopReason, null);
  });

  it("accepts all StopReason variants (type-level)", () => {
    const variants: StopReason[] = [
      "complete",
      "truncated",
      "refused",
      "tool_wait",
      "aborted",
    ];
    for (const v of variants) {
      const output: AgentRunOutput = {
        rawStdout: "",
        rawStderr: "",
        exitCode: 0,
        stopReason: v,
      };
      assert.equal(output.stopReason, v);
    }
  });
});
