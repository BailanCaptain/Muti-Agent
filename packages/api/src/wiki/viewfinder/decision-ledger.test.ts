/**
 * F027 P12 · DecisionLedger 测试
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1194-1235
 *
 * 覆盖：
 *   - append: 写入 + sourceHash 自动算 + lastInsertRowid 返回
 *   - revoke: 写新 reject 行 + UPDATE 旧行 superseded_by
 *   - tombstone: markTombstone 需 fencingToken 一致
 *   - getActive: superseded_by IS NULL 自然过滤
 *   - getTombstone: tombstone=1 包含被 supersede 的（关键决策永存）
 *   - revoke race: 重复 revoke 同一行 → 第二次抛
 */

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { DecisionLedger } from "./decision-ledger"
import { ViewfinderError } from "./types"

function makeDb(): {
  db: ReturnType<typeof createDrizzleDb>["raw"]
  close: () => void
} {
  const dir = mkdtempSync(path.join(tmpdir(), "decision-ledger-test-"))
  const dbPath = path.join(dir, "test.sqlite")
  const { raw, close } = createDrizzleDb(dbPath)
  return {
    db: raw,
    close: () => {
      close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex")
}

const FENCING = "leader-1:term-1"
const ROOM = "R-201"

describe("DecisionLedger.append", () => {
  it("写入决策行，sourceHash 自动算，返回 lastInsertRowid > 0", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const id = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "F027 P12 走 rule-based 模板 + LLM extractor",
        sourceMessageIds: ["msg-100"],
        sourceQuote: "1A 模板填空",
        fencingToken: FENCING,
        extractorConfidence: 0.85,
      })
      assert.equal(typeof id, "number")
      assert.ok(id > 0, "decisionId 必须 > 0")
      const row = ledger.getById(id)
      assert.ok(row, "刚 append 必须能 getById")
      assert.equal(row?.sourceHash, sha256("1A 模板填空"), "sourceHash 必须 sha256(sourceQuote)")
      assert.equal(row?.tombstone, false, "默认 tombstone=false")
      assert.equal(row?.supersededBy, null)
      assert.equal(row?.extractorConfidence, 0.85)
      assert.deepEqual(row?.sourceMessageIds, ["msg-100"])
    } finally {
      close()
    }
  })

  it("tombstone=true 直接写入", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const id = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "reject",
        content: "不要回到 V12 一气呵成的拆法",
        sourceMessageIds: ["msg-180"],
        sourceQuote: "不回 V12",
        fencingToken: FENCING,
        tombstone: true,
      })
      const row = ledger.getById(id)
      assert.equal(row?.tombstone, true)
    } finally {
      close()
    }
  })
})

