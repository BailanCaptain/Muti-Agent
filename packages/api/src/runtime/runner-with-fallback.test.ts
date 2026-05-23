import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { HaikuRunner, HaikuRunResult } from "./haiku-runner"
import {
  createRunnerWithFallback,
  defaultShouldFallback,
  didFallback,
} from "./runner-with-fallback"

/**
 * F027 P4 AC-P4-8 (a) · Sonnet + Haiku fallback runner 单测
 *
 * 测试覆盖:
 *   (1) primary success → 返 primary, 不走 fallback
 *   (2) primary timeout → 走 fallback (success) → text=fallback text + error='fallback-haiku-success'
 *   (3) primary quota → 走 fallback
 *   (4) primary rate-limit → 走 fallback
 *   (5) primary 429 → 走 fallback
 *   (6) primary empty-output (非 quota/rate) → NOT fallback, 返 primary error (业务错)
 *   (7) primary spawn-error → NOT fallback, 返 primary error
 *   (8) primary fail + fallback fail → ok=false + 'primary-and-fallback-failed:'
 *   (9) didFallback 识别
 *  (10) custom shouldFallback override
 */

function mockRunner(result: HaikuRunResult): HaikuRunner {
  return {
    async runPrompt() {
      return result
    },
  }
}

describe("createRunnerWithFallback", () => {
  it("(1) primary success → 不走 fallback", async () => {
    const primary = mockRunner({ ok: true, text: "primary out", durationMs: 100 })
    let fallbackCalled = false
    const fallback: HaikuRunner = {
      async runPrompt() {
        fallbackCalled = true
        return { ok: true, text: "fallback out", durationMs: 50 }
      },
    }
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, true)
    assert.equal(r.text, "primary out")
    assert.equal(fallbackCalled, false)
  })

  it("(2) primary timeout → fallback success", async () => {
    const primary = mockRunner({ ok: false, text: "", durationMs: 5000, error: "timeout" })
    const fallback = mockRunner({ ok: true, text: "haiku saved", durationMs: 300 })
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, true)
    assert.equal(r.text, "haiku saved")
    assert.equal(r.durationMs, 5300)
    assert.equal(r.error, "fallback-haiku-success")
    assert.equal(didFallback(r), true)
  })

  it("(3) primary quota → fallback", async () => {
    const primary = mockRunner({
      ok: false,
      text: "",
      durationMs: 100,
      error: "exit-code-1: quota exceeded",
    })
    const fallback = mockRunner({ ok: true, text: "haiku", durationMs: 200 })
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, true)
    assert.equal(r.error, "fallback-haiku-success")
  })

  it("(4) primary rate-limit → fallback", async () => {
    const primary = mockRunner({
      ok: false,
      text: "",
      durationMs: 100,
      error: "rate-limit hit",
    })
    const fallback = mockRunner({ ok: true, text: "haiku", durationMs: 200 })
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, true)
  })

  it("(5) primary 429 → fallback", async () => {
    const primary = mockRunner({
      ok: false,
      text: "",
      durationMs: 100,
      error: "exit-code-429",
    })
    const fallback = mockRunner({ ok: true, text: "haiku", durationMs: 200 })
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, true)
  })

  it("(6) primary empty-output → NOT fallback (业务错)", async () => {
    const primary = mockRunner({ ok: false, text: "", durationMs: 100, error: "empty-output" })
    let fallbackCalled = false
    const fallback: HaikuRunner = {
      async runPrompt() {
        fallbackCalled = true
        return { ok: true, text: "fallback", durationMs: 50 }
      },
    }
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, false)
    assert.equal(r.error, "empty-output")
    assert.equal(fallbackCalled, false)
  })

  it("(7) primary spawn-error → NOT fallback", async () => {
    const primary = mockRunner({
      ok: false,
      text: "",
      durationMs: 0,
      error: "spawn-error:ENOENT",
    })
    let fallbackCalled = false
    const fallback: HaikuRunner = {
      async runPrompt() {
        fallbackCalled = true
        return { ok: true, text: "fb", durationMs: 50 }
      },
    }
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, false)
    assert.equal(fallbackCalled, false)
  })

  it("(8) primary fail + fallback fail → both-failed err", async () => {
    const primary = mockRunner({ ok: false, text: "", durationMs: 5000, error: "timeout" })
    const fallback = mockRunner({
      ok: false,
      text: "",
      durationMs: 300,
      error: "empty-output",
    })
    const runner = createRunnerWithFallback({ primary, fallback })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, false)
    assert.equal(r.durationMs, 5300)
    assert.ok(r.error?.startsWith("primary-and-fallback-failed:"))
    assert.ok(r.error?.includes("timeout"))
    assert.ok(r.error?.includes("empty-output"))
  })

  it("(9) didFallback 识别", () => {
    assert.equal(
      didFallback({ ok: true, text: "x", durationMs: 100, error: "fallback-haiku-success" }),
      true,
    )
    assert.equal(didFallback({ ok: true, text: "x", durationMs: 100 }), false)
    assert.equal(
      didFallback({ ok: false, text: "", durationMs: 100, error: "fallback-haiku-success" }),
      false,
    )
  })

  it("(10) custom shouldFallback override", async () => {
    const primary = mockRunner({ ok: false, text: "", durationMs: 100, error: "any-error" })
    const fallback = mockRunner({ ok: true, text: "fb", durationMs: 200 })
    const runner = createRunnerWithFallback({
      primary,
      fallback,
      shouldFallback: () => true,
    })
    const r = await runner.runPrompt("test")
    assert.equal(r.ok, true)
    assert.equal(r.text, "fb")
  })

  it("defaultShouldFallback patterns", () => {
    assert.equal(defaultShouldFallback("timeout"), true)
    assert.equal(defaultShouldFallback("quota exceeded"), true)
    assert.equal(defaultShouldFallback("rate-limit"), true)
    assert.equal(defaultShouldFallback("429 too many"), true)
    assert.equal(defaultShouldFallback("empty-output"), false)
    assert.equal(defaultShouldFallback("spawn-error:ENOENT"), false)
    assert.equal(defaultShouldFallback(undefined), false)
  })
})
