import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { describe, it } from "node:test"
import type { TokenUsageSnapshot } from "@multi-agent/shared"
import type { RuntimeDependencies } from "./base-runtime"
import { ClaudeRuntime } from "./claude-runtime"
import { pickModelWindow, runTurn } from "./cli-orchestrator"
import { CodexRuntime } from "./codex-runtime"
import { ProcessLivenessProbe } from "./liveness-probe"

// F043 Task 4 · orchestrator scope 路由 + resolveUsage 接线的集成回归。
// 事件语料 = AC0 探针档案（__fixtures__/f043/），解析走真 adapter（注入 spawn），
// 覆盖 AC1 验收「重放封存现场：usedTokens=末次足迹而非整轮累加」的机械化版。

const FIXTURES = path.join(__dirname, "__fixtures__", "f043")

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4321
  killed = false
  kill() {
    this.killed = true
    return true
  }
}

function fakeProbeFactory(): RuntimeDependencies["createLivenessProbe"] {
  return (pid, config) =>
    new ProcessLivenessProbe(pid, config, {
      platform: "linux",
      isPidAlive: () => true,
      sampleCpuTime: async () => 0,
      setInterval: (() => ({ unref: () => undefined })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => undefined) as unknown as typeof globalThis.clearInterval,
    })
}

/** spawn 注入：把原始 ndjson 行原样打进 stdout（真 adapter 解析真事件）。 */
function scriptedSpawn(lines: string[]): RuntimeDependencies["spawn"] {
  return () => {
    const child = new FakeChildProcess()
    setImmediate(() => {
      for (const line of lines) {
        child.stdout.write(`${line}\n`)
      }
      setImmediate(() => {
        child.stdout.end()
        child.stderr.end()
        child.emit("close", 0)
      })
    })
    return child as never
  }
}

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES, name), "utf-8").split("\n").filter(Boolean)
}

function baseOptions(runtime: ClaudeRuntime | CodexRuntime, over: Record<string, unknown> = {}) {
  return {
    threadId: "t-f043",
    provider: "claude" as const,
    model: null as string | null,
    effort: null,
    nativeSessionId: null as string | null,
    userMessage: "probe",
    onAssistantDelta: () => undefined,
    onSession: () => undefined,
    onModel: () => undefined,
    runtime,
    ...over,
  }
}

describe("F043 runTurn usage scope routing (claude fixture replay)", () => {
  it("usedTokens = 末次 context 足迹；result 累计升级窗口但不覆盖分子", async () => {
    const snapshots: TokenUsageSnapshot[] = []
    const runtime = new ClaudeRuntime({
      spawn: scriptedSpawn(fixtureLines("claude-multicall.ndjson")),
      platform: "linux",
      createLivenessProbe: fakeProbeFactory(),
    })
    const result = await runTurn(
      baseOptions(runtime, { onUsageSnapshot: (s: TokenUsageSnapshot) => snapshots.push(s) }),
    ).promise

    // 分子 = 末次 message_start/delta 足迹（28,904），绝不是整轮累加（57,820）
    assert.equal(result.usage?.usedTokens, 28_904)
    // 分母 = result.modelUsage 提炼的账户生效窗口（init 事件 currentModel 全名精确匹配）
    assert.equal(result.usage?.windowTokens, 200_000)
    // 分子真足迹 + 窗口 CLI 自报 → 整体 exact
    assert.equal(result.usage?.source, "exact")
    // turn_total 改道统计出口，不进 seal
    assert.equal(result.turnTotals?.totalTokens, 57_820)
    // 28,904 / 200,000 = 0.14 → 远离阈值，不封存（旧口径 57,820/200k=0.29 也不封，
    // 但 07-10 现场 15 调用轮是 989k/200k=100% 必封 —— 分离后回到真实占用）
    assert.equal(result.sealDecision?.shouldSeal, false)
    assert.equal(result.sealDecision?.reason, null)

    // 实时快照序列：4 次 context（start/delta ×2 调用）+ 1 次 result 触发的窗口升级重建
    assert.deepEqual(
      snapshots.map((s) => s.usedTokens),
      [28_568, 28_568, 28_904, 28_904, 28_904],
    )
    assert.equal(snapshots[0].source, "approx", "result 之前窗口来自兜底表")
    assert.equal(snapshots[snapshots.length - 1].source, "exact", "result 后升级 exact")
  })

  it("只有 turn_total（无 message_start）→ usage/sealDecision 为空，turnTotals 照常", async () => {
    const resultLine = fixtureLines("claude-multicall.ndjson").find((l) =>
      l.startsWith('{"type":"result"'),
    )
    assert.ok(resultLine)
    const runtime = new ClaudeRuntime({
      spawn: scriptedSpawn([resultLine]),
      platform: "linux",
      createLivenessProbe: fakeProbeFactory(),
    })
    const result = await runTurn(baseOptions(runtime)).promise

    assert.equal(result.usage, null, "turn_total 绝不构成 context 快照")
    assert.equal(result.sealDecision, null)
    assert.equal(result.turnTotals?.totalTokens, 57_820)
  })

  it("contextWindowOverride 仍压过 CLI 自报窗口（F021 P6 语义保持）", async () => {
    const runtime = new ClaudeRuntime({
      spawn: scriptedSpawn(fixtureLines("claude-multicall.ndjson")),
      platform: "linux",
      createLivenessProbe: fakeProbeFactory(),
    })
    const result = await runTurn(baseOptions(runtime, { contextWindowOverride: 500_000 })).promise
    assert.equal(result.usage?.windowTokens, 500_000)
    assert.equal(result.usage?.usedTokens, 28_904)
  })
})

