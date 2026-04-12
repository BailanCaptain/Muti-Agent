import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { SqliteStore } from "../db/sqlite"
import { AuthorizationRuleRepository } from "../db/repositories/authorization-rule-repository"
import { ApprovalManager } from "./approval-manager"
import { AuthorizationRuleStore } from "./authorization-rule-store"

describe("ApprovalManager", () => {
  function createManager(timeoutMs = 500) {
    const emitted: Array<{ type: string; payload: unknown }> = []
    const emit = (event: { type: string; payload: unknown }) => { emitted.push(event) }
    const manager = new ApprovalManager(emit as never, undefined, timeoutMs)
    return { manager, emitted }
  }

  function createManagerWithRules(timeoutMs = 500) {
    const emitted: Array<{ type: string; payload: unknown }> = []
    const emit = (event: { type: string; payload: unknown }) => { emitted.push(event) }
    const sqlite = new SqliteStore(":memory:")
    const repo = new AuthorizationRuleRepository(sqlite)
    const ruleStore = new AuthorizationRuleStore(repo)
    const manager = new ApprovalManager(emit as never, ruleStore, timeoutMs)
    return { manager, emitted, ruleStore }
  }

  it("requestPermission holds until respond is called with granted", async () => {
    const { manager, emitted } = createManager()

    const promise = manager.requestPermission({
      invocationId: "inv-1",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "thread-1",
      sessionGroupId: "group-1",
      action: "run_command",
      reason: "需要执行 rm -rf",
    })

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].type, "approval.request")
    const payload = emitted[0].payload as { requestId: string }
    assert.ok(payload.requestId)

    const found = manager.respond(payload.requestId, true, "once")
    assert.equal(found, true)

    const result = await promise
    assert.equal(result.status, "granted")

    assert.equal(emitted.length, 2)
    assert.deepEqual(emitted[1], {
      type: "approval.resolved",
      payload: { requestId: payload.requestId, granted: true },
    })
  })

  it("requestPermission holds until respond is called with denied", async () => {
    const { manager, emitted } = createManager()

    const promise = manager.requestPermission({
      invocationId: "inv-2",
      provider: "claude",
      agentAlias: "小孙",
      threadId: "thread-2",
      sessionGroupId: "group-2",
      action: "edit_file",
      reason: "修改配置文件",
    })

    const payload = emitted[0].payload as { requestId: string }
    manager.respond(payload.requestId, false, "once")

    const result = await promise
    assert.equal(result.status, "denied")
  })

  it("times out and returns denied after timeoutMs", async () => {
    const { manager } = createManager(50)

    const result = await manager.requestPermission({
      invocationId: "inv-3",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "thread-3",
      sessionGroupId: "group-3",
      action: "delete_file",
      reason: "删除临时文件",
    })

    assert.equal(result.status, "timeout")
  })

  it("respond returns false for unknown requestId", () => {
    const { manager } = createManager()
    assert.equal(manager.respond("nonexistent", true, "once"), false)
  })

  it("cancelAll denies all pending requests for a session group", async () => {
    const { manager, emitted } = createManager(5000)

    const p1 = manager.requestPermission({
      invocationId: "inv-4",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "thread-4",
      sessionGroupId: "group-4",
      action: "run_command",
      reason: "test1",
    })

    const p2 = manager.requestPermission({
      invocationId: "inv-5",
      provider: "claude",
      agentAlias: "小孙",
      threadId: "thread-5",
      sessionGroupId: "group-4",
      action: "edit_file",
      reason: "test2",
    })

    const p3 = manager.requestPermission({
      invocationId: "inv-6",
      provider: "gemini",
      agentAlias: "桂芬",
      threadId: "thread-6",
      sessionGroupId: "group-other",
      action: "read_file",
      reason: "test3",
    })

    manager.cancelAll("group-4")

    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1.status, "denied")
    assert.equal(r2.status, "denied")

    const p3Req = emitted.find(
      (e) => e.type === "approval.request" && (e.payload as { sessionGroupId: string }).sessionGroupId === "group-other",
    )
    assert.ok(p3Req)
    const p3Id = (p3Req.payload as { requestId: string }).requestId
    manager.respond(p3Id, true, "once")
    const r3 = await p3
    assert.equal(r3.status, "granted")
  })

  it("hasPending returns correct state", () => {
    const { manager, emitted } = createManager()

    assert.equal(manager.hasPending("group-5"), false)

    manager.requestPermission({
      invocationId: "inv-7",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "thread-7",
      sessionGroupId: "group-5",
      action: "run_command",
      reason: "test",
    })

    assert.equal(manager.hasPending("group-5"), true)

    const payload = emitted[0].payload as { requestId: string }
    manager.respond(payload.requestId, true, "once")
    assert.equal(manager.hasPending("group-5"), false)
  })

  // ── F005: Rule matching + scope persistence ──

  it("auto-grants when a matching global rule exists", async () => {
    const { manager, emitted, ruleStore } = createManagerWithRules()

    ruleStore.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    const result = await manager.requestPermission({
      invocationId: "inv-10",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t1",
      sessionGroupId: "g1",
      action: "npm test",
      fingerprint: { tool: "npm", target: "test", risk: "low" },
      reason: "运行测试",
    })
    assert.equal(result.status, "granted")
    assert.equal(emitted.filter(e => e.type === "approval.request").length, 0)
    assert.equal(emitted.filter(e => e.type === "approval.auto_granted").length, 1)
  })

  it("auto-denies when a matching deny rule exists", async () => {
    const { manager, ruleStore } = createManagerWithRules()

    ruleStore.addRule({ provider: "codex", action: "rm *", scope: "global", decision: "deny" })
    const result = await manager.requestPermission({
      invocationId: "inv-11",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t1",
      sessionGroupId: "g1",
      action: "rm -rf /tmp",
      fingerprint: { tool: "rm", target: "/tmp", risk: "high" },
      reason: "清理临时文件",
    })
    assert.equal(result.status, "denied")
  })

  it("respond with scope=global creates a persistent rule", async () => {
    const { manager, emitted } = createManagerWithRules()

    const promise = manager.requestPermission({
      invocationId: "inv-12",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t1",
      sessionGroupId: "g1",
      action: "npm test",
      fingerprint: { tool: "npm", target: "test", risk: "low" },
      reason: "运行测试",
    })

    const reqId = (emitted[0].payload as { requestId: string }).requestId
    manager.respond(reqId, true, "global")
    await promise

    const result2 = await manager.requestPermission({
      invocationId: "inv-13",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t1",
      sessionGroupId: "g1",
      action: "npm test",
      fingerprint: { tool: "npm", target: "test", risk: "low" },
      reason: "运行测试",
    })
    assert.equal(result2.status, "granted")
  })

  it("respond with scope=thread creates a thread-scoped rule", async () => {
    const { manager, emitted } = createManagerWithRules()

    const promise = manager.requestPermission({
      invocationId: "inv-14",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t1",
      sessionGroupId: "g1",
      action: "edit_file",
      fingerprint: { tool: "edit_file", risk: "medium" },
      reason: "修改文件",
    })
    const reqId = (emitted[0].payload as { requestId: string }).requestId
    manager.respond(reqId, true, "thread")
    await promise

    const r1 = await manager.requestPermission({
      invocationId: "inv-15",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t1",
      sessionGroupId: "g1",
      action: "edit_file",
      fingerprint: { tool: "edit_file", risk: "medium" },
      reason: "修改文件",
    })
    assert.equal(r1.status, "granted")

    const p2 = manager.requestPermission({
      invocationId: "inv-16",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t2",
      sessionGroupId: "g1",
      action: "edit_file",
      fingerprint: { tool: "edit_file", risk: "medium" },
      reason: "修改文件",
    })
    const newReqs = emitted.filter(e => e.type === "approval.request")
    assert.equal(newReqs.length, 2)
    const reqId2 = (newReqs[1].payload as { requestId: string }).requestId
    manager.respond(reqId2, true, "once")
    await p2
  })

  it("getPending returns waiting requests for a sessionGroupId", () => {
    const { manager } = createManagerWithRules()

    manager.requestPermission({
      invocationId: "inv-17",
      provider: "codex",
      agentAlias: "范德彪",
      threadId: "t1",
      sessionGroupId: "g1",
      action: "run_command",
      fingerprint: { tool: "run_command", risk: "high" },
      reason: "test",
    })
    const pending = manager.getPending("g1")
    assert.equal(pending.length, 1)
    assert.equal(pending[0].action, "run_command")
  })
})
