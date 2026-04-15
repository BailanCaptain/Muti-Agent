import assert from "node:assert/strict"
import test from "node:test"
import { getTools, handleToolCall } from "./server.js"

// ---------------------------------------------------------------------------
// getTools tests
// ---------------------------------------------------------------------------

test("getTools returns 12 tools", () => {
  const tools = getTools()
  assert.equal(tools.length, 12, `Expected 12 tools, got ${tools.length}`)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    "create_task",
    "get_memory",
    "get_room_context",
    "get_room_summary",
    "get_task_status",
    "parallel_think",
    "post_message",
    "request_decision",
    "request_permission",
    "search_room_memories",
    "take_screenshot",
    "trigger_mention",
  ])
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

test("handleToolCall returns unknown tool error for invalid tool", async () => {
  const result = await handleToolCall("nonexistent_tool", {})
  assert.ok(result, "Should return a result")
  assert.equal(result.isError, true)
  assert.ok(result.content[0]?.text.includes("unknown tool: nonexistent_tool"))
})
