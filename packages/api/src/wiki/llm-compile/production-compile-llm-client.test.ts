/**
 * F027 v3 G11 · production CompileLLMClient 适配器单测（node:test）
 *
 * 覆盖：ok+valid / ```json fence / malformed JSON / wrong shape / runner !ok /
 *       fallback-haiku-success / timeoutMs 透传。
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { HaikuRunResult, HaikuRunner } from "../../runtime/haiku-runner"
import { createProductionCompileLLMClient } from "./production-compile-llm-client"
import { LLMCompileSchemaError } from "./types"

/** 合法 LLMCompileOutput fixture（schema 全字段齐）。 */
function validOutputJson(): string {
  return JSON.stringify({
    title: "F018 Context Resume",
    type: "concept",
    summary: "Context 续传机制。",
    facts: [{ text: "wakeup 重建 prompt", source_span: "L1-L3" }],
    quoted_spans: [],
    sources: [{ type: "conversation", contributed_by: "黄仁勋" }],
    cross_refs: [{ target: "F026-envelope", relation: "references", rationale: "复用 envelope" }],
    dedup_decision: { verdict: "new_entity", target_entity: null, rationale: "无相似 entity" },
    canonical_owner_suggestion: "wiki/concepts/",
    draft_quality: {
      completeness: 0.8,
      clarity: 0.9,
      has_actionable_facts: true,
      structural_pass: true,
    },
  })
}

/** 构造 stub HaikuRunner，按传入 result 返回，并记录收到的 prompt / opts。 */
function stubRunner(result: HaikuRunResult): {
  runner: HaikuRunner
  calls: Array<{ prompt: string; opts?: { timeoutMs?: number } }>
} {
  const calls: Array<{ prompt: string; opts?: { timeoutMs?: number } }> = []
  const runner: HaikuRunner = {
    async runPrompt(prompt: string, opts?: { timeoutMs?: number }) {
      calls.push({ prompt, opts })
      return result
    },
  }
  return { runner, calls }
}

const okResult = (text: string, error?: string): HaikuRunResult => ({
  ok: true,
  text,
  durationMs: 100,
  ...(error ? { error } : {}),
})

describe("createProductionCompileLLMClient", () => {
  it("ok + valid JSON → returns parsed LLMCompileOutput", async () => {
    const { runner } = stubRunner(okResult(validOutputJson()))
    const client = createProductionCompileLLMClient({ runner })

    const out = await client.compile({ systemPrompt: "SYS", userMessage: "USR" })

    assert.equal(out.title, "F018 Context Resume")
    assert.equal(out.type, "concept")
    assert.equal(out.cross_refs[0].relation, "references")
    assert.equal(out.dedup_decision.verdict, "new_entity")
  })

  it("ok + ```json fence 包裹 → parseLLMCompileJSON 去 fence 后成功", async () => {
    const fenced = "```json\n" + validOutputJson() + "\n```"
    const { runner } = stubRunner(okResult(fenced))
    const client = createProductionCompileLLMClient({ runner })

    const out = await client.compile({ systemPrompt: "SYS", userMessage: "USR" })
    assert.equal(out.title, "F018 Context Resume")
  })

  it("ok + malformed JSON → 抛 LLMCompileSchemaError（可重试）", async () => {
    const { runner } = stubRunner(okResult("{not valid json"))
    const client = createProductionCompileLLMClient({ runner })

    await assert.rejects(
      () => client.compile({ systemPrompt: "S", userMessage: "U" }),
      (err: unknown) => err instanceof LLMCompileSchemaError,
    )
  })

  it("ok + 合法 JSON 但 shape 不符 → 抛 LLMCompileSchemaError（可重试）", async () => {
    const bad = JSON.stringify({ title: "x", type: "not-a-valid-type" })
    const { runner } = stubRunner(okResult(bad))
    const client = createProductionCompileLLMClient({ runner })

    await assert.rejects(
      () => client.compile({ systemPrompt: "S", userMessage: "U" }),
      (err: unknown) => err instanceof LLMCompileSchemaError,
    )
  })

  it("runner !ok（timeout）→ 抛普通 Error（非 LLMCompileSchemaError，不重试）", async () => {
    const { runner } = stubRunner({ ok: false, text: "", durationMs: 60000, error: "timeout" })
    const client = createProductionCompileLLMClient({ runner })

    const err = await client.compile({ systemPrompt: "S", userMessage: "U" }).catch((e) => e)
    assert.ok(err instanceof Error)
    assert.ok(!(err instanceof LLMCompileSchemaError))
    assert.match(String(err.message), /timeout/)
  })

  it("fallback-haiku-success → 仍解析 + 调 logger 记降级", async () => {
    const { runner } = stubRunner(okResult(validOutputJson(), "fallback-haiku-success"))
    const logged: string[] = []
    const client = createProductionCompileLLMClient({ runner, logger: (m) => logged.push(m) })

    const out = await client.compile({ systemPrompt: "S", userMessage: "U" })
    assert.equal(out.title, "F018 Context Resume")
    assert.ok(logged.some((m) => m.includes("Haiku")))
  })

  it("透传 timeoutMs（默认 60s）+ SYSTEM/USER 拼接顺序", async () => {
    const { runner, calls } = stubRunner(okResult(validOutputJson()))
    const client = createProductionCompileLLMClient({ runner })
    await client.compile({ systemPrompt: "THE-SYSTEM", userMessage: "THE-USER" })

    assert.equal(calls[0].opts?.timeoutMs, 60_000)
    assert.ok(calls[0].prompt.indexOf("THE-SYSTEM") < calls[0].prompt.indexOf("THE-USER"))
  })

  it("自定义 timeoutMs 覆盖默认", async () => {
    const { runner, calls } = stubRunner(okResult(validOutputJson()))
    const client = createProductionCompileLLMClient({ runner, timeoutMs: 12345 })
    await client.compile({ systemPrompt: "S", userMessage: "U" })
    assert.equal(calls[0].opts?.timeoutMs, 12345)
  })
})
