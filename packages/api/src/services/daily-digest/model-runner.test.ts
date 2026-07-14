import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { HaikuRunOptions, HaikuRunResult, HaikuRunner } from "../../runtime/haiku-runner"
import { DIGEST_DEFAULT_FALLBACK_MODEL, DIGEST_DEFAULT_PRIMARY_MODEL } from "./digest-settings"
import {
  DIGEST_EMERGENCY_FALLBACK,
  buildDigestModelTargets,
  createDigestModelRunner,
  runValidatedStage,
} from "./model-runner"

function result(
  ok: boolean,
  label: string,
  durationMs = 10,
  error = `${label}-failed`,
): HaikuRunResult {
  return ok
    ? { ok: true, text: `${label}-text`, durationMs }
    : { ok: false, text: "", durationMs, error }
}

function scriptedRunner(
  label: string,
  scripted: HaikuRunResult,
  calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }>,
): HaikuRunner {
  return {
    async runPrompt(prompt, opts) {
      calls.push({ label, prompt, opts })
      return scripted
    },
  }
}

describe("buildDigestModelTargets", () => {
  it("默认是两个 Claude + 固定 Codex gpt-5.6-sol/high", () => {
    assert.deepEqual(buildDigestModelTargets("claude-opus-4-8", "claude-opus-4-7"), [
      { provider: "claude", model: "claude-opus-4-8" },
      { provider: "claude", model: "claude-opus-4-7" },
      DIGEST_EMERGENCY_FALLBACK,
    ])
  })

  it("固定 Codex slug 不能占用两个 Claude 配置位；历史脏值回落 Claude 默认层", () => {
    assert.deepEqual(buildDigestModelTargets("gpt-5.6-sol", "gpt-5.6-sol"), [
      { provider: "claude", model: DIGEST_DEFAULT_PRIMARY_MODEL },
      { provider: "claude", model: DIGEST_DEFAULT_FALLBACK_MODEL },
      DIGEST_EMERGENCY_FALLBACK,
    ])
    assert.deepEqual(buildDigestModelTargets("claude-opus-4-8", "claude-opus-4-8"), [
      { provider: "claude", model: "claude-opus-4-8" },
      DIGEST_EMERGENCY_FALLBACK,
    ])
  })
})

