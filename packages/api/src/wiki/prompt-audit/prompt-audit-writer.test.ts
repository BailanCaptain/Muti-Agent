/**
 * F027 Phase 3 P20 · PromptAuditWriter tests — Week 2 Day 8 b
 *
 * 覆盖：
 *   - happy write 26 字段全可读回
 *   - 9 recall fields 真落（recall_required / trigger / path / satisfied / escalate /
 *     total_ms / critique_calls / budget_exceeded / top_score）
 *   - V15.1 5 字段（recall_queries / results / total_tokens / rejected_reasons + top_score 共用）
 *   - 可选字段缺省 → null / 0 / false 正确处理
 *   - buildRecallAuditPatch：executor 跑过 → 9 字段全填；executor 未跑 → null/false
 *   - buildRecallAuditPatch：top_score = max(hits[*].score)
 *   - buildRecallAuditPatch：empty hits → top_score = null
 *   - NoopPromptAuditWriter 返回 id=0 不真落库
 *   - sourceEventIds + agentSessionRef 正确序列化
 *   - prompt-inspector 已读字段（scenario / parts_json / 10 recall fields）真值可读
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { getSqliteClient } from "../../routes/phase3/sqlite-helper"
import type { ExecuteOutput } from "../adaptive-recall/types"
import type { RecallHit } from "../memory-preflight/types"
import {
  NoopPromptAuditWriter,
  PromptAuditWriter,
  buildRecallAuditPatch,
} from "./prompt-audit-writer"

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

function makeDb() {
  const tmp = safeTempDir("F027-Day8b-audit-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  return { db, close, tmp }
}

function makeHit(path: string, score: number): RecallHit {
  return { path, score, excerpt: `excerpt for ${path}` }
}

function makeExecuteOutput(hits: RecallHit[], extras: Partial<ExecuteOutput> = {}): ExecuteOutput {
  return {
    recallPath: 2,
    recallSatisfied: true,
    hits,
    totalMs: 142,
    critiqueCalls: 1,
    budgetExceeded: false,
    attempts: [{ level: 2, hitsCount: hits.length, satisfied: true, ms: 142, reason: "ok" }],
    ...extras,
  }
}

test("Day 8b · PromptAuditWriter · happy write → id>0 + row 可读回", () => {
  const { db, close, tmp } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    const r = writer.write({
      createdAt: "2026-05-21T08:00:00.000Z",
      alias: "黄仁勋",
      roomId: "R-201",
      scenario: "a2a_handoff",
      totalTokens: 1234,
      cap: 200000,
      partsJson: '[{"section":"task"}]',
      ironLawsCount: 0,
      rawText: "task: do thing",
      recallRequired: true,
      recallTrigger: "a2a_call",
      recallPath: 2,
      topScore: 0.92,
      recallSatisfied: true,
      escalateReason: null,
      recallTotalMs: 142,
      recallCritiqueCalls: 1,
      recallBudgetExceeded: false,
    })
    assert.ok(r.id > 0)

    const client = getSqliteClient(db)
    const row = client.prepare("SELECT * FROM prompt_audit WHERE id = ?").get(r.id) as Record<
      string,
      unknown
    >
    assert.equal(row.alias, "黄仁勋")
    assert.equal(row.room_id, "R-201")
    assert.equal(row.scenario, "a2a_handoff")
    assert.equal(row.total_tokens, 1234)
    assert.equal(row.cap, 200000)
    assert.equal(row.parts_json, '[{"section":"task"}]')
    assert.equal(row.recall_required, 1)
    assert.equal(row.recall_trigger, "a2a_call")
    assert.equal(row.recall_path, 2)
    assert.equal(row.top_score, 0.92)
    assert.equal(row.recall_satisfied, 1)
    assert.equal(row.escalate_reason, null)
    assert.equal(row.recall_total_ms, 142)
    assert.equal(row.recall_critique_calls, 1)
    assert.equal(row.recall_budget_exceeded, 0)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 8b · PromptAuditWriter · escalate path（L5）→ escalate_reason 真落 + budget_exceeded=1", () => {
  const { db, close, tmp } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    const r = writer.write({
      createdAt: "2026-05-21T08:00:00.000Z",
      alias: "桂芬",
      scenario: "wake_up",
      totalTokens: 800,
      cap: 8000,
      partsJson: "[]",
      ironLawsCount: 0,
      rawText: "wake-up content",
      recallRequired: true,
      recallTrigger: "wake_up_history",
      recallPath: 5,
      topScore: null,
      recallSatisfied: false,
      escalateReason: "budget_exceeded_at_l3",
      recallTotalMs: 5050,
      recallCritiqueCalls: 2,
      recallBudgetExceeded: true,
    })

    const client = getSqliteClient(db)
    const row = client
      .prepare(
        "SELECT recall_path, recall_satisfied, escalate_reason, recall_budget_exceeded FROM prompt_audit WHERE id = ?",
      )
      .get(r.id) as Record<string, unknown>
    assert.equal(row.recall_path, 5)
    assert.equal(row.recall_satisfied, 0)
    assert.equal(row.escalate_reason, "budget_exceeded_at_l3")
    assert.equal(row.recall_budget_exceeded, 1)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 8b · PromptAuditWriter · 缺省 optional → null / 0 / false default 正确", () => {
  const { db, close, tmp } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    const r = writer.write({
      createdAt: "2026-05-21T08:00:00.000Z",
      alias: "范德彪",
      scenario: "direct_turn",
      totalTokens: 100,
      cap: 0,
      partsJson: "[]",
      ironLawsCount: 0,
      rawText: "minimal row",
      // 全部 optional 缺省
    })
    const client = getSqliteClient(db)
    const row = client.prepare("SELECT * FROM prompt_audit WHERE id = ?").get(r.id) as Record<
      string,
      unknown
    >
    assert.equal(row.room_id, null)
    assert.equal(row.recall_required, 0, "default false → 0")
    assert.equal(row.recall_satisfied, 0)
    assert.equal(row.recall_path, null)
    assert.equal(row.top_score, null)
    assert.equal(row.escalate_reason, null)
    assert.equal(row.recall_trigger, null)
    assert.equal(row.recall_total_ms, null)
    assert.equal(row.recall_critique_calls, null)
    // budgetExceeded 未传 → null（区分 explicit false 与未跑）
    assert.equal(row.recall_budget_exceeded, null)
    // V15.1 字段全 null
    assert.equal(row.recall_queries, null)
    assert.equal(row.recall_results, null)
    assert.equal(row.recall_total_tokens, null)
    assert.equal(row.recall_rejected_reasons, null)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 8b · PromptAuditWriter · V15.1 5 字段（含 top_score 共用）真落", () => {
  const { db, close, tmp } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    const r = writer.write({
      createdAt: "2026-05-21T08:00:00.000Z",
      alias: "黄仁勋",
      scenario: "session_bootstrap",
      totalTokens: 5000,
      cap: 200000,
      partsJson: "[]",
      ironLawsCount: 0,
      rawText: "bootstrap content",
      recallQueries: '[{"query":"F027 plan","source":"task_summary"}]',
      recallResults: '[{"query":"F027 plan","hits":[{"path":"wiki/x.md","score":0.88}]}]',
      recallTotalTokens: 320,
      recallRejectedReasons: '[{"path":"wiki/y.md","reason":"score_below_floor"}]',
      topScore: 0.88,
    })
    const client = getSqliteClient(db)
    const row = client.prepare("SELECT * FROM prompt_audit WHERE id = ?").get(r.id) as Record<
      string,
      unknown
    >
    assert.match(String(row.recall_queries), /F027 plan/)
    assert.match(String(row.recall_results), /wiki\/x\.md/)
    assert.equal(row.recall_total_tokens, 320)
    assert.match(String(row.recall_rejected_reasons), /score_below_floor/)
    assert.equal(row.top_score, 0.88)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 8b · PromptAuditWriter · sourceEventIds + agentSessionRef 真落", () => {
  const { db, close, tmp } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    const r = writer.write({
      createdAt: "2026-05-21T08:00:00.000Z",
      alias: "黄仁勋",
      scenario: "a2a_handoff",
      totalTokens: 1,
      cap: 0,
      partsJson: "[]",
      ironLawsCount: 0,
      rawText: "x",
      sourceEventIds: '["msg-001","msg-002"]',
      agentSessionRef: "session-xyz-1",
    })
    const client = getSqliteClient(db)
    const row = client
      .prepare("SELECT source_event_ids, agent_session_ref FROM prompt_audit WHERE id = ?")
      .get(r.id) as Record<string, unknown>
    assert.equal(row.source_event_ids, '["msg-001","msg-002"]')
    assert.equal(row.agent_session_ref, "session-xyz-1")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 8b · buildRecallAuditPatch · executor 跑过 → 9 字段全填", () => {
  const out = makeExecuteOutput([makeHit("wiki/a.md", 0.92), makeHit("wiki/b.md", 0.81)], {
    recallPath: 3,
    recallSatisfied: true,
    totalMs: 250,
    critiqueCalls: 2,
    budgetExceeded: false,
  })
  const patch = buildRecallAuditPatch({ output: out, trigger: "a2a_call" })
  assert.equal(patch.recallRequired, true)
  assert.equal(patch.recallTrigger, "a2a_call")
  assert.equal(patch.recallPath, 3)
  assert.equal(patch.topScore, 0.92, "top_score = max(hits[*].score)")
  assert.equal(patch.recallSatisfied, true)
  assert.equal(patch.escalateReason, null)
  assert.equal(patch.recallTotalMs, 250)
  assert.equal(patch.recallCritiqueCalls, 2)
  assert.equal(patch.recallBudgetExceeded, false)
})

test("Day 8b · buildRecallAuditPatch · executor 未跑（disabled / skip）→ recall_required=false + 全 null/0/false", () => {
  const patch = buildRecallAuditPatch({ output: undefined, trigger: "a2a_call" })
  assert.equal(patch.recallRequired, false)
  assert.equal(patch.recallTrigger, "a2a_call")
  assert.equal(patch.recallPath, null)
  assert.equal(patch.topScore, null)
  assert.equal(patch.recallSatisfied, false)
  assert.equal(patch.escalateReason, null)
  assert.equal(patch.recallTotalMs, null)
  assert.equal(patch.recallCritiqueCalls, null)
  assert.equal(patch.recallBudgetExceeded, false)
})

test("Day 8b · buildRecallAuditPatch · executor 跑但 recallRequired override → 用 override", () => {
  const out = makeExecuteOutput([makeHit("wiki/a.md", 0.5)])
  const patch = buildRecallAuditPatch({
    output: out,
    trigger: "wake_up",
    recallRequired: false, // override: Hard Gate 判定不需要，但 executor 还是跑了
  })
  assert.equal(patch.recallRequired, false)
})

test("Day 8b · buildRecallAuditPatch · empty hits → top_score=null + recall_path 仍有值", () => {
  const out = makeExecuteOutput([], {
    recallPath: 5,
    recallSatisfied: false,
    escalateReason: "no_hits",
  })
  const patch = buildRecallAuditPatch({ output: out, trigger: "wake_up" })
  assert.equal(patch.topScore, null)
  assert.equal(patch.recallPath, 5)
  assert.equal(patch.escalateReason, "no_hits")
  assert.equal(patch.recallSatisfied, false)
})

test("Day 8b · NoopPromptAuditWriter · 返回 id=0 不真落库", () => {
  const noop = new NoopPromptAuditWriter()
  const r = noop.write({
    createdAt: "x",
    alias: "x",
    scenario: "x",
    totalTokens: 0,
    cap: 0,
    partsJson: "[]",
    ironLawsCount: 0,
    rawText: "x",
  })
  assert.equal(r.id, 0)
})

test("Day 8b · PromptAuditWriter · prompt-inspector 已读字段（scenario / parts_json / recall 10 fields）值可读", () => {
  const { db, close, tmp } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    const r = writer.write({
      createdAt: "2026-05-21T08:00:00.000Z",
      alias: "黄仁勋",
      roomId: "R-201",
      scenario: "wake_up",
      totalTokens: 1500,
      cap: 200000,
      partsJson: '[{"section":"task","tokens":1200}]',
      ironLawsCount: 1,
      rawText: "wake-up content",
      recallQueries: '[{"query":"q1"}]',
      recallResults: "[]",
      recallTotalTokens: 800,
      recallRequired: true,
      recallTrigger: "wake_up_history_keyword",
      recallPath: 2,
      recallSatisfied: true,
      escalateReason: null,
    })

    const client = getSqliteClient(db)
    const row = client
      .prepare(
        `SELECT scenario, parts_json,
                recall_queries, recall_results, recall_total_tokens,
                recall_required, recall_trigger, recall_path,
                recall_satisfied, escalate_reason
           FROM prompt_audit WHERE id = ?`,
      )
      .get(r.id) as Record<string, unknown>

    assert.equal(row.scenario, "wake_up")
    assert.equal(row.parts_json, '[{"section":"task","tokens":1200}]')
    assert.equal(row.recall_queries, '[{"query":"q1"}]')
    assert.equal(row.recall_total_tokens, 800)
    assert.equal(row.recall_required, 1)
    assert.equal(row.recall_trigger, "wake_up_history_keyword")
    assert.equal(row.recall_path, 2)
    assert.equal(row.recall_satisfied, 1)
  } finally {
    close()
    safeCleanup(tmp)
  }
})
