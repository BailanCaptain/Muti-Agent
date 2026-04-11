import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ClaudeRuntime } from "./claude-runtime";

describe("ClaudeRuntime.parseStopReason", () => {
  const runtime = new ClaudeRuntime();

  it("maps result.stop_reason=end_turn → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "end_turn" }),
      "complete",
    );
  });

  it("maps result.stop_reason=stop_sequence → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "stop_sequence" }),
      "complete",
    );
  });

  it("maps result.stop_reason=max_tokens → truncated", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "max_tokens" }),
      "truncated",
    );
  });

  it("maps result.stop_reason=refusal → refused", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "refusal" }),
      "refused",
    );
  });

  it("maps result.stop_reason=tool_use → tool_wait", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "tool_use" }),
      "tool_wait",
    );
  });

  it("reads message_delta nested delta.stop_reason (streaming close)", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
      }),
      "truncated",
    );
  });

  it("returns null for unknown stop_reason values", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", stop_reason: "something_new" }),
      null,
    );
  });

  it("returns null when result event has no stop_reason", () => {
    assert.equal(runtime.parseStopReason({ type: "result" }), null);
  });

  it("returns null for non-terminal events", () => {
    assert.equal(
      runtime.parseStopReason({ type: "content_block_delta" }),
      null,
    );
    assert.equal(runtime.parseStopReason({ type: "message_start" }), null);
    assert.equal(runtime.parseStopReason({ type: "assistant" }), null);
  });

  it("returns null when message_delta has no nested stop_reason", () => {
    assert.equal(
      runtime.parseStopReason({ type: "message_delta", delta: {} }),
      null,
    );
  });
});