describe("DecisionLedger.revoke (append-only 纠错)", () => {
  it("写新 reject 行 + UPDATE 旧行 superseded_by = newId", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const oldId = ledger.append({
        roomId: ROOM,
        decidedBy: "黄仁勋",
        decisionType: "commit",
        content: "LLM 误判：'已合并' 当 commit 写入",
        sourceMessageIds: ["msg-200"],
        sourceQuote: "已合并",
        fencingToken: FENCING,
      })
      const newId = ledger.revoke({
        oldDecisionId: oldId,
        reason: "误判：'已合并' 是询问不是决策",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })
      assert.ok(newId > oldId, "revoke 写新行")
      const oldRow = ledger.getById(oldId)
      assert.equal(oldRow?.supersededBy, newId, "旧行 superseded_by = newId")
      // 旧行的 content / sourceQuote / sourceHash 不变（append-only）
      assert.equal(oldRow?.content, "LLM 误判：'已合并' 当 commit 写入")
      assert.equal(oldRow?.sourceQuote, "已合并")
      const newRow = ledger.getById(newId)
      assert.equal(newRow?.decisionType, "reject")
      assert.match(newRow?.content ?? "", /撤销 D-/, "新行 content 引用旧 decision")
      assert.deepEqual(newRow?.sourceMessageIds, [`decision:${oldId}`])
    } finally {
      close()
    }
  })

  it("重复 revoke 同一行 → 第二次抛 ViewfinderError", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const oldId = ledger.append({
        roomId: ROOM,
        decidedBy: "黄仁勋",
        decisionType: "commit",
        content: "test",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      ledger.revoke({
        oldDecisionId: oldId,
        reason: "first revoke",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })
      assert.throws(
        () =>
          ledger.revoke({
            oldDecisionId: oldId,
            reason: "second revoke",
            decidedBy: "小孙",
            fencingToken: FENCING,
          }),
        (err: unknown) =>
          err instanceof ViewfinderError &&
          err.stage === "ledger_revoke" &&
          /already superseded/.test(err.message),
        "重复 revoke 必须抛 ViewfinderError(ledger_revoke)",
      )
    } finally {
      close()
    }
  })

  it("revoke 不存在的 decision_id → 抛 ViewfinderError", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      assert.throws(
        () =>
          ledger.revoke({
            oldDecisionId: 99999,
            reason: "not exist",
            decidedBy: "小孙",
            fencingToken: FENCING,
          }),
        (err: unknown) => err instanceof ViewfinderError && /not found/.test(err.message),
      )
    } finally {
      close()
    }
  })

  it("F027 final-vision P1-1 P2: revoke 接受 extraSourceMessageIds → 合并到新行 source_message_ids", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const oldId = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "旧决策",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      const newId = ledger.revoke({
        oldDecisionId: oldId,
        reason: "拒绝原因",
        decidedBy: "小孙",
        fencingToken: FENCING,
        extraSourceMessageIds: ["msg:trigger-1", "msg:trigger-2"],
      })
      const newRow = ledger.getById(newId)
      assert.ok(newRow)
      assert.deepEqual(
        newRow.sourceMessageIds,
        [`decision:${oldId}`, "msg:trigger-1", "msg:trigger-2"],
        "revoke 新行 source_message_ids 必须含 decision:<oldId> + extraSourceMessageIds",
      )
    } finally {
      close()
    }
  })
})

describe("DecisionLedger.supersede (F027 final-vision P1-1)", () => {
  it("supersede: 写新 commit 行 + UPDATE 旧行 superseded_by + status=superseded", () => {
    const { db, close } = makeDb()
    try {
      let n = 0
      const ledger = new DecisionLedger(db, () => {
        n++
        return `2026-05-27T1${n}:00:00Z`
      })
      const oldId = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "旧 spec: ingest 走 LLM compile",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      const newId = ledger.supersede({
        oldDecisionId: oldId,
        reason: "新 spec: ingest 走 sanitized markdown 直接落盘",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })

      assert.notEqual(newId, oldId)
      const newRow = ledger.getById(newId)
      assert.ok(newRow)
      assert.equal(newRow.decisionType, "commit", "supersede 新行必须是 commit 类型 (不是 reject)")
      assert.equal(
        newRow.content,
        "新 spec: ingest 走 sanitized markdown 直接落盘",
        "supersede 新行 content 直接是 reason 原文 (不加 '撤销 D-X:' 前缀)",
      )
      assert.deepEqual(newRow.sourceMessageIds, [`decision:${oldId}`])

      const oldRow = ledger.getById(oldId)
      assert.ok(oldRow)
      assert.equal(oldRow.supersededBy, newId, "旧行 superseded_by = 新 commit id")
      assert.equal(oldRow.status, "superseded", "旧行 status = superseded")
    } finally {
      close()
    }
  })

  it("supersede: 接受 extraSourceMessageIds → 合并到新行 source_message_ids", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-27T11:00:00Z")
      const oldId = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "旧",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      const newId = ledger.supersede({
        oldDecisionId: oldId,
        reason: "新",
        decidedBy: "小孙",
        fencingToken: FENCING,
        extraSourceMessageIds: ["msg:abc", "msg:def"],
      })
      const newRow = ledger.getById(newId)
      assert.ok(newRow)
      assert.deepEqual(newRow.sourceMessageIds, [`decision:${oldId}`, "msg:abc", "msg:def"])
    } finally {
      close()
    }
  })

  it("supersede 不存在的 decision_id → 抛 ViewfinderError", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-27T10:00:00Z")
      assert.throws(
        () =>
          ledger.supersede({
            oldDecisionId: 99999,
            reason: "x",
            decidedBy: "小孙",
            fencingToken: FENCING,
          }),
        (err: unknown) => err instanceof ViewfinderError && /not found/.test(err.message),
      )
    } finally {
      close()
    }
  })

  it("supersede 已被 supersede 的 decision → 抛 ViewfinderError(already superseded)", () => {
    const { db, close } = makeDb()
    try {
      let n = 0
      const ledger = new DecisionLedger(db, () => {
        n++
        return `2026-05-27T1${n}:00:00Z`
      })
      const oldId = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "old",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      ledger.supersede({
        oldDecisionId: oldId,
        reason: "first",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })
      assert.throws(
        () =>
          ledger.supersede({
            oldDecisionId: oldId,
            reason: "second",
            decidedBy: "小孙",
            fencingToken: FENCING,
          }),
        (err: unknown) => err instanceof ViewfinderError && /already superseded/.test(err.message),
      )
    } finally {
      close()
    }
  })
})

