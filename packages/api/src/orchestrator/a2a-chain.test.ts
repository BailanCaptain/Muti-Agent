import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { type A2AChainEntry, A2AChainRegistry } from "./a2a-chain"

const entry = (overrides: Partial<A2AChainEntry> = {}): A2AChainEntry => ({
  invocationId: "inv-1",
  threadId: "th-1",
  provider: "claude",
  alias: "黄仁勋",
  parentInvocationId: null,
  rootMessageId: "root-1",
  sessionGroupId: "sg-1",
  createdAt: 1,
  ...overrides,
})

describe("A2AChainRegistry", () => {
  it("registers and retrieves by invocationId", () => {
    const reg = new A2AChainRegistry()
    const e = entry()
    reg.register(e)
    assert.deepEqual(reg.get("inv-1"), e)
  })

  it("returns null for unknown invocationId", () => {
    const reg = new A2AChainRegistry()
    assert.equal(reg.get("missing"), null)
  })

  it("resolves parent via parentInvocationId", () => {
    const reg = new A2AChainRegistry()
    const parent = entry()
    const child = entry({
      invocationId: "inv-2",
      parentInvocationId: "inv-1",
      alias: "范德彪",
      provider: "codex",
    })
    reg.register(parent)
    reg.register(child)
    assert.deepEqual(reg.getParent("inv-2"), parent)
  })

  it("getParent returns null for top-level turn with no parent", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry())
    assert.equal(reg.getParent("inv-1"), null)
  })

  it("getParent returns null when parent entry has been released", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry())
    reg.register(entry({ invocationId: "inv-2", parentInvocationId: "inv-1" }))
    reg.release("inv-1")
    assert.equal(reg.getParent("inv-2"), null)
  })

  it("release removes the entry", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry())
    reg.release("inv-1")
    assert.equal(reg.get("inv-1"), null)
  })

  it("release of unknown id is a no-op", () => {
    const reg = new A2AChainRegistry()
    reg.release("nothing")
  })

  it("re-registering same invocationId overwrites prior entry", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry())
    reg.register(entry({ alias: "黄仁勋-v2" }))
    assert.equal(reg.get("inv-1")?.alias, "黄仁勋-v2")
  })

  // F026 Phase 2 Task A · render fields (senderAlias + triggerMessageId)
  it("stores and returns senderAlias for render layer", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry({ senderAlias: "范德彪" }))
    assert.equal(reg.get("inv-1")?.senderAlias, "范德彪")
  })

  it("stores and returns triggerMessageId for render layer", () => {
    const reg = new A2AChainRegistry()
    reg.register(entry({ triggerMessageId: "msg-42" }))
    assert.equal(reg.get("inv-1")?.triggerMessageId, "msg-42")
  })

  it("senderAlias + triggerMessageId are optional — legacy entries without them still round-trip", () => {
    const reg = new A2AChainRegistry()
    const legacy = entry()
    reg.register(legacy)
    const got = reg.get("inv-1")
    assert.ok(got, "entry must exist")
    assert.equal(got!.senderAlias, undefined)
    assert.equal(got!.triggerMessageId, undefined)
  })
})
