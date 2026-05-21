/**
 * F027 Phase 3 P20 · PromptInspectorService tests — Week 1 Day 4
 *
 * 覆盖：
 *   - 表无 row → empty arrays + recallState defaults
 *   - parts_json 多种 schema 容忍（name/bytes/tokens vs kind/byteLength/tokenCount）
 *   - recall_queries + recall_results index 对齐 + gate 三段（high/mid/low）
 *   - recall_required / recall_path / recall_satisfied / escalate_reason 解析
 *   - recall_trigger 'a2a_call=X' / 'user_msg=Y' / 'scheduler_tick' 解析
 *   - scenario 兜底（无 recall_trigger 时）
 *   - 损坏 JSON 容忍 → 空数组而非抛
 *   - 不同 room 隔离 + 取最新一行
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { PromptInspectorService } from "./prompt-inspector"

function safeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, prefix))
}
function safeCleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

interface InsertAuditOpts {
  roomId: string
  alias?: string
  scenario?: string
  partsJson?: string
  recallQueries?: string | null
  recallResults?: string | null
  recallRequired?: number
  recallTrigger?: string | null
  recallPath?: number | null
  recallSatisfied?: number
  escalateReason?: string | null
  recallTotalTokens?: number | null
  ironLawsCount?: number
}

function insertAudit(
  db: ReturnType<typeof createDrizzleDb>["db"],
  opts: InsertAuditOpts,
): number {
  const client = (
    db as unknown as {
      $client: {
        prepare: (sql: string) => {
          run: (...args: unknown[]) => { lastInsertRowid: number | bigint }
        }
      }
    }
  ).$client
  const result = client
    .prepare(
      `INSERT INTO prompt_audit (
        created_at, alias, room_id, scenario,
        total_tokens, cap, parts_json, not_injected_json, iron_laws_count,
        raw_text, source_event_ids,
        recall_queries, recall_results, recall_total_tokens, recall_rejected_reasons,
        recall_required, recall_trigger, recall_path, top_score, recall_satisfied,
        escalate_reason, recall_total_ms, recall_critique_calls, recall_budget_exceeded,
        agent_session_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      opts.alias ?? "黄仁勋",
      opts.roomId,
      opts.scenario ?? "wake-up.a2a",
      1000,
      8000,
      opts.partsJson ?? "[]",
      null,
      opts.ironLawsCount ?? 1,
      "raw prompt text",
      null,
      opts.recallQueries ?? null,
      opts.recallResults ?? null,
      opts.recallTotalTokens ?? null,
      null,
      opts.recallRequired ?? 0,
      opts.recallTrigger ?? null,
      opts.recallPath ?? null,
      null,
      opts.recallSatisfied ?? 0,
      opts.escalateReason ?? null,
      null,
      null,
      null,
      null,
    )
  return Number(result.lastInsertRowid)
}

test("Day 4 · PromptInspector · 表无 row → empty + defaults", async () => {
  const tmp = safeTempDir("F027-Day4-pi-empty-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-999", undefined)
    assert.deepEqual(r.injectedParts, [])
    assert.deepEqual(r.recallQueries, [])
    assert.equal(r.recallState.recallRequired, false)
    assert.equal(r.recallState.recallPath, null)
    assert.equal(r.recallState.recallSatisfied, false)
    assert.equal(r.recallState.escalateReason, null)
    assert.equal(r.recallState.budgetConsumed, 0)
    assert.equal(r.recallState.budgetMax, 4000)
    assert.deepEqual(r.wakeUpTrigger, { kind: null, ref: null })
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · parts_json 标准 schema 解析", async () => {
  const tmp = safeTempDir("F027-Day4-pi-parts-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const parts = [
      { name: "IronLaws", bytes: 1024, tokens: 256, source: "shared-rules.md" },
      { name: "RecallPack", bytes: 512, tokens: 128, source: "memory-preflight" },
      { name: "Viewfinder", bytes: 2048, tokensEstimated: 512, source: "viewfinder.md" },
    ]
    insertAudit(db, { roomId: "R-201", partsJson: JSON.stringify(parts) })

    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.equal(r.injectedParts.length, 3)
    assert.equal(r.injectedParts[0]?.name, "IronLaws")
    assert.equal(r.injectedParts[0]?.bytes, 1024)
    assert.equal(r.injectedParts[0]?.tokensEstimated, 256)
    assert.equal(r.injectedParts[2]?.tokensEstimated, 512)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · parts_json 替代字段名兼容（kind/byteLength/tokenCount）", async () => {
  const tmp = safeTempDir("F027-Day4-pi-alt-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const parts = [
      { kind: "ALT", byteLength: 800, tokenCount: 200, from: "alt-source.md" },
    ]
    insertAudit(db, { roomId: "R-201", partsJson: JSON.stringify(parts) })

    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.equal(r.injectedParts.length, 1)
    assert.equal(r.injectedParts[0]?.name, "ALT")
    assert.equal(r.injectedParts[0]?.bytes, 800)
    assert.equal(r.injectedParts[0]?.tokensEstimated, 200)
    assert.equal(r.injectedParts[0]?.source, "alt-source.md")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · parts_json 缺 tokens 字段时按 bytes/4 估算", async () => {
  const tmp = safeTempDir("F027-Day4-pi-est-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const parts = [{ name: "NoTokens", bytes: 400, source: "x.md" }]
    insertAudit(db, { roomId: "R-201", partsJson: JSON.stringify(parts) })

    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.equal(r.injectedParts[0]?.tokensEstimated, 100, "400 bytes / 4 = 100 tokens")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · recall_queries + results index 对齐 + gate 分类", async () => {
  const tmp = safeTempDir("F027-Day4-pi-recall-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const queries = ["high-score query", "mid query", "low query"]
    const results = [
      [{ id: 1, score: 0.9 }, { id: 2, score: 0.85 }],
      [{ id: 3, score: 0.7 }],
      [{ id: 4, score: 0.4 }, { id: 5, score: 0.3 }],
    ]
    insertAudit(db, {
      roomId: "R-201",
      recallQueries: JSON.stringify(queries),
      recallResults: JSON.stringify(results),
    })

    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.equal(r.recallQueries.length, 3)
    assert.equal(r.recallQueries[0]?.query, "high-score query")
    assert.equal(r.recallQueries[0]?.hits, 2)
    assert.equal(r.recallQueries[0]?.gate, "high")
    assert.ok(r.recallQueries[0]!.topScore >= 0.75)
    assert.equal(r.recallQueries[1]?.gate, "mid")
    assert.equal(r.recallQueries[2]?.gate, "low")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · recallState 字段解析（required / path / satisfied / escalate / budget）", async () => {
  const tmp = safeTempDir("F027-Day4-pi-state-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, {
      roomId: "R-201",
      recallRequired: 1,
      recallPath: 4,
      recallSatisfied: 0,
      escalateReason: "Level 4 strict path not found",
      recallTotalTokens: 1500,
    })

    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.equal(r.recallState.recallRequired, true)
    assert.equal(r.recallState.recallPath, 4)
    assert.equal(r.recallState.recallSatisfied, false)
    assert.equal(r.recallState.escalateReason, "Level 4 strict path not found")
    assert.equal(r.recallState.budgetConsumed, 1500)
    assert.equal(r.recallState.budgetMax, 4000)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · recallPath 越界（0/6）→ null", async () => {
  const tmp = safeTempDir("F027-Day4-pi-clamp-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, { roomId: "R-201", recallPath: 0 })
    insertAudit(db, { roomId: "R-202", recallPath: 6 })

    const svc = new PromptInspectorService({ db })
    assert.equal(svc.getInspector("R-201", undefined).recallState.recallPath, null)
    assert.equal(svc.getInspector("R-202", undefined).recallState.recallPath, null)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · wakeUpTrigger 'a2a_call=X' 解析", async () => {
  const tmp = safeTempDir("F027-Day4-pi-trig-a2a-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, {
      roomId: "R-201",
      recallTrigger: "a2a_call=R-201-call-001",
    })
    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.deepEqual(r.wakeUpTrigger, { kind: "a2a_call", ref: "R-201-call-001" })
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · wakeUpTrigger 'user_msg=Y' 归一化为 user_message", async () => {
  const tmp = safeTempDir("F027-Day4-pi-trig-user-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, { roomId: "R-201", recallTrigger: "user_msg=msg-042" })
    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.deepEqual(r.wakeUpTrigger, { kind: "user_message", ref: "msg-042" })
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · wakeUpTrigger 'scheduler_tick' 无 ref", async () => {
  const tmp = safeTempDir("F027-Day4-pi-trig-tick-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, { roomId: "R-201", recallTrigger: "scheduler_tick" })
    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.deepEqual(r.wakeUpTrigger, { kind: "scheduler_tick", ref: null })
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · 无 recall_trigger 时 scenario 兜底", async () => {
  const tmp = safeTempDir("F027-Day4-pi-scenario-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, { roomId: "R-201", scenario: "wake-up.a2a" })
    insertAudit(db, { roomId: "R-202", scenario: "wake-up.user" })
    insertAudit(db, { roomId: "R-203", scenario: "scheduler.tick" })
    insertAudit(db, { roomId: "R-204", scenario: "unknown" })

    const svc = new PromptInspectorService({ db })
    assert.equal(svc.getInspector("R-201", undefined).wakeUpTrigger.kind, "a2a_call")
    assert.equal(svc.getInspector("R-202", undefined).wakeUpTrigger.kind, "user_message")
    assert.equal(svc.getInspector("R-203", undefined).wakeUpTrigger.kind, "scheduler_tick")
    assert.equal(svc.getInspector("R-204", undefined).wakeUpTrigger.kind, null)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · 损坏 JSON 容忍 → 空数组", async () => {
  const tmp = safeTempDir("F027-Day4-pi-bad-json-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, {
      roomId: "R-201",
      partsJson: "{ not valid json",
      recallQueries: "[ broken",
    })
    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.deepEqual(r.injectedParts, [])
    assert.deepEqual(r.recallQueries, [])
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · 取最新一行（同 room 多 audit）", async () => {
  const tmp = safeTempDir("F027-Day4-pi-latest-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, {
      roomId: "R-201",
      partsJson: JSON.stringify([{ name: "OLD", bytes: 100, source: "x" }]),
    })
    insertAudit(db, {
      roomId: "R-201",
      partsJson: JSON.stringify([{ name: "NEW", bytes: 200, source: "y" }]),
    })

    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.equal(r.injectedParts.length, 1)
    assert.equal(r.injectedParts[0]?.name, "NEW")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · room 隔离", async () => {
  const tmp = safeTempDir("F027-Day4-pi-isolation-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertAudit(db, {
      roomId: "R-201",
      partsJson: JSON.stringify([{ name: "A", bytes: 100, source: "x" }]),
    })
    insertAudit(db, {
      roomId: "R-202",
      partsJson: JSON.stringify([{ name: "B", bytes: 200, source: "y" }]),
    })

    const svc = new PromptInspectorService({ db })
    assert.equal(svc.getInspector("R-201", undefined).injectedParts[0]?.name, "A")
    assert.equal(svc.getInspector("R-202", undefined).injectedParts[0]?.name, "B")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · extractTopScore 兼容 hybridScore / bm25Score 字段（范-r1 P2-4）", async () => {
  const tmp = safeTempDir("F027-Day4-pi-hybrid-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    // V16.5 P14 hybrid retriever 真实输出形态：hits[].hybridScore / bm25Score / cosineScore
    const queries = ["q1", "q2", "q3"]
    const results = [
      [{ id: 1, hybridScore: 0.92 }], // hybrid retriever 主输出
      [{ id: 2, hybrid_score: 0.65 }], // snake_case 兼容
      [{ id: 3, bm25Score: 0.55, cosineScore: 0.4 }], // 拆分 score 子项 fallback
    ]
    insertAudit(db, {
      roomId: "R-201",
      recallQueries: JSON.stringify(queries),
      recallResults: JSON.stringify(results),
    })

    const svc = new PromptInspectorService({ db })
    const r = svc.getInspector("R-201", undefined)
    assert.equal(r.recallQueries.length, 3)
    assert.ok(r.recallQueries[0]!.topScore >= 0.9, "hybridScore 字段应被识别")
    assert.equal(r.recallQueries[0]?.gate, "high")
    assert.ok(r.recallQueries[1]!.topScore >= 0.6 && r.recallQueries[1]!.topScore < 0.75)
    assert.equal(r.recallQueries[1]?.gate, "mid")
    assert.equal(r.recallQueries[2]?.gate, "low")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 4 · PromptInspector · 自定义 budgetMax", async () => {
  const tmp = safeTempDir("F027-Day4-pi-budget-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const svc = new PromptInspectorService({ db, recallBudgetMax: 8000 })
    const r = svc.getInspector("R-999", undefined)
    assert.equal(r.recallState.budgetMax, 8000)
  } finally {
    close()
    safeCleanup(tmp)
  }
})
