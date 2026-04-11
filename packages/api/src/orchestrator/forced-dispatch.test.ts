import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { planForcedDispatch } from "./forced-dispatch"

describe("planForcedDispatch", () => {
  const baseInput = {
    nextDispatch: {
      target: "reviewer",
      promptTemplate: "@%TARGET% 请 review 我刚提交的 PR",
    },
    sourceProvider: "claude" as const,
    sourceAlias: "黄仁勋",
    llmContent: "quality-gate 已通过",
    resolveTargetAlias: (_provider: string) => "范德彪",
  }

  it("returns synthetic content with @alias when LLM did not mention target", () => {
    const plan = planForcedDispatch(baseInput)
    assert.ok(plan)
    assert.equal(plan.targetProvider, "codex")
    assert.equal(plan.targetAlias, "范德彪")
    assert.ok(plan.syntheticContent.startsWith("@范德彪"))
    assert.match(plan.syntheticContent, /请 review/)
  })

  it("returns null when LLM already mentioned the resolved alias", () => {
    const plan = planForcedDispatch({
      ...baseInput,
      llmContent: "已完成\n@范德彪 请帮忙 review 一下 PR",
    })
    assert.equal(plan, null)
  })

  it("returns null when resolver returns null target alias", () => {
    const plan = planForcedDispatch({
      ...baseInput,
      resolveTargetAlias: () => null,
    })
    assert.equal(plan, null)
  })

  it("returns null when resolveReviewerProvider yields no provider", () => {
    const plan = planForcedDispatch({
      ...baseInput,
      nextDispatch: { target: "unknown-role", promptTemplate: "@%TARGET% hi" },
    })
    assert.equal(plan, null)
  })

  it("substitutes %TARGET% with the alias in the template", () => {
    const plan = planForcedDispatch({
      ...baseInput,
      nextDispatch: {
        target: "reviewer",
        promptTemplate: "@%TARGET% 请看 PR #%PR%",
      },
    })
    assert.ok(plan)
    assert.match(plan.syntheticContent, /^@范德彪 请看 PR #%PR%/)
  })

  it("prepends @alias if the template does not start with the placeholder", () => {
    const plan = planForcedDispatch({
      ...baseInput,
      nextDispatch: {
        target: "reviewer",
        promptTemplate: "请 review PR #42",
      },
    })
    assert.ok(plan)
    assert.ok(plan.syntheticContent.startsWith("@范德彪 "))
  })

  it("line-start match — @alias in middle of line does NOT count as manual mention", () => {
    // matchMode: "line-start" is what enqueuePublicMentions uses; forced-dispatch
    // should mirror that: only a line starting with @alias counts as manual.
    const plan = planForcedDispatch({
      ...baseInput,
      llmContent: "review 完成 cc @范德彪 看看",
    })
    assert.ok(plan)
  })
})
