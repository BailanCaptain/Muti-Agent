import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { A2AChainRegistry, type A2AChainEntry } from "./a2a-chain";

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
});

describe("A2AChainRegistry", () => {
  it("registers and retrieves by invocationId", () => {
    const reg = new A2AChainRegistry();
    const e = entry();
    reg.register(e);
    assert.deepEqual(reg.get("inv-1"), e);
  });

  it("returns null for unknown invocationId", () => {
    const reg = new A2AChainRegistry();
    assert.equal(reg.get("missing"), null);
  });

  it("resolves parent via parentInvocationId", () => {
    const reg = new A2AChainRegistry();
    const parent = entry();
    const child = entry({
      invocationId: "inv-2",
      parentInvocationId: "inv-1",
      alias: "范德彪",
      provider: "codex",
    });
    reg.register(parent);
    reg.register(child);
    assert.deepEqual(reg.getParent("inv-2"), parent);
  });

  it("getParent returns null for top-level turn with no parent", () => {
    const reg = new A2AChainRegistry();
    reg.register(entry());
    assert.equal(reg.getParent("inv-1"), null);
  });

  it("getParent returns null when parent entry has been released", () => {
    const reg = new A2AChainRegistry();
    reg.register(entry());
    reg.register(entry({ invocationId: "inv-2", parentInvocationId: "inv-1" }));
    reg.release("inv-1");
    assert.equal(reg.getParent("inv-2"), null);
  });

  it("release removes the entry", () => {
    const reg = new A2AChainRegistry();
    reg.register(entry());
    reg.release("inv-1");
    assert.equal(reg.get("inv-1"), null);
  });

  it("release of unknown id is a no-op", () => {
    const reg = new A2AChainRegistry();
    reg.release("nothing");
  });

  it("re-registering same invocationId overwrites prior entry", () => {
    const reg = new A2AChainRegistry();
    reg.register(entry());
    reg.register(entry({ alias: "黄仁勋-v2" }));
    assert.equal(reg.get("inv-1")?.alias, "黄仁勋-v2");
  });
});
