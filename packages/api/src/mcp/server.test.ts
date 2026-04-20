import assert from "node:assert/strict"
import test from "node:test"
import { encodeMessage, getTools, handleToolCall, parseFrame } from "./server.js"

// ---------------------------------------------------------------------------
// getTools tests
// ---------------------------------------------------------------------------

test("getTools returns 14 tools", () => {
  const tools = getTools()
  assert.equal(tools.length, 14, `Expected 14 tools, got ${tools.length}`)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    "create_task",
    "get_memory",
    "get_room_context",
    "get_room_summary",
    "get_task_status",
    "parallel_think",
    "post_message",
    "recall_similar_context",
    "request_decision",
    "request_permission",
    "search_room_memories",
    "take_screenshot",
    "trigger_mention",
    "update_workflow_sop",
  ])
})

test("recall_similar_context tool has expected schema (F018 P5 AC6.3)", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "recall_similar_context")
  assert.ok(tool)
  const schema = tool!.inputSchema as {
    type: string
    properties: Record<string, { type: string }>
    required?: string[]
  }
  assert.equal(schema.type, "object")
  assert.equal(schema.properties.query.type, "string")
  assert.equal(schema.properties.topK.type, "integer")
  assert.deepEqual(schema.required, ["query"])
})

test("handleToolCall recall_similar_context rejects empty query", async () => {
  const result = await handleToolCall("recall_similar_context", { query: "   " })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /query is required/)
})

test("update_workflow_sop tool has expected schema (F019 P3)", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "update_workflow_sop")
  assert.ok(tool, "update_workflow_sop tool should be registered")
  assert.ok(tool.description.length > 0)
  const schema = tool.inputSchema as {
    type: string
    properties: Record<string, unknown>
    required?: string[]
  }
  assert.equal(schema.type, "object")
  assert.ok(schema.properties.backlogItemId, "backlogItemId property present")
  assert.ok(schema.properties.stage, "stage property present")
  assert.ok(schema.properties.expectedVersion, "expectedVersion property present")
  assert.deepEqual(schema.required, ["backlogItemId"])
})

test("handleToolCall update_workflow_sop returns error when backlogItemId missing", async () => {
  const result = await handleToolCall("update_workflow_sop", {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /backlogItemId/)
})

test("get_task_status tool has optional agentId property", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "get_task_status")
  assert.ok(tool, "get_task_status tool should exist")
  const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] }
  assert.ok(schema.properties.agentId, "Should have agentId property")
  assert.ok(!schema.required, "agentId should be optional (no required array)")
})

test("create_task tool requires assignee and description", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "create_task")
  assert.ok(tool, "create_task tool should exist")
  const schema = tool.inputSchema as { required: string[] }
  assert.ok(schema.required.includes("assignee"), "assignee should be required")
  assert.ok(schema.required.includes("description"), "description should be required")
})

test("trigger_mention tool requires targetAgentId and taskSnippet", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "trigger_mention")
  assert.ok(tool, "trigger_mention tool should exist")
  const schema = tool.inputSchema as { required: string[] }
  assert.ok(schema.required.includes("targetAgentId"), "targetAgentId should be required")
  assert.ok(schema.required.includes("taskSnippet"), "taskSnippet should be required")
})

// ---------------------------------------------------------------------------
// handleToolCall dispatch tests
// These verify that each new tool case hits the callback path.  Since no
// real server is running, the HTTP request will fail with ECONNREFUSED.
// We set env vars so getCallbackIdentity() doesn't throw, and then assert
// the error message proves the correct endpoint was attempted.
// ---------------------------------------------------------------------------

// Set callback identity env vars for the test process
process.env.MULTI_AGENT_API_URL = "http://127.0.0.1:19999"
process.env.MULTI_AGENT_INVOCATION_ID = "inv-test-123"
process.env.MULTI_AGENT_CALLBACK_TOKEN = "tok-test-456"

