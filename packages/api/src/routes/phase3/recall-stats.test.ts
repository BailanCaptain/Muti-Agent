import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { createDrizzleDb } from "../../db/drizzle-instance"
import { PromptAuditWriter } from "../../wiki/prompt-audit/prompt-audit-writer"
import { RecallStatsService } from "./recall-stats"

function safeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, prefix))
}

function makeDb() {
  const tmp = safeTempDir("F042-recall-stats-")
  const { db, close } = createDrizzleDb(path.join(tmp, "t.sqlite"))
  return { db, close, tmp }
}

function seedRow(
  writer: PromptAuditWriter,
  opts: {
    roomId?: string
    createdAt?: string
    results?: Array<{ path: string; score: number }>
    executed?: boolean
    trigger?: string
    mode?: string | null
    /** 德彪 r1 P1-1 · 占位行形态：results/total_ms 双 NULL（异步召回未 settle） */
    placeholder?: boolean
  } = {},
) {
  return writer.write({
    createdAt: opts.createdAt ?? "2026-07-11T08:00:00.000Z",
    alias: "德彪",
    roomId: opts.roomId ?? "R-201",
    scenario: "direct_turn",
    totalTokens: 100,
    cap: 0,
    partsJson: "[]",
    ironLawsCount: 1,
    rawText: "x",
    recallMode: opts.mode === undefined ? "shadow" : opts.mode,
    recallRequired: opts.executed ?? true,
    recallTrigger: opts.trigger ?? "direct_turn",
    recallQueries: JSON.stringify(["q"]),
    recallResults: opts.placeholder
      ? null
      : JSON.stringify((opts.results ?? []).map((r) => ({ ...r, excerpt: "e" }))),
    recallTotalMs: opts.placeholder ? null : 50,
  })
}

test("F042 AC2 · 统计口径：totalRecalls/hitRate/adoptionRate/annotatedCount/topEntries", () => {
  const { db, close } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    // 3 行：2 命中（其中 1 被判 adopted，1 判 not-adopted）、1 空结果（不可判 → 不计标注）
    const r1 = seedRow(writer, {
      results: [
        { path: "wiki/concepts/F031.md", score: 0.9 },
        { path: "wiki/methods/preview.md", score: 0.7 },
      ],
    })
    const r2 = seedRow(writer, { results: [{ path: "wiki/concepts/F031.md", score: 0.8 }] })
    seedRow(writer, { results: [] })
    writer.updateAdoption(r1.id, { adopted: true, matches: [{ path: "wiki/concepts/F031.md", term: "F031" }] })
    writer.updateAdoption(r2.id, { adopted: false, matches: [] })

    const svc = new RecallStatsService({ db })
    const s = svc.getStats({ window: 50 })
    assert.equal(s.window, 50)
    assert.equal(s.totalRecalls, 3)
    assert.ok(Math.abs(s.hitRate - 2 / 3) < 1e-9, `hitRate=${s.hitRate}`)
    assert.equal(s.annotatedCount, 2)
    assert.ok(s.adoptionRate !== null && Math.abs(s.adoptionRate - 0.5) < 1e-9)
    assert.equal(s.topEntries[0].path, "wiki/concepts/F031.md")
    assert.equal(s.topEntries[0].count, 2)
    assert.ok(s.oldestAt && s.newestAt)
  } finally {
    close()
  }
})

test("F042 AC2 · 空库 → 全零 + adoptionRate=null（分母 0 不编造）", () => {
  const { db, close } = makeDb()
  try {
    const svc = new RecallStatsService({ db })
    const s = svc.getStats({ window: 50 })
    assert.equal(s.totalRecalls, 0)
    assert.equal(s.hitRate, 0)
    assert.equal(s.adoptionRate, null)
    assert.equal(s.annotatedCount, 0)
    assert.deepEqual(s.topEntries, [])
    assert.equal(s.oldestAt, null)
  } finally {
    close()
  }
})

