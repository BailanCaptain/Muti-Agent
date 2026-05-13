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