test("handleToolCall dispatches get_task_status", async () => {
  // No callback server running, so the HTTP request will reject with ECONNREFUSED.
  // This proves the dispatch reached the correct callback function.
  await assert.rejects(
    () => handleToolCall("get_task_status", {}),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall dispatches create_task with correct args", async () => {
  await assert.rejects(
    () => handleToolCall("create_task", {
      assignee: "agent-1",
      description: "Fix the bug",
      priority: "high",
    }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall dispatches trigger_mention with correct args", async () => {
  await assert.rejects(
    () => handleToolCall("trigger_mention", {
      targetAgentId: "designer",
      taskSnippet: "Review the UI",
    }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall dispatches get_memory", async () => {
  await assert.rejects(
    () => handleToolCall("get_memory", { keyword: "test" }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall dispatches get_room_context", async () => {
  await assert.rejects(
    () => handleToolCall("get_room_context", { limit: 10 }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall dispatches get_room_summary", async () => {
  await assert.rejects(
    () => handleToolCall("get_room_summary", {}),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall dispatches search_room_memories", async () => {
  await assert.rejects(
    () => handleToolCall("search_room_memories", { keyword: "architecture" }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall search_room_memories rejects empty keyword", async () => {
  const result = await handleToolCall("search_room_memories", { keyword: "" })
  assert.ok(result, "Should return a result")
  assert.equal(result.isError, true)
  assert.ok(result.content[0]?.text.includes("keyword is required"))
})

test("handleToolCall search_room_memories rejects missing keyword", async () => {
  const result = await handleToolCall("search_room_memories", {})
  assert.ok(result, "Should return a result")
  assert.equal(result.isError, true)
  assert.ok(result.content[0]?.text.includes("keyword is required"))
})

test("handleToolCall dispatches take_screenshot", async () => {
  await assert.rejects(
    () => handleToolCall("take_screenshot", { url: "http://localhost:3000" }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// Transport: MCP stdio must use NDJSON (newline-delimited JSON), not LSP
// Content-Length framing. All three CLIs (Claude/Codex/Gemini) parse stdio
// MCP servers per the spec — NDJSON — so we must match.
// ---------------------------------------------------------------------------

test("encodeMessage produces NDJSON (trailing \\n, no Content-Length header)", () => {
  const line = encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } })
  assert.ok(line.endsWith("\n"), "must terminate with newline")
  assert.ok(!line.includes("Content-Length"), "must not use LSP framing")
  const parsed = JSON.parse(line.trimEnd())
  assert.equal(parsed.id, 1)
  assert.deepEqual(parsed.result, { ok: true })
})

test("parseFrame splits newline-delimited JSON", () => {
  const { messages, remaining } = parseFrame(
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
  )
  assert.equal(messages.length, 2)
  assert.equal((messages[0] as { id: number }).id, 1)
  assert.equal((messages[1] as { id: number }).id, 2)
  assert.equal(remaining, "")
})

test("parseFrame keeps incomplete tail across chunk boundary", () => {
  const first = parseFrame('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0"')
  assert.equal(first.messages.length, 1)
  assert.equal(first.remaining, '{"jsonrpc":"2.0"')
  const second = parseFrame(first.remaining + ',"id":2,"method":"tools/list"}\n')
  assert.equal(second.messages.length, 1)
  assert.equal((second.messages[0] as { id: number }).id, 2)
  assert.equal(second.remaining, "")
})

test("parseFrame ignores blank lines (LSP-to-NDJSON tolerant)", () => {
  const { messages, remaining } = parseFrame('\n\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n')
  assert.equal(messages.length, 1)
  assert.equal(remaining, "")
})

test("handleToolCall returns unknown tool error for invalid tool", async () => {
  const result = await handleToolCall("nonexistent_tool", {})
  assert.ok(result, "Should return a result")
  assert.equal(result.isError, true)
  assert.ok(result.content[0]?.text.includes("unknown tool: nonexistent_tool"))
})