describe("F043 runTurn resolveUsage wiring (codex full chain)", () => {
  const SESSION_ID = "019f4b0b-91ba-7db3-9072-cb640aab7f3e"
  // 探针 stream 事件：thread.started 带 sessionId + turn.completed 带累计 usage
  const codexLines = [
    JSON.stringify({ type: "thread.started", thread_id: SESSION_ID }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 39_727, cached_input_tokens: 37_120, output_tokens: 213 },
    }),
  ]

  function makeCodex(sessionsDir: string) {
    return new CodexRuntime(
      {
        spawn: scriptedSpawn(codexLines),
        platform: "linux",
        createLivenessProbe: fakeProbeFactory(),
      },
      sessionsDir,
    )
  }

  it("rollout 回读覆盖流内累计值：39,727(approx) → 13,400(exact) + 真窗口 353,400", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f043-orch-codex-"))
    try {
      const dayDir = path.join(dir, "2026", "07", "10")
      mkdirSync(dayDir, { recursive: true })
      copyFileSync(
        path.join(FIXTURES, "codex-rollout-tail.jsonl"),
        path.join(dayDir, `rollout-2026-07-10T16-01-17-${SESSION_ID}.jsonl`),
      )
      const snapshots: TokenUsageSnapshot[] = []
      const result = await runTurn(
        baseOptions(makeCodex(dir), {
          provider: "codex" as const,
          model: "gpt-5.6-sol",
          onUsageSnapshot: (s: TokenUsageSnapshot) => snapshots.push(s),
        }),
      ).promise

      assert.equal(result.usage?.usedTokens, 13_400, "rollout last_token_usage 真足迹")
      assert.equal(result.usage?.windowTokens, 353_400, "rollout model_context_window 真窗口")
      assert.equal(result.usage?.source, "exact")
      // seal 判定基于回读后的最终值：13,400/353,400 = 0.038 → 不封
      assert.equal(result.sealDecision?.shouldSeal, false)
      assert.equal(result.sealDecision?.reason, null)
      // 实时快照末条 = 回读覆盖后的 exact 值（AC8 消费的就是这个序列）
      assert.equal(snapshots[snapshots.length - 1].usedTokens, 13_400)
      assert.equal(snapshots[snapshots.length - 1].source, "exact")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rollout 缺失 → 保留流内退化值（input 单值 + 兜底表窗口，恒 approx）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "f043-orch-codex-empty-"))
    try {
      const result = await runTurn(
        baseOptions(makeCodex(dir), { provider: "codex" as const, model: "gpt-5.6-sol" }),
      ).promise

      assert.equal(result.usage?.usedTokens, 39_727, "退化 = input_tokens 单值（不加 cached）")
      assert.equal(result.usage?.windowTokens, 353_400, "分母走兜底表（gpt-5.6 实测快照）")
      assert.equal(result.usage?.source, "approx", "退化路径必须标 approx")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("F043 pickModelWindow", () => {
  it("完整模型名精确命中", () => {
    assert.equal(
      pickModelWindow({ "claude-haiku-4-5-20251001": 200_000 }, "claude-haiku-4-5-20251001"),
      200_000,
    )
  })
  it("前缀匹配（currentModel 短名 vs modelUsage 全名，双向）", () => {
    assert.equal(pickModelWindow({ "claude-opus-4-8-20260115": 1_000_000 }, "claude-opus-4-8"), 1_000_000)
    assert.equal(pickModelWindow({ "claude-opus-4-8": 1_000_000 }, "claude-opus-4-8-20260115"), 1_000_000)
  })
  it("匹配不到但只有一个条目 → 取之", () => {
    assert.equal(pickModelWindow({ "claude-opus-4-8": 1_000_000 }, "some-alias"), 1_000_000)
  })
  it("多条目匹配不到 → 取最大窗口（宁可晚封不误封）", () => {
    assert.equal(
      pickModelWindow(
        { "claude-haiku-4-5-20251001": 200_000, "claude-opus-4-8": 1_000_000 },
        "unknown",
      ),
      1_000_000,
    )
  })
  it("空表/空模型容错", () => {
    assert.equal(pickModelWindow({}, "claude-opus-4-8"), null)
    assert.equal(pickModelWindow({ "claude-opus-4-8": 1_000_000 }, null), 1_000_000)
  })
})
