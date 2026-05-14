/**
 * F027 P13.1 · AdaptiveRecallExecutor 单元测试
 * 测试 5 级 fallback 状态机 + per-turn budget。
 *
 * AC-P1-12 fixture：5 级 fallback 全部触发（L1 命中 / L2 命中 / L3 命中 /
 * L4 命中 / L5 escalate）+ budget 触顶 → 强制 escalate。
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { executeAdaptiveRecall } from "./executor"
import type {
  CritiqueAgent,
  CritiqueInput,
  CritiqueVerdict,
  EscalateInfo,
  Level2Backend,
  Level3Backend,
  Level4Backend,
  Level5Sink,
} from "./types"
import type { RecallHit } from "../memory-preflight/types"

// ─── 测试 helpers ──────────────────────────────────────────────────────

function hit(path: string, score: number, excerpt = "..."): RecallHit {
  return { path, score, excerpt }
}

interface CritiqueScript {
  /** 按 level 决定返什么 verdict */
  byLevel: Partial<Record<1 | 2 | 3 | 4, CritiqueVerdict>>
}

function scriptedCritique(script: CritiqueScript): CritiqueAgent {
  return {
    async evaluate(input: CritiqueInput): Promise<CritiqueVerdict> {
      const v = script.byLevel[input.level]
      if (!v) {
        // 默认：未脚本化 → not satisfied + 进下一级（L4 时给 escalate）
        if (input.level === 4) {
          return { satisfied: false, escalate: true, reason: "default_no_script_l4" }
        }
        return {
          satisfied: false,
          nextLevel: (input.level + 1) as 2 | 3 | 4 | 5,
          reason: `default_no_script_l${input.level}`,
        }
      }
      return v
    },
  }
}

function stubLevel2(hits: RecallHit[] = []): Level2Backend {
  return { async searchWiki() { return hits } }
}
function stubLevel3(hits: RecallHit[] = []): Level3Backend {
  return { async queryMessages() { return hits } }
}
function stubLevel4(hit: RecallHit | null = null): Level4Backend {
  return { async readWiki() { return hit } }
}
function recordingLevel5(): { sink: Level5Sink; calls: EscalateInfo[] } {
  const calls: EscalateInfo[] = []
  return {
    sink: {
      async escalate(info: EscalateInfo) {
        calls.push(info)
      },
    },
    calls,
  }
}

// ─── 测试 ──────────────────────────────────────────────────────────────

