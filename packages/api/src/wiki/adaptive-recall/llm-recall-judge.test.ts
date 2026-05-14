/**
 * F027 P13.2 r2 · LlmRecallJudge 单元测试
 * 范-r1 P1-2 修：兑现 P11 hard-gate.ts 注释承诺"真 LLM judge 在 P13 接入"。
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildRecallJudgePrompt,
  LlmRecallJudge,
  parseRecallJudgeJson,
} from "./llm-recall-judge"
import type { ClaudeRunner } from "./critique-agent"
import type { TriggerContext } from "../memory-preflight/types"

function ctx(over: Partial<TriggerContext> = {}): TriggerContext {
  return {
    scenario: "turn",
    ...over,
  }
}

function fakeRunner(response: { ok: boolean; text?: string; error?: string }): ClaudeRunner {
  return {
    async runPrompt() {
      return {
        ok: response.ok,
        text: response.text ?? "",
        error: response.error,
        durationMs: 1234,
      }
    },
  }
}

describe("F027 P13.2-r2 · buildRecallJudgePrompt", () => {
  it("含 scenario + draft + cite 块", () => {
    const prompt = buildRecallJudgePrompt(
      "我们之前已经决定走方案 A 了",
      ctx({ scenario: "a2a_handoff", citedMessageIds: ["m-1", "m-2"] }),
    )
    assert.match(prompt, /a2a_handoff/)
    assert.match(prompt, /我们之前已经决定走方案 A 了/)
    assert.match(prompt, /messages: \[m-1, m-2\]/)
    assert.match(prompt, /只返回 JSON/)
  })

  it("无 cite 时显示 (无 cite)", () => {
    const prompt = buildRecallJudgePrompt("draft", ctx())
    assert.match(prompt, /无 cite/)
  })

  it("draft 长度截 600", () => {
    const longDraft = "x".repeat(2000)
    const prompt = buildRecallJudgePrompt(longDraft, ctx())
    // prompt 里 draft 段最多 600 字符
    const draftMatch = prompt.match(/\[draft\]\n(x+)/)
    assert.ok(draftMatch)
    assert.equal(draftMatch![1].length, 600)
  })

  it("含 decision cite 时显示", () => {
    const prompt = buildRecallJudgePrompt(
      "之前 [decision_id=42] 已决定",
      ctx({ citedDecisionIds: ["42", "43"] }),
    )
    assert.match(prompt, /decisions: \[42, 43\]/)
  })
})

describe("F027 P13.2-r2 · parseRecallJudgeJson", () => {
  it("required=true → RecallJudgeResult", () => {
    const r = parseRecallJudgeJson('{"required": true, "reason": "draft 真在引用历史结论无 cite"}')
    assert.equal(r.required, true)
    assert.match(r.reason, /真在引用/)
  })

  it("required=false → RecallJudgeResult", () => {
    const r = parseRecallJudgeJson('{"required": false, "reason": "只是字面关键词"}')
    assert.equal(r.required, false)
    assert.match(r.reason, /字面/)
  })

  it("required 非 boolean → 抛", () => {
    assert.throws(
      () => parseRecallJudgeJson('{"required": "yes", "reason": "..."}'),
      /required 必须为 boolean/,
    )
  })

  it("invalid JSON → 抛", () => {
    assert.throws(() => parseRecallJudgeJson("not json"), /recall-judge-parse-failed/)
  })

  it("数组 JSON → 抛", () => {
    assert.throws(() => parseRecallJudgeJson("[]"), /not an object/)
  })

  it("markdown fence 包裹也能解析", () => {
    const r = parseRecallJudgeJson('```json\n{"required": true, "reason": "ok"}\n```')
    assert.equal(r.required, true)
  })

  it("缺 reason 用 fallback", () => {
    const r = parseRecallJudgeJson('{"required": true}')
    assert.equal(r.reason, "llm_judged_required")
    const r2 = parseRecallJudgeJson('{"required": false}')
    assert.equal(r2.reason, "llm_judged_not_required")
  })
})

describe("F027 P13.2-r2 · LlmRecallJudge", () => {
  it("runner 返合法 JSON → judge 返 {required, reason}", async () => {
    const judge = new LlmRecallJudge(
      fakeRunner({ ok: true, text: '{"required": true, "reason": "no cite"}' }),
    )
    const r = await judge.judge({
      draft: "我们之前已经决定",
      context: ctx({ scenario: "turn" }),
    })
    assert.equal(r.required, true)
    assert.match(r.reason, /no cite/)
  })

  it("runner 失败 → 抛 recall-judge-runner-failed", async () => {
    const judge = new LlmRecallJudge(fakeRunner({ ok: false, error: "timeout" }))
    await assert.rejects(
      () => judge.judge({ draft: "x", context: ctx() }),
      /recall-judge-runner-failed.*timeout/,
    )
  })

  it("runner 返非法 JSON → 抛 recall-judge-parse-failed", async () => {
    const judge = new LlmRecallJudge(fakeRunner({ ok: true, text: "<bad>" }))
    await assert.rejects(
      () => judge.judge({ draft: "x", context: ctx() }),
      /recall-judge-parse-failed/,
    )
  })

  it("接 P11 RecallJudgeProvider 接口契约：detectRecallTrigger 可直接注入", async () => {
    // 验证 LlmRecallJudge 是 RecallJudgeProvider — 编译期 + 运行时
    const { detectRecallTrigger } = await import("../memory-preflight/hard-gate")
    const judge = new LlmRecallJudge(
      fakeRunner({ ok: true, text: '{"required": false, "reason": "字面关键词无引用"}' }),
    )
    const result = await detectRecallTrigger(
      {
        scenario: "turn",
        draft: "之前的代码不在了，需要看现在的版本",
      },
      judge,
    )
    // HISTORY_KEYWORD 命中 "之前" → 走第二层 LLM judge → required=false
    assert.equal(result.required, false)
    assert.equal(result.source, "llm_judge")
    assert.match(result.trigger, /字面关键词/)
  })
})