describe("createDigestModelRunner", () => {
  it("validated stage 在 parser 判坏后前进到不同 target，不重启 primary", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) =>
        scriptedRunner(
          model,
          model === "claude-primary"
            ? { ok: true, text: "malformed", durationMs: 10 }
            : { ok: true, text: '{"valid":true}', durationMs: 20 },
          calls,
        ),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    const got = await runValidatedStage({
      runner,
      stageName: "composer",
      buildPrompt: ({ target }) => `COMPOSE:${target.provider}:${target.model}`,
      validate(text) {
        return text === '{"valid":true}' ? { valid: true } : null
      },
    })

    assert.deepEqual(
      calls.map((call) => call.label),
      ["claude-primary", "claude-fallback"],
    )
    assert.deepEqual(got, {
      ok: true,
      value: { valid: true },
      target: { provider: "claude", model: "claude-fallback" },
      targetIndex: 1,
      durationMs: 30,
      attempts: [
        {
          target: { provider: "claude", model: "claude-primary" },
          targetIndex: 0,
          status: "invalid_output",
          durationMs: 10,
        },
        {
          target: { provider: "claude", model: "claude-fallback" },
          targetIndex: 1,
          status: "valid",
          durationMs: 20,
        },
      ],
    })
  })

  it("CLI exit-0 空输出属于 invalid_output，不能伪装 provider unavailable", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) =>
        scriptedRunner(
          model,
          model === "claude-primary"
            ? { ok: false, text: "", durationMs: 10, error: "empty-output" }
            : { ok: true, text: '{"valid":true}', durationMs: 20 },
          calls,
        ),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    const got = await runValidatedStage({
      runner,
      stageName: "editorial",
      buildPrompt: ({ target }) => `REVIEW:${target.model}`,
      validate: (text) => (text === '{"valid":true}' ? { valid: true } : null),
    })

    assert.equal(got.ok, true)
    assert.deepEqual(
      got.attempts.map((attempt) => attempt.status),
      ["invalid_output", "valid"],
    )
  })

  it("暴露去重后的只读 targets，且能只运行指定 target 形成独立审核票", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) => scriptedRunner(model, result(true, model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })
    const ac = new AbortController()

    assert.deepEqual(runner.targets, [
      { provider: "claude", model: "claude-primary" },
      { provider: "claude", model: "claude-fallback" },
      DIGEST_EMERGENCY_FALLBACK,
    ])
    const got = await runner.runTargetPrompt(1, "REVIEW-B", {
      timeoutMs: 123,
      signal: ac.signal,
    })

    assert.equal(got.ok, true)
    assert.equal(got.text, "claude-fallback-text")
    assert.deepEqual(
      calls.map((call) => [call.label, call.prompt]),
      [["claude-fallback", "REVIEW-B"]],
    )
    assert.equal(calls[0]?.opts?.timeoutMs, 21_600_000)
    assert.equal(calls[0]?.opts?.signal, ac.signal)
  })

  it("拒绝越界 target index，且不触发任何 provider", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) => scriptedRunner(model, result(true, model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    const got = await runner.runTargetPrompt(99, "MUST-NOT-RUN")

    assert.deepEqual(got, {
      ok: false,
      text: "",
      durationMs: 0,
      error: "invalid-digest-model-target",
    })
    assert.deepEqual(calls, [])
  })

  it("主力成功立即短路，不调用 Claude 备用或 Codex", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const created: string[] = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner(model) {
        created.push(`claude:${model}`)
        return scriptedRunner(model, result(true, model), calls)
      },
      createCodexRunner(opts) {
        created.push(`codex:${opts.model}:${opts.effort}`)
        return scriptedRunner(opts.model, result(true, opts.model), calls)
      },
    })

    const ac = new AbortController()
    const got = await runner.runPrompt("PROMPT", { timeoutMs: 123, signal: ac.signal })
    assert.equal(got.ok, true)
    assert.equal(got.text, "claude-primary-text")
    assert.deepEqual(
      calls.map((c) => c.label),
      ["claude-primary"],
    )
    assert.deepEqual(created, [
      "claude:claude-primary",
      "claude:claude-fallback",
      "codex:gpt-5.6-sol:high",
    ])
    assert.equal(calls[0].opts?.timeoutMs, 21_600_000)
    assert.equal(calls[0].opts?.signal, ac.signal)
  })

  it("主力/备用同模型时运行态也只调用一次，再进入固定 Codex", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-same",
      fallbackModel: "claude-same",
      createClaudeRunner: (model) => scriptedRunner(model, result(false, model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    const got = await runner.runPrompt("PROMPT")
    assert.equal(got.ok, true)
    assert.deepEqual(
      calls.map((c) => c.label),
      ["claude-same", "gpt-5.6-sol"],
    )
  })

  it("允许两层 Claude 各跑 6 小时，并给最终 Codex/high 至少 12 小时且直通信号", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) => scriptedRunner(model, result(false, model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })
    const ac = new AbortController()

    const got = await runner.runPrompt("PROMPT", { timeoutMs: 21_600_000, signal: ac.signal })

    assert.equal(got.ok, true)
    assert.deepEqual(
      calls.map((call) => call.opts?.timeoutMs),
      [21_600_000, 21_600_000, 43_200_000],
    )
    assert.ok(calls.every((call) => call.opts?.signal === ac.signal))
  })

  it("调用方误传紧时限不得缩短任一层极宽保险丝", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) => scriptedRunner(model, result(false, model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    await runner.runPrompt("PROMPT", { timeoutMs: 123 })

    assert.deepEqual(
      calls.map((call) => call.opts?.timeoutMs),
      [21_600_000, 21_600_000, 43_200_000],
    )
  })

  it("调用方给 Codex 的时限若已更宽则不得缩短", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) => scriptedRunner(model, result(false, model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    await runner.runPrompt("PROMPT", { timeoutMs: 45_000_000 })

    assert.equal(calls[2]?.opts?.timeoutMs, 45_000_000)
  })

  it("主力失败、Claude 备用成功时不调用 Codex", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) =>
        scriptedRunner(model, result(model === "claude-fallback", model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    const got = await runner.runPrompt("PROMPT")
    assert.equal(got.ok, true)
    assert.equal(got.text, "claude-fallback-text")
    assert.equal(got.durationMs, 20)
    assert.deepEqual(
      calls.map((c) => c.label),
      ["claude-primary", "claude-fallback"],
    )
  })

  it("两个 Claude 都失败才调用一次 Codex，且模型/强度固定", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const codexOpts: Array<{ model: string; effort: string }> = []
    const logs: string[] = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      log: (message) => logs.push(message),
      createClaudeRunner: (model) => scriptedRunner(model, result(false, model), calls),
      createCodexRunner(opts) {
        codexOpts.push(opts)
        return scriptedRunner(opts.model, result(true, opts.model), calls)
      },
    })

    const got = await runner.runPrompt("PROMPT")
    assert.equal(got.ok, true)
    assert.equal(got.text, "gpt-5.6-sol-text")
    assert.equal(got.durationMs, 30)
    assert.deepEqual(codexOpts, [{ model: "gpt-5.6-sol", effort: "high" }])
    assert.deepEqual(
      calls.map((c) => c.label),
      ["claude-primary", "claude-fallback", "gpt-5.6-sol"],
    )
    assert.ok(logs.some((line) => line.includes("claude:claude-primary")))
    assert.ok(logs.some((line) => line.includes("claude:claude-fallback")))
    assert.ok(logs.some((line) => line.includes("fallback success codex:gpt-5.6-sol:high")))
    assert.ok(
      logs.every((line) => !line.includes("PROMPT")),
      "日志不得包含 prompt 正文",
    )
  })

  it("aborted 立即停链，不调用下一层", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) =>
        scriptedRunner(model, result(false, model, 5, "aborted"), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(true, model), calls),
    })

    const got = await runner.runPrompt("PROMPT")
    assert.equal(got.ok, false)
    assert.equal(got.error, "aborted")
    assert.deepEqual(
      calls.map((c) => c.label),
      ["claude-primary"],
    )
  })

  it("全部失败返回含三层目标的聚合错误", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      createClaudeRunner: (model) => scriptedRunner(model, result(false, model), calls),
      createCodexRunner: ({ model }) => scriptedRunner(model, result(false, model), calls),
    })

    const got = await runner.runPrompt("PROMPT")
    assert.equal(got.ok, false)
    assert.equal(got.durationMs, 30)
    assert.match(got.error ?? "", /claude:claude-primary/)
    assert.match(got.error ?? "", /claude:claude-fallback/)
    assert.match(got.error ?? "", /codex:gpt-5\.6-sol:high/)
  })

  it("provider 原始 stderr 不得进入日志或聚合错误，只保留安全分类", async () => {
    const calls: Array<{ label: string; prompt: string; opts?: HaikuRunOptions }> = []
    const logs: string[] = []
    const sentinels = [
      "PROMPT_SECRET_SENTINEL",
      "PRIVATE_TITLE_SENTINEL",
      "RESPONSE_BODY_SENTINEL",
      "https://secret.example/private",
    ]
    const leaked = sentinels.join(" ")
    const runner = createDigestModelRunner({
      primaryModel: "claude-primary",
      fallbackModel: "claude-fallback",
      log: (message) => logs.push(message),
      createClaudeRunner: (model) =>
        scriptedRunner(model, result(false, model, 10, `exit-code-1: ${leaked}`), calls),
      createCodexRunner: ({ model }) =>
        scriptedRunner(model, result(false, model, 10, `spawn-error:${leaked}`), calls),
    })

    const got = await runner.runPrompt("PROMPT")
    const observable = [...logs, got.error ?? ""].join("\n")

    assert.equal(got.ok, false)
    for (const sentinel of sentinels) assert.ok(!observable.includes(sentinel), sentinel)
    assert.match(observable, /exit-code-1/)
    assert.match(observable, /spawn-error/)
  })
})
