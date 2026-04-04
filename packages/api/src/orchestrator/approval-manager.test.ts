import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { ApprovalManager } from "./approval-manager"

describe("ApprovalManager", () => {
  function createManager(timeoutMs = 500) {
    const emitted: Array<{ type: string; payload: unknown }> = []
    const emit = (event: { type: string; payload: unknown }) => { emitted.push(event) }
    const manager = new ApprovalManager(emit, timeoutMs)
    return { manager, emitted }
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

    // Should have emitted approval.request
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].type, "approval.request")
    const payload = emitted[0].payload as { requestId: string }
    assert.ok(payload.requestId)

    // Respond with granted
    const found = manager.respond(payload.requestId, true, "once")
    assert.equal(found, true)

    const result = await promise
    assert.equal(result.status, "granted")

    // Should have emitted approval.resolved
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
    const { manager } = createManager(50) // 50ms timeout

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

    // A different group — should NOT be cancelled
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

    // p3 should still be pending — resolve it manually
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
})