describe("F027 P13.1 · AdaptiveRecallExecutor", () => {
  it("L1 命中：taskMemoryPack 已有 hits + critique satisfied → recall_path=1, 不进 L2", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "F011 drizzle 优化",
        taskMemoryPack: [hit("wiki/concepts/F011-xxx.md", 0.85)],
      },
      {
        critique: scriptedCritique({
          byLevel: { 1: { satisfied: true, reason: "task_memory_pack_covers_query" } },
        }),
        level2: stubLevel2(),
        level3: stubLevel3(),
        level4: stubLevel4(),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 1, "应停在 L1")
    assert.equal(result.recallSatisfied, true)
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].path, "wiki/concepts/F011-xxx.md")
    assert.equal(result.critiqueCalls, 1, "L1 critique 一次")
    assert.equal(result.budgetExceeded, false)
    assert.equal(result.escalateReason, undefined)
    assert.equal(l5.calls.length, 0, "未 escalate")
    assert.equal(result.attempts.length, 1)
    assert.equal(result.attempts[0].level, 1)
    assert.equal(result.attempts[0].satisfied, true)
  })

  it("L2 命中：L1 not satisfied → L2 search_wiki hits + critique satisfied → recall_path=2", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "F011 drizzle 优化",
        taskMemoryPack: [hit("wiki/concepts/stale.md", 0.5)],
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "l1_score_too_low" },
            2: { satisfied: true, reason: "search_wiki_covers" },
          },
        }),
        level2: stubLevel2([hit("wiki/concepts/F011-real.md", 0.82)]),
        level3: stubLevel3(),
        level4: stubLevel4(),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 2)
    assert.equal(result.recallSatisfied, true)
    assert.equal(result.hits[0].path, "wiki/concepts/F011-real.md")
    assert.equal(result.critiqueCalls, 2, "L1 + L2 critique 各一次")
    assert.equal(result.attempts.length, 2)
    assert.equal(result.attempts[1].level, 2)
    assert.equal(l5.calls.length, 0)
  })

  it("L3 命中：L1/L2 not satisfied → query_messages hits + critique satisfied → recall_path=3", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "drizzle 性能",
        // 注意：critique budget=3 才能跑到 L3 satisfied（L1+L2+L3 = 3 次 critique）
        budget: { maxCritiqueCalls: 3 },
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "no_l1" },
            2: { satisfied: false, nextLevel: 3, reason: "no_l2_hits" },
            3: { satisfied: true, reason: "query_messages_hit" },
          },
        }),
        level2: stubLevel2([]),
        level3: stubLevel3([hit("messages/R-201/m-xxx", 0.7, "drizzle 优化讨论")]),
        level4: stubLevel4(),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 3)
    assert.equal(result.recallSatisfied, true)
    // L1 因 taskMemoryPack 未传被跳过；L2 + L3 = 2 个 attempts
    assert.equal(result.attempts.length, 2)
    assert.equal(result.attempts[0].level, 2)
    assert.equal(result.attempts[1].level, 3)
    assert.equal(l5.calls.length, 0)
  })

  it("L4 命中（严格模式）：critique 输出 specificPath → read_wiki(path) → satisfied → recall_path=4", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "F011 drizzle 性能",
        budget: { maxLevels: 4, maxCritiqueCalls: 4 },
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "no_l1" },
            2: { satisfied: false, nextLevel: 3, reason: "no_l2" },
            3: {
              satisfied: false,
              nextLevel: 4,
              specificPath: "wiki/concepts/F011-deep.md",
              reason: "need_read_specific_path",
            },
            4: { satisfied: true, reason: "specific_path_resolves_query" },
          },
        }),
        level2: stubLevel2([]),
        level3: stubLevel3([]),
        level4: stubLevel4(hit("wiki/concepts/F011-deep.md", 1.0, "deep content")),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 4)
    assert.equal(result.recallSatisfied, true)
    assert.equal(result.hits[0].path, "wiki/concepts/F011-deep.md")
    // L1 因 taskMemoryPack 未传被跳过；L2 + L3 + L4 = 3 个 attempts
    assert.equal(result.attempts.length, 3)
    assert.equal(result.attempts[2].level, 4)
    assert.equal(result.attempts[2].meta?.path, "wiki/concepts/F011-deep.md")
    assert.equal(l5.calls.length, 0)
  })

  it("L5 escalate：L1-L3 全部 not satisfied 且 critique 不给 specificPath → escalate, recallSatisfied=false", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "完全不存在的话题",
        budget: { maxCritiqueCalls: 3 },
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "no_l1" },
            2: { satisfied: false, nextLevel: 3, reason: "no_l2" },
            // L3 不给 specificPath → 直接 escalate（严格模式 L4 不触发）
            3: { satisfied: false, nextLevel: 4, reason: "l3_no_specific_path" },
          },
        }),
        level2: stubLevel2([]),
        level3: stubLevel3([]),
        level4: stubLevel4(),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 5)
    assert.equal(result.recallSatisfied, false)
    assert.ok(result.escalateReason, "escalateReason 非空")
    assert.equal(l5.calls.length, 1, "level5 sink 收到 1 次 escalate")
    assert.equal(l5.calls[0].trigger, "history_keyword")
    assert.equal(l5.calls[0].query, "完全不存在的话题")
    assert.deepEqual(l5.calls[0].visitedLevels, [2, 3])
  })

  it("L4 严格度：critique 输出 nextLevel=4 但无 specificPath → 不触发 L4，直接 escalate", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "?",
        budget: { maxLevels: 4, maxCritiqueCalls: 4 },
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "no_l1" },
            2: { satisfied: false, nextLevel: 3, reason: "no_l2" },
            3: { satisfied: false, nextLevel: 4, reason: "fuzzy_no_path" }, // 无 specificPath
          },
        }),
        level2: stubLevel2([]),
        level3: stubLevel3([]),
        level4: stubLevel4(hit("wrong/path.md", 1.0)),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 5, "L4 不触发，escalate")
    assert.equal(result.recallSatisfied, false)
    // 不应该有 L4 attempt
    assert.equal(result.attempts.find((a) => a.level === 4), undefined)
  })

  it("budget maxLevels=2 限制：L2 not satisfied → 不进 L3 直接 escalate", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "x",
        budget: { maxLevels: 2, maxCritiqueCalls: 5 },
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "no_l1" },
            2: { satisfied: false, nextLevel: 3, reason: "no_l2" },
          },
        }),
        level2: stubLevel2([]),
        level3: stubLevel3([hit("messages/should-not-reach", 0.9)]),
        level4: stubLevel4(),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 5)
    assert.equal(result.recallSatisfied, false)
    assert.equal(result.attempts.find((a) => a.level === 3), undefined, "L3 不应被触发")
    assert.equal(l5.calls.length, 1)
  })

  it("budget maxCritiqueCalls 触顶：L2 critique 时已 == maxCritiqueCalls → 立即 escalate, budgetExceeded=true", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "x",
        taskMemoryPack: [hit("stale.md", 0.3)],
        budget: { maxCritiqueCalls: 1 }, // 只允许 1 次 critique
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "no_l1" },
          },
        }),
        level2: stubLevel2([hit("wiki/2.md", 0.9)]),
        level3: stubLevel3(),
        level4: stubLevel4(),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 5)
    assert.equal(result.budgetExceeded, true)
    assert.equal(result.critiqueCalls, 1, "只跑了 L1 的 critique")
    assert.equal(l5.calls.length, 1)
    // L1 跑完后 critique budget 已用完，进 L2 前的 budgetLeft 检查触发 escalate
    assert.match(l5.calls[0].reason, /budget_exceeded_before_l2/)
  })

  it("【范-r1 P1-1】budget maxTotalMs 触顶：critique 慢但返 satisfied → 仍强制 escalate, budgetExceeded=true", async () => {
    const l5 = recordingLevel5()
    let fakeMs = 1000
    // critique 慢响应但返 satisfied — 当前 bug: executor 直接接受 satisfied 不查 maxTotalMs
    const slowSatisfiedCritique: CritiqueAgent = {
      async evaluate(input) {
        fakeMs += 6000 // 单次跳 6s, 超 maxTotalMs=5000
        return { satisfied: true, reason: `level_${input.level}_satisfied_but_slow` }
      },
    }
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "x",
        taskMemoryPack: [hit("wiki/x.md", 0.5)],
        budget: { maxTotalMs: 5000, maxCritiqueCalls: 5 },
      },
      {
        critique: slowSatisfiedCritique,
        level2: stubLevel2(),
        level3: stubLevel3(),
        level4: stubLevel4(),
        level5: l5.sink,
        now: () => fakeMs,
      },
    )

    // 范-r1 P1-1: critique 返 satisfied 但 totalMs 已超 cap → 必须 escalate（V16.5 行 1415-1418 + executor.ts:12 注释"任一触顶 → 强制 L5 escalate"）
    assert.equal(result.recallPath, 5, "慢 critique 返 satisfied 仍必须 escalate")
    assert.equal(result.recallSatisfied, false)
    assert.equal(result.budgetExceeded, true)
    assert.ok(result.escalateReason, "escalate reason 非空")
    assert.match(result.escalateReason!, /max_total_ms|budget_exceeded/)
    assert.ok(result.totalMs >= 5000)
    assert.equal(l5.calls.length, 1)
  })

  it("budget maxTotalMs 触顶：critique 慢响应 → totalMs 超 cap → escalate, budgetExceeded=true", async () => {
    const l5 = recordingLevel5()
    // 用注入的 now() 模拟时间快速流逝
    let fakeMs = 1000
    const slowCritique: CritiqueAgent = {
      async evaluate(input) {
        fakeMs += 3000 // 每次 critique 跳 3s
        if (input.level === 1) return { satisfied: false, nextLevel: 2, reason: "no_l1" }
        return { satisfied: false, nextLevel: 3, reason: "no_l2" }
      },
    }
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "x",
        taskMemoryPack: [hit("stale.md", 0.5)],
        budget: { maxTotalMs: 5000, maxCritiqueCalls: 10 },
      },
      {
        critique: slowCritique,
        level2: stubLevel2([hit("wiki/x.md", 0.5)]),
        level3: stubLevel3(),
        level4: stubLevel4(),
        level5: l5.sink,
        now: () => fakeMs,
      },
    )

    assert.equal(result.recallPath, 5)
    assert.equal(result.budgetExceeded, true)
    // 两次 critique 后 fakeMs 应已经 +6000 超 maxTotalMs=5000
    assert.ok(result.totalMs >= 5000, `totalMs=${result.totalMs} 应 >= 5000`)
    assert.equal(l5.calls.length, 1)
  })

  it("taskMemoryPack 为空：跳过 L1 直接进 L2", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "x",
        // taskMemoryPack 未传
      },
      {
        critique: scriptedCritique({
          byLevel: { 2: { satisfied: true, reason: "l2_covers" } },
        }),
        level2: stubLevel2([hit("wiki/y.md", 0.8)]),
        level3: stubLevel3(),
        level4: stubLevel4(),
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 2)
    assert.equal(result.recallSatisfied, true)
    assert.equal(result.critiqueCalls, 1, "只有 L2 critique 一次")
    assert.equal(result.attempts.length, 1, "L1 因 taskMemoryPack 空被跳过")
    assert.equal(result.attempts[0].level, 2)
  })

  it("Level 4 路径未找到：read_wiki 返 null → 立即 escalate, attempt level=4 satisfied=false", async () => {
    const l5 = recordingLevel5()
    const result = await executeAdaptiveRecall(
      {
        roomId: "R-201",
        alias: "桂芬",
        trigger: "history_keyword",
        query: "x",
        budget: { maxLevels: 4, maxCritiqueCalls: 4 },
      },
      {
        critique: scriptedCritique({
          byLevel: {
            1: { satisfied: false, nextLevel: 2, reason: "no_l1" },
            2: { satisfied: false, nextLevel: 3, reason: "no_l2" },
            3: {
              satisfied: false,
              nextLevel: 4,
              specificPath: "wiki/missing.md",
              reason: "go_l4",
            },
          },
        }),
        level2: stubLevel2([]),
        level3: stubLevel3([]),
        level4: stubLevel4(null), // ← read_wiki 返 null
        level5: l5.sink,
      },
    )

    assert.equal(result.recallPath, 5)
    assert.equal(result.recallSatisfied, false)
    const l4Attempt = result.attempts.find((a) => a.level === 4)
    assert.ok(l4Attempt, "L4 attempt 应存在")
    assert.equal(l4Attempt.satisfied, false)
    assert.equal(l4Attempt.reason, "read_wiki_path_not_found")
    assert.equal(l4Attempt.meta?.path, "wiki/missing.md")
  })
})
