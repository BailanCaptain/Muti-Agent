import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { SqliteStore } from "../db/sqlite"
import { CallRegistry, type CallStatus } from "./call-registry"

function tmp(): { registry: CallRegistry; store: SqliteStore; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-call-registry-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  const clock = Date.parse("2026-04-23T13:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const registry = new CallRegistry({ db: store.db, now })
  return {
    registry,
    store,
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

test("F026 ADR-002: openCall inserts row and returns call_id", () => {
  const h = tmp()
  try {
    const callId = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "group-A",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    assert.ok(typeof callId === "string" && callId.length > 0)
    const row = h.store.db
      .prepare("SELECT * FROM a2a_calls WHERE call_id = ?")
      .get(callId) as Record<string, unknown>
    assert.equal(row.parent_call_id, null)
    assert.equal(row.root_call_id, callId, "root = self when no parent")
    assert.equal(row.issuer_id, "黄仁勋")
    assert.equal(row.convener_id, "小孙")
    assert.equal(row.status, "pending")
    assert.equal(row.envelope_version, "v1")
  } finally {
    h.close()
  }
})

test("F026 ADR-002: child call inherits root_call_id from parent", () => {
  const h = tmp()
  try {
    const rootId = h.registry.openCall({
      issuerId: "小孙",
      convenerId: "小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const childId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "黄仁勋",
      convenerId: "小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const grandId = h.registry.openCall({
      parentCallId: childId,
      issuerId: "范德彪",
      convenerId: "黄仁勋",
      replyTo: "agent:范德彪",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const grand = h.store.db
      .prepare("SELECT root_call_id, parent_call_id FROM a2a_calls WHERE call_id = ?")
      .get(grandId) as Record<string, string>
    assert.equal(grand.parent_call_id, childId)
    assert.equal(grand.root_call_id, rootId, "root propagates through 3 levels")
  } finally {
    h.close()
  }
})

test("F026 ADR-002: openCall throws on unknown parent_call_id", () => {
  const h = tmp()
  try {
    assert.throws(() =>
      h.registry.openCall({
        parentCallId: "does-not-exist",
        issuerId: "X",
        convenerId: "Y",
        replyTo: "r",
        sessionGroupId: "g",
        deadlineAt: "2026-04-23T14:00:00.000Z",
      }),
    )
  } finally {
    h.close()
  }
})

test("F026 ADR-002: pendingOf(parent) returns only pending+working siblings", () => {
  const h = tmp()
  try {
    const parent = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const c1 = h.registry.openCall({
      parentCallId: parent,
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const c2 = h.registry.openCall({
      parentCallId: parent,
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const c3 = h.registry.openCall({
      parentCallId: parent,
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    h.registry.settle(c1, "done")
    // c2 still pending, c3 advanced to working
    assert.equal(h.registry.advance(c3, "working"), true)

    const pending = h.registry.pendingOf(parent)
    const ids = pending.map((c) => c.callId).sort()
    assert.deepEqual(ids, [c2, c3].sort())
  } finally {
    h.close()
  }
})

test("F026 ADR-002 + I4 CAS: settle is idempotent on terminal state (second settle returns false)", () => {
  const h = tmp()
  try {
    const id = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    assert.equal(h.registry.settle(id, "done"), true, "first settle succeeds")
    assert.equal(
      h.registry.settle(id, "done"),
      false,
      "second settle on terminal state must not re-enter",
    )
  } finally {
    h.close()
  }
})

test("F026 ADR-002: settle fails when target status is not terminal", () => {
  const h = tmp()
  try {
    const id = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    // @ts-expect-error — passing intermediate status to settle is illegal
    assert.throws(() => h.registry.settle(id, "working"), /terminal/)
  } finally {
    h.close()
  }
})

test("F026 ADR-002: advance transitions follow state machine", () => {
  const h = tmp()
  try {
    const id = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    assert.equal(h.registry.advance(id, "working"), true)
    assert.equal(
      h.registry.advance(id, "working"),
      false,
      "cannot re-advance to working from working (CAS)",
    )
  } finally {
    h.close()
  }
})

test("F026 I4: timeoutScan marks past-deadline working calls as timeout", () => {
  const h = tmp()
  try {
    const id = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T12:00:00.000Z",
    }) // deadline in past
    h.registry.advance(id, "working")
    const swept = h.registry.timeoutScan()
    assert.equal(swept, 1)
    const row = h.store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(id) as {
      status: CallStatus
    }
    assert.equal(row.status, "timeout")
  } finally {
    h.close()
  }
})

test("F026 I4: timeoutScan does not touch non-working or non-expired calls", () => {
  const h = tmp()
  try {
    const a = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    }) // future
    h.registry.advance(a, "working")
    const b = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T12:00:00.000Z",
    }) // past but still pending
    h.registry.timeoutScan()
    const rowA = h.store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(a) as {
      status: string
    }
    const rowB = h.store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(b) as {
      status: string
    }
    assert.equal(rowA.status, "working", "future deadline must not be swept")
    assert.equal(rowB.status, "pending", "timeoutScan only acts on working state")
  } finally {
    h.close()
  }
})

test("F026 ADR-002: getTree returns all calls sharing root_call_id", () => {
  const h = tmp()
  try {
    const r = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const c1 = h.registry.openCall({
      parentCallId: r,
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const c2 = h.registry.openCall({
      parentCallId: c1,
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const tree = h.registry.getTree(r)
    const ids = tree.map((c) => c.callId).sort()
    assert.deepEqual(ids, [r, c1, c2].sort())
  } finally {
    h.close()
  }
})

test("F026 I7 fuzz: 100-deep call tree builds without stack overflow", () => {
  const h = tmp()
  try {
    let prev: string | undefined
    let root: string | null = null
    for (let i = 0; i < 100; i++) {
      const id: string = h.registry.openCall({
        parentCallId: prev,
        issuerId: `agent-${i}`,
        convenerId: "root",
        replyTo: "r",
        sessionGroupId: "g",
        deadlineAt: "2026-04-23T14:00:00.000Z",
      })
      if (!root) root = id
      prev = id
    }
    assert.ok(root)
    const tree = h.registry.getTree(root!)
    assert.equal(tree.length, 100)
  } finally {
    h.close()
  }
})

// ── F026 P4 T1 · STALE 双档 ──────────────────────────────────────────
// spec line 373: STALE 阈值扫描任务（60s queued / 10min processing）
// pending = queued, working = processing。pending 超阈值无 advance → timeout，
// 防 dispatch 失踪后 pending 永挂死。

function tmpClock(): {
  registry: CallRegistry
  store: SqliteStore
  tick: (ms: number) => void
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p4-t1-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  let clock = Date.parse("2026-04-29T12:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const registry = new CallRegistry({ db: store.db, now })
  return {
    registry,
    store,
    tick: (ms: number) => {
      clock += ms
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

test("F026 P4 T1: timeoutScan with stalePendingMs sweeps pending older than threshold", () => {
  // P2 v2 review#2 修订：场景必须是"child 无 active worklist 承载"才符合
  // dispatch 失踪语义；root call 不参与 stale-pending 扫描。
  const h = tmpClock()
  try {
    const rootId = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    const id = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "B",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    h.tick(61_000)
    const swept = h.registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(swept, 1, "orphan child older than stalePendingMs must be swept")
    const row = h.store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(id) as {
      status: CallStatus
    }
    assert.equal(row.status, "timeout")
  } finally {
    h.close()
  }
})

test("F026 P4 T1: timeoutScan keeps fresh pending within stalePendingMs window", () => {
  const h = tmpClock()
  try {
    const id = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    h.tick(30_000)
    const swept = h.registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(swept, 0, "fresh pending under threshold must not be swept")
    const row = h.store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(id) as {
      status: CallStatus
    }
    assert.equal(row.status, "pending")
  } finally {
    h.close()
  }
})

test("F026 P4 T1: timeoutScan sweeps stale-pending + past-deadline-working in one pass", () => {
  // P2 v2 review#2 修订：stale-pending 必须是 orphan child（无 active worklist），
  // working past deadline 不受 worklist 影响（working 分支只看 deadline）。
  const h = tmpClock()
  try {
    const wRoot = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T12:00:30.000Z", // 30s after fixture clock start
    })
    const w = h.registry.openCall({
      parentCallId: wRoot,
      issuerId: "B",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T12:00:30.000Z",
    })
    h.registry.advance(w, "working")
    const pRoot = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    const p = h.registry.openCall({
      parentCallId: pRoot,
      issuerId: "B",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    h.tick(90_000) // past w deadline AND past p stalePendingMs (60s)
    const swept = h.registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(
      swept,
      2,
      "single timeoutScan must sweep both orphan-queued-stale and working-past-deadline",
    )
    const rows = h.store.db.prepare("SELECT call_id, status FROM a2a_calls").all() as {
      call_id: string
      status: string
    }[]
    const byId = new Map(rows.map((r) => [r.call_id, r.status]))
    assert.equal(byId.get(w), "timeout", "working past deadline → timeout")
    assert.equal(byId.get(p), "timeout", "orphan stale pending → timeout")
    assert.equal(byId.get(wRoot), "pending", "root must NOT be swept by stale-pending")
    assert.equal(byId.get(pRoot), "pending", "root must NOT be swept by stale-pending")
  } finally {
    h.close()
  }
})

test("F026 P4 T1: timeoutScan default (no opts) backwards-compatible — only working scanned", () => {
  // Existing call sites that don't pass stalePendingMs keep prior behavior:
  // pending stays pending. server.ts opts in explicitly via A2A_PENDING_STALE_MS.
  const h = tmpClock()
  try {
    const p = h.registry.openCall({
      issuerId: "A",
      convenerId: "A",
      replyTo: "r",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    h.tick(600_000) // 10 minutes — well past any plausible stale threshold
    h.registry.timeoutScan() // no opts
    const row = h.store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(p) as {
      status: CallStatus
    }
    assert.equal(row.status, "pending", "no stalePendingMs opt → pending untouched (back-compat)")
  } finally {
    h.close()
  }
})

// ─── F026 P2 v2 review#2 · timeoutScan 不能让 call/worklist 状态分裂 ──────
// 范德彪 review#2 P1：P4 T1 加 stalePendingMs 时漏 root + active-worklist-covered child。
// root 语义是「召集闭环」永不进 working；queued child 在 active worklist 排队 60s+ 是合法。
// 真孤儿 pending（无 worklist 承载）才该被标 timeout —— 保留 P4 T1 抗 dispatch 失踪初衷。

function insertActiveWorklist(
  store: SqliteStore,
  args: {
    worklistId: string
    parentCallId: string
    rootCallId: string
    sessionGroupId: string
    nowIso: string
  },
): void {
  store.db
    .prepare(
      `INSERT INTO a2a_worklists (
        worklist_id, parent_worklist_id, parent_call_id, root_call_id,
        session_group_id, items, current_index, status, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, '[]', 0, 'active', ?, ?)`,
    )
    .run(
      args.worklistId,
      args.parentCallId,
      args.rootCallId,
      args.sessionGroupId,
      args.nowIso,
      args.nowIso,
    )
}

test("F026 P2 v2 review#2: timeoutScan(stalePendingMs) preserves root call (parent IS NULL)", () => {
  const h = tmpClock()
  try {
    const rootId = h.registry.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user:user",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    h.tick(90_000) // past 60s stalePendingMs
    const swept = h.registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(swept, 0, "root call must NOT be swept — '召集闭环' 语义，无 dispatch 失踪概念")
    const row = h.store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(rootId) as {
      status: CallStatus
    }
    assert.equal(row.status, "pending", "root pending must stay pending")
  } finally {
    h.close()
  }
})

test("F026 P2 v2 review#2: timeoutScan(stalePendingMs) preserves child covered by active worklist", () => {
  const h = tmpClock()
  try {
    const rootId = h.registry.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user:user",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    const childId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "Coder",
      convenerId: "user",
      replyTo: "agent:Coder",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    insertActiveWorklist(h.store, {
      worklistId: "w-root",
      parentCallId: rootId,
      rootCallId: rootId,
      sessionGroupId: "g",
      nowIso: "2026-04-29T12:00:00.000Z",
    })
    h.tick(90_000)
    const swept = h.registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(
      swept,
      0,
      "queued child under active worklist must NOT be swept — dispatcher 仍在排队",
    )
    const childRow = h.store.db
      .prepare("SELECT status FROM a2a_calls WHERE call_id = ?")
      .get(childId) as { status: CallStatus }
    assert.equal(childRow.status, "pending", "active-worklist-covered child stays pending")
  } finally {
    h.close()
  }
})

test("F026 P2 v2 review#2: timeoutScan(stalePendingMs) still sweeps orphan pending child (no active worklist)", () => {
  // 真孤儿 pending：父 worklist 已 settled，child 却仍 pending —— 真正的 dispatch 失踪场景。
  // 保留 P4 T1 抗失踪初衷：这种 child 必须被 timeoutScan 扫到。
  const h = tmpClock()
  try {
    const rootId = h.registry.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user:user",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    const orphanChildId = h.registry.openCall({
      parentCallId: rootId,
      issuerId: "Coder",
      convenerId: "user",
      replyTo: "agent:Coder",
      sessionGroupId: "g",
      deadlineAt: "2026-04-29T13:00:00.000Z",
    })
    // 父 worklist 已 settled —— child 是真孤儿
    h.store.db
      .prepare(
        `INSERT INTO a2a_worklists (
          worklist_id, parent_worklist_id, parent_call_id, root_call_id,
          session_group_id, items, current_index, status, created_at, updated_at
        ) VALUES ('w-settled', NULL, ?, ?, 'g', '[]', 0, 'settled', ?, ?)`,
      )
      .run(rootId, rootId, "2026-04-29T12:00:00.000Z", "2026-04-29T12:00:00.000Z")
    h.tick(90_000)
    const swept = h.registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(swept, 1, "orphan pending child (no active worklist) must be swept")
    const childRow = h.store.db
      .prepare("SELECT status FROM a2a_calls WHERE call_id = ?")
      .get(orphanChildId) as { status: CallStatus }
    assert.equal(childRow.status, "timeout", "orphan child → timeout")
  } finally {
    h.close()
  }
})

// ─── F026 P5 T4 · pending_change WS emit ───────────────────────────────────

import type { RealtimeServerEvent } from "@multi-agent/shared"

function tmpWithBroadcaster(): {
  registry: CallRegistry
  store: SqliteStore
  events: RealtimeServerEvent[]
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p5-t4-pending-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  const clock = Date.parse("2026-04-29T13:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const events: RealtimeServerEvent[] = []
  const registry = new CallRegistry({
    db: store.db,
    now,
    broadcaster: { broadcast: (e) => events.push(e) },
  })
  return {
    registry,
    store,
    events,
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

test("F026 P5 T4 · openCall emits pending.change with empty pendingSet for new root", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    assert.equal(h.events.length, 1)
    const ev = h.events[0]
    assert.equal(ev.type, "pending.change")
    if (ev.type !== "pending.change") return
    assert.equal(ev.payload.rootCallId, root)
    assert.equal(ev.payload.parentCallId, root) // root 自身
    assert.equal(ev.payload.sessionGroupId, "g1")
    assert.deepEqual(ev.payload.pendingSet, []) // 没有 child → 空 set
  } finally {
    h.close()
  }
})

test("F026 P5 T4 · openCall child emits pending.change with sibling pendingSet", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const childA = h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    h.registry.openCall({
      parentCallId: root,
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "agent:桂芬",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    // 3 events: root + childA + childB
    assert.equal(h.events.length, 3)
    const last = h.events[2]
    if (last.type !== "pending.change") throw new Error("unexpected event type")
    assert.equal(last.payload.rootCallId, root)
    assert.equal(last.payload.pendingSet.length, 2) // childA + childB
    assert.deepEqual(last.payload.pendingSet.map((p) => p.alias).sort(), ["桂芬", "黄仁勋"])
    assert.ok(last.payload.pendingSet.some((p) => p.callId === childA && p.status === "pending"))
  } finally {
    h.close()
  }
})

test("F026 P5 T4 · advance emits pending.change with status=working", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const child = h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    h.events.length = 0 // reset
    h.registry.advance(child, "working")
    assert.equal(h.events.length, 1)
    const ev = h.events[0]
    if (ev.type !== "pending.change") throw new Error("unexpected event type")
    assert.equal(ev.payload.pendingSet[0].status, "working")
  } finally {
    h.close()
  }
})

test("F026 P5 T4 · settle 减少 pendingSet（已结算 sibling 不再列出）", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const childA = h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const childB = h.registry.openCall({
      parentCallId: root,
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "agent:桂芬",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    h.events.length = 0
    h.registry.settle(childA, "done")
    assert.equal(h.events.length, 1)
    const ev = h.events[0]
    if (ev.type !== "pending.change") throw new Error("unexpected event type")
    assert.equal(ev.payload.pendingSet.length, 1) // 只剩 childB
    assert.equal(ev.payload.pendingSet[0].callId, childB)
  } finally {
    h.close()
  }
})

test("F026 P5 T4 · settle CAS noop（重复 settle）不重复 emit", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const childA = h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    h.registry.settle(childA, "done")
    h.events.length = 0
    const second = h.registry.settle(childA, "done")
    assert.equal(second, false) // CAS noop
    assert.equal(h.events.length, 0) // 不再 emit
  } finally {
    h.close()
  }
})

test("F026 P5 T4 · 无 broadcaster 时静默 skip（向后兼容）", () => {
  const h = tmp() // 无 broadcaster
  try {
    assert.doesNotThrow(() => {
      const root = h.registry.openCall({
        issuerId: "user:小孙",
        convenerId: "user:小孙",
        replyTo: "user:小孙",
        sessionGroupId: "g1",
        deadlineAt: "2026-04-23T14:00:00.000Z",
      })
      h.registry.advance(root, "working")
      h.registry.settle(root, "done")
    })
  } finally {
    h.close()
  }
})

test("F026 P5 T4 · computePendingSet 排除 root 自身", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const set = h.registry.computePendingSet(root)
    // root 自身虽然 pending 也不应在 set 里
    assert.equal(set.length, 1) // 只 child
    assert.equal(set[0].alias, "黄仁勋")
  } finally {
    h.close()
  }
})

// ─── F026 P5 review#4 fix · pending.change settled 终态广播 ──────────────────
//
// 范德彪 review#4 P1: settle 后 pendingSet 剔除 entry，前端 AtPill 命不中
// pendingByRoot 时 fallback 到 message envelope snapshot，但 envelope 不重发，
// snapshot 仍是 pending → AtPill 卡在 ack/working 不进 done/timeout/error。
//
// A' 修复：emitPendingChange 在 row 已 terminal 时附带 settled 字段；
//          timeoutScan 改为 SELECT-then-UPDATE 后逐个 emit（之前完全不 emit）。

test("F026 review#4 fix · settle(done) emits pending.change with settled=[{callId,alias,status:'done'}]", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const child = h.registry.openCall({
      parentCallId: root,
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "agent:桂芬",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    h.events.length = 0
    h.registry.settle(child, "done")
    assert.equal(h.events.length, 1)
    const ev = h.events[0]
    if (ev.type !== "pending.change") throw new Error("unexpected event type")
    assert.deepEqual(ev.payload.settled, [
      { callId: child, alias: "桂芬", status: "done" },
    ])
  } finally {
    h.close()
  }
})

test("F026 review#4 fix · settle(failed/timeout/cancelled) maps each terminal status into settled[]", () => {
  for (const terminal of ["failed", "timeout", "cancelled"] as const) {
    const h = tmpWithBroadcaster()
    try {
      const root = h.registry.openCall({
        issuerId: "user:小孙",
        convenerId: "user:小孙",
        replyTo: "user:小孙",
        sessionGroupId: "g1",
        deadlineAt: "2026-04-29T14:00:00.000Z",
      })
      const child = h.registry.openCall({
        parentCallId: root,
        issuerId: "黄仁勋",
        convenerId: "黄仁勋",
        replyTo: "agent:黄仁勋",
        sessionGroupId: "g1",
        deadlineAt: "2026-04-29T14:00:00.000Z",
      })
      h.events.length = 0
      h.registry.settle(child, terminal)
      const ev = h.events[0]
      if (ev.type !== "pending.change") throw new Error("unexpected event type")
      assert.deepEqual(ev.payload.settled, [
        { callId: child, alias: "黄仁勋", status: terminal },
      ])
    } finally {
      h.close()
    }
  }
})

test("F026 review#4 fix · openCall / advance emit pending.change with settled=[] (not terminal)", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const child = h.registry.openCall({
      parentCallId: root,
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "agent:桂芬",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    h.events.length = 0
    h.registry.advance(child, "working")
    const evAdv = h.events[0]
    if (evAdv.type !== "pending.change") throw new Error("unexpected event type")
    // openCall/advance 状态非 terminal — settled 为空数组（不含当前 row）
    assert.deepEqual(evAdv.payload.settled ?? [], [])
  } finally {
    h.close()
  }
})

test("F026 review#4 fix · timeoutScan(working past deadline) emits pending.change per-call with settled status='timeout'", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    const child = h.registry.openCall({
      parentCallId: root,
      issuerId: "范德彪",
      convenerId: "范德彪",
      replyTo: "agent:范德彪",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T12:30:00.000Z", // 已过 deadline (now=13:00)
    })
    h.registry.advance(child, "working")
    h.events.length = 0
    const swept = h.registry.timeoutScan()
    assert.equal(swept, 1)
    // 应当 per-call emit 一次 pending.change，settled 包含被 timeout 的 child
    const settledEvents = h.events.filter(
      (e) =>
        e.type === "pending.change" &&
        e.payload.settled?.some((s) => s.callId === child),
    )
    assert.equal(settledEvents.length, 1, "timeoutScan should emit per-call pending.change")
    const ev = settledEvents[0]
    if (ev.type !== "pending.change") throw new Error("unexpected event type")
    assert.deepEqual(ev.payload.settled, [
      { callId: child, alias: "范德彪", status: "timeout" },
    ])
  } finally {
    h.close()
  }
})

test("F026 review#4 fix · timeoutScan(stalePendingMs orphan child) emits pending.change with settled='timeout'", () => {
  const h = tmpWithBroadcaster()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T14:00:00.000Z",
    })
    // 改 created_at 让 child 看起来已 stale，并设 deadline 仍未到（避免被 working 扫到）
    h.store.db
      .prepare("UPDATE a2a_calls SET created_at = ? WHERE call_id = ?")
      .run("2026-04-29T12:00:00.000Z", root)
    const child = h.registry.openCall({
      parentCallId: root,
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "agent:桂芬",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T15:00:00.000Z",
    })
    h.store.db
      .prepare("UPDATE a2a_calls SET created_at = ? WHERE call_id = ?")
      .run("2026-04-29T12:00:00.000Z", child)
    h.events.length = 0
    const swept = h.registry.timeoutScan({ stalePendingMs: 60_000 })
    assert.equal(swept, 1)
    const ev = h.events.find(
      (e) =>
        e.type === "pending.change" &&
        e.payload.settled?.some((s) => s.callId === child),
    )
    assert.ok(ev, "stale pending child should emit pending.change with settled")
    if (ev?.type !== "pending.change") throw new Error("unexpected event type")
    assert.deepEqual(ev.payload.settled, [
      { callId: child, alias: "桂芬", status: "timeout" },
    ])
  } finally {
    h.close()
  }
})
