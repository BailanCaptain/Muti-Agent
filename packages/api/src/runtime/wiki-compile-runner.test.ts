/**
 * F027 收录设置 · wiki-compile-runner 单测（三引擎 + 自由模型 id）
 *
 * 真相源：docs/features/F027-unified-memory-architecture.md「收尾补丁 · 收录体验」
 *   + 小孙 2026-06-13 拍板（模型可自己写 / 不只 claude）
 *
 * 契约：
 *   - 每次 runPrompt 动态读 config（热生效）
 *   - provider 三家分发；model 自由字符串；claude 缺省补 Opus 4.7，codex/gemini 缺省 = CLI 默认
 *   - fallback 恒 claude Haiku 4.5；primary 即 claude haiku → 直跑不自叠
 *   - 降级 → onFallback("<provider>:<model|default>")
 *   - runner 按 label 缓存复用
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { HaikuRunner, HaikuRunResult } from "./haiku-runner"
import type { RuntimeConfig } from "./runtime-config"
import {
  createDynamicWikiCompileRunner,
  type ResolvedWikiCompileTarget,
  resolveWikiCompileTarget,
  wikiCompileTargetLabel,
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

/** buildRunner 注入：按 label 记录构造与调用。 */
function stubFactory(overrides: Record<string, Partial<HaikuRunResult>> = {}) {
  const built: string[] = []
  const runners = new Map<string, ReturnType<typeof stubRunner>>()
  const build = (target: ResolvedWikiCompileTarget) => {
    const label = wikiCompileTargetLabel(target)
    built.push(label)
    const r = stubRunner(overrides[label] ?? { text: `from-${label}` })
    runners.set(label, r)
    return r
  }
  return { build, built, runners }
}

describe("resolveWikiCompileTarget", () => {
  it("缺配置 → claude + Opus 4.7", () => {
    assert.deepEqual(resolveWikiCompileTarget({}), {
      provider: "claude",
      model: "claude-opus-4-7",
      effort: undefined,
    })
  })

  it("claude + 自由 id（建议列表外）原样生效", () => {
    assert.deepEqual(
      resolveWikiCompileTarget({ wikiCompile: { primaryModel: "claude-fable-5" } }),
      { provider: "claude", model: "claude-fable-5", effort: undefined },
    )
  })

  it("codex/gemini 留空 model → undefined（CLI 默认模型）", () => {
    assert.deepEqual(resolveWikiCompileTarget({ wikiCompile: { provider: "codex" } }), {
      provider: "codex",
      model: undefined,
      effort: undefined,
    })
    assert.deepEqual(
      resolveWikiCompileTarget({ wikiCompile: { provider: "gemini", primaryModel: "  " } }),
      { provider: "gemini", model: undefined, effort: undefined },
    )
  })

  it("label：claude:id / codex:default", () => {
    assert.equal(
      wikiCompileTargetLabel({ provider: "claude", model: "claude-opus-4-7" }),
      "claude:claude-opus-4-7",
    )
    assert.equal(wikiCompileTargetLabel({ provider: "codex", model: undefined }), "codex:default")
  })
})

