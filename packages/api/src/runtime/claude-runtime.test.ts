import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"
import { ClaudeRuntime } from "./claude-runtime"

function createRuntime() {
  return new ClaudeRuntime()
}

describe("ClaudeRuntime stream_event handling", () => {
  let runtime: ClaudeRuntime

  beforeEach(() => {
    runtime = createRuntime()
  })

  describe("parseActivityLine — thinking buffer", () => {
    it("returns null for thinking_delta (buffered, not emitted immediately)", () => {
      const result = runtime.parseActivityLine({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me think..." },
        },
      })
      assert.equal(result, null)
    })

    it("emits accumulated thinking on content_block_stop", () => {
      runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      })
      runtime.parseActivityLine({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Step 1. " },
        },
      })
      runtime.parseActivityLine({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Step 2." },
        },
      })
      const result = runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      })
      assert.equal(result, "Step 1. Step 2.")
    })

    it("returns null on content_block_stop when buffer is empty", () => {
      runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
      })
      const result = runtime.parseActivityLine({
        type: "stream_event",
        event: { type: "content_block_stop", index: 1 },
      })
      assert.equal(result, null)
    })

    it("handles system/compact_boundary event", () => {
      const result = runtime.parseActivityLine({
        type: "system",
        subtype: "compact_boundary",
      })
      assert.equal(result, "[context compacted]")
    })

    it("rate_limit_event with status=allowed is a quota heartbeat — drop (B016)", () => {
      const result = runtime.parseActivityLine({
        type: "rate_limit_event",
        rate_limit: { status: "allowed", windowType: "five_hour" },
      })
      assert.equal(result, null)
    })

    it("rate_limit_event without status field is treated as heartbeat — drop (B016)", () => {
      const result = runtime.parseActivityLine({ type: "rate_limit_event" })
      assert.equal(result, null)
    })

    it("rate_limit_event with non-allowed status surfaces precise placeholder (B016)", () => {
      const exceeded = runtime.parseActivityLine({
        type: "rate_limit_event",
        rate_limit: { status: "exceeded" },
      })
      assert.equal(exceeded, "[quota: exceeded]")

      const approaching = runtime.parseActivityLine({
        type: "rate_limit_event",
        rate_limit: { status: "approaching" },
      })
      assert.equal(approaching, "[quota: approaching]")
    })

    it("rate_limit_event status at top level is also honored (B016)", () => {
      const result = runtime.parseActivityLine({
        type: "rate_limit_event",
        status: "blocked",
      })
      assert.equal(result, "[quota: blocked]")
    })
  })

  describe("parseAssistantDelta — text_delta streaming + dedup", () => {
    it("extracts text_delta from stream_event", () => {
      const result = runtime.parseAssistantDelta({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Hello" },
        },
      })
      assert.equal(result, "Hello")
    })

    it("skips signature_delta", () => {
      const result = runtime.parseAssistantDelta({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "abc" },
        },
      })
      assert.equal(result, "")
    })

    it("returns empty for thinking_delta in parseAssistantDelta", () => {
      const result = runtime.parseAssistantDelta({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "x" },
        },
      })
      assert.equal(result, "")
    })

    it("deduplicates text from full assistant message when text_delta was streamed", () => {
      // 1. message_start sets currentMessageId
      runtime.parseUsage({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
        },
      })
      // 2. text_delta marks this messageId as having streamed text
      runtime.parseAssistantDelta({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Hello" },
        },
      })
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
      })
      assert.equal(result, "")
    })

    it("R-075 follow-up: envelope 含 text 也不进 content stream（envelope 永远视为冗余 partial snapshot）", () => {
      // 旧设计：envelope 是流式没 add 时的兜底来源 → return text
      // 新设计（R-075 4/30 双段实证后）：CLI 行为 envelope 总是冗余于流式 text_delta，
      // 永远 return ""，避免任何状态机错乱（如多 invocation 共享 singleton 状态、或
      // partialTextMessageIds 被 module-level 某条路径异常清理）导致的双段。
      const result = runtime.parseAssistantDelta({
        type: "assistant",
        message: {
          id: "msg_2",
          content: [{ type: "text", text: "World" }],
        },
      })
      assert.equal(
        result,
        "",
        "envelope 永远不进 content stream — 流式 text_delta 是 source of truth",
      )
    })

    /**
     * R-057 复验：Claude 在同一 message_id 下先发 text_delta，再发 thinking-only assistant
     * envelope，再发含 text 的 full assistant envelope。
     *
     * 旧实现：只要看到该 message_id 的 assistant envelope 就 delete partialTextMessageIds，
     * 即便 envelope 内根本没 text content。结果 thinking-only envelope 提前清掉 skip 标记，
     * 下一帧真含 text 的 full envelope 不再 skip，DB 入了两份相同文本（前端两段一摸一样）。
     */
    it("Bug1 R-057: thinking-only assistant envelope must NOT consume the partial-text skip flag", () => {
      // 1. message_start
      runtime.parseUsage({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_R057", usage: { input_tokens: 10, output_tokens: 0 } },
        },
      })
      // 2. text_delta marks msg_R057 as having streamed text
      runtime.parseAssistantDelta({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "回复内容" },
        },
      })
      // 3. thinking-only assistant envelope (no text content) — must leave skip flag intact
      const thinkingOnly = runtime.parseAssistantDelta({
        type: "assistant",
        message: {
          id: "msg_R057",
          content: [{ type: "thinking", thinking: "思考过程" }],
        },
      })
      assert.equal(thinkingOnly, "", "thinking-only envelope contributes no text")
      // 4. Full assistant envelope (with same text) — must still be skipped (no duplicate)
      const fullText = runtime.parseAssistantDelta({
        type: "assistant",
        message: {
          id: "msg_R057",
          content: [{ type: "text", text: "回复内容" }],
        },
      })
      assert.equal(
        fullText,
        "",
        "full text envelope after thinking-only must still be skipped — otherwise DB stores 2x same text",
      )
    })

    /**
     * R-075（4/30 D-五轮传话游戏 仁勋 final）：DB 实证 1724B 双段拼接（单段 ×2，差 1 字节回车），
     * 同 invocation 内流式 text_delta 累加（17 条 = 851B）+ 第二个 envelope 含完整 text →
     * 内容字符级精确双拷贝。R-057 修法在我能 replay 的事件序列下 work，但生产环境实证双段——
     * 强化兜底：envelope 含 text 一律不进货，无论 partialTextMessageIds 状态如何。
     */
    it("R-075: 流式 + 双 envelope（thinking-only + text-only）累加结果不双段", () => {
      runtime.parseUsage({
        type: "stream_event",
        event: {
          type: "message_start",
          message: { id: "msg_R075", usage: { input_tokens: 100, output_tokens: 0 } },
        },
      })
      let content = ""
      for (const delta of ["Hello ", "World", "!"]) {
        content += runtime.parseAssistantDelta({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: delta },
          },
        })
      }
      // envelope #1 thinking-only (R-057: 不消费 skip)
      content += runtime.parseAssistantDelta({
        type: "assistant",
        message: { id: "msg_R075", content: [{ type: "thinking", thinking: "思考过程" }] },
      })
      // envelope #2 text-only (R-075: 不进货，即便 R-057 修过的 skip 在某条件下失效)
      content += runtime.parseAssistantDelta({
        type: "assistant",
        message: { id: "msg_R075", content: [{ type: "text", text: "Hello World!" }] },
      })
      assert.equal(content, "Hello World!", "envelope 永远不该进货 — 流式是 source of truth")
    })
  })

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
      })
      assert.ok(result)
      assert.equal(result!.totalTokens, 160)
    })

    it("extracts usage from stream_event message_delta", () => {
      const result = runtime.parseUsage({
        type: "stream_event",
        event: {
          type: "message_delta",
          usage: { input_tokens: 0, output_tokens: 200 },
        },
      })
      assert.ok(result)
    })

    it("still handles top-level result usage", () => {
      const result = runtime.parseUsage({
        type: "result",
        usage: { input_tokens: 500, output_tokens: 100 },
      })
      assert.ok(result)
    })
  })

  describe("parseStopReason — stream_event message_delta", () => {
    it("extracts stop_reason from stream_event message_delta", () => {
      const result = runtime.parseStopReason({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      })
      assert.equal(result, "complete")
    })

    it("maps result error subtypes", () => {
      assert.equal(
        runtime.parseStopReason({ type: "result", is_error: true, subtype: "error_max_turns" }),
        "truncated",
      )
      assert.equal(
        runtime.parseStopReason({
          type: "result",
          is_error: true,
          subtype: "error_max_budget_usd",
        }),
        "truncated",
      )
      assert.equal(
        runtime.parseStopReason({
          type: "result",
          is_error: true,
          subtype: "error_during_execution",
        }),
        "aborted",
      )
    })

    it("still handles top-level result stop_reason", () => {
      const result = runtime.parseStopReason({
        type: "result",
        stop_reason: "end_turn",
      })
      assert.equal(result, "complete")
    })
  })

  describe("transformToolEvent — dedup with partialTextMessageIds", () => {
    it("still extracts tool_use from assistant message", () => {
      const result = runtime.transformToolEvent({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      })
      assert.ok(result)
      assert.equal(result!.type, "tool_use")
      assert.equal(result!.toolName, "Bash")
    })
  })
})

describe("F023 ClaudeRuntime buildCommand — 项目级 .mcp.json 接管", () => {
  it("must NOT inject --mcp-config (project-level .mcp.json takes over)", () => {
    const runtime = new ClaudeRuntime()
    const cmd = (
      runtime as unknown as {
        buildCommand: (i: { prompt: string; env?: Record<string, string> }) => {
          args: string[]
          cleanup?: unknown
        }
      }
    ).buildCommand({
      prompt: "hi",
      env: {
        MULTI_AGENT_API_URL: "http://localhost:8787",
        MULTI_AGENT_INVOCATION_ID: "inv_test",
        MULTI_AGENT_CALLBACK_TOKEN: "tok_test",
      },
    })
    assert.ok(
      !cmd.args.includes("--mcp-config"),
      "--mcp-config must be removed (project-level .mcp.json replaces it)",
    )
    assert.equal(cmd.cleanup, undefined, "cleanup must be undefined (no tmp dir to clean)")
  })
})
