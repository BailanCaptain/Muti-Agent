/**
 * F026 Phase 2 · 收官 scenario 验收
 *
 * 这批测试不是单元级（每个组件已各自有单测），也不是完整 end-to-end（那属于
 * preview 层手工验证）。它的职责是 **把 Phase 2 落地的多个组件拼起来跑真场景**，
 * 作为 Phase 2 的 AC 证据：call-tree 引擎在组合调用下的行为正确、状态机边界
 * 正确、timeoutScan 的语义面向"已调度 working 件"而非 pending 件。
 *
 * 覆盖的 scenario（Phase 2 剧本清单对应 S1/S3/S4/S5）：
 *   S1  单叫 open→advance→settle · pendingOf 流转
 *   S3  2 层嵌套：叶子 settle 不自动级联回父/根（本层是"真相源"而非 orchestrator）
 *   S4  timeoutScan 只扫 working 且只扫过期的——pending / 未过期 / 终态都不动
 *   S5  多子叶交互：同父下两子分别 done/timeout，pendingOf 归零但父仍 working
 *
 * 不覆盖（已有专测覆盖，本文件不重复）：
 *   - R-184 same-turn single-row（see a2a-replay/R-184-same-turn-single-row.test.ts）
 *   - ADR-004 透明性 content-layer guard（Task F）
 *   - mention-router 三层识别（layer1/layer2 专测）
 *   - rate-limiter 30s 窗口 + dedup（rate-limiter 专测）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { SqliteStore } from "../../db/sqlite"
import { CallRegistry } from "../../orchestrator/call-registry"

type Harness = {
  registry: CallRegistry
  store: SqliteStore
  /** 把墙钟拨到某个 ISO 时间（下次 registry.now() 会返回它） */
  setClock: (iso: string) => void
  close: () => void
}

function tmp(startIso = "2026-04-24T10:00:00.000Z"): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-phase2-scenarios-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  let clockMs = Date.parse(startIso)
  const now = () => new Date(clockMs).toISOString()
  const registry = new CallRegistry({ db: store.db, now })
  return {
    registry,
    store,
    setClock: (iso: string) => {
      clockMs = Date.parse(iso)
    },
    close: () => {
      try {
        store.db.close()
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

test("F026 Phase 2 · S1 单叫 · openCall → advance(working) → settle(done) · pendingOf 前后流转 0→1→0", () => {
  const h = tmp()
  try {
    const rootCallId = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "group-S1",
      deadlineAt: "2026-04-24T11:00:00.000Z",
    })
    const childCallId = h.registry.openCall({
      parentCallId: rootCallId,
      issuerId: "agent:黄仁勋",
      convenerId: "user:小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "group-S1",
      deadlineAt: "2026-04-24T11:00:00.000Z",
    })

    // 刚 open：child 是 pending，父视角下 pendingOf = 1
    assert.equal(
      h.registry.pendingOf(rootCallId).length,
      1,
      "newly opened child must be in pendingOf(parent)",
    )
    assert.equal(h.registry.get(childCallId)!.status, "pending")

    // advance 到 working：CAS 成功一次
    assert.equal(
      h.registry.advance(childCallId, "working"),
      true,
      "first advance to working must succeed",
    )
    assert.equal(h.registry.get(childCallId)!.status, "working")
    // pendingOf 仍然包含（pendingOf 涵盖 pending+working）
    assert.equal(
      h.registry.pendingOf(rootCallId).length,
      1,
      "working child still counts as pending-from-parent",
    )

    // 重复 advance：CAS 应返回 false（不再是 pending）
    assert.equal(
      h.registry.advance(childCallId, "working"),
      false,
      "double-advance must be CAS-rejected",
    )

    // settle 到 done
    assert.equal(h.registry.settle(childCallId, "done"), true)
    assert.equal(h.registry.get(childCallId)!.status, "done")
    assert.equal(
      h.registry.pendingOf(rootCallId).length,
      0,
      "settled child must not appear in pendingOf",
    )

    // 终态二次 settle 必须被 CAS 拒绝
    assert.equal(h.registry.settle(childCallId, "failed"), false, "terminal status is immutable")
    assert.equal(
      h.registry.get(childCallId)!.status,
      "done",
      "terminal row must not mutate on rejected CAS",
    )
  } finally {
    h.close()
  }
})

test("F026 Phase 2 · S3 2 层嵌套 · 叶子 settle 不自动级联 · call-tree 真相源是展开结构不是瀑布", () => {
  const h = tmp()
  try {
    const rootId = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g-S3",
      deadlineAt: "2026-04-24T11:00:00.000Z",
    })
    const midId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "agent:黄仁勋",
      convenerId: "user:小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g-S3",
      deadlineAt: "2026-04-24T11:00:00.000Z",
    })
    const leafId = h.registry.openCall({
      parentCallId: midId,
      issuerId: "agent:范德彪",
      convenerId: "agent:黄仁勋",
      replyTo: "agent:范德彪",
      sessionGroupId: "g-S3",
      deadlineAt: "2026-04-24T11:00:00.000Z",
    })

    // tree 形状：3 行全挂同一 root_call_id，parent_call_id 形成链
    const tree = h.registry.getTree(rootId)
    assert.equal(tree.length, 3, "tree must contain root + mid + leaf")
    const byId = new Map(tree.map((r) => [r.callId, r]))
    assert.equal(byId.get(rootId)!.parentCallId, null)
    assert.equal(byId.get(midId)!.parentCallId, rootId)
    assert.equal(byId.get(leafId)!.parentCallId, midId)
    for (const row of tree) {
      assert.equal(
        row.rootCallId,
        rootId,
        `every node in tree shares rootCallId (node ${row.callId})`,
      )
    }

    // 叶子 settle 后：mid 和 root 必须保持 pending（本层不级联）
    assert.equal(h.registry.settle(leafId, "done"), true)
    assert.equal(h.registry.get(leafId)!.status, "done")
    assert.equal(h.registry.get(midId)!.status, "pending", "leaf settle must NOT cascade to mid")
    assert.equal(h.registry.get(rootId)!.status, "pending", "leaf settle must NOT cascade to root")

    // pendingOf(mid) 必须立刻反映叶子已结算
    assert.equal(h.registry.pendingOf(midId).length, 0)
    // pendingOf(root) 仍然返回 mid（mid 还没 settle）
    const pendingUnderRoot = h.registry.pendingOf(rootId)
    assert.equal(pendingUnderRoot.length, 1)
    assert.equal(pendingUnderRoot[0].callId, midId)
  } finally {
    h.close()
  }
})

