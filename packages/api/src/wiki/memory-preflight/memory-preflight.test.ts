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
import { describe, it } from "node:test"
import { EmbeddingService } from "../../services/embedding-service"
import {
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
  it("空 ctx 只 task_summary 1 query", () => {
    const qs = generateRecallQueries({
      roomId: "R-205",
      alias: "桂芬",
      scenario: "wake_up",
      taskSummary: "F011 drizzle 优化",
    })
    assert.equal(qs.length, 1)
    assert.equal(qs[0].source, "task_summary")
    assert.equal(qs[0].query, "F011 drizzle 优化")
    assert.equal(qs[0].topK, 3)
    assert.equal(qs[0].expectedScoreFloor, 0.6)
  })

  it("4 源都有 → 5 query（cap 上限）", () => {
    const qs = generateRecallQueries({
      roomId: "R-205",
      alias: "桂芬",
      scenario: "wake_up",
      taskSummary: "F011 drizzle",
      capabilityDigestKeywords: ["frontend", "F018", "TranscriptWriter"],
      recentMessageConcepts: ["B022", "redundancy", "fail-closed"],
      unresolvedThreads: ["等范 review", "桂芬补 acceptance", "第三个"],
    })
    // task + capability + recent + 2 unresolved = 5
    assert.equal(qs.length, 5)
    assert.equal(qs[0].source, "task_summary")
    assert.equal(qs[1].source, "capability_digest")
    assert.equal(qs[2].source, "recent_messages")
    assert.equal(qs[3].source, "unresolved_threads")
    assert.equal(qs[4].source, "unresolved_threads")
  })

  it("空白 taskSummary 跳过", () => {
    const qs = generateRecallQueries({
      roomId: "R-1",
      alias: "a",
      scenario: "turn",
      taskSummary: "   ",
      capabilityDigestKeywords: ["frontend"],
    })
    assert.equal(qs.length, 1)
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

  it("token cap 触发 → budget_exceeded + 降级 inspector", () => {
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
    assert.ok(
      out.buckets.rejected.some((r) => r.reason === "token_budget_exceeded"),
      "至少 1 个 reject 原因是 token_budget_exceeded",
    )
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
  it("端到端 happy path", async () => {
    const provider = new FakeProvider({
      "F011 优化": [fakeHit("wiki/concepts/F011.md", 0.92, "drizzle migration safety")],
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
    assert.equal(out.queries.length, 1)
    assert.equal(out.buckets.injected.length, 1)
    assert.equal(out.prompt.hits.length, 1)
    assert.equal(out.prompt.hits[0].path, "wiki/concepts/F011.md")
    assert.ok(out.totalTokens > 0)
    assert.match(out.packMarkdown, /F011\.md/)
  })

  it("search 抛错 → 静默降级到空 hits", async () => {
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

    // ── 断言 2: F011 score > F021 score > B022 score (基础 ranking 对) ──
    const f011 = sorted.find((h) => h.path.includes("F011-backend-hardening-drizzle"))!
    const f021 = sorted.find((h) => h.path.includes("F021-context-window"))
    const b022 = sorted.find((h) => h.path.includes("B022"))
    assert.ok(f011)
    if (f021) {
      assert.ok(
        f011.score > f021.score,
        `F011 (${f011.score.toFixed(3)}) 应高于 F021 (${f021.score.toFixed(3)})`,
      )
    }
    if (b022) {
      assert.ok(
        f011.score > b022.score,
        `F011 (${f011.score.toFixed(3)}) 应高于 B022 (${b022.score.toFixed(3)}) — drizzle vs prompt-injection 语义远`,
      )
    }

    // ── 断言 3: deriveAuditPatch 可写 prompt_audit（schema 字段齐） ─────
    const patch = deriveAuditPatch(out)
    assert.ok(patch.topScore !== null)
    assert.equal(patch.topScore, sorted[0].score)
    assert.ok(patch.recallTotalTokens >= 0)
    const parsedQ = JSON.parse(patch.recallQueries)
    const parsedR = JSON.parse(patch.recallResults)
    assert.equal(parsedQ.length, 1)
    assert.equal(parsedR[0].source, "task_summary")

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
   * 严阈值 fixture：F011 sim ≥ 0.85 + F021 sim ≥ 0.6 + Inspector ≥ 3 项中置信
   * 物理上需 P15 BM25 hybrid + LLM rerank 才能达到（单 vector cosine 中文短 query 顶 ~0.5）
   * 小孙 2026-05-12 拍 B 路径：现在一次干到 P14+P15+P11 严阈值 fixture
   * 待 P15 commit 时把这条转成正式 it() 并断 ≥0.85 / ≥0.6 / ≥3 inspector
   */
  it.todo(
    "(P15 后补) F011 sim ≥ 0.85 + F021 sim ≥ 0.6 + Inspector ≥ 3 项 — 需 BM25 hybrid + LLM rerank",
  )
})
