/**
 * F027 Phase 3 P20 · DecisionService tests — Week 2 Day 6
 *
 * 覆盖：
 *   - happy commit append → 写新行 + action=append + ledgerCursor 推进
 *   - happy reject append → decision_type='reject'
 *   - revoke（commit + supersedesDecisionId）→ 写新行 + 标旧行 superseded
 *   - tombstone（kind=tombstone + supersedesDecisionId）→ UPDATE 旧行 tombstone=1，不写新行
 *   - tombstone 缺 supersedesDecisionId（contract 拦）→ DECISION_INVALID
 *   - revoke 目标不存在 → DECISION_INVALID + detail.reason=decision_not_found
 *   - tombstone 目标不存在 → DECISION_INVALID
 *   - getCoverage 空 room → broad=[] status=fail
 *   - getCoverage broad < 3 → status=warn 即使 100%
 *   - getCoverage 5 行 4 resolved → coverage=0.8 status=warn（< 0.95）
 *   - getCoverage 跨 room 隔离
 *   - getCoverage state 分类（active / superseded / tombstone / completed）
 *   - sourceMessageIds 映射：message → msg:<id>，decision → decision:<id>
 *   - clock 注入 → appendedAt 确定
 *   - fencingToken 注入 → 写入审计可追
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { validatePostDecision } from "./contracts"
import { DecisionService } from "./decisions"
import { getSqliteClient } from "./sqlite-helper"

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

function makeService(opts: { clock?: Date; token?: string } = {}) {
  const tmp = safeTempDir("F027-Day6-decisions-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const svc = new DecisionService({
    db,
    clock: opts.clock ? () => opts.clock! : undefined,
    newFencingToken: opts.token ? () => opts.token! : undefined,
  })
  return { svc, db, close, tmp }
}

test("Day 6 · DecisionService · happy commit append → action=append + 新行", () => {
  const { svc, db, close, tmp } = makeService()
  try {
    const res = svc.commitDecision("R-201", {
      kind: "commit",
      content: "F026 进 merge-gate",
      evidence: [{ kind: "message", ref: "msg-101" }],
      callerAlias: "小孙",
    })
    assert.equal(res.action, "append")
    assert.match(res.decisionId, /^\d+$/)
    assert.ok(res.ledgerCursor >= Number(res.decisionId))

    const client = getSqliteClient(db)
    const row = client
      .prepare("SELECT * FROM room_decisions WHERE decision_id = ?")
      .get(Number(res.decisionId)) as Record<string, unknown>
    assert.equal(row.room_id, "R-201")
    assert.equal(row.decision_type, "commit")
    assert.equal(row.decided_by, "小孙")
    assert.equal(row.content, "F026 进 merge-gate")
    assert.equal(row.status, "active")
    assert.equal(row.tombstone, 0)
    assert.equal(row.superseded_by, null)
    // sourceMessageIds 映射
    const ids = JSON.parse(row.source_message_ids as string)
    assert.deepEqual(ids, ["msg:msg-101"])
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · reject append → decision_type=reject", () => {
  const { svc, db, close, tmp } = makeService()
  try {
    const res = svc.commitDecision("R-201", {
      kind: "reject",
      content: "不接受 V12 plan v2",
      evidence: [{ kind: "message", ref: "m1" }],
      callerAlias: "小孙",
    })
    assert.equal(res.action, "append")
    const client = getSqliteClient(db)
    const row = client
      .prepare("SELECT decision_type FROM room_decisions WHERE decision_id = ?")
      .get(Number(res.decisionId)) as { decision_type: string }
    assert.equal(row.decision_type, "reject")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · revoke commit + supersedesDecisionId → 标旧行 superseded + 新 reject 行", () => {
  const { svc, db, close, tmp } = makeService()
  try {
    const old = svc.commitDecision("R-201", {
      kind: "commit",
      content: "旧决策",
      evidence: [{ kind: "message", ref: "m1" }],
      callerAlias: "小孙",
    })
    const rev = svc.commitDecision("R-201", {
      kind: "commit",
      content: "撤销旧决策（原因：误判）",
      evidence: [{ kind: "decision", ref: old.decisionId }],
      callerAlias: "小孙",
      supersedesDecisionId: old.decisionId,
    })
    assert.equal(rev.action, "revoke")
    assert.notEqual(rev.decisionId, old.decisionId)

    const client = getSqliteClient(db)
    const oldRow = client
      .prepare("SELECT status, superseded_by FROM room_decisions WHERE decision_id = ?")
      .get(Number(old.decisionId)) as { status: string; superseded_by: number }
    assert.equal(oldRow.status, "superseded")
    assert.equal(oldRow.superseded_by, Number(rev.decisionId))

    const newRow = client
      .prepare("SELECT decision_type, content FROM room_decisions WHERE decision_id = ?")
      .get(Number(rev.decisionId)) as { decision_type: string; content: string }
    assert.equal(newRow.decision_type, "reject")
    assert.ok(newRow.content.includes(`撤销 D-${old.decisionId}`))
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · tombstone → UPDATE 旧行 tombstone=1，不写新行", () => {
  const { svc, db, close, tmp } = makeService()
  try {
    const old = svc.commitDecision("R-201", {
      kind: "commit",
      content: "关键决策（要永久投影）",
      evidence: [{ kind: "message", ref: "m1" }],
      callerAlias: "小孙",
    })
    const client = getSqliteClient(db)
    const countBefore = (
      client.prepare("SELECT COUNT(*) AS n FROM room_decisions WHERE room_id = ?").get("R-201") as {
        n: number
      }
    ).n
    assert.equal(countBefore, 1)

    const ts = svc.commitDecision("R-201", {
      kind: "tombstone",
      content: "拍永久投影",
      evidence: [{ kind: "decision", ref: old.decisionId }],
      callerAlias: "小孙",
      supersedesDecisionId: old.decisionId,
    })
    assert.equal(ts.action, "tombstone")
    assert.equal(ts.decisionId, old.decisionId, "tombstone 返回的是被 mark 的旧行 id")

    const countAfter = (
      client.prepare("SELECT COUNT(*) AS n FROM room_decisions WHERE room_id = ?").get("R-201") as {
        n: number
      }
    ).n
    assert.equal(countAfter, 1, "tombstone 不写新行")

    const row = client
      .prepare("SELECT tombstone FROM room_decisions WHERE decision_id = ?")
      .get(Number(old.decisionId)) as { tombstone: number }
    assert.equal(row.tombstone, 1)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · validatePostDecision · tombstone 缺 supersedesDecisionId → DECISION_INVALID", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    {
      kind: "tombstone",
      content: "拍",
      evidence: [{ kind: "message", ref: "m1" }],
      callerAlias: "小孙",
    },
  )
  assert.equal(r.ok, false)
  if (r.ok === false) {
    assert.equal(r.error, "DECISION_INVALID")
    assert.equal(r.detail?.reason, "tombstone_requires_target")
  }
})

test("Day 6 · validatePostDecision · 缺 callerAlias → DECISION_INVALID + detail.reason=caller_required", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    {
      kind: "commit",
      content: "x",
      evidence: [{ kind: "message", ref: "m1" }],
    },
  )
  assert.equal(r.ok, false)
  if (r.ok === false) {
    assert.equal(r.error, "DECISION_INVALID")
    assert.equal(r.detail?.reason, "caller_required")
  }
})

test("Day 6 · validatePostDecision · supersedesDecisionId 非数字 → DECISION_INVALID", () => {
  const r = validatePostDecision(
    { id: "R-201" },
    {
      kind: "tombstone",
      content: "x",
      evidence: [{ kind: "message", ref: "m1" }],
      callerAlias: "小孙",
      supersedesDecisionId: "dec-abc",
    },
  )
  assert.equal(r.ok, false)
  if (r.ok === false) {
    assert.equal(r.detail?.reason, "invalid_decision_id")
  }
})

test("Day 6 · DecisionService · revoke 目标不存在 → DecisionNotFoundError 抛出", () => {
  const { svc, close, tmp } = makeService()
  try {
    assert.throws(
      () =>
        svc.commitDecision("R-201", {
          kind: "commit",
          content: "撤销",
          evidence: [{ kind: "decision", ref: "9999" }],
          callerAlias: "小孙",
          supersedesDecisionId: "9999",
        }),
      /decision_id=9999 not found/,
    )
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · tombstone 目标不存在 → DecisionNotFoundError 抛出", () => {
  const { svc, close, tmp } = makeService()
  try {
    assert.throws(
      () =>
        svc.commitDecision("R-201", {
          kind: "tombstone",
          content: "mark",
          evidence: [{ kind: "decision", ref: "9999" }],
          callerAlias: "小孙",
          supersedesDecisionId: "9999",
        }),
      /decision_id=9999 not found/,
    )
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · getCoverage 空 room → broad=[] status=fail", () => {
  const { svc, close, tmp } = makeService()
  try {
    const cov = svc.getCoverage("R-999")
    assert.deepEqual(cov.broad, [])
    assert.deepEqual(cov.resolved, [])
    assert.deepEqual(cov.unresolved, [])
    assert.equal(cov.coverage, null)
    assert.equal(cov.status, "fail")
    assert.ok(cov.generatedAt)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · getCoverage broad < 3 → status=warn 即使 100%", () => {
  const { svc, close, tmp } = makeService()
  try {
    const d1 = svc.commitDecision("R-201", {
      kind: "commit",
      content: "d1",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })
    // mark d1 tombstone → resolved
    svc.commitDecision("R-201", {
      kind: "tombstone",
      content: "永久",
      evidence: [{ kind: "decision", ref: d1.decisionId }],
      callerAlias: "小孙",
      supersedesDecisionId: d1.decisionId,
    })

    const cov = svc.getCoverage("R-201")
    // tombstone 不写新行 → broad=1, resolved=1, 100% 但 broad<3 → warn
    assert.equal(cov.broad.length, 1)
    assert.equal(cov.resolved.length, 1)
    assert.equal(cov.unresolved.length, 0)
    assert.equal(cov.coverage, 1)
    assert.equal(cov.status, "warn")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · getCoverage 5 行 4 resolved → coverage=0.8 status=warn", () => {
  const { svc, close, tmp } = makeService()
  try {
    // 5 个 active decisions
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const d = svc.commitDecision("R-201", {
        kind: "commit",
        content: `d${i}`,
        evidence: [{ kind: "message", ref: `m${i}` }],
        callerAlias: "小孙",
      })
      ids.push(d.decisionId)
    }
    // mark 前 4 个 tombstone（resolved）
    for (let i = 0; i < 4; i += 1) {
      svc.commitDecision("R-201", {
        kind: "tombstone",
        content: `永久 ${i}`,
        evidence: [{ kind: "decision", ref: ids[i] }],
        callerAlias: "小孙",
        supersedesDecisionId: ids[i],
      })
    }

    const cov = svc.getCoverage("R-201")
    assert.equal(cov.broad.length, 5)
    assert.equal(cov.resolved.length, 4)
    assert.equal(cov.unresolved.length, 1)
    assert.ok(cov.coverage !== null)
    assert.ok(Math.abs((cov.coverage ?? 0) - 0.8) < 1e-9)
    assert.equal(cov.status, "warn")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · getCoverage state 分类（active / superseded / tombstone）", () => {
  const { svc, close, tmp } = makeService()
  try {
    // 1 active
    svc.commitDecision("R-201", {
      kind: "commit",
      content: "active",
      evidence: [{ kind: "message", ref: "m1" }],
      callerAlias: "小孙",
    })
    // 1 superseded
    const toRevoke = svc.commitDecision("R-201", {
      kind: "commit",
      content: "will be revoked",
      evidence: [{ kind: "message", ref: "m2" }],
      callerAlias: "小孙",
    })
    svc.commitDecision("R-201", {
      kind: "commit",
      content: "撤销",
      evidence: [{ kind: "decision", ref: toRevoke.decisionId }],
      callerAlias: "小孙",
      supersedesDecisionId: toRevoke.decisionId,
    })
    // 1 tombstone
    const toMark = svc.commitDecision("R-201", {
      kind: "commit",
      content: "to be marked",
      evidence: [{ kind: "message", ref: "m3" }],
      callerAlias: "小孙",
    })
    svc.commitDecision("R-201", {
      kind: "tombstone",
      content: "永久",
      evidence: [{ kind: "decision", ref: toMark.decisionId }],
      callerAlias: "小孙",
      supersedesDecisionId: toMark.decisionId,
    })

    const cov = svc.getCoverage("R-201")
    const states = cov.broad.map((d) => d.state).sort()
    // 1 active(原始) + 1 active(撤销 reject 新行) + 1 superseded + 1 tombstone = 4 行
    assert.equal(cov.broad.length, 4)
    assert.deepEqual(states, ["active", "active", "superseded", "tombstone"])
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · getCoverage 跨 room 隔离", () => {
  const { svc, close, tmp } = makeService()
  try {
    svc.commitDecision("R-201", {
      kind: "commit",
      content: "a",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })
    svc.commitDecision("R-202", {
      kind: "commit",
      content: "b",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })
    svc.commitDecision("R-202", {
      kind: "commit",
      content: "c",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })

    assert.equal(svc.getCoverage("R-201").broad.length, 1)
    assert.equal(svc.getCoverage("R-202").broad.length, 2)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · sourceMessageIds 映射 message → msg:<ref>, decision → decision:<ref>", () => {
  const { svc, db, close, tmp } = makeService()
  try {
    const res = svc.commitDecision("R-201", {
      kind: "commit",
      content: "x",
      evidence: [
        { kind: "message", ref: "m-100" },
        { kind: "decision", ref: "42" },
      ],
      callerAlias: "小孙",
    })
    const client = getSqliteClient(db)
    const row = client
      .prepare("SELECT source_message_ids FROM room_decisions WHERE decision_id = ?")
      .get(Number(res.decisionId)) as { source_message_ids: string }
    assert.deepEqual(JSON.parse(row.source_message_ids), ["msg:m-100", "decision:42"])
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · clock 注入 → appendedAt 确定", () => {
  const fixed = new Date("2026-05-21T08:00:00Z")
  const { svc, close, tmp } = makeService({ clock: fixed })
  try {
    const res = svc.commitDecision("R-201", {
      kind: "commit",
      content: "x",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })
    assert.equal(res.appendedAt, "2026-05-21T08:00:00.000Z")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · fencingToken 注入 → 写入审计可追", () => {
  const { svc, db, close, tmp } = makeService({ token: "fence-test-abc" })
  try {
    const res = svc.commitDecision("R-201", {
      kind: "commit",
      content: "x",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })
    const client = getSqliteClient(db)
    const row = client
      .prepare("SELECT fencing_token FROM room_decisions WHERE decision_id = ?")
      .get(Number(res.decisionId)) as { fencing_token: string }
    assert.equal(row.fencing_token, "fence-test-abc")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 6 · DecisionService · ledgerCursor 推进 = MAX(decision_id)", () => {
  const { svc, close, tmp } = makeService()
  try {
    const r1 = svc.commitDecision("R-201", {
      kind: "commit",
      content: "1",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })
    const r2 = svc.commitDecision("R-201", {
      kind: "commit",
      content: "2",
      evidence: [{ kind: "message", ref: "m" }],
      callerAlias: "小孙",
    })
    assert.equal(r2.ledgerCursor, Number(r2.decisionId))
    assert.ok(r2.ledgerCursor > r1.ledgerCursor)
  } finally {
    close()
    safeCleanup(tmp)
  }
})
