import assert from "node:assert/strict"
import test from "node:test"
import { encodeMessage, getTools, handleToolCall, parseFrame } from "./server.js"

// ---------------------------------------------------------------------------
// getTools tests
// ---------------------------------------------------------------------------

test("getTools returns 16 tools (F040 修7 +send_file；F027 B1-a 退役旧 3 session_memories 工具)", () => {
  // F027 B1-a（小孙 2026-06-06 拍方案一）：get_memory / get_room_summary / search_room_memories
  // 三个旧 session_memories 工具从广播列表移除（agent 不再发现/使用，收敛到 4 件套）。
  // session_memories 表 + 自动注入（POLICY_FULL）+ dispatch/HTTP 后端不动（legacy 直呼仍优雅可达）。
  const tools = getTools()
  assert.equal(tools.length, 16, `Expected 16 tools, got ${tools.length}`)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    "acquire_wiki_lease",
    "create_task",
    "get_room_context",
    "get_task_status",
    "post_message",
    "query_messages",
    "read_wiki",
    "recall_similar_context",
    "request_decision",
    "request_permission",
    "search_wiki",
    "send_file",
    "take_screenshot",
    "trigger_mention",
    "update_wiki",
    "update_workflow_sop",
  ])
  // 退役的 3 个不在广播列表
  assert.ok(!names.includes("get_memory"), "get_memory 已退役（不广播）")
  assert.ok(!names.includes("get_room_summary"), "get_room_summary 已退役（不广播）")
  assert.ok(!names.includes("search_room_memories"), "search_room_memories 已退役（不广播）")
})

test("query_messages tool has expected schema (F027 P14.b)", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "query_messages")
  assert.ok(tool)
  const schema = tool!.inputSchema as unknown as {
    type: string
    properties: Record<string, { type: string | string[] }>
    required?: string[]
  }
  assert.equal(schema.type, "object")
  assert.equal(schema.properties.query.type, "string")
  assert.equal(schema.properties.topK.type, "integer")
  assert.equal(schema.properties.threadId.type, "string")
  assert.equal(schema.properties.role.type, "string")
  assert.deepEqual(schema.required, ["query"])
})

test("handleToolCall query_messages rejects empty query", async () => {
  const result = await handleToolCall("query_messages", { query: "   " })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /query is required/)
})

test("recall_similar_context tool has expected schema (F018 P5 AC6.3)", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "recall_similar_context")
  assert.ok(tool)
  const schema = tool!.inputSchema as unknown as {
    type: string
    properties: Record<string, { type: string | string[] }>
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

test("F027 P3 acquire_wiki_lease tool requires path", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "acquire_wiki_lease")
  assert.ok(tool)
  const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> }
  assert.deepEqual(schema.required, ["path"])
  assert.ok(schema.properties.ttlSeconds, "ttlSeconds optional present")
})

test("F027 P3 read_wiki tool requires path", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "read_wiki")
  assert.ok(tool)
  const schema = tool.inputSchema as { required: string[] }
  assert.deepEqual(schema.required, ["path"])
})

test("F027 P3 update_wiki tool requires path/action/content/fencing_token", () => {
  const tools = getTools()
  const tool = tools.find((t) => t.name === "update_wiki")
  assert.ok(tool)
  const schema = tool.inputSchema as unknown as {
    required: string[]
    properties: Record<string, { enum?: string[] }>
  }
  assert.deepEqual(schema.required.sort(), ["action", "content", "fencing_token", "path"])
  assert.deepEqual(schema.properties.action.enum, [
    "write",
    "append",
    "patch",
    "ingest",
    "promote",
    "demote",
    "delete",
  ])
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
    () =>
      handleToolCall("create_task", {
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
    () =>
      handleToolCall("trigger_mention", {
        targetAgentId: "designer",
        taskSnippet: "Review the UI",
      }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

// F027 #285 S3 · 旧 3 记忆工具后端真退役：dispatch 支已删，落 default「unknown tool」。
// 职能接管：rooms/<roomId>/session-summary.md（S1 双写 + S2 存量导出）经 read_wiki /
// search_wiki 覆盖。session_memories 表数据不动（Iron Law，DROP 留小孙手动）。
test("F027 #285 S3 · get_memory 已退役 → unknown tool（不再打后端）", async () => {
  const result = await handleToolCall("get_memory", { keyword: "test" })
  assert.equal(result.isError, true)
  assert.ok(result.content[0]?.text.includes("unknown tool"))
})

test("F027 #285 S3 · get_room_summary 已退役 → unknown tool", async () => {
  const result = await handleToolCall("get_room_summary", {})
  assert.equal(result.isError, true)
  assert.ok(result.content[0]?.text.includes("unknown tool"))
})

test("F027 #285 S3 · search_room_memories 已退役 → unknown tool", async () => {
  const result = await handleToolCall("search_room_memories", { keyword: "architecture" })
  assert.equal(result.isError, true)
  assert.ok(result.content[0]?.text.includes("unknown tool"))
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

test("handleToolCall dispatches take_screenshot", async () => {
  await assert.rejects(
    () => handleToolCall("take_screenshot", { url: "http://localhost:3000" }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("handleToolCall dispatches send_file（F040 T7 修7）", async () => {
  await assert.rejects(
    () => handleToolCall("send_file", { filename: "hello.txt", content: "hi" }),
    (err: Error) => {
      assert.ok(err.message.includes("ECONNREFUSED"), `Expected ECONNREFUSED, got: ${err.message}`)
      return true
    },
  )
})

test("send_file 空 content 本地即拒（不打 API）", async () => {
  const result = await handleToolCall("send_file", { filename: "x.txt", content: "" })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /content is required/)
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