describe("createDynamicWikiCompileRunner（三引擎）", () => {
  it("默认（空配置）走 claude Opus 4.7", async () => {
    const f = stubFactory()
    const runner = createDynamicWikiCompileRunner({ loadConfig: () => ({}), buildRunner: f.build })
    const r = await runner.runPrompt("p1")
    assert.equal(r.text, "from-claude:claude-opus-4-7")
  })

  it("provider=codex → codex runner 收到调用，claude primary 不构造", async () => {
    const f = stubFactory()
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { provider: "codex", primaryModel: "gpt-5.4" } }),
      buildRunner: f.build,
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.text, "from-codex:gpt-5.4")
    assert.ok(!f.built.includes("claude:claude-opus-4-7"), `built: ${f.built.join(",")}`)
  })

  it("claude 自由 id（建议列表外）按需构造并生效", async () => {
    const f = stubFactory()
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { primaryModel: "claude-fable-5" } }),
      buildRunner: f.build,
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.text, "from-claude:claude-fable-5")
  })

  it("两次调用间改配置 → 切引擎热生效；runner 按 label 缓存复用", async () => {
    const f = stubFactory()
    let config: RuntimeConfig = {}
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => config,
      buildRunner: f.build,
    })
    await runner.runPrompt("p1")
    config = { wikiCompile: { provider: "gemini" } }
    await runner.runPrompt("p2")
    config = {}
    await runner.runPrompt("p3")
    assert.equal(f.built.filter((l) => l === "claude:claude-opus-4-7").length, 1, "缓存复用不重建")
    assert.equal(f.runners.get("claude:claude-opus-4-7")?.calls.length, 2)
    assert.equal(f.runners.get("gemini:default")?.calls.length, 1)
  })

  it("codex primary timeout → claude Haiku 兜底 + onFallback 收 'codex:default'", async () => {
    const f = stubFactory({
      "codex:default": { ok: false, text: "", error: "timeout" },
      "claude:claude-haiku-4-5": { text: "from-haiku" },
    })
    const fallbackSeen: string[] = []
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { provider: "codex" } }),
      buildRunner: f.build,
      onFallback: (label) => fallbackSeen.push(label),
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.ok, true)
    assert.equal(r.text, "from-haiku")
    assert.equal(r.error, "fallback-haiku-success")
    assert.deepEqual(fallbackSeen, ["codex:default"])
  })

  // 德彪 kb-ux2 r1 P1：自由输入时代「业务错不降级」站不住——填错 id 是最常见失败形态，
  // 卡片向小孙承诺「失败自动降级 Haiku 4.5」。wiki 编译链任何 primary 失败都降级
  //（AC-P4-8 default 谓词只认 timeout/quota，是 primary=fallback 同 CLI 时代的假设）。
  it("未知 model id（exit-code 业务错）→ 也降级 Haiku + onFallback 审计", async () => {
    const f = stubFactory({
      "claude:claude-future-9": { ok: false, text: "", error: "exit-code-1: unknown model" },
      "claude:claude-haiku-4-5": { text: "from-haiku" },
    })
    const fallbackSeen: string[] = []
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { primaryModel: "claude-future-9" } }),
      buildRunner: f.build,
      onFallback: (label) => fallbackSeen.push(label),
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.ok, true)
    assert.equal(r.text, "from-haiku")
    assert.equal(r.error, "fallback-haiku-success")
    assert.deepEqual(fallbackSeen, ["claude:claude-future-9"])
  })

  it("codex CLI 不可用（spawn-error）→ 跨引擎降级 Haiku（codex 挂 ≠ claude 挂）", async () => {
    const f = stubFactory({
      "codex:default": { ok: false, text: "", error: "spawn-error:ENOENT" },
      "claude:claude-haiku-4-5": { text: "from-haiku" },
    })
    const fallbackSeen: string[] = []
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { provider: "codex" } }),
      buildRunner: f.build,
      onFallback: (label) => fallbackSeen.push(label),
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.ok, true)
    assert.equal(r.text, "from-haiku")
    assert.deepEqual(fallbackSeen, ["codex:default"])
  })

  it("primary=claude haiku → 直跑一次，失败也不自叠 fallback", async () => {
    const f = stubFactory({
      "claude:claude-haiku-4-5": { ok: false, text: "", error: "timeout" },
    })
    const fallbackSeen: string[] = []
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => ({ wikiCompile: { primaryModel: "claude-haiku-4-5" } }),
      buildRunner: f.build,
      onFallback: (label) => fallbackSeen.push(label),
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.ok, false)
    assert.equal(r.error, "timeout")
    assert.equal(f.runners.get("claude:claude-haiku-4-5")?.calls.length, 1)
    assert.deepEqual(fallbackSeen, [])
  })

  it("loadConfig 抛错 → 回落默认引擎+默认模型不炸", async () => {
    const f = stubFactory()
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => {
        throw new Error("corrupt config")
      },
      buildRunner: f.build,
    })
    const r = await runner.runPrompt("p1")
    assert.equal(r.text, "from-claude:claude-opus-4-7")
  })

  // 补丁#3（小孙「claude/codex 可选强度」）：effort 贯通 target + 缓存键
  it("resolveWikiCompileTarget 带 effort（claude/codex）；无 effort → undefined", () => {
    assert.deepEqual(
      resolveWikiCompileTarget({ wikiCompile: { provider: "claude", effort: "high" } }),
      { provider: "claude", model: "claude-opus-4-7", effort: "high" },
    )
    assert.deepEqual(
      resolveWikiCompileTarget({
        wikiCompile: { provider: "codex", primaryModel: "gpt-5.4", effort: "xhigh" },
      }),
      { provider: "codex", model: "gpt-5.4", effort: "xhigh" },
    )
    assert.deepEqual(resolveWikiCompileTarget({ wikiCompile: { provider: "claude" } }), {
      provider: "claude",
      model: "claude-opus-4-7",
      effort: undefined,
    })
  })

  it("effort 变化触发重建（缓存键含 effort），buildRunner 收到正确 effort；回到旧值命中缓存", async () => {
    const built: ResolvedWikiCompileTarget[] = []
    let config: RuntimeConfig = { wikiCompile: { provider: "claude", effort: "low" } }
    const runner = createDynamicWikiCompileRunner({
      loadConfig: () => config,
      buildRunner: (t) => {
        built.push(t)
        return stubRunner({ text: `e=${t.effort ?? "none"}` })
      },
    })
    const r1 = await runner.runPrompt("p")
    assert.equal(r1.text, "e=low")
    config = { wikiCompile: { provider: "claude", effort: "high" } }
    const r2 = await runner.runPrompt("p")
    assert.equal(r2.text, "e=high", "effort 变化必须重建（缓存键含 effort）")
    const opusBuilds = built.filter((t) => t.model === "claude-opus-4-7")
    assert.equal(opusBuilds.length, 2, "low + high 各建一次")
    config = { wikiCompile: { provider: "claude", effort: "low" } }
    await runner.runPrompt("p")
    assert.equal(
      built.filter((t) => t.model === "claude-opus-4-7").length,
      2,
      "回到 low → 命中缓存，不重建",
    )
  })
})
