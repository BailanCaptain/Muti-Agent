import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodexRuntime } from "./codex-runtime";

describe("CodexRuntime.parseStopReason", () => {
  const runtime = new CodexRuntime();

  it("maps turn.completed → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "turn.completed", usage: {} }),
      "complete",
    );
  });

  it("maps turn.failed with context_length_exceeded → truncated", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "turn.failed",
        error: { type: "context_length_exceeded" },
      }),
      "truncated",
    );
  });

  it("maps turn.failed with max_output_tokens → truncated", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "turn.failed",
        error: { type: "max_output_tokens" },
      }),
      "truncated",
    );
  });

  it("maps generic turn.failed → aborted", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "turn.failed",
        error: { type: "unknown" },
      }),
      "aborted",
    );
  });

  it("maps turn.failed without error object → aborted", () => {
    assert.equal(
      runtime.parseStopReason({ type: "turn.failed" }),
      "aborted",
    );
  });

  it("returns null for intermediate events", () => {
    assert.equal(runtime.parseStopReason({ type: "item.started" }), null);
    assert.equal(runtime.parseStopReason({ type: "item.completed" }), null);
    assert.equal(
      runtime.parseStopReason({ type: "response.output_text.delta" }),
      null,
    );
  });

  it("returns null for empty events", () => {
    assert.equal(runtime.parseStopReason({}), null);
  });
});
