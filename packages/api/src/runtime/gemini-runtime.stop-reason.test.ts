import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GeminiRuntime } from "./gemini-runtime";

describe("GeminiRuntime.parseStopReason", () => {
  const runtime = new GeminiRuntime();

  it("maps result.finishReason=STOP → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "STOP" }),
      "complete",
    );
  });

  it("maps result.finishReason=END_TURN → complete", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "END_TURN" }),
      "complete",
    );
  });

  it("maps result.finishReason=MAX_TOKENS → truncated", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "MAX_TOKENS" }),
      "truncated",
    );
  });

  it("maps result.finishReason=SAFETY → refused", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "SAFETY" }),
      "refused",
    );
  });

  it("maps result.finishReason=RECITATION → refused", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "RECITATION" }),
      "refused",
    );
  });

  it("is case-insensitive (stop → complete)", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "stop" }),
      "complete",
    );
  });

  it("falls back to stats.finishReason when top-level missing", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "result",
        status: "success",
        stats: { finishReason: "MAX_TOKENS" },
      }),
      "truncated",
    );
  });

  it("prefers top-level finishReason over stats.finishReason", () => {
    assert.equal(
      runtime.parseStopReason({
        type: "result",
        finishReason: "STOP",
        stats: { finishReason: "MAX_TOKENS" },
      }),
      "complete",
    );
  });

  it("returns null for unknown finishReason", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", finishReason: "WHATEVER" }),
      null,
    );
  });

  it("returns null for non-result events", () => {
    assert.equal(runtime.parseStopReason({ type: "tool_use" }), null);
    assert.equal(runtime.parseStopReason({ type: "message" }), null);
    assert.equal(runtime.parseStopReason({ type: "content" }), null);
  });

  it("returns null when result has no finishReason at all", () => {
    assert.equal(
      runtime.parseStopReason({ type: "result", status: "success" }),
      null,
    );
  });
});
