/**
 * F027 P11 · memory_preflight 端到端测试
 * 真相源：docs/plans/V16.5-final.md chap 10 + chap 12
 *
 * AC-P1-11 ★ 北极星：
 *   桂芬第一次进 R-205 讨论 "F011 drizzle 优化" → 必须命中:
 *     - wiki/concepts/F011-backend-hardening-drizzle.md (sim ≥ 0.85)
 *     - wiki/concepts/F021-context-window-resolver.md (sim ≥ 0.6)
 *   + Inspector 区列出至少 3 项中置信
 *
 * 五层覆盖：
 *   1. generateRecallQueries: rule-based 2-5 query 派生
 *   2. applyQualityGate: floor + dedupe + token cap + 分桶
 *   3. renderTaskMemoryPack: markdown 格式 + 标签 + 区段
 *   4. detectRecallTrigger: deterministic + LLM judge stub
 *   5. AC-P1-11 fixture: InMemoryStub + 真 embedding 端到端命中
 */

import assert from "node:assert/strict"
import { promises as fsAsync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { createDrizzleDb } from "../../db/drizzle-instance"
import * as schema from "../../db/schema"
import { EmbeddingService } from "../../services/embedding-service"
import { WikiEntityFtsProvider } from "../wiki-search/wiki-entity-fts-provider"
import { reindexWikiEntities } from "../wiki-search/wiki-entity-indexer"
import {
  HybridSearchProvider,
  InMemoryWikiSearchProvider,
  applyQualityGate,
  buildWikiEntityRecords,
  conservativeStubJudge,
  deriveAuditPatch,
  detectRecallTrigger,
  generateRecallQueries,
  loadTaskMemoryPack,
  renderTaskMemoryPack,
  toAssemblePromptHits,
} from "./index"
import type {
  RecallHit,
  RecallJudgeProvider,
  RecallQuery,
  RecallResult,
  TaskContext,
  TriggerContext,
  WikiSearchProvider,
} from "./index"

// ─── Fake provider for unit tests（不调真 embedding） ─────────────────

class FakeProvider implements WikiSearchProvider {
  constructor(private hitsByQuery: Record<string, RecallHit[]>) {}
  async search(query: string, opts: { topK: number }) {
    const hits = this.hitsByQuery[query] ?? []
    return hits.slice(0, opts.topK)
  }
}

function fakeHit(path: string, score: number, excerpt = "x".repeat(20)): RecallHit {
  return { path, score, excerpt }
}

// ─────────────────────────────────────────────────────────────────────
// 1. generateRecallQueries
// ─────────────────────────────────────────────────────────────────────

describe("generateRecallQueries", () => {
  it("范-r1 P1-1：只 taskSummary 含 entity ID → 至少 2 query（主 + entity 派生）", () => {
    const qs = generateRecallQueries({
      roomId: "R-205",
      alias: "桂芬",
      scenario: "wake_up",
      taskSummary: "F011 drizzle 优化",
    })
    // V16.5 chap 10 行 1095："生成 2-5 个召回 query"——至少 2 条
    assert.ok(qs.length >= 2, `应至少 2 query (spec 2-5)，实际 ${qs.length}`)
    assert.equal(qs[0].source, "task_summary")
    assert.equal(qs[0].query, "F011 drizzle 优化")
    assert.equal(qs[0].topK, 3)
    assert.equal(qs[0].expectedScoreFloor, 0.6)
    // 第二 query 应是 entity ID 派生（F011 高精度路径召回）
    assert.ok(
      qs.some((q) => q.query.includes("F011") && q !== qs[0]),
      "应有 entity-derived query 含 F011",
    )
  })

  it("范-r1 P1-1：taskSummary 无 entity ID → fallback 用 alias+scenario 补到 2 query", () => {
    const qs = generateRecallQueries({
      roomId: "R-205",
      alias: "桂芬",
      scenario: "wake_up",
      taskSummary: "继续干昨天的事",
    })
    assert.ok(qs.length >= 2, `应 ≥ 2 query (spec)，实际 ${qs.length}`)
    assert.equal(qs[0].source, "task_summary")
    // 第二 query 应是 fallback（room/alias/scenario context 派生）
    assert.notEqual(qs[1].query, qs[0].query)
  })

  it("4 源都有（含 entity ID 派生）→ 5 query（cap 上限，task_summary 系优先）", () => {
    const qs = generateRecallQueries({
      roomId: "R-205",
      alias: "桂芬",
      scenario: "wake_up",
      taskSummary: "F011 drizzle",
      capabilityDigestKeywords: ["frontend", "F018", "TranscriptWriter"],
      recentMessageConcepts: ["B022", "redundancy", "fail-closed"],
      unresolvedThreads: ["等范 review", "桂芬补 acceptance", "第三个"],
    })
    // 范-r1 P1-1 修后：task_summary 主 + task_summary entity 派生 + capability
    //   + recent + 2 unresolved = 6 → cap 5（最后一个 unresolved 截掉）
    assert.equal(qs.length, 5)
    assert.equal(qs[0].source, "task_summary")
    assert.equal(qs[0].query, "F011 drizzle")
    assert.equal(qs[1].source, "task_summary") // entity 派生
    assert.equal(qs[1].query, "F011")
    assert.equal(qs[2].source, "capability_digest")
    assert.equal(qs[3].source, "recent_messages")
    assert.equal(qs[4].source, "unresolved_threads")
  })

  it("空白 taskSummary + 有 capability_digest → 仍补足 ≥ 2 query", () => {
    const qs = generateRecallQueries({
      roomId: "R-1",
      alias: "a",
      scenario: "turn",
      taskSummary: "   ",
      capabilityDigestKeywords: ["frontend"],
    })
    // 范-r1 P1-1: 即使 taskSummary 空也要保证 ≥ 2 query
    assert.ok(qs.length >= 2, `应 ≥ 2 query，实际 ${qs.length}`)
    assert.equal(qs[0].source, "capability_digest")
  })

  it("taskSummary 截 200 char", () => {
    const long = "x".repeat(300)
    const qs = generateRecallQueries({
      roomId: "R-1",
      alias: "a",
      scenario: "wake_up",
      taskSummary: long,
    })
    assert.equal(qs[0].query.length, 200)
  })

  it("maxQueries=2 截短", () => {
    const qs = generateRecallQueries(
      {
        roomId: "R-1",
        alias: "a",
        scenario: "wake_up",
        taskSummary: "T",
        capabilityDigestKeywords: ["c"],
        recentMessageConcepts: ["m"],
        unresolvedThreads: ["u1", "u2"],
      },
      { maxQueries: 2 },
    )
    assert.equal(qs.length, 2)
    assert.equal(qs[0].source, "task_summary")
  })

  it("范-r1 P1-1：多种 entity ID（F/B/R-/D-）都被抽出", () => {
    const qs = generateRecallQueries({
      roomId: "R-205",
      alias: "桂芬",
      scenario: "wake_up",
      taskSummary: "复盘 F011 + B022 + R-201 之前 D-018 决策",
    })
    assert.ok(qs.length >= 2)
    const entityQ = qs.find((q) => q !== qs[0])
    assert.ok(entityQ)
    // 至少含 1 个 entity ID
    assert.match(entityQ.query, /(F011|B022|R-201|D-018)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. applyQualityGate
// ─────────────────────────────────────────────────────────────────────

function mkResult(query: string, hits: RecallHit[]): RecallResult {
  return {
    query: { query, source: "task_summary", expectedScoreFloor: 0.6, topK: 5 },
    hits,
  }
}

describe("applyQualityGate", () => {
  it("score < 0.6 → reject below_floor", () => {
    const out = applyQualityGate([
      mkResult("q", [fakeHit("p1", 0.9), fakeHit("p2", 0.5), fakeHit("p3", 0.3)]),
    ])
    assert.equal(out.buckets.injected.length, 1)
    assert.equal(out.buckets.injected[0].path, "p1")
    assert.equal(out.buckets.rejected.length, 2)
    assert.ok(out.buckets.rejected.every((r) => r.reason === "below_floor"))
  })

  it("0.6 ≤ score < 0.75 → inspectorOnly", () => {
    const out = applyQualityGate([
      mkResult("q", [fakeHit("hi", 0.92), fakeHit("mid", 0.7), fakeHit("low", 0.61)]),
    ])
    assert.equal(out.buckets.injected.length, 1)
    assert.equal(out.buckets.inspectorOnly.length, 2)
    // 排序：高 → 低
    assert.equal(out.buckets.inspectorOnly[0].path, "mid")
  })

  it("同 path 多 query 命中 → 保留最高分", () => {
    const out = applyQualityGate([
      mkResult("q1", [fakeHit("F011.md", 0.7)]),
      mkResult("q2", [fakeHit("F011.md", 0.92)]),
      mkResult("q3", [fakeHit("F011.md", 0.8)]),
    ])
    assert.equal(out.buckets.injected.length, 1)
    assert.equal(out.buckets.injected[0].score, 0.92)
    // 0.7 + 0.8 被 reject
    const dupCount = out.buckets.rejected.filter((r) => r.reason === "duplicate_source").length
    assert.equal(dupCount, 2)
  })

  it("范-r1 P2-1：token cap 触发 → budget_exceeded + 单一状态降级 inspector（不重复进 rejected）", () => {
    // 默认 estimateTokens = len/4，excerpt 长 800 → 200 tok / hit
    const longExcerpt = "x".repeat(800)
    const out = applyQualityGate(
      [
        mkResult("q", [
          fakeHit("a", 0.95, longExcerpt),
          fakeHit("b", 0.9, longExcerpt),
          fakeHit("c", 0.85, longExcerpt),
          fakeHit("d", 0.8, longExcerpt),
          fakeHit("e", 0.76, longExcerpt),
          fakeHit("f", 0.75, longExcerpt),
          fakeHit("g", 0.75, longExcerpt),
          fakeHit("h", 0.75, longExcerpt),
        ]),
      ],
      { totalTokenCap: 700 }, // 200 * 3 = 600 OK，第 4 个 800 超
    )
    assert.ok(out.budgetExceeded, "应标 budgetExceeded")
    assert.ok(out.buckets.injected.length < 8, "至少一部分降级到 inspector")
    // 范-r1 P2-1: rejected 只承担"真丢弃"（below_floor + duplicate_source），
    // 不再含 token_budget_exceeded（已改用单一状态降级 inspector）
    for (const r of out.buckets.rejected) {
      assert.ok(
        r.reason === "below_floor" || r.reason === "duplicate_source",
        `rejected.reason 仅允许 below_floor / duplicate_source，实际 ${r.reason}`,
      )
    }
    // 超 cap 的 hit 进 inspectorOnly + score >= injectFloor → "未注入的高置信"
    const highInInspector = out.buckets.inspectorOnly.filter((h) => h.score >= 0.75)
    assert.ok(highInInspector.length >= 1, "至少 1 个高置信 hit 因 token cap 降级到 inspector")
    // 同一 hit 不应同时在两个 bucket
    const injectedPaths = new Set(out.buckets.injected.map((h) => h.path))
    const inspectorPaths = new Set(out.buckets.inspectorOnly.map((h) => h.path))
    for (const p of injectedPaths) {
      assert.ok(!inspectorPaths.has(p), `path ${p} 不应同时在 injected + inspector`)
    }
  })

  it("自定义 scoreFloor / injectFloor", () => {
    const out = applyQualityGate(
      [mkResult("q", [fakeHit("a", 0.5), fakeHit("b", 0.65), fakeHit("c", 0.95)])],
      { scoreFloor: 0.4, injectFloor: 0.6 },
    )
    assert.equal(out.buckets.injected.length, 2) // 0.65 + 0.95
    assert.equal(out.buckets.inspectorOnly.length, 1) // 0.5 inspector? No, < injectFloor=0.6
    // 0.5 ≥ scoreFloor=0.4 但 < 0.6 → inspectorOnly
    assert.equal(out.buckets.inspectorOnly[0].score, 0.5)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. renderTaskMemoryPack
// ─────────────────────────────────────────────────────────────────────

describe("renderTaskMemoryPack", () => {
  it("基础 markdown 含 4 段（header / query / hits / footer）", () => {
    const queries: RecallQuery[] = [
      { query: "F011 drizzle", source: "task_summary", expectedScoreFloor: 0.6, topK: 2 },
    ]
    const results: RecallResult[] = [
      mkResult("F011 drizzle", [
        fakeHit("wiki/concepts/F011.md", 0.92, "drizzle migration safety..."),
      ]),
    ]
    const buckets = {
      injected: [fakeHit("wiki/concepts/F011.md", 0.92, "drizzle migration safety...")],
      inspectorOnly: [],
      rejected: [],
    }
    const md = renderTaskMemoryPack(queries, results, buckets, "wake_up")
    assert.match(md, /## 自动召回（memory_preflight）/)
    assert.match(md, /wake-up/)
    assert.match(md, /\*\*Query 1\*\*: "F011 drizzle"/)
    assert.match(md, /wiki\/concepts\/F011\.md/)
    assert.match(md, /\[injected\]/)
    assert.match(md, /主动深挖：read_wiki/)
  })

  it("inspectorOnly + rejected 都标记", () => {
    const queries: RecallQuery[] = [
      { query: "q", source: "task_summary", expectedScoreFloor: 0.6, topK: 5 },
    ]
    const results: RecallResult[] = [
      mkResult("q", [fakeHit("hi", 0.95), fakeHit("mid", 0.7), fakeHit("low", 0.4)]),
    ]
    const buckets = {
      injected: [fakeHit("hi", 0.95)],
      inspectorOnly: [fakeHit("mid", 0.7)],
      rejected: [{ hit: fakeHit("low", 0.4), reason: "below_floor" as const }],
    }
    const md = renderTaskMemoryPack(queries, results, buckets, "a2a_handoff")
    assert.match(md, /\[injected\]/)
    assert.match(md, /\[inspector-only\]/)
    assert.match(md, /\[rejected\]/)
    assert.match(md, /1 hit 被 Quality Gate reject/)
    assert.match(md, /A2A handoff/)
  })

  it("query 含换行 escape 成单行", () => {
    const queries: RecallQuery[] = [
      {
        query: "line1\nline2\rline3",
        source: "task_summary",
        expectedScoreFloor: 0.6,
        topK: 1,
      },
    ]
    const md = renderTaskMemoryPack(
      queries,
      [],
      { injected: [], inspectorOnly: [], rejected: [] },
      "wake_up",
    )
    assert.ok(!md.includes("line1\nline2"), "原始换行不应保留在 query 行")
    assert.match(md, /line1 line2 line3/)
  })

  it("toAssemblePromptHits 形状 match context-assembler", () => {
    const h = toAssemblePromptHits(fakeHit("p", 0.9, "excerpt"))
    assert.deepEqual(h, { score: 0.9, summary: "excerpt", path: "p" })
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. detectRecallTrigger (Hard Gate)
// ─────────────────────────────────────────────────────────────────────

describe("detectRecallTrigger", () => {
  it("scenario=a2a_handoff → required deterministic", async () => {
    const t = await detectRecallTrigger({ scenario: "a2a_handoff" }, null)
    assert.equal(t.required, true)
    assert.equal(t.trigger, "a2a_handoff")
    assert.equal(t.source, "deterministic")
  })

  it("scenario=session_bootstrap → required deterministic", async () => {
    const t = await detectRecallTrigger({ scenario: "session_bootstrap" }, null)
    assert.equal(t.required, true)
    assert.equal(t.trigger, "session_bootstrap")
  })

  it("draft 含 '修改 plan' → required modify_plan_or_wiki", async () => {
    const t = await detectRecallTrigger(
      { scenario: "turn", draft: "我要修改 plan 中的 P11 优先级" },
      null,
    )
    assert.equal(t.required, true)
    assert.equal(t.trigger, "modify_plan_or_wiki")
  })

  it("draft 含 'review 一下' → required review_action", async () => {
    const t = await detectRecallTrigger(
      { scenario: "turn", draft: "麻烦 review 一下我这个 PR" },
      null,
    )
    assert.equal(t.required, true)
    assert.equal(t.trigger, "review_action")
  })

  it("范-r1 P1-2：中文 '审核' 命中 review_action（不依赖英文 \\b 边界）", async () => {
    const t = await detectRecallTrigger({ scenario: "turn", draft: "麻烦审核一下我这个 PR" }, null)
    assert.equal(t.required, true)
    assert.equal(t.trigger, "review_action")
  })

  it("范-r1 P1-2：中文 '过一眼' 命中 review_action", async () => {
    const t = await detectRecallTrigger({ scenario: "turn", draft: "帮我过一眼这段代码" }, null)
    assert.equal(t.required, true)
    assert.equal(t.trigger, "review_action")
  })

  it("范-r1 P3-2：已 cite + modify_wiki 共存 → modify_wiki 优先级最高 required", async () => {
    // spec V16.5 chap 12 行 1374 + 1376："修改 plan / wiki" 是顶级 trigger，
    // evidence_already_cited 只豁免"引用历史"类。共存时 modify_wiki 应胜出。
    const t = await detectRecallTrigger(
      {
        scenario: "turn",
        draft: "我要修改 plan 中的 P11 优先级",
        citedMessageIds: ["msg_123"],
      },
      null,
    )
    assert.equal(t.required, true)
    assert.equal(t.trigger, "modify_plan_or_wiki")
  })

  it("已 cite message_id → evidence_already_cited not required", async () => {
    const t = await detectRecallTrigger(
      {
        scenario: "turn",
        draft: "之前我们说过这个",
        citedMessageIds: ["msg_123"],
      },
      null,
    )
    assert.equal(t.required, false)
    assert.equal(t.trigger, "evidence_already_cited")
  })

  it("draft 含 '之前' 无 judge → 保守 required", async () => {
    const t = await detectRecallTrigger({ scenario: "turn", draft: "之前我们好像决定过这个" }, null)
    assert.equal(t.required, true)
    assert.equal(t.trigger, "history_keyword_no_judge")
    assert.equal(t.source, "none")
  })

  it("draft 含 '已决定' + judge → 走 LLM judge", async () => {
    const judge: RecallJudgeProvider = {
      async judge({ draft }) {
        return { required: false, reason: `judge_says_no (len=${draft.length})` }
      },
    }
    const t = await detectRecallTrigger({ scenario: "turn", draft: "上次已决定 X 方案" }, judge)
    assert.equal(t.required, false)
    assert.equal(t.source, "llm_judge")
    assert.match(t.trigger, /judge_says_no/)
  })

  it("turn-local 闲聊 → not required turn_local", async () => {
    const t = await detectRecallTrigger({ scenario: "turn", draft: "1+1 等于几" }, null)
    assert.equal(t.required, false)
    assert.equal(t.trigger, "turn_local")
  })

  it("conservativeStubJudge 永远 required=true", async () => {
    const r = await conservativeStubJudge.judge({
      draft: "test",
      context: { scenario: "turn" },
    })
    assert.equal(r.required, true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. loadTaskMemoryPack + InMemoryWikiSearchProvider 单元
// ─────────────────────────────────────────────────────────────────────

describe("loadTaskMemoryPack with FakeProvider", () => {
  it("端到端 happy path（taskSummary 含 entity ID → 2 query 都返同一 hit）", async () => {
    // 范-r1 P1-1 修后：taskSummary "F011 优化" 抽 entity → 第二 query "F011"
    // 两 query 都返同 path → quality-gate dedup 保留最高分
    const provider = new FakeProvider({
      "F011 优化": [fakeHit("wiki/concepts/F011.md", 0.92, "drizzle migration safety")],
      F011: [fakeHit("wiki/concepts/F011.md", 0.95, "drizzle migration safety")],
    })
    const out = await loadTaskMemoryPack(
      {
        roomId: "R-205",
        alias: "桂芬",
        scenario: "wake_up",
        taskSummary: "F011 优化",
      },
      { search: provider },
    )
    assert.equal(out.queries.length, 2) // 主 + entity 派生
    assert.equal(out.buckets.injected.length, 1) // dedup 后保留最高分 0.95
    assert.equal(out.buckets.injected[0].score, 0.95)
    assert.equal(out.prompt.hits[0].path, "wiki/concepts/F011.md")
    assert.ok(out.totalTokens > 0)
    assert.match(out.packMarkdown, /F011\.md/)
  })

  it("search 抛错 → fail-soft 空 hits", async () => {
    const provider: WikiSearchProvider = {
      async search() {
        throw new Error("model down")
      },
    }
    const out = await loadTaskMemoryPack(
      {
        roomId: "R",
        alias: "a",
        scenario: "wake_up",
        taskSummary: "anything",
      },
      { search: provider },
    )
    assert.equal(out.results[0].hits.length, 0)
    assert.equal(out.buckets.injected.length, 0)
  })

  it("范-r1 P2-2：search 抛错时 logger.warn 被调用（防 backend 整体挂掉静默）", async () => {
    const provider: WikiSearchProvider = {
      async search() {
        throw new Error("xenova model load failed")
      },
    }
    const warnCalls: Array<{ obj: unknown; msg?: string }> = []
    const logger = {
      warn(obj: unknown, msg?: string) {
        warnCalls.push({ obj, msg })
      },
    }
    await loadTaskMemoryPack(
      { roomId: "R", alias: "a", scenario: "wake_up", taskSummary: "F011 优化" },
      { search: provider, logger },
    )
    // 2 query (主 + entity) 都 fail → 2 warn
    assert.ok(warnCalls.length >= 1, "应至少 1 warn")
    assert.match(warnCalls[0].msg ?? "", /memory_preflight search.*失败/)
    const obj = warnCalls[0].obj as Record<string, unknown>
    assert.equal(obj.stage, "memory_preflight.search")
    assert.ok((obj.err as { message: string }).message.includes("xenova"))
  })

  it("deriveAuditPatch 输出可 JSON.parse + 字段齐全", async () => {
    const provider = new FakeProvider({
      F011: [fakeHit("p1", 0.9, "exc1"), fakeHit("p2", 0.7, "exc2")],
    })
    const out = await loadTaskMemoryPack(
      { roomId: "R", alias: "a", scenario: "wake_up", taskSummary: "F011" },
      { search: provider },
    )
    const patch = deriveAuditPatch(out)
    assert.ok(JSON.parse(patch.recallQueries).length >= 1)
    assert.ok(JSON.parse(patch.recallResults)[0].hits.length === 2)
    assert.equal(patch.topScore, 0.9)
    assert.equal(patch.recallBudgetExceeded, 0)
    assert.equal(typeof patch.recallTotalTokens, "number")
  })
})

// ─────────────────────────────────────────────────────────────────────
// 6a. InMemoryWikiSearchProvider 维度/NaN 防御（范-r1 P2-3）
// ─────────────────────────────────────────────────────────────────────

describe("InMemoryWikiSearchProvider 范-r1 P2-3 维度/NaN 防御", () => {
  it("不同维度向量 → 该 record 跳过（不漏 NaN 进 buckets）", async () => {
    const records = [
      { path: "p1.md", body: "body 1", embedding: [1, 0, 0] }, // 3-dim
      { path: "p2.md", body: "body 2", embedding: [1, 0] }, // 2-dim 错维
      { path: "p3.md", body: "body 3", embedding: [0.5, 0.5, 0.7] }, // 3-dim OK
    ]
    // generator 总返 3-dim
    const provider = new InMemoryWikiSearchProvider(records, async () => [1, 0, 0])
    const hits = await provider.search("q", { topK: 10 })
    assert.equal(hits.length, 2, `跳过 p2 (2-dim) 后应剩 2 hit，实际 ${hits.length}`)
    assert.ok(!hits.some((h) => h.path === "p2.md"))
    for (const h of hits) assert.ok(Number.isFinite(h.score))
  })

  it("空向量 / generator 返 null → 跳过 + 空结果", async () => {
    const records = [{ path: "p1.md", body: "b", embedding: [] }]
    const provider = new InMemoryWikiSearchProvider(records, async () => [1, 0, 0])
    const hits1 = await provider.search("q", { topK: 5 })
    assert.equal(hits1.length, 0)

    const provider2 = new InMemoryWikiSearchProvider(
      [{ path: "p1.md", body: "b", embedding: [1, 0, 0] }],
      async () => null,
    )
    const hits2 = await provider2.search("q", { topK: 5 })
    assert.equal(hits2.length, 0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 6. AC-P1-11 ★ 北极星 fixture
//    P11.a baseline（本 commit 通过）：F011 排首位 + Quality Gate 全字段对
//    P11.b 严阈值 ≥0.85/≥0.6（P15 BM25 hybrid + LLM rerank 后补）— it.todo
//    小孙 2026-05-12 拍：B 路径 = 一次干到 P14+P15+P11 严阈值 fixture
// ─────────────────────────────────────────────────────────────────────

describe("AC-P1-11 ★ 北极星 baseline (P11.a)：桂芬进 R-205 自动召回 F011", () => {
  it("F011 drizzle 优化 query → F011 排首位 + Quality Gate 输出齐", async () => {
    // 真 embedding（Xenova all-MiniLM-L6-v2 q8）— B019 已修，离线 OK
    const embed = new EmbeddingService()
    const ok = await embed.ensureModel()
    if (!ok) {
      // 模型不可用时 skip（开发环境兜底）— Phase 1 evidence pack 跑时必须可用
      console.warn("AC-P1-11: embedding model unavailable, skipping fixture (CI 必须可用)")
      return
    }

    // 用 F011/F021 真实 wiki 实体 body 概要（短 representative 段，模拟 wiki entity compile 后）
    const raw = [
      {
        path: "wiki/concepts/F011-backend-hardening-drizzle.md",
        body: "F011 drizzle 优化 backend hardening. drizzle migration safety + backfill 安全策略, 把 SELECT max + INSERT 包在 db.transaction 防 TOCTOU. BEGIN IMMEDIATE 锁串行写. drizzle better-sqlite3 driver wrapper.immediate. 优化 query 改 prepared statement 防 sql injection 同时减 plan parse 开销。",
      },
      {
        path: "wiki/concepts/F021-context-window-resolver.md",
        body: "F021 上下文窗口 / Seal 阈值齿轮可配 + fillRatio 实时观测 + seal 感知. context window resolver 动态调整 prompt token 预算. seal 阈值由 config 控制 + 实时 metrics 输出. 与 F018 ThreadMemory rolling summary 集成.",
      },
      {
        path: "wiki/concepts/F018-session-bootstrap.md",
        body: "F018 SessionBootstrap 续接逻辑. ThreadMemory rolling summary + 7 entries prelude. 新 session 注入 reference-only 上下文.",
      },
      {
        path: "wiki/bugReport/B022-prompt-injection-redundancy.md",
        body: "B022 prompt 注入四源冗余 + L0_DIGEST drift. fail-closed 防御.",
      },
      {
        path: "wiki/concepts/F004-prompt-assembly.md",
        body: "F004 assemblePrompt 统一注入合约. 5 reference-only section: viewfinder / recall-pack / handbook / collaboration-contract / capability-digest.",
      },
    ]
    const records = await buildWikiEntityRecords(raw, (t) => embed.generateEmbedding(t))
    assert.ok(records.length >= 3, "至少 3 个 record 嵌入成功（embedding pipeline 可用）")

    const provider = new InMemoryWikiSearchProvider(records, (t) => embed.generateEmbedding(t))

    // 关键：P11.a baseline 用 scoreFloor=0 接受所有 hit，验证 ranking 逻辑；
    // 严阈值 (≥0.85 inject / ≥0.6 inspector) 物理上需 P15 BM25 hybrid 才能达
    const out = await loadTaskMemoryPack(
      {
        roomId: "R-205",
        alias: "桂芬",
        scenario: "wake_up",
        taskSummary: "F011 drizzle 优化",
      },
      { search: provider },
      { gate: { scoreFloor: 0, injectFloor: 0 } }, // baseline: 看 ranking 不看绝对分
    )

    // ── 断言 1: F011 排首位（task_summary 语义最相关） ───────────────────
    const sorted = [...out.buckets.injected, ...out.buckets.inspectorOnly].sort(
      (a, b) => b.score - a.score,
    )
    assert.ok(sorted.length >= 3, `应至少 3 hit 进 buckets，实际 ${sorted.length}`)
    assert.match(
      sorted[0].path,
      /F011-backend-hardening-drizzle/,
      `F011 应排首位 (task_summary 最相关)，实际首位=${sorted[0].path} score=${sorted[0].score.toFixed(3)}`,
    )

    // ── 断言 2: 严格 F011 > F021 > B022 ranking（范-r1 P1-3 修） ──
    const f011 = sorted.find((h) => h.path.includes("F011-backend-hardening-drizzle"))!
    const f021 = sorted.find((h) => h.path.includes("F021-context-window"))
    const b022 = sorted.find((h) => h.path.includes("B022"))
    assert.ok(f011)
    assert.ok(f021, `F021 应进 buckets，实际 sorted=${sorted.map((h) => h.path).join(",")}`)
    assert.ok(b022, `B022 应进 buckets，实际 sorted=${sorted.map((h) => h.path).join(",")}`)
    assert.ok(
      f011.score > f021.score,
      `F011 (${f011.score.toFixed(3)}) 应高于 F021 (${f021.score.toFixed(3)}) — 任务主题 drizzle 直接匹配`,
    )
    assert.ok(
      f021.score > b022.score,
      `F021 (${f021.score.toFixed(3)}) 应高于 B022 (${b022.score.toFixed(3)}) — F-series 设计文档 vs bug 报告语义远`,
    )
    assert.ok(
      f011.score > b022.score,
      `F011 (${f011.score.toFixed(3)}) 应高于 B022 (${b022.score.toFixed(3)})`,
    )

    // ── 断言 3: deriveAuditPatch 可写 prompt_audit（schema 字段齐） ─────
    const patch = deriveAuditPatch(out)
    assert.ok(patch.topScore !== null)
    assert.equal(patch.topScore, sorted[0].score)
    assert.ok(patch.recallTotalTokens >= 0)
    const parsedQ = JSON.parse(patch.recallQueries)
    const parsedR = JSON.parse(patch.recallResults)
    // 范-r1 P1-1 修后：taskSummary "F011 drizzle 优化" 抽 entity → 2 query
    assert.equal(parsedQ.length, 2)
    assert.equal(parsedR[0].source, "task_summary")
    assert.equal(parsedR[1].source, "task_summary") // entity-derived

    // ── 断言 4: packMarkdown 含 F011 ───────────────────────────────────
    assert.match(out.packMarkdown, /F011/)

    // ── 断言 5: prompt.hits 形状 match assemblePrompt input.memoryPreflight ──
    for (const h of out.prompt.hits) {
      assert.equal(typeof h.score, "number")
      assert.equal(typeof h.summary, "string")
      assert.equal(typeof h.path, "string")
    }
  })

  /**
   * P11.b 弱阈值 fixture：HybridSearchProvider 召回功能验证（命中 + 排序）
   *
   * 实现路径：HybridSearchProvider = WikiEntityFtsProvider (BM25) + EmbeddingService
   * (cosine sim) + LLMReranker (Phase 1 NoopReranker)。hybrid score = max(bm25_norm, cosine_sim)
   * —— 任一信号强即认为相关。
   *
   * 验收边界（范-P11.b r1 拍 + 小孙 2026-05-13 拍）：
   *   本测试只验"hybrid 召回功能成立"（F011/F021 命中 + 排序）。AC-P1-11 严阈值
   *   (sim ≥ 0.85 + Inspector ≥ 3) 物理依赖 Phase 2 真 LLM rerank confidence
   *   score —— Phase 1 NoopReranker 透传时 hybrid_score 同时承担 ranking + gate
   *   双职责，BM25 rank 0 永远拿 1.0，inspector 中段 (0.6-0.85) 几乎不可达；
   *   严阈值 it.todo 等 Phase 2 接真 LLM 转正（plan chap 12 行 1403 "BM25 + LLM rerank"
   *   原意：confidence score 从 LLM rerank 输出，不是 BM25 rank/cosine sim 直接派生）。
   */
  it("(P11.b) HybridSearchProvider 召回功能：F011 排首位 + F021 进 buckets", async () => {
    // 真 embedding（Xenova all-MiniLM-L6-v2 q8）+ 真 BM25 (SQLite FTS5 trigram)
    const embed = new EmbeddingService()
    const ok = await embed.ensureModel()
    if (!ok) {
      console.warn("AC-P1-11 严阈值: embedding model unavailable, skipping (CI 必须可用)")
      return
    }

    // Setup: temp DB + temp wiki/ → reindex → wiki_entity_index 填好 → BM25 ready
    const dbDir = mkdtempSync(path.join(tmpdir(), "p11b-strict-db-"))
    const fsRoot = mkdtempSync(path.join(tmpdir(), "p11b-strict-fs-"))
    const dbPath = path.join(dbDir, "test.sqlite")

    try {
      const fixture: { relPath: string; body: string }[] = [
        {
          relPath: "concepts/F011-backend-hardening-drizzle.md",
          body: "F011 drizzle 优化 backend hardening. drizzle migration safety + backfill 安全策略, 把 SELECT max + INSERT 包在 db.transaction 防 TOCTOU. BEGIN IMMEDIATE 锁串行写. drizzle better-sqlite3 driver wrapper.immediate. 优化 query 改 prepared statement 防 sql injection 同时减 plan parse 开销。",
        },
        {
          relPath: "concepts/F021-context-window-resolver.md",
          body: "F021 上下文窗口 / Seal 阈值齿轮可配 + fillRatio 实时观测 + seal 感知. context window resolver 动态调整 prompt token 预算. seal 阈值由 config 控制 + 实时 metrics 输出. 与 F018 ThreadMemory rolling summary 集成. drizzle 配置兼容.",
        },
        {
          relPath: "concepts/F018-session-bootstrap.md",
          body: "F018 SessionBootstrap 续接逻辑. ThreadMemory rolling summary + 7 entries prelude. 新 session 注入 reference-only 上下文. drizzle 持久化 thread_memory 字段.",
        },
        {
          relPath: "bugReport/B022-prompt-injection-redundancy.md",
          body: "B022 prompt 注入四源冗余 + L0_DIGEST drift. fail-closed 防御. F011 backend 注入合约关联.",
        },
        {
          relPath: "concepts/F004-prompt-assembly.md",
          body: "F004 assemblePrompt 统一注入合约. 5 reference-only section: viewfinder / recall-pack / handbook / collaboration-contract / capability-digest.",
        },
      ]

      for (const ent of fixture) {
        const abs = path.join(fsRoot, "wiki", ent.relPath)
        await fsAsync.mkdir(path.dirname(abs), { recursive: true })
        await fsAsync.writeFile(abs, ent.body, "utf8")
      }

      const { raw, close } = createDrizzleDb(dbPath)
      const drizzleDb = drizzleBetter(raw as never, { schema })
      try {
        await reindexWikiEntities({ wikiRoot: fsRoot, db: drizzleDb })

        // 预生成 entity body embedding（HybridProvider lookup 用）
        const records = await buildWikiEntityRecords(
          fixture.map((f) => ({ path: `wiki/${f.relPath}`, body: f.body })),
          (t) => embed.generateEmbedding(t),
        )
        assert.ok(records.length === fixture.length, "全部 entity embedding 成功")

        const bm25 = new WikiEntityFtsProvider(drizzleDb)
        const hybrid = new HybridSearchProvider(bm25, records, (t) => embed.generateEmbedding(t))

        const out = await loadTaskMemoryPack(
          {
            roomId: "R-205",
            alias: "桂芬",
            scenario: "wake_up",
            taskSummary: "F011 drizzle 优化",
            // 注入 multi-source 让 generateRecallQueries 出多 query 增加召回
            capabilityDigestKeywords: ["前端", "F018", "TranscriptWriter"],
            recentMessageConcepts: ["context window", "seal 阈值"],
          },
          { search: hybrid },
          // 默认 quality gate 阈值（plan chap 10 行 1146-1150：≥0.75 inject / ≥0.6 inspector）
        )

        // ── 输出 score 分布给 debugging + 后续 Phase 2 转正阈值参考 ──
        const allHits = [...out.buckets.injected, ...out.buckets.inspectorOnly]
          .map((h) => `${h.path.split("/").pop()} = ${h.score.toFixed(3)}`)
          .join(", ")
        const rejectedSummary = out.buckets.rejected
          .map((r) => `${r.hit.path.split("/").pop()} (${r.reason})`)
          .join(", ")
        process.stderr.write(
          `\n[P11.b weak] injected=${out.buckets.injected.length} inspector=${out.buckets.inspectorOnly.length} rejected=${out.buckets.rejected.length}\n` +
            `[P11.b weak] all hits: ${allHits}\n[P11.b weak] rejected: ${rejectedSummary}\n`,
        )

        // ── 断言 1: F011 必须命中（任一 bucket）────────────────────────
        const f011 =
          out.buckets.injected.find((h) => h.path.includes("F011-backend-hardening")) ??
          out.buckets.inspectorOnly.find((h) => h.path.includes("F011-backend-hardening"))
        assert.ok(
          f011,
          `F011 必须召回（hybrid backend 工作）。实际 injected=${out.buckets.injected.map((h) => h.path).join(",")} inspector=${out.buckets.inspectorOnly.map((h) => h.path).join(",")}`,
        )

        // ── 断言 2: F021 必须命中（任一 bucket）────────────────────────
        const f021 =
          out.buckets.injected.find((h) => h.path.includes("F021-context-window")) ??
          out.buckets.inspectorOnly.find((h) => h.path.includes("F021-context-window"))
        assert.ok(
          f021,
          `F021 必须召回（multi-query recent_messages 路径）。实际 injected=${out.buckets.injected.map((h) => h.path).join(",")} inspector=${out.buckets.inspectorOnly.map((h) => h.path).join(",")}`,
        )

        // ── 断言 3: F011 score ≥ F021 score（task_summary 主 query 排序优先）──
        assert.ok(
          f011.score >= f021.score,
          `F011 (${f011.score.toFixed(3)}) 应 ≥ F021 (${f021.score.toFixed(3)}) — 主 query 'F011 drizzle 优化' 直接对应 F011`,
        )

        // ── 断言 4: 总召回 ≥ 2（hybrid backend 真返回结果，非空）──────
        const totalRecalled = out.buckets.injected.length + out.buckets.inspectorOnly.length
        assert.ok(totalRecalled >= 2, `总召回应 ≥ 2，实际 ${totalRecalled}`)
      } finally {
        close()
      }
    } finally {
      rmSync(dbDir, { recursive: true, force: true })
      rmSync(fsRoot, { recursive: true, force: true })
    }
  })

  /**
   * 范-P11.b r2 Q2 锁住测试：cosine 路径真生效（max 融合不退化为纯 BM25）
   *
   * 弱 e2e AC 锁不住 "hybrid 算法"——纯 BM25 也能让 F011/F021 命中。本 unit test 用
   * mock BM25 + 固定 embedding 向量直接锁 HybridSearchProvider.search 的 max 融合行为：
   *
   *   - mock BM25 返回 candidate (path A, score=0.1) — 模拟 BM25 弱命中
   *   - 预生成 record A 的 embedding = [1, 0, 0, ...]
   *   - mock query embedding = [1, 0, 0, ...] — cosine sim = 1.0
   *
   * 期望：hybrid score = max(0.1, 1.0) = 1.0；如果实现退化为纯 BM25 用 cand.score，
   * 输出会是 0.1 → 测试红。
   */
  it("(P11.b 范-r2 Q2) cosine 路径锁住：max 融合让 BM25 弱命中 entity 被 cosine 拉高", async () => {
    // mock 一个固定向量 embedding generator —— 不依赖真 model
    const fixedVec = [1, 0, 0, 0, 0]
    const mockQueryEmbed = async () => fixedVec

    // mock BM25 candidate provider：返回 path A，score 故意低（0.1）
    const mockBM25: import("./hybrid-search-provider").BM25CandidateProvider = {
      async search() {
        return [{ path: "wiki/concepts/A.md", score: 0.1, excerpt: "A excerpt" }]
      },
    }

    // entity A 的 embedding 与 query embedding 一致 → cosine sim = 1.0
    const records = [{ path: "wiki/concepts/A.md", body: "A body content", embedding: fixedVec }]

    const hybrid = new HybridSearchProvider(mockBM25, records, mockQueryEmbed)
    const hits = await hybrid.search("any query string", { topK: 5 })

    process.stderr.write(
      `\n[P11.b cosine-lock] mocked hits = ${hits.map((h) => `${h.path.split("/").pop()}=${h.score.toFixed(3)}`).join(", ")}\n`,
    )

    assert.equal(hits.length, 1)
    assert.equal(hits[0].path, "wiki/concepts/A.md")
    // 断言：max(BM25 0.1, cosine 1.0) = 1.0；如果退化为纯 BM25，hits[0].score 会是 0.1
    assert.ok(
      hits[0].score >= 0.99,
      `hybrid score=${hits[0].score.toFixed(3)} 应 ≥ 0.99 (cosine sim=1.0 拉高)；如果是 ~0.1 说明 max 融合退化为纯 BM25`,
    )
  })

  /**
   * AC-P1-11 严阈值 it.todo —— 等 Phase 2 真 LLM rerank confidence score 转正
   *
   * 物理依赖（范-P11.b r1 拍）：plan chap 12 行 1403 "Level 2: search_wiki ← BM25 +
   * LLM rerank" 原意是 confidence score 来源 = LLM rerank 输出，不是 BM25 corpus-内
   * normalize 或 cosine 绝对值。Phase 1 NoopReranker 透传时：
   *   - hybrid_score = max(bm25_norm, cosine_sim) 同时承担 ranking + gate 双职责
   *   - BM25 query 内 rank 0 永远 1.0 → 命中 entity 全 inject，inspector 中段空
   *   - cosine sim 中文短 query 顶 ~0.5（Xenova all-MiniLM-L6-v2 q8 物理限制）
   *
   * Phase 2 接真 LLM rerank 后（范-r2 Q4 修：原"自然落区间"是过度承诺）：
   *   - rerank 输出 confidence —— **默认未校准**（数字自评、logits、cross-encoder
   *     分都不天然等价概率，不一定落 plan [0.6, 0.85) 区间）
   *   - hybrid 排序 = max(bm25, cosine) 仍用作 ranking
   *   - gate 用 rerank confidence，**必须配 prompt schema + fixture 校准集 + 阈值
   *     回归测试**，确认落 plan 阈值区间后才转正
   *
   * Phase 2 类型层 follow-up（范-r2 Q1）：
   *   分离 ranking score (rankScore = max hybrid) vs gate score (gateScore = rerank
   *   confidence)。择一：
   *     a) 扩 RecallHit 加 rankScore + gateScore 两字段
   *     b) 严格定义 reranker 覆写 score 后 score === gate confidence，文档化契约
   *
   * 不改 plan AC 阈值（0.85/0.6/inspector ≥ 3）—— 范说"plan 隐含的是可校准置信度，
   * 直接改成 ≥1 是验收漂移"。
   */
  it.todo(
    "(Phase 2 后补) F011 gate confidence ≥ 0.85 + F021 ≥ 0.6 + Inspector ≥ 3 — 需真 LLM rerank confidence + 校准 fixture",
  )
})
