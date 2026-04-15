import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CodexRuntime } from "./codex-runtime";

describe("CodexRuntime.parseActivityLine — reasoning", () => {
  const runtime = new CodexRuntime();

  it("returns placeholder on reasoning started", () => {
    const result = runtime.parseActivityLine({
      type: "item.started",
      item: { type: "reasoning" },
    });
    assert.equal(result, "🧠 正在推理...");
  });

  it("extracts text from item.summary array (Responses API format)", () => {
    const result = runtime.parseActivityLine({
      type: "item.completed",
      item: {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "Let me think about this..." },
          { type: "summary_text", text: "The answer is 42." },
        ],
      },
    });
    assert.equal(result, "Let me think about this...\nThe answer is 42.");
  });

  it("prefers item.text when present (legacy format)", () => {
    const result = runtime.parseActivityLine({
      type: "item.completed",
      item: {
        type: "reasoning",
        text: "Direct reasoning text",
        summary: [{ type: "summary_text", text: "Should not use this" }],
      },
    });
    assert.equal(result, "Direct reasoning text");
  });

  it("returns null when reasoning has no text and no summary", () => {
    const result = runtime.parseActivityLine({
      type: "item.completed",
      item: { type: "reasoning" },
    });
    assert.equal(result, null);
  });

  it("returns null when summary array is empty", () => {
    const result = runtime.parseActivityLine({
      type: "item.completed",
      item: { type: "reasoning", summary: [] },
    });
    assert.equal(result, null);
  });
});

describe("CodexRuntime.parseAssistantDelta — reasoning suppression", () => {
  const runtime = new CodexRuntime();

  it("returns empty string for reasoning items (no leak into content)", () => {
    const result = runtime.parseAssistantDelta({
      type: "item.completed",
      item: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Should not appear" }],
      },
    });
    assert.equal(result, "");
  });
});
