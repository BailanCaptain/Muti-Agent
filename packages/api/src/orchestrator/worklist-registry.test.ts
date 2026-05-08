import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"
import { applyA2AWorklistsTreeMigration } from "../db/a2a-worklists-tree-migration"
import { WorklistRegistry } from "./worklist-registry"

/**
 * F026 P2 v2 Task 2 · WorklistRegistry 树形 register / get / findChildWorklists.
 *
 * 关键点：
 *   - parentWorklistId 必传（root 时显式传 null，调用方意图明确，禁止 undefined fallback）
 *   - findChildWorklists 是 cascade settle 不变量的查询基础（Task 3 用）
 */

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  db.exec(`CREATE TABLE a2a_worklists (
    worklist_id TEXT PRIMARY KEY,
    parent_call_id TEXT NOT NULL,
    root_call_id TEXT NOT NULL,
    session_group_id TEXT NOT NULL,
    items TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('active','settled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  applyA2AWorklistsTreeMigration(db)
  return db
}

describe("WorklistRegistry tree", () => {
  it("register root worklist with parentWorklistId=null", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const row = r.get(id)
    assert.ok(row)
    assert.equal(row?.parentWorklistId, null)
    assert.equal(row?.parentCallId, "call-A")
    assert.equal(row?.rootCallId, "call-root")
    assert.equal(row?.status, "active")
    assert.equal(row?.items.length, 1)
    assert.equal(row?.items[0]?.alias, "桂芬")
  })

  it("register child worklist with parentWorklistId pointing to existing root", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const rootId = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const childId = r.register({
      parentWorklistId: rootId,
      parentCallId: "call-B",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })
    const child = r.get(childId)
    assert.equal(child?.parentWorklistId, rootId)
  })

  it("findChildWorklists returns all worklists with parent_worklist_id = self (created_at ASC)", () => {
    const db = setupDb()
    let nowCounter = 0
    const r = new WorklistRegistry({
      db,
      now: () => `2026-05-05T00:00:0${nowCounter++}.000Z`,
    })
    const rootId = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [
        { alias: "桂芬", status: "pending" },
        { alias: "范德彪", status: "pending" },
      ],
    })
    const child1 = r.register({
      parentWorklistId: rootId,
      parentCallId: "call-B-桂芬",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "X", status: "pending" }],
    })
    const child2 = r.register({
      parentWorklistId: rootId,
      parentCallId: "call-B-范德彪",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "Y", status: "pending" }],
    })
    const children = r.findChildWorklists(rootId)
    assert.equal(children.length, 2)
    assert.deepEqual(
      children.map((c) => c.worklistId),
      [child1, child2],
      "ordered by created_at ASC",
    )
  })

  it("findChildWorklists returns empty array when no children exist", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    assert.deepEqual(r.findChildWorklists(id), [])
  })

  it("findAllByRootCallId 返回 root tree 内所有 worklist (含 active + settled, 按 created_at ASC)", () => {
    const db = setupDb()
    let nowCounter = 0
    const r = new WorklistRegistry({
      db,
      now: () => `2026-05-05T00:00:0${nowCounter++}.000Z`,
    })
    const rootCallId = "call-root"
    const wlRoot = r.register({
      parentWorklistId: null,
      parentCallId: rootCallId,
      rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const wlChild = r.register({
      parentWorklistId: wlRoot,
      parentCallId: "call-桂芬",
      rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })
    // 不同 root tree —— 不应被拉出
    r.register({
      parentWorklistId: null,
      parentCallId: "call-other-root",
      rootCallId: "call-other-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "X", status: "pending" }],
    })
    // 已 settle 的也应返回
    r.settle(wlRoot)
    const all = r.findAllByRootCallId(rootCallId)
    assert.equal(all.length, 2)
    assert.deepEqual(
      all.map((w) => w.worklistId),
      [wlRoot, wlChild],
    )
    assert.equal(all[0]?.status, "settled")
    assert.equal(all[1]?.status, "active")
  })

  it("get returns null for unknown worklist id", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    assert.equal(r.get("worklist-nonexistent"), null)
  })

  it("register validates required fields and rejects empty items", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    assert.throws(
      () =>
        r.register({
          parentWorklistId: null,
          parentCallId: "",
          rootCallId: "call-root",
          sessionGroupId: "sg-1",
          items: [{ alias: "桂芬", status: "pending" }],
        }),
      /parentCallId required/,
    )
    assert.throws(
      () =>
        r.register({
          parentWorklistId: null,
          parentCallId: "call-A",
          rootCallId: "call-root",
          sessionGroupId: "sg-1",
          items: [],
        }),
      /items must be non-empty/,
    )
  })

  it("findActiveByParentCallId returns the active worklist for a given parent call", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const found = r.findActiveByParentCallId("call-A")
    assert.equal(found?.worklistId, id)
    assert.equal(r.findActiveByParentCallId("call-nonexistent"), null)
  })

  it("markItemStatus updates the item's status by index", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [
        { alias: "桂芬", status: "pending" },
        { alias: "范德彪", status: "pending" },
      ],
    })
    r.markItemStatus(id, 0, "done")
    const row = r.get(id)
    assert.equal(row?.items[0]?.status, "done")
    assert.equal(row?.items[1]?.status, "pending")
  })

  it("settle CAS active → settled (idempotent: second call returns false)", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    assert.equal(r.settle(id), true)
    assert.equal(r.get(id)?.status, "settled")
    assert.equal(r.settle(id), false, "second settle is no-op (CAS)")
  })
})

describe("WorklistRegistry tryCascadeSettle (drain-based 不变量)", () => {
  it("settles self when items all done AND no children", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    r.markItemStatus(id, 0, "done")
    const result = r.tryCascadeSettle(id)
    assert.deepEqual(result.settled, [id])
    assert.equal(r.get(id)?.status, "settled")
  })

  it("does NOT settle when items all done but has active child worklist (v2 关键差异 vs v1 平表)", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const parentId = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    // 桂芬 reply 时又派了 grandchild → 注册 child worklist
    r.register({
      parentWorklistId: parentId,
      parentCallId: "call-B-桂芬",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })
    r.markItemStatus(parentId, 0, "done") // 桂芬 invocation 完成
    const result = r.tryCascadeSettle(parentId)
    assert.deepEqual(result.settled, [], "v2: parent 等 child worklist drain 后才能 settle")
    assert.equal(r.get(parentId)?.status, "active")
  })

  it("does NOT settle when items have pending entry", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [
        { alias: "桂芬", status: "pending" },
        { alias: "范德彪", status: "pending" },
      ],
    })
    r.markItemStatus(id, 0, "done")
    const result = r.tryCascadeSettle(id)
    assert.deepEqual(result.settled, [])
    assert.equal(r.get(id)?.status, "active")
  })

  it("cascades up: child settle then parent settle when all conditions met (bottom-up)", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const parentId = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const childId = r.register({
      parentWorklistId: parentId,
      parentCallId: "call-B-桂芬",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })
    r.markItemStatus(parentId, 0, "done")
    r.markItemStatus(childId, 0, "done")
    const result = r.tryCascadeSettle(childId)
    assert.deepEqual(
      result.settled,
      [childId, parentId],
      "bottom-up: child settles first, then cascades to parent",
    )
    assert.equal(r.get(childId)?.status, "settled")
    assert.equal(r.get(parentId)?.status, "settled")
  })

  it("cascade stops at any unsettleable ancestor (multi-layer with mid-tree blocked)", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    // 三层：root → mid → leaf；mid 还有另一个 sibling (block) 没 done
    const rootId = r.register({
      parentWorklistId: null,
      parentCallId: "call-root-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const midId = r.register({
      parentWorklistId: rootId,
      parentCallId: "call-mid-B",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [
        { alias: "范德彪", status: "pending" },
        { alias: "黄仁勋", status: "pending" }, // sibling 还没 done
      ],
    })
    const leafId = r.register({
      parentWorklistId: midId,
      parentCallId: "call-leaf-C",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "X", status: "pending" }],
    })
    r.markItemStatus(midId, 0, "done") // 范德彪 done
    // 黄仁勋 还 pending → mid 不 settle
    r.markItemStatus(leafId, 0, "done")
    const result = r.tryCascadeSettle(leafId)
    assert.deepEqual(result.settled, [leafId], "leaf settles, mid blocks (sibling pending)")
    assert.equal(r.get(midId)?.status, "active")
    assert.equal(r.get(rootId)?.status, "active")
  })

  it("rehydrate: tree shape preserved across new WorklistRegistry instance, cascade resumes from leaf", () => {
    // F026 P2 v2 Task 8 · 进程重启 rehydrate 验证。
    //
    // 场景：API 在 mid-chain 时被 kill -9 →
    //   - root worklist active, items[0]=done (黄仁勋 已完成)
    //   - child worklist active, items[0]=pending (桂芬 还没回来)
    // 重启后新 WorklistRegistry 实例指向同 db，桂芬 finished 触发 cascade,
    // 整棵树应正常 drain（child settle → root settle）。
    const db = setupDb()
    const r1 = new WorklistRegistry({ db })
    const rootWlId = r1.register({
      parentWorklistId: null,
      parentCallId: "call-user-root",
      rootCallId: "call-user-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "黄仁勋", status: "pending" }],
    })
    const childWlId = r1.register({
      parentWorklistId: rootWlId,
      parentCallId: "call-黄仁勋",
      rootCallId: "call-user-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    r1.markItemStatus(rootWlId, 0, "done") // 黄仁勋 已完成
    // 此处模拟 kill -9：r1 不再被使用，新建 r2 指向同 db

    const r2 = new WorklistRegistry({ db })

    // rehydrate 验证：tree 结构 + 状态全部从 db 读出
    const rootRehydrated = r2.get(rootWlId)
    assert.ok(rootRehydrated, "root worklist 从 db 读出")
    assert.equal(rootRehydrated?.parentWorklistId, null)
    assert.equal(rootRehydrated?.items[0]?.status, "done")
    assert.equal(rootRehydrated?.status, "active")

    const childRehydrated = r2.get(childWlId)
    assert.ok(childRehydrated, "child worklist 从 db 读出")
    assert.equal(childRehydrated?.parentWorklistId, rootWlId, "tree edge preserved")
    assert.equal(childRehydrated?.items[0]?.status, "pending")

    // 桂芬 finished → cascade resume
    r2.markItemStatus(childWlId, 0, "done")
    const cascade = r2.tryCascadeSettle(childWlId)
    assert.deepEqual(
      cascade.settled,
      [childWlId, rootWlId],
      "rehydrate 后 cascade 仍按 v2 不变量上升 settle child→root",
    )
    assert.equal(r2.get(rootWlId)?.status, "settled")
    assert.equal(r2.get(childWlId)?.status, "settled")
  })

  it("guards against cycle: bounded depth (defensive, won't infinite loop)", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    // 手工构造：worklist A.parent_worklist_id = B; B.parent_worklist_id = A — 异常环
    db.prepare(
      `INSERT INTO a2a_worklists (worklist_id, parent_worklist_id, parent_call_id, root_call_id, session_group_id, items, current_index, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
    ).run(
      "wl-A",
      "wl-B",
      "call-A",
      "call-root",
      "sg-1",
      JSON.stringify([{ alias: "x", status: "done" }]),
      "2026-05-05T00:00:00.000Z",
      "2026-05-05T00:00:00.000Z",
    )
    db.prepare(
      `INSERT INTO a2a_worklists (worklist_id, parent_worklist_id, parent_call_id, root_call_id, session_group_id, items, current_index, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
    ).run(
      "wl-B",
      "wl-A",
      "call-B",
      "call-root",
      "sg-1",
      JSON.stringify([{ alias: "y", status: "done" }]),
      "2026-05-05T00:00:00.000Z",
      "2026-05-05T00:00:00.000Z",
    )
    // tryCascadeSettle 不能死循环；最多走 50 层就退出
    const result = r.tryCascadeSettle("wl-A")
    // settled 数应在 [0, 50] 之间，关键是不死循环（测试自身能终止即胜）
    assert.ok(result.settled.length <= 50, `cascade bounded; got ${result.settled.length}`)
  })
})
