import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ClaudeRuntime } from "./claude-runtime";

function createRuntime() {
  return new ClaudeRuntime();
}

describe("ClaudeRuntime stream_event handling", () => {
  let runtime: ClaudeRuntime;

  beforeEach(() => {
    runtime = createRuntime();
  });

  describe("parseActivityLine — thinking buffer", () => {
    it("returns null for thinking_delta (buffered, not emitted immediately)", () => {
      const result = runtime.parseActivityLine({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me think..." },
        },
      });
      assert.equal(result, null);
    });

    it("emits accumulated thinking on content_block_stop", () => {
      runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      });
      runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 1. " } },
      });
      runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Step 2." } },
      });
      const result = runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      });
      assert.equal(result, "Step 1. Step 2.");
    });

    it("returns null on content_block_stop when buffer is empty", () => {
      runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
      });
      const result = runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_stop", index: 1 },
      });
      assert.equal(result, null);
    });

    it("handles system/compact_boundary event", () => {
      const result = runtime.parseActivityLine({
        type: "system",
        subtype: "compact_boundary",
      });
      assert.equal(result, "[context compacted]");
    });

    it("handles rate_limit_event", () => {
      const result = runtime.parseActivityLine({ type: "rate_limit_event" });
      assert.equal(result, "[rate limited]");
    });
  });

  describe("parseAssistantDelta — text_delta streaming + dedup", () => {
    it("extracts text_delta from stream_event", () => {
      const result = runtime.parseAssistantDelta({
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
      });
      assert.equal(result, "Hello");
    });

    it("skips signature_delta", () => {
      const result = runtime.parseAssistantDelta({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
      });
      assert.equal(result, "");
    });

    it("returns empty for thinking_delta in parseAssistantDelta", () => {
      const result = runtime.parseAssistantDelta({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } },
      });
      assert.equal(result, "");
    });

    it("deduplicates text from full assistant message when text_delta was streamed", () => {
      // 1. message_start sets currentMessageId
      runtime.parseUsage({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
        },
      });
      // 2. text_delta marks this messageId as having streamed text
      runtime.parseAssistantDelta({
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
      });
      // 3. Full assistant message arrives — text should be skipped
      const result = runtime.parseAssistantDelta({
        type: "assistant",
        message: {
          id: "msg_1",
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/a" } },
          ],
        },
      });
      assert.equal(result, "");
    });

    it("still extracts text from full assistant message when NO text_delta was streamed", () => {
      const result = runtime.parseAssistantDelta({
        type: "assistant",
        message: {
          id: "msg_2",
          content: [{ type: "text", text: "World" }],
        },
      });
      assert.equal(result, "World");
    });
  });

  describe("parseUsage — stream_event message_start/message_delta", () => {
    it("extracts usage from stream_event message_start (with cache tokens)", () => {
      const result = runtime.parseUsage({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_1",
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 10,
            },
          },
        },
      });
      assert.ok(result);
      assert.equal(result!.totalTokens, 160);
    });

    it("extracts usage from stream_event message_delta", () => {
      const result = runtime.parseUsage({
        type: "stream_event",
        event: {
          type: "message_delta",
          usage: { input_tokens: 0, output_tokens: 200 },
        },
      });
      assert.ok(result);
    });

    it("still handles top-level result usage", () => {
      const result = runtime.parseUsage({
        type: "result",
        usage: { input_tokens: 500, output_tokens: 100 },
      });
      assert.ok(result);
    });
  });

  describe("parseStopReason — stream_event message_delta", () => {
    it("extracts stop_reason from stream_event message_delta", () => {
      const result = runtime.parseStopReason({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      });
      assert.equal(result, "complete");
    });

    it("maps result error subtypes", () => {
      assert.equal(
        runtime.parseStopReason({ type: "result", is_error: true, subtype: "error_max_turns" }),
        "truncated",
      );
      assert.equal(
        runtime.parseStopReason({ type: "result", is_error: true, subtype: "error_max_budget_usd" }),
        "truncated",
      );
      assert.equal(
        runtime.parseStopReason({ type: "result", is_error: true, subtype: "error_during_execution" }),
        "aborted",
      );
    });

    it("still handles top-level result stop_reason", () => {
      const result = runtime.parseStopReason({
        type: "result",
        stop_reason: "end_turn",
      });
      assert.equal(result, "complete");
    });
  });

  describe("transformToolEvent — dedup with partialTextMessageIds", () => {
    it("still extracts tool_use from assistant message", () => {
      const result = runtime.transformToolEvent({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      });
      assert.ok(result);
      assert.equal(result!.type, "tool_use");
      assert.equal(result!.toolName, "Bash");
    });
  });
});