describe("DecisionLedger.markTombstone (fencingToken 校验)", () => {
  it("fencingToken 一致 → UPDATE 成功", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const id = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "F027 V16.5 立项",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "立项",
        fencingToken: FENCING,
      })
      const ok = ledger.markTombstone(id, FENCING)
      assert.equal(ok, true)
      assert.equal(ledger.getById(id)?.tombstone, true)
    } finally {
      close()
    }
  })

  it("fencingToken 不一致（错 leader / race） → UPDATE noop 返 false", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const id = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "test",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      const ok = ledger.markTombstone(id, "wrong-leader:term-99")
      assert.equal(ok, false, "fencing 不一致必须 noop")
      assert.equal(ledger.getById(id)?.tombstone, false, "原行 tombstone 没动")
    } finally {
      close()
    }
  })
})

describe("DecisionLedger.markCompleted (P4 C-auto-2 自动 sweep)", () => {
  it("把 active commit 标 completed，getActive 自动排除", () => {
    const { db, close } = makeDb()
    try {
      let n = 0
      const ledger = new DecisionLedger(db, () => {
        n++
        return `2026-05-08T0${n}:00:00Z`
      })
      const d1 = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "进 merger-gate",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "进 merger-gate",
        fencingToken: FENCING,
      })
      const d2 = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "F026 已合 dev",
        sourceMessageIds: ["msg-2"],
        sourceQuote: "F026 已合",
        fencingToken: FENCING,
      })
      // 模拟 extractor 写 d2 后判定 d1 已完成
      const completedIds = ledger.markCompleted([d1], FENCING)
      assert.deepEqual(completedIds, [d1], "返回实际改成功 id")
      const active = ledger.getActiveDecisions(ROOM)
      const activeIds = active.map((r) => r.decisionId)
      assert.ok(!activeIds.includes(d1), `D-${d1} sweep 后不在 active`)
      assert.ok(activeIds.includes(d2), `D-${d2} 仍 active`)
      // 验证 status 字段确实变了
      const d1Row = ledger.getById(d1)
      assert.equal(d1Row?.status, "completed")
      const d2Row = ledger.getById(d2)
      assert.equal(d2Row?.status, "active")
    } finally {
      close()
    }
  })

  it("已 completed 的 decision 重复 markCompleted → 跳过（idempotent）", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const id = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "test",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      const first = ledger.markCompleted([id], FENCING)
      assert.deepEqual(first, [id])
      const second = ledger.markCompleted([id], FENCING)
      assert.deepEqual(second, [], "已 completed 不再标")
    } finally {
      close()
    }
  })

  it("已 superseded 的 decision 不被 markCompleted 影响（防覆盖 revoke 状态）", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const oldId = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "原决策",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "原",
        fencingToken: FENCING,
      })
      ledger.revoke({
        oldDecisionId: oldId,
        reason: "误判",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })
      // 此时 oldId status='superseded'，markCompleted 不该改它
      const completed = ledger.markCompleted([oldId], FENCING)
      assert.deepEqual(completed, [], "superseded 不被 sweep 改写")
      assert.equal(ledger.getById(oldId)?.status, "superseded")
    } finally {
      close()
    }
  })

  it("fencingToken 不一致 → 全部跳过（防错 leader / race）", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const id = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "test",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "test",
        fencingToken: FENCING,
      })
      const completed = ledger.markCompleted([id], "wrong-leader:term-99")
      assert.deepEqual(completed, [])
      assert.equal(ledger.getById(id)?.status, "active", "原状态不动")
    } finally {
      close()
    }
  })

  it("空 ids[] → 返空 []，0 SQL", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "t")
      assert.deepEqual(ledger.markCompleted([], FENCING), [])
    } finally {
      close()
    }
  })

  it("混合 active + completed + superseded → 只对 active 生效", () => {
    const { db, close } = makeDb()
    try {
      let n = 0
      const ledger = new DecisionLedger(db, () => {
        n++
        return `2026-05-13T10:${String(n).padStart(2, "0")}:00Z`
      })
      const dActive = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "active",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "a",
        fencingToken: FENCING,
      })
      const dCompleted = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "completed",
        sourceMessageIds: ["msg-2"],
        sourceQuote: "c",
        fencingToken: FENCING,
      })
      ledger.markCompleted([dCompleted], FENCING)
      const dSuperseded = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "superseded",
        sourceMessageIds: ["msg-3"],
        sourceQuote: "s",
        fencingToken: FENCING,
      })
      ledger.revoke({
        oldDecisionId: dSuperseded,
        reason: "rv",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })
      // 一次性传所有三个 → 只有 dActive 被标 completed
      const result = ledger.markCompleted([dActive, dCompleted, dSuperseded], FENCING)
      assert.deepEqual(result, [dActive])
    } finally {
      close()
    }
  })
})

