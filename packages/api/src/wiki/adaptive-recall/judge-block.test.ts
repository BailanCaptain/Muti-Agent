/**
 * F027 P13.5 · Judge BLOCKED lint 单元测试
 * 决策表覆盖 5 路径 + 边界 case。
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { judgeRecallBlock } from "./judge-block"

describe("F027 P13.5 · judgeRecallBlock", () => {
  it("recall_required=false → PASS (gate 不卡)", () => {
    const v = judgeRecallBlock({
      recallRequired: false,
      recallSatisfied: false,
      agentOutput: "我们之前已经决定走方案 A 的",
    })
    assert.equal(v.blocked, false)
    assert.equal(v.reason, "recall_not_required")
  })

  it("recall_required=true + satisfied=true → PASS (召回成功，可以谈历史)", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: true,
      agentOutput: "我们之前已经决定走方案 A 的",
    })
    assert.equal(v.blocked, false)
    assert.equal(v.reason, "recall_satisfied")
  })

  it("recall_required=true + satisfied=false + 无历史结论 → PASS (agent 没乱说)", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "我需要查一下相关 wiki 才能回答这个问题",
    })
    assert.equal(v.blocked, false)
    assert.equal(v.reason, "no_history_claim_in_output")
  })

  it("recall_required=true + satisfied=false + 含历史结论 + 无 cite → BLOCKED ★", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "我们之前已经决定走方案 A 了，按 A 推进就行",
    })
    assert.equal(v.blocked, true)
    assert.equal(v.reason, "agent_claims_history_without_recall_or_cite")
    assert.ok("matchedPattern" in v && v.matchedPattern.length > 0)
  })

  it("recall_required=true + satisfied=false + 含历史结论 + 有 [decision_id=42] cite → PASS", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "我们之前已经决定走方案 A [decision_id=42, msg_xxx]",
    })
    assert.equal(v.blocked, false)
    assert.equal(v.reason, "history_claim_but_cited")
  })

  it("有 [D-12] cite 视为 PASS", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "上次拍了走 A [D-12]",
    })
    assert.equal(v.blocked, false)
  })

  it("有 [msg_xxx-uuid] cite 视为 PASS", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "之前讨论过这个 [msg_abc-123-def]",
    })
    assert.equal(v.blocked, false)
  })

  it("F026 [a2a_call=call-xxx] 也算 cite", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "我们之前完成了这个任务 [a2a_call=call-abcd1234]",
    })
    assert.equal(v.blocked, false)
  })

  it("'之前' 词组但没动作描述 → 不算历史结论 → PASS", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "之前的代码不在了，需要看现在的版本",
    })
    // "之前的代码不在了" 不匹配 HISTORY_CLAIM (无 决定/拍/说...) → PASS
    assert.equal(v.blocked, false)
  })

  it("'已经决定' 命中 → BLOCKED", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "这个我们已经决定了，按之前的来",
    })
    assert.equal(v.blocked, true)
  })

  it("'一直以来都是按 X 走' 命中 → BLOCKED", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "一直以来我们都是按方案 B 走的",
    })
    assert.equal(v.blocked, true)
  })

  it("空 agentOutput → PASS", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "",
    })
    assert.equal(v.blocked, false)
  })

  it("混合：含 cite + 含历史结论 → PASS（cite 优先）", () => {
    const v = judgeRecallBlock({
      recallRequired: true,
      recallSatisfied: false,
      agentOutput: "我们之前在 [decision_id=18] 决定了 V14 plan 升级",
    })
    assert.equal(v.blocked, false)
  })
})
