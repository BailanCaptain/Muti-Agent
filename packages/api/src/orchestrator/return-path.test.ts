import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { A2AChainRegistry, type A2AChainEntry } from "./a2a-chain";
import { planReturnPathDispatch } from "./return-path";

function mkEntry(overrides: Partial<A2AChainEntry> = {}): A2AChainEntry {
  return {
    invocationId: "inv-child",
    threadId: "th-child",
    provider: "codex",
    alias: "范德彪",
    parentInvocationId: "inv-parent",
    rootMessageId: "root-1",
    sessionGroupId: "sg-1",
    createdAt: 1,
    ...overrides,
  };
}

function seed(reg: A2AChainRegistry) {
  reg.register({
    invocationId: "inv-parent",
    threadId: "th-parent",
    provider: "claude",
    alias: "黄仁勋",
    parentInvocationId: null,
    rootMessageId: "root-1",
    sessionGroupId: "sg-1",
    createdAt: 0,
  });
  reg.register(mkEntry());
  return reg;
}

describe("planReturnPathDispatch", () => {
  it("returns a dispatch when child reply has no outbound queued mentions", () => {
    const reg = seed(new A2AChainRegistry());
    const plan = planReturnPathDispatch({
      chainRegistry: reg,
      childInvocationId: "inv-child",
      childContent: "review 完成，findings: ...",
      queuedOutboundMentionCount: 0,
      currentRootMessageId: "root-1",
      activeSkillName: "requesting-review",
    });
    assert.ok(plan);
    assert.equal(plan.parentThreadId, "th-parent");
    assert.equal(plan.parentInvocationId, "inv-parent");
    assert.equal(plan.parentAlias, "黄仁勋");
    assert.match(plan.prompt, /范德彪/);
    assert.match(plan.prompt, /requesting-review/);
    assert.match(plan.prompt, /review 完成，findings/);
    assert.match(plan.prompt, /请继续你的流程/);
  });

  it("skips when child already enqueued outbound mentions (natural path handles it)", () => {
    const reg = seed(new A2AChainRegistry());
    const plan = planReturnPathDispatch({
      chainRegistry: reg,
      childInvocationId: "inv-child",
      childContent: "@黄仁勋 review done",
      queuedOutboundMentionCount: 1,
      currentRootMessageId: "root-1",
      activeSkillName: null,
    });
    assert.equal(plan, null);
  });

  it("skips when parent rootMessageId diverges from current", () => {
    const reg = new A2AChainRegistry();
    reg.register({
      invocationId: "inv-parent",
      threadId: "th-parent",
      provider: "claude",
      alias: "黄仁勋",
      parentInvocationId: null,
      rootMessageId: "root-OLD",
      sessionGroupId: "sg-1",
      createdAt: 0,
    });
    reg.register(mkEntry());
    const plan = planReturnPathDispatch({
      chainRegistry: reg,
      childInvocationId: "inv-child",
      childContent: "done",
      queuedOutboundMentionCount: 0,
      currentRootMessageId: "root-1",
      activeSkillName: null,
    });
    assert.equal(plan, null);
  });

  it("skips when child is the top-level turn (no parent recorded)", () => {
    const reg = new A2AChainRegistry();
    reg.register(mkEntry({ parentInvocationId: null }));
    const plan = planReturnPathDispatch({
      chainRegistry: reg,
      childInvocationId: "inv-child",
      childContent: "user-facing reply",
      queuedOutboundMentionCount: 0,
      currentRootMessageId: "root-1",
      activeSkillName: null,
    });
    assert.equal(plan, null);
  });

  it("skips when child content is empty/whitespace", () => {
    const reg = seed(new A2AChainRegistry());
    const plan = planReturnPathDispatch({
      chainRegistry: reg,
      childInvocationId: "inv-child",
      childContent: "   \n  ",
      queuedOutboundMentionCount: 0,
      currentRootMessageId: "root-1",
      activeSkillName: null,
    });
    assert.equal(plan, null);
  });

  it("omits skill label when no active skill given", () => {
    const reg = seed(new A2AChainRegistry());
    const plan = planReturnPathDispatch({
      chainRegistry: reg,
      childInvocationId: "inv-child",
      childContent: "some reply",
      queuedOutboundMentionCount: 0,
      currentRootMessageId: "root-1",
      activeSkillName: null,
    });
    assert.ok(plan);
    assert.match(plan.prompt, /\[范德彪 的答复\]/);
  });
});