test("F026 Phase 2 · S4 timeoutScan 边界 · 只扫 working+过期 · pending/未过期/终态全不动", () => {
  const h = tmp("2026-04-24T10:00:00.000Z")
  try {
    const rootId = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g-S4",
      deadlineAt: "2026-04-24T12:00:00.000Z",
    })

    // A: working + 已过期 deadline —— 应该被扫
    const aId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "agent:黄仁勋",
      convenerId: "user:小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g-S4",
      deadlineAt: "2026-04-24T10:30:00.000Z",
    })
    h.registry.advance(aId, "working")

    // B: working + 未过期 deadline —— 不动
    const bId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "agent:范德彪",
      convenerId: "user:小孙",
      replyTo: "agent:范德彪",
      sessionGroupId: "g-S4",
      deadlineAt: "2026-04-24T13:00:00.000Z",
    })
    h.registry.advance(bId, "working")

    // C: pending + 已过期 —— 不动（F026 语义：pending = 尚未调度，timeout 只针对 working）
    const cId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "agent:桂芬",
      convenerId: "user:小孙",
      replyTo: "agent:桂芬",
      sessionGroupId: "g-S4",
      deadlineAt: "2026-04-24T10:30:00.000Z",
    })
    // 注意 C 不 advance

    // D: done + 已过期 —— 终态不可变
    const dId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "agent:黄仁勋",
      convenerId: "user:小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g-S4",
      deadlineAt: "2026-04-24T10:30:00.000Z",
    })
    h.registry.advance(dId, "working")
    assert.equal(h.registry.settle(dId, "done"), true)

    // 墙钟推进到 11:00（A/C/D 的 deadline 都已过，B 未过）
    h.setClock("2026-04-24T11:00:00.000Z")

    const swept = h.registry.timeoutScan()
    assert.equal(swept, 1, "only A should be swept (working+expired) — B未过 · C非working · D终态")
    assert.equal(h.registry.get(aId)!.status, "timeout", "A: working+过期 → timeout")
    assert.equal(h.registry.get(bId)!.status, "working", "B: working+未过期 → 保持")
    assert.equal(h.registry.get(cId)!.status, "pending", "C: pending+过期 → 保持（pending 不被扫）")
    assert.equal(h.registry.get(dId)!.status, "done", "D: 终态 → 不可变")
  } finally {
    h.close()
  }
})

test("F026 Phase 2 · S5 多子叶交互 · 同父下两子分别 done/timeout · pendingOf 归零但父行自己保持原状态", () => {
  const h = tmp()
  try {
    const parentId = h.registry.openCall({
      issuerId: "agent:黄仁勋",
      convenerId: "user:小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g-S5",
      deadlineAt: "2026-04-24T12:00:00.000Z",
    })
    const leftId = h.registry.openCall({
      parentCallId: parentId,
      issuerId: "agent:范德彪",
      convenerId: "agent:黄仁勋",
      replyTo: "agent:范德彪",
      sessionGroupId: "g-S5",
      deadlineAt: "2026-04-24T12:00:00.000Z",
    })
    const rightId = h.registry.openCall({
      parentCallId: parentId,
      issuerId: "agent:桂芬",
      convenerId: "agent:黄仁勋",
      replyTo: "agent:桂芬",
      sessionGroupId: "g-S5",
      deadlineAt: "2026-04-24T12:00:00.000Z",
    })

    assert.equal(
      h.registry.pendingOf(parentId).length,
      2,
      "two siblings both pending from parent's view",
    )

    // 一个 settle done，另一个 settle timeout（直接终态，模拟调度层判超时后显式结算）
    assert.equal(h.registry.settle(leftId, "done"), true)
    assert.equal(h.registry.settle(rightId, "timeout"), true)

    // 父视角下 pendingOf 归零
    assert.equal(h.registry.pendingOf(parentId).length, 0)

    // 父自己的行保持 pending（本层不自动级联 —— 级联策略由 orchestrator 层决定）
    assert.equal(
      h.registry.get(parentId)!.status,
      "pending",
      "two siblings all terminal must NOT auto-cascade to parent",
    )

    // tree 查询依然完整（3 行）
    const tree = h.registry.getTree(parentId)
    assert.equal(tree.length, 3)
    const statuses = new Map(tree.map((r) => [r.callId, r.status]))
    assert.equal(statuses.get(parentId), "pending")
    assert.equal(statuses.get(leftId), "done")
    assert.equal(statuses.get(rightId), "timeout")
  } finally {
    h.close()
  }
})