describe("DecisionLedger 查询", () => {
  it("getActiveDecisions 自然过滤 superseded_by NOT NULL", () => {
    const { db, close } = makeDb()
    try {
      let now = 1
      const ledger = new DecisionLedger(db, () => `2026-05-13T10:00:0${now}Z`)
      now = 1
      const id1 = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "decision 1",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "1",
        fencingToken: FENCING,
      })
      now = 2
      const id2 = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "decision 2",
        sourceMessageIds: ["msg-2"],
        sourceQuote: "2",
        fencingToken: FENCING,
      })
      now = 3
      ledger.revoke({
        oldDecisionId: id1,
        reason: "误判",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })

      const active = ledger.getActiveDecisions(ROOM)
      const activeIds = active.map((r) => r.decisionId).sort()
      assert.ok(!activeIds.includes(id1), `revoke 后旧 D-${id1} 不该在 active 列表`)
      assert.ok(activeIds.includes(id2), `D-${id2} 仍 active`)
    } finally {
      close()
    }
  })

  it("getTombstoneDecisions 包含被 supersede 的（关键决策原文永存）", () => {
    const { db, close } = makeDb()
    try {
      const ledger = new DecisionLedger(db, () => "2026-05-13T10:00:00Z")
      const id = ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "立项 F027 V16.5",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "立项",
        fencingToken: FENCING,
        tombstone: true,
      })
      // 模拟后续被 supersede（极端情况：tombstone 决策被 revoke）
      ledger.revoke({
        oldDecisionId: id,
        reason: "立项调整",
        decidedBy: "小孙",
        fencingToken: FENCING,
      })
      const tombstones = ledger.getTombstoneDecisions(ROOM)
      assert.equal(tombstones.length, 1, "tombstone 决策原文永存（即便被 supersede）")
      assert.equal(tombstones[0].content, "立项 F027 V16.5")
    } finally {
      close()
    }
  })

  it("getActiveByType 按 type 过滤 + 最新在前", () => {
    const { db, close } = makeDb()
    try {
      let n = 0
      const ledger = new DecisionLedger(db, () => {
        n++
        return `2026-05-13T10:00:${String(n).padStart(2, "0")}Z`
      })
      ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "c1",
        sourceMessageIds: ["msg-1"],
        sourceQuote: "1",
        fencingToken: FENCING,
      })
      ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "spec",
        content: "s1",
        sourceMessageIds: ["msg-2"],
        sourceQuote: "2",
        fencingToken: FENCING,
      })
      ledger.append({
        roomId: ROOM,
        decidedBy: "小孙",
        decisionType: "commit",
        content: "c2",
        sourceMessageIds: ["msg-3"],
        sourceQuote: "3",
        fencingToken: FENCING,
      })
      const commits = ledger.getActiveByType(ROOM, "commit")
      assert.equal(commits.length, 2)
      assert.equal(commits[0].content, "c2", "最新在前")
      assert.equal(commits[1].content, "c1")
    } finally {
      close()
    }
  })
})