test("F042 AC2 · 嵌套形状 recall_results 解析防御（preview 验收捕获；德彪 r1 P1-2 后冷启行已出窗，此为形状漂移防御）", () => {
  // 两种形状：coordinator 支扁平 [{path,score,excerpt}]（buildRecallAuditPatch）、
  // 冷启支嵌套 [{query,source,hits:[{path,...}]}]（buildColdStartRecallAuditPatch）。
  // P1-2 修后冷启行被 trigger 过滤出窗，嵌套解析保留为防御（形状混用/漂移时统计不丢）。
  const { db, close } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    writer.write({
      createdAt: "2026-07-11T08:00:00.000Z",
      alias: "德彪",
      roomId: "R-201",
      scenario: "direct_turn",
      totalTokens: 100,
      cap: 0,
      partsJson: "[]",
      ironLawsCount: 1,
      rawText: "x",
      recallMode: "shadow",
      recallRequired: true,
      recallTrigger: "direct_turn",
      recallTotalMs: 50,
      recallQueries: JSON.stringify(["q1", "q2"]),
      recallResults: JSON.stringify([
        {
          query: "q1",
          source: "task_summary",
          hits: [
            { path: "wiki/concepts/cold-hit.md", score: 0.9, excerpt: "e" },
            { path: "wiki/methods/cold-hit-2.md", score: 0.8, excerpt: "e" },
          ],
        },
        { query: "q2", source: "task_summary", hits: [{ path: "wiki/concepts/cold-hit.md", score: 0.7, excerpt: "e" }] },
      ]),
    })

    const svc = new RecallStatsService({ db })
    const s = svc.getStats({ window: 50 })
    assert.equal(s.totalRecalls, 1)
    assert.equal(s.hitRate, 1, `嵌套形状行有 hits，hitRate 应为 1，实际 ${s.hitRate}`)
    assert.equal(s.topEntries[0].path, "wiki/concepts/cold-hit.md")
    assert.equal(s.topEntries[0].count, 2)
  } finally {
    close()
  }
})

test("F042 AC2 · oldest/newest 按时间聚合（不依赖 id 序 = 时间序）", () => {
  const { db, close } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    // 故意倒序插入：后插的行时间更早
    seedRow(writer, { createdAt: "2026-07-10T00:00:00.000Z", results: [] })
    seedRow(writer, { createdAt: "2026-07-01T00:00:00.000Z", results: [] })

    const svc = new RecallStatsService({ db })
    const s = svc.getStats({ window: 50 })
    assert.equal(s.oldestAt, "2026-07-01T00:00:00.000Z")
    assert.equal(s.newestAt, "2026-07-10T00:00:00.000Z")
  } finally {
    close()
  }
})

test("F042 AC2 · window 截断（最新优先）+ roomId 过滤 + 非召回行不计", () => {
  const { db, close } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    seedRow(writer, { roomId: "R-201", createdAt: "2026-07-01T00:00:00Z", results: [{ path: "wiki/a.md", score: 0.5 }] })
    seedRow(writer, { roomId: "R-201", createdAt: "2026-07-02T00:00:00Z", results: [] })
    seedRow(writer, { roomId: "R-999", createdAt: "2026-07-03T00:00:00Z", results: [{ path: "wiki/b.md", score: 0.6 }] })
    // recall 没真跑的行（off 模式 scenario_skip：executed=false）不进统计
    seedRow(writer, { roomId: "R-201", executed: false })

    const svc = new RecallStatsService({ db })
    assert.equal(svc.getStats({ window: 50 }).totalRecalls, 3, "executed=false 不计")
    assert.equal(svc.getStats({ window: 1 }).totalRecalls, 1, "window 截断")
    const roomScoped = svc.getStats({ window: 50, roomId: "R-201" })
    assert.equal(roomScoped.totalRecalls, 2)
  } finally {
    close()
  }
})

// ── 德彪 r1 · P1-1 + P1-2 观察窗纯度 ─────────────────────────────────────

test("德彪 r1 P1-1 · 占位行（异步召回未 settle）不计入窗口——防第 50 条未完成时烧错小结", () => {
  const { db, close } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    seedRow(writer, { results: [{ path: "wiki/a.md", score: 0.8 }] }) // settled 带命中
    seedRow(writer, { placeholder: true }) // shadow 异步占位（results/total_ms 双 NULL）
    const s = new RecallStatsService({ db }).getStats({ window: 50 })
    assert.equal(s.totalRecalls, 1, "占位行不计；settle 回填后自然进窗")
    assert.equal(s.hitRate, 1, "占位行不得稀释命中率")
  } finally {
    close()
  }
})

test("德彪 r1 P1-2 · 冷启行（trigger=session_bootstrap，实际注入）与非 shadow 行不进 shadow 观察窗", () => {
  const { db, close } = makeDb()
  try {
    const writer = new PromptAuditWriter({ db })
    seedRow(writer, { results: [{ path: "wiki/a.md", score: 0.8 }] }) // shadow×direct_turn 唯一合法行
    seedRow(writer, { trigger: "session_bootstrap", mode: null, results: [{ path: "wiki/cold.md", score: 0.9 }] })
    seedRow(writer, { mode: "inject", results: [{ path: "wiki/b.md", score: 0.7 }] })
    const s = new RecallStatsService({ db }).getStats({ window: 50 })
    assert.equal(s.totalRecalls, 1, "观察窗=shadow×direct_turn 窗：冷启行/inject 行都不计")
    assert.equal(s.topEntries.length, 1)
    assert.equal(s.topEntries[0].path, "wiki/a.md", "冷启/inject 的命中不得混入 Top 条目")
  } finally {
    close()
  }
})
