/**
 * F027 收尾补丁 AC-W1 · wiki-compile-runner 单测
 *
 * 真相源：docs/features/F027-unified-memory-architecture.md「收尾补丁 · 收录体验」AC-W1
 *
 * 契约：
 *   - 每次 runPrompt 动态读 runtime config（热生效，改配置不用重启）
 *   - primary = wikiCompile.primaryModel（白名单 4 模型，默认 Opus 4.7）
 *   - fallback 链固定 Haiku 4.5（runner-with-fallback 既有语义）
 *   - primary 本身是 Haiku → 直跑不自叠 fallback（避免同模型双跑）
 *   - 降级发生 → onFallback(真实 primary 模型名)（审计 log 用）
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { HaikuRunner, HaikuRunResult } from "./haiku-runner"
import type { RuntimeConfig } from "./runtime-config"
import {
  createDynamicWikiCompileRunner,
  resolveWikiCompileModel,
} from "./wiki-compile-runner"

function stubRunner(result: Partial<HaikuRunResult>): HaikuRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runPrompt(prompt: string) {
      calls.push(prompt)
      return Promise.resolve({
        ok: result.ok ?? true,
        text: result.text ?? "ok-output",
        durationMs: 1,
        ...(result.error !== undefined ? { error: result.error } : {}),
      })
    },
  }
}

function stubSet(overrides: Partial<Record<string, Partial<HaikuRunResult>>> = {}) {
  return {
    "claude-opus-4-7": stubRunner(overrides["claude-opus-4-7"] ?? { text: "from-opus47" }),
    "claude-sonnet-4-6": stubRunner(overrides["claude-sonnet-4-6"] ?? { text: "from-sonnet" }),
    "claude-opus-4-6": stubRunner(overrides["claude-opus-4-6"] ?? { text: "from-opus46" }),
    "claude-haiku-4-5": stubRunner(overrides["claude-haiku-4-5"] ?? { text: "from-haiku" }),
  }
}

describe("resolveWikiCompileModel", () => {
  it("缺配置 → 默认 claude-opus-4-7", () => {
    assert.equal(resolveWikiCompileModel({}), "claude-opus-4-7")
    assert.equal(resolveWikiCompileModel({ wikiCompile: {} } as RuntimeConfig), "claude-opus-4-7")
  })

  it("合法配置 → 取配置值", () => {
    assert.equal(
      resolveWikiCompileModel({ wikiCompile: { primaryModel: "claude-sonnet-4-6" } }),
      "claude-sonnet-4-6",
    )
  })
})

describe("createDynamicWikiCompileRunner", () => {
  it("默认（空配置）走 Opus 4.7 primary", async () => {
    const runners = stubSet()
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({}),
      runnersById: runners,
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.text, "from-opus47")
    assert.equal(runners["claude-opus-4-7"].calls.length, 1)
    assert.equal(runners["claude-sonnet-4-6"].calls.length, 0)
  })

  it("配置 sonnet → sonnet primary，opus 不被调", async () => {
    const runners = stubSet()
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { primaryModel: "claude-sonnet-4-6" } }),
      runnersById: runners,
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.text, "from-sonnet")
    assert.equal(runners["claude-opus-4-7"].calls.length, 0)
  })

  it("两次调用间改配置 → 第二次用新模型（热生效不重启）", async () => {
    const runners = stubSet()
    let config: RuntimeConfig = {}
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => config,
      runnersById: runners,
    })
    await runner.runPrompt("p1")
    config = { wikiCompile: { primaryModel: "claude-opus-4-6" } }
    await runner.runPrompt("p2")
    assert.equal(runners["claude-opus-4-7"].calls.length, 1)
    assert.equal(runners["claude-opus-4-6"].calls.length, 1)
  })

  it("primary timeout → Haiku 兜底成功 + onFallback 收到真实 primary 模型名", async () => {
    const runners = stubSet({
      "claude-sonnet-4-6": { ok: false, text: "", error: "timeout" },
    })
    const fallbackSeen: string[] = []
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { primaryModel: "claude-sonnet-4-6" } }),
      runnersById: runners,
      onFallback: (model) => fallbackSeen.push(model),
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.ok, true)
    assert.equal(r.text, "from-haiku")
    assert.equal(r.error, "fallback-haiku-success")
    assert.deepEqual(fallbackSeen, ["claude-sonnet-4-6"])
  })

  it("primary 业务错（非 timeout/quota）→ 不降级原样返回", async () => {
    const runners = stubSet({
      "claude-opus-4-7": { ok: false, text: "", error: "empty-output" },
    })
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({}),
      runnersById: runners,
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.ok, false)
    assert.equal(r.error, "empty-output")
    assert.equal(runners["claude-haiku-4-5"].calls.length, 0)
  })

  it("primary=haiku → 直跑一次，失败也不自叠 fallback 双跑", async () => {
    const runners = stubSet({
      "claude-haiku-4-5": { ok: false, text: "", error: "timeout" },
    })
    const fallbackSeen: string[] = []
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { primaryModel: "claude-haiku-4-5" } }),
      runnersById: runners,
      onFallback: (model) => fallbackSeen.push(model),
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.ok, false)
    assert.equal(r.error, "timeout")
    assert.equal(runners["claude-haiku-4-5"].calls.length, 1, "haiku 只跑一次")
    assert.deepEqual(fallbackSeen, [])
  })

  it("loadConfig 抛错 → 回落默认模型不炸", async () => {
    const runners = stubSet()
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => {
        throw new Error("corrupt config")
      },
      runnersById: runners,
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.text, "from-opus47")
  })
})
