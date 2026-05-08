import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"
import { CallRegistry } from "../orchestrator/call-registry"
import { applyA2AWorklistsTreeMigration } from "../db/a2a-worklists-tree-migration"
import { WorklistRegistry } from "../orchestrator/worklist-registry"
import { WorklistExecutor } from "./worklist-executor"
import type { QueueEntry } from "../orchestrator/dispatch"

/**
 * F026 P2 v2 Task 4 · WorklistExecutor.registerForDispatch parentWorklistId 反查.
 *
 * 反查逻辑：派发者 agent 的 call_id (parentCallId) 是否当前是某个 worklist 的 child？
 *   等价于：从 callRegistry.get(parentCallId) 拿 callRow.parentCallId（grandparent_call_id），
 *   再 worklistRegistry.findActiveByParentCallId(grandparent_call_id)。
 *   找到 → 它就是新 worklist 的 parentWorklistId
 *   找不到 → 新 worklist 是 root worklist（parentWorklistId = null）
 */

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  // 简化建表 — 测试只用 a2a_calls 树形列 + a2a_worklists 树形列
  db.exec(`CREATE TABLE a2a_calls (
    call_id TEXT PRIMARY KEY,
    parent_call_id TEXT,
    root_call_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    convener_id TEXT NOT NULL,
    on_behalf_of TEXT,
    reply_to TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    join_set_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','working','done','failed','timeout','cancelled')),
    envelope_version TEXT NOT NULL DEFAULT 'v1',
    session_group_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
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

function mkQueueEntry(toAgentId: string): QueueEntry {
  return {
    id: `q-${toAgentId}-${Math.random()}`,
    sessionGroupId: "sg-1",
    rootMessageId: "msg-root",
    from: { agentId: "from-agent", messageId: "msg-from", provider: "claude" },
    to: { agentId: toAgentId, provider: "claude" },
    taskSnippet: "task",
    contextSnapshot: [],
    parentInvocationId: null,
    hopIndex: 1,
  }
}

describe("WorklistExecutor.registerForDispatch (parentWorklistId 反查)", () => {
  it("returns null when parentCallId is missing", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const result = exec.registerForDispatch({
      parentCallId: null,
      sessionGroupId: "sg-1",
      queued: [mkQueueEntry("桂芬")],
    })
    assert.equal(result, null)
  })

  it("returns null when queued is empty", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const userRootCall = calls.get(userRootCallId)!

    const result = exec.registerForDispatch({
      parentCallId: userRootCall.callId,
      sessionGroupId: "sg-1",
      queued: [],
    })
    assert.equal(result, null)
  })

  it("registers ROOT worklist when dispatcher (parentCall) has no grandparent worklist", () => {
    // 场景：user 派 @黄仁勋。dispatcher = user-root call (无 parent_call_id)
    //   → 反查 grandparent worklist → 找不到 → 新 worklist 是 root（parentWorklistId=null）
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const userRootCall = calls.get(userRootCallId)!

    const wlId = exec.registerForDispatch({
      parentCallId: userRootCall.callId,
      sessionGroupId: "sg-1",
      queued: [mkQueueEntry("黄仁勋")],
    })
    assert.ok(wlId, "worklist registered")
    const wl = worklists.get(wlId!)
    assert.equal(wl?.parentWorklistId, null, "root worklist has parentWorklistId=null")
    assert.equal(wl?.parentCallId, userRootCall.callId)
    assert.equal(wl?.rootCallId, userRootCall.rootCallId)
    assert.equal(wl?.items[0]?.alias, "黄仁勋")
  })

  it("registers CHILD worklist when dispatcher is itself in an active grandparent worklist", () => {
    // 场景：user → @黄仁勋 → 黄仁勋 reply [Call:@桂芬]
    //   1) user-root call 建好
    //   2) 黄仁勋_call (parent = user-root) 建好
    //   3) user 派发黄仁勋时，root worklist (parent_call=user-root, items=[黄仁勋]) 已注册
    //   4) 黄仁勋 reply 含 [Call:@桂芬] → 派发桂芬，dispatcher=黄仁勋_call
    //      反查：黄仁勋_call.parent = user-root；user-root 是 grandparent worklist 的 parent_call
    //      → 找到 grandparent worklist (root worklist) → 新 worklist 挂它下（parentWorklistId=rootWorklistId）
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const userRootCall = calls.get(userRootCallId)!
    const huangCallId = calls.openCall({
      parentCallId: userRootCall.callId,
      issuerId: "user",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const huangCall = calls.get(huangCallId)!
    // root worklist：parent_call_id = user-root，items=[黄仁勋]
    const rootWlId = worklists.register({
      parentWorklistId: null,
      parentCallId: userRootCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "黄仁勋", status: "pending" }],
    })

    // 黄仁勋 派发 @桂芬：dispatcher = 黄仁勋_call
    const childWlId = exec.registerForDispatch({
      parentCallId: huangCall.callId,
      sessionGroupId: "sg-1",
      queued: [mkQueueEntry("桂芬")],
    })
    assert.ok(childWlId)
    const childWl = worklists.get(childWlId!)
    assert.equal(
      childWl?.parentWorklistId,
      rootWlId,
      "child worklist 挂在 root worklist 下（树形不变量）",
    )
    assert.equal(childWl?.rootCallId, userRootCall.rootCallId, "rootCallId 沿用整棵 call tree 的根")
    assert.equal(childWl?.items[0]?.alias, "桂芬")
  })

  it("falls back to ROOT when grandparent's active worklist is missing (e.g. settled)", () => {
    // 边界：黄仁勋 reply [Call:@桂芬]，但 root worklist 由于 race / 异常已 settled
    //   → findActiveByParentCallId 返回 null → 新 worklist 默认 root
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const userRootCall = calls.get(userRootCallId)!
    const huangCallId = calls.openCall({
      parentCallId: userRootCall.callId,
      issuerId: "user",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const huangCall = calls.get(huangCallId)!
    const rootWlId = worklists.register({
      parentWorklistId: null,
      parentCallId: userRootCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "黄仁勋", status: "pending" }],
    })
    worklists.settle(rootWlId) // root worklist 异常 settled 了

    const childWlId = exec.registerForDispatch({
      parentCallId: huangCall.callId,
      sessionGroupId: "sg-1",
      queued: [mkQueueEntry("桂芬")],
    })
    assert.ok(childWlId)
    const childWl = worklists.get(childWlId!)
    assert.equal(
      childWl?.parentWorklistId,
      null,
      "fallback: grandparent worklist not active → child 当 root 处理（不挂死链）",
    )
  })

  it("returns null when parentCallId not found in CallRegistry (defensive)", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const result = exec.registerForDispatch({
      parentCallId: "call-nonexistent",
      sessionGroupId: "sg-1",
      queued: [mkQueueEntry("桂芬")],
    })
    assert.equal(result, null)
  })
})

describe("WorklistExecutor.onChildFinished (cascade settle · root-only 续推)", () => {
  function bootstrapTree(opts: {
    db: DatabaseSync
    calls: CallRegistry
    worklists: WorklistRegistry
  }): {
    userRootCall: ReturnType<CallRegistry["get"]> & {}
    huangCall: ReturnType<CallRegistry["get"]> & {}
    rootWlId: string
  } {
    const userRootCallId = opts.calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const userRootCall = opts.calls.get(userRootCallId)!
    const huangCallId = opts.calls.openCall({
      parentCallId: userRootCall.callId,
      issuerId: "user",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const huangCall = opts.calls.get(huangCallId)!
    // root worklist：user 派 @黄仁勋
    const rootWlId = opts.worklists.register({
      parentWorklistId: null,
      parentCallId: userRootCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "黄仁勋", status: "pending" }],
    })
    return { userRootCall, huangCall, rootWlId }
  }

  it("single-layer A→B→A: B finished → root settles → onDoneContinuation called once", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const cb_calls: Array<{ worklistId: string; childAliases: string[] }> = []
    exec.setOnDoneContinuation((args) => {
      cb_calls.push({ worklistId: args.worklist.worklistId, childAliases: args.childAliases })
    })

    const { huangCall, rootWlId } = bootstrapTree({ db, calls, worklists })
    // 黄仁勋 finished, content non-empty
    const result = exec.onChildFinished({
      childCallId: huangCall.callId,
      childAlias: "黄仁勋",
      childContent: "黄仁勋 final reply",
      ok: true,
    })
    assert.equal(result?.decision, "settled")
    assert.equal(result?.rootSettled, true)
    assert.equal(cb_calls.length, 1, "续推回调被调一次")
    assert.equal(cb_calls[0]?.worklistId, rootWlId)
    assert.deepEqual(cb_calls[0]?.childAliases, ["黄仁勋"])
    assert.equal(worklists.get(rootWlId)?.status, "settled")
  })

  it("multi-layer A→B→C: B finished but B has active child worklist → NOT cascade, NOT trigger continuation", () => {
    // 场景：root worklist {items=[黄仁勋]}, 黄仁勋 reply 含 [Call:@桂芬] →
    //   register child worklist (parent = rootWl) → 黄仁勋 finished
    //   断言：root worklist 仍 active；onDoneContinuation 0 次
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const cb_calls: Array<unknown> = []
    exec.setOnDoneContinuation((args) => cb_calls.push(args))

    const { userRootCall, huangCall, rootWlId } = bootstrapTree({ db, calls, worklists })
    // 黄仁勋 reply 时已派出 grandchild 桂芬 → child worklist 注册（reply 之前）
    worklists.register({
      parentWorklistId: rootWlId,
      parentCallId: huangCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })

    const result = exec.onChildFinished({
      childCallId: huangCall.callId,
      childAlias: "黄仁勋",
      childContent: "黄仁勋 中间 reply (含 [Call:@桂芬])",
      ok: true,
    })
    assert.equal(result?.decision, "advanced", "items 全 done 但有 active child → 不 cascade")
    assert.equal(result?.rootSettled, false)
    assert.equal(cb_calls.length, 0, "续推回调没被调")
    assert.equal(worklists.get(rootWlId)?.status, "active", "root 仍等 child drain")
  })

  it("multi-layer A→B→C: when grandchild C also finishes → cascade settles child→root, only root triggers continuation", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const cb_calls: Array<{ worklistId: string }> = []
    exec.setOnDoneContinuation((args) => cb_calls.push({ worklistId: args.worklist.worklistId }))

    const { userRootCall, huangCall, rootWlId } = bootstrapTree({ db, calls, worklists })
    // 桂芬 call: parent = huangCall
    const guifenCallId = calls.openCall({
      parentCallId: huangCall.callId,
      issuerId: "黄仁勋",
      convenerId: "桂芬",
      replyTo: "gemini:桂芬",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const guifenCall = calls.get(guifenCallId)!
    const childWlId = worklists.register({
      parentWorklistId: rootWlId,
      parentCallId: huangCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })

    // 1) 黄仁勋 finished — root 不 settle（child 还 active）
    const r1 = exec.onChildFinished({
      childCallId: huangCall.callId,
      childAlias: "黄仁勋",
      childContent: "黄仁勋 中间 reply",
      ok: true,
    })
    assert.equal(r1?.rootSettled, false)
    assert.equal(cb_calls.length, 0)

    // 2) 桂芬 finished — child cascade settle，再 cascade 到 root settle
    const r2 = exec.onChildFinished({
      childCallId: guifenCall.callId,
      childAlias: "桂芬",
      childContent: "桂芬 reply",
      ok: true,
    })
    assert.equal(r2?.decision, "settled")
    assert.equal(r2?.rootSettled, true, "root cascade settle 触发")
    assert.equal(worklists.get(childWlId)?.status, "settled")
    assert.equal(worklists.get(rootWlId)?.status, "settled")
    assert.equal(cb_calls.length, 1, "中间层 child settle 不派续推；只有 root settle 派一次")
    assert.equal(cb_calls[0]?.worklistId, rootWlId, "续推目标是 root worklist (黄仁勋)")
  })

  it("middle worklist settle does NOT trigger continuation when root is also settled (root-only contract)", () => {
    // 强化场景：直接 cascade 全套 settle，验证 cb 只触发一次（root），不是 child + root 两次
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    exec.setOnDoneContinuation(() => cbCount++)

    const { userRootCall, huangCall, rootWlId } = bootstrapTree({ db, calls, worklists })
    const guifenCallId = calls.openCall({
      parentCallId: huangCall.callId,
      issuerId: "黄仁勋",
      convenerId: "桂芬",
      replyTo: "gemini:桂芬",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const guifenCall = calls.get(guifenCallId)!
    worklists.register({
      parentWorklistId: rootWlId,
      parentCallId: huangCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    // 黄仁勋 + 桂芬 都先标 done，再触发 cascade（顺序无关）
    exec.onChildFinished({
      childCallId: huangCall.callId,
      childAlias: "黄仁勋",
      childContent: "x",
      ok: true,
    })
    exec.onChildFinished({
      childCallId: guifenCall.callId,
      childAlias: "桂芬",
      childContent: "y",
      ok: true,
    })
    assert.equal(cbCount, 1, "全树 cascade settle 后 onDoneContinuation 仅触发一次（root only）")
  })

  it("failed child: halt path settles directly, no cascade, no continuation", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    exec.setOnDoneContinuation(() => cbCount++)

    const { huangCall, rootWlId } = bootstrapTree({ db, calls, worklists })
    const result = exec.onChildFinished({
      childCallId: huangCall.callId,
      childAlias: "黄仁勋",
      childContent: "",
      ok: false,
    })
    assert.equal(result?.decision, "halted")
    assert.equal(result?.rootSettled, false)
    assert.equal(cbCount, 0, "failed 不触发续推")
    assert.equal(worklists.get(rootWlId)?.status, "settled", "halt 路径直接 settle 自身")
  })

  it("returns null when childCallId is missing or worklist not found", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    assert.equal(
      exec.onChildFinished({ childCallId: null, childContent: "x", ok: true }),
      null,
    )
    assert.equal(
      exec.onChildFinished({ childCallId: "call-nonexistent", childContent: "x", ok: true }),
      null,
    )
  })
})

describe("WorklistExecutor.onChildFinished continuation-guard (F026 P3 R-095/R-096)", () => {
  it("R-095 接力链：root tree 内某 worklist.items 含 panel agent → 跳过续推", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    exec.setOnDoneContinuation(() => cbCount++)

    // user-root call (replyTo="user")
    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    // 仁勋 directTurnCall (replyTo="claude:黄仁勋" — 1A.2 修补)
    const huangCallId = calls.openCall({
      parentCallId: userRootCallId,
      issuerId: "user",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    // 范德彪 call: 仁勋第1棒派出
    const debiaoCallId = calls.openCall({
      parentCallId: huangCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    // 桂芬 call: 范德彪派出
    const guifenCallId = calls.openCall({
      parentCallId: debiaoCallId,
      issuerId: "范德彪",
      convenerId: "范德彪",
      replyTo: "codex:范德彪",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    // 仁勋第2棒 call: 桂芬派出（反向接力 → 仁勋）
    const huang2CallId = calls.openCall({
      parentCallId: guifenCallId,
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "gemini:桂芬",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })

    // worklist tree:
    //  WL_A (parentCallId=huangCallId, items=[范德彪], parentWorklistId=null) ← root
    //  WL_B (parentCallId=debiaoCallId, items=[桂芬], parentWorklistId=WL_A)
    //  WL_C (parentCallId=guifenCallId, items=[黄仁勋], parentWorklistId=WL_B) ← 含 panel!
    const wlA = worklists.register({
      parentWorklistId: null,
      parentCallId: huangCallId,
      rootCallId: userRootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })
    const wlB = worklists.register({
      parentWorklistId: wlA,
      parentCallId: debiaoCallId,
      rootCallId: userRootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const wlC = worklists.register({
      parentWorklistId: wlB,
      parentCallId: guifenCallId,
      rootCallId: userRootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "黄仁勋", status: "pending" }],
    })

    // 时序：范德彪 finished → 桂芬 finished → 仁勋第2棒 finished（cascade 到 root）
    exec.onChildFinished({
      childCallId: debiaoCallId,
      childAlias: "范德彪",
      childContent: "范德彪 reply [Call:@桂芬]",
      ok: true,
    })
    exec.onChildFinished({
      childCallId: guifenCallId,
      childAlias: "桂芬",
      childContent: "桂芬 reply [Call:@黄仁勋 收尾]",
      ok: true,
    })
    const result = exec.onChildFinished({
      childCallId: huang2CallId,
      childAlias: "黄仁勋",
      childContent: "整合 reply",
      ok: true,
    })
    assert.equal(result?.rootSettled, true, "WL_A 被 cascade settle")
    assert.equal(worklists.get(wlA)?.status, "settled")
    assert.equal(worklists.get(wlB)?.status, "settled")
    assert.equal(worklists.get(wlC)?.status, "settled")
    assert.equal(cbCount, 0, "panel agent 已在 WL_C items 中 → 跳过续推（不再重复）")
  })

  it("R-096 fan-out + 反向接力：root tree 内 child worklist.items 含 panel → 跳过续推", () => {
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    exec.setOnDoneContinuation(() => cbCount++)

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    const huangCallId = calls.openCall({
      parentCallId: userRootCallId,
      issuerId: "user",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    // 仁勋 fan-out: 桂芬 + 范德彪
    const guifenCallId = calls.openCall({
      parentCallId: huangCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    const debiaoCallId = calls.openCall({
      parentCallId: huangCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    // 范德彪反向接力 → 仁勋第2棒
    const huang2CallId = calls.openCall({
      parentCallId: debiaoCallId,
      issuerId: "范德彪",
      convenerId: "范德彪",
      replyTo: "codex:范德彪",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })

    // WL_A root (parentCallId=huangCallId, items=[桂芬, 范德彪])
    const wlA = worklists.register({
      parentWorklistId: null,
      parentCallId: huangCallId,
      rootCallId: userRootCallId,
      sessionGroupId: "sg-1",
      items: [
        { alias: "桂芬", status: "pending" },
        { alias: "范德彪", status: "pending" },
      ],
    })
    // WL_B child (parentCallId=debiaoCallId, items=[黄仁勋])  ← 含 panel
    const wlB = worklists.register({
      parentWorklistId: wlA,
      parentCallId: debiaoCallId,
      rootCallId: userRootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "黄仁勋", status: "pending" }],
    })

    // 时序：桂芬 finished → 范德彪 finished（已派出 [Call:@仁勋] 注册 WL_B）
    //  → 仁勋第2棒 finished → cascade settle WL_B → WL_A
    exec.onChildFinished({
      childCallId: guifenCallId,
      childAlias: "桂芬",
      childContent: "桂芬 reply",
      ok: true,
    })
    exec.onChildFinished({
      childCallId: debiaoCallId,
      childAlias: "范德彪",
      childContent: "范德彪 reply [Call:@黄仁勋 反向]",
      ok: true,
    })
    const result = exec.onChildFinished({
      childCallId: huang2CallId,
      childAlias: "黄仁勋",
      childContent: "整合 reply",
      ok: true,
    })
    assert.equal(result?.rootSettled, true)
    assert.equal(worklists.get(wlA)?.status, "settled")
    assert.equal(worklists.get(wlB)?.status, "settled")
    assert.equal(cbCount, 0, "panel agent 已在 WL_B items 中 → 跳过续推")
  })

  it("正常 fan-out（无反向接力）：root tree 内无 panel alias → 续推照常派", () => {
    // 仁勋派 [@桂芬][@范德彪]，桂芬/范德彪 都答完没派啥
    // WL_A root items=[桂芬, 范德彪]，无 child worklist
    // root settle → guard 不命中 → 续推 1 次 ✅
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    exec.setOnDoneContinuation(() => cbCount++)

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    const huangCallId = calls.openCall({
      parentCallId: userRootCallId,
      issuerId: "user",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    const guifenCallId = calls.openCall({
      parentCallId: huangCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    const debiaoCallId = calls.openCall({
      parentCallId: huangCallId,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T18:00:00.000Z",
    })
    worklists.register({
      parentWorklistId: null,
      parentCallId: huangCallId,
      rootCallId: userRootCallId,
      sessionGroupId: "sg-1",
      items: [
        { alias: "桂芬", status: "pending" },
        { alias: "范德彪", status: "pending" },
      ],
    })

    exec.onChildFinished({
      childCallId: guifenCallId,
      childAlias: "桂芬",
      childContent: "x",
      ok: true,
    })
    const result = exec.onChildFinished({
      childCallId: debiaoCallId,
      childAlias: "范德彪",
      childContent: "y",
      ok: true,
    })
    assert.equal(result?.rootSettled, true)
    assert.equal(cbCount, 1, "panel agent 不在 root tree 任何 worklist items → 续推照常派")
  })
})

describe("WorklistExecutor wide+deep tree cascade (Task 7 多层 e2e)", () => {
  it("scenario: user @ [B, C], C reply [Call:@D], D done — root settles only after D drains", () => {
    // 树形：
    //   user-root call
    //     ├── B_call         (root worklist item[0])
    //     └── C_call         (root worklist item[1])
    //          └── D_call    (child worklist item[0], parentWL=root)
    //
    // Cascade 时序：
    //   1) B finished → root.items[0]=done；items[1] 仍 pending → tryCascadeSettle 0 步
    //   2) C 派出 D → registerForDispatch 注册 child worklist (parent=root)
    //   3) C finished → root.items[1]=done；items 全 done 但 child worklist 还 active
    //                   → tryCascadeSettle 0 步（v2 关键差异 vs v1 平表）
    //   4) D finished → child worklist items 全 done + 无 grandchild → cascade settle child
    //                   → 再 cascade settle root（items 全 done + child settled）
    //                   → root settle 触发 onDoneContinuation 一次
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    let lastCbWorklistId: string | null = null
    exec.setOnDoneContinuation((args) => {
      cbCount++
      lastCbWorklistId = args.worklist.worklistId
    })

    // 1) user-root call
    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const userRootCall = calls.get(userRootCallId)!
    // 2) B / C 都挂在 user-root 下（user 同 turn @ [B, C]）
    const bCallId = calls.openCall({
      parentCallId: userRootCall.callId,
      issuerId: "user",
      convenerId: "范德彪",
      replyTo: "codex:范德彪",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const cCallId = calls.openCall({
      parentCallId: userRootCall.callId,
      issuerId: "user",
      convenerId: "桂芬",
      replyTo: "gemini:桂芬",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const bCall = calls.get(bCallId)!
    const cCall = calls.get(cCallId)!

    // 3) root worklist：parent_call_id=user-root, items=[B, C]
    const rootWlId = worklists.register({
      parentWorklistId: null,
      parentCallId: userRootCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [
        { alias: "范德彪", status: "pending" },
        { alias: "桂芬", status: "pending" },
      ],
    })

    // ── Step 1: B finished
    const r1 = exec.onChildFinished({
      childCallId: bCall.callId,
      childAlias: "范德彪",
      childContent: "B reply",
      ok: true,
    })
    assert.equal(r1?.decision, "advanced", "B done 但 C 还 pending → 不 cascade")
    assert.equal(cbCount, 0)

    // ── Step 2: C reply 派 D，registerForDispatch 注册 child worklist
    const dCallId = calls.openCall({
      parentCallId: cCall.callId,
      issuerId: "桂芬",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const dCall = calls.get(dCallId)!
    // 模拟 message-service wire 的 registerForDispatch 调用 — dispatcher=C
    const childWlId = exec.registerForDispatch({
      parentCallId: cCall.callId,
      sessionGroupId: "sg-1",
      queued: [
        {
          id: "q-D",
          sessionGroupId: "sg-1",
          rootMessageId: "msg-root",
          from: { agentId: "桂芬", messageId: "msg-c", provider: "gemini" },
          to: { agentId: "黄仁勋", provider: "claude" },
          taskSnippet: "task",
          contextSnapshot: [],
          parentInvocationId: null,
          hopIndex: 2,
        },
      ],
    })
    assert.ok(childWlId, "child worklist registered")
    const childWl = worklists.get(childWlId!)!
    assert.equal(
      childWl.parentWorklistId,
      rootWlId,
      "child worklist 挂在 root worklist 下（树形不变量）",
    )

    // ── Step 3: C finished — items 全 done 但 child worklist 还 active → root 不 settle
    const r3 = exec.onChildFinished({
      childCallId: cCall.callId,
      childAlias: "桂芬",
      childContent: "C 中间 reply 含 [Call:@黄仁勋]",
      ok: true,
    })
    assert.equal(r3?.decision, "advanced", "v2 关键：items 全 done 但有 active child → 不 cascade")
    assert.equal(r3?.rootSettled, false)
    assert.equal(cbCount, 0, "中间状态不触发续推")
    assert.equal(worklists.get(rootWlId)?.status, "active", "root 仍等 child drain")

    // ── Step 4: D finished — cascade settle child → cascade settle root → cb 触发
    const r4 = exec.onChildFinished({
      childCallId: dCall.callId,
      childAlias: "黄仁勋",
      childContent: "D final reply",
      ok: true,
    })
    assert.equal(r4?.decision, "settled")
    assert.equal(r4?.rootSettled, true, "root cascade settle 命中")
    assert.equal(worklists.get(childWlId!)?.status, "settled", "child 先 settle")
    assert.equal(worklists.get(rootWlId)?.status, "settled", "root 后 settle")
    assert.equal(cbCount, 1, "整棵树 drain 后续推 cb 触发恰好一次")
    assert.equal(lastCbWorklistId, rootWlId, "续推目标 = root worklist")
  })

  it("scenario: 接力 user@A → A reply [Call:@B] → A continuation reply [Call:@C] → C done — root settles", () => {
    // 树形（接力两层）：
    //   user-root
    //     └── A_call (root WL items=[A], parentCall=user-root)
    //          └── B_call (child WL items=[B], parentCall=A_call, parentWL=rootWl)
    //                 (B done 触发 A 续推；A 续推 reply 含 [Call:@C] → register grandchild WL)
    //          └── A_continuation_call (under user-root in v2 wire 的 dispatchWorklistContinuation)
    //                 此处简化：把"A 续推后再派 C"建模为 root WL 同层并行（不挂 A_call 下）
    //
    // 接力场景关键不变量：root WL 在 [A 续推] 之后仍含 active items 时不 settle。
    // 这条测试主要锁住 cascade 不会绕过 'items 全 done 才 settle' 的不变量。
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    exec.setOnDoneContinuation(() => cbCount++)

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const userRootCall = calls.get(userRootCallId)!
    const aCallId = calls.openCall({
      parentCallId: userRootCall.callId,
      issuerId: "user",
      convenerId: "黄仁勋",
      replyTo: "claude:黄仁勋",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const aCall = calls.get(aCallId)!
    // root WL: user 派 @A
    const rootWlId = worklists.register({
      parentWorklistId: null,
      parentCallId: userRootCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "黄仁勋", status: "pending" }],
    })
    // A reply 派 [Call:@B] → register B child WL
    const bCallId = calls.openCall({
      parentCallId: aCall.callId,
      issuerId: "黄仁勋",
      convenerId: "范德彪",
      replyTo: "codex:范德彪",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const bCall = calls.get(bCallId)!
    const bWlId = worklists.register({
      parentWorklistId: rootWlId,
      parentCallId: aCall.callId,
      rootCallId: userRootCall.rootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })

    // A finished (中间 reply 含 [Call:@B]) — root 不 settle
    exec.onChildFinished({
      childCallId: aCall.callId,
      childAlias: "黄仁勋",
      childContent: "A 中间 reply",
      ok: true,
    })
    assert.equal(cbCount, 0, "B 还没做完 → 不续推")
    assert.equal(worklists.get(rootWlId)?.status, "active")

    // B finished — cascade settle B WL → 再 cascade root WL settle
    exec.onChildFinished({
      childCallId: bCall.callId,
      childAlias: "范德彪",
      childContent: "B final reply",
      ok: true,
    })
    assert.equal(worklists.get(bWlId)?.status, "settled", "B WL settled")
    assert.equal(worklists.get(rootWlId)?.status, "settled", "root WL cascade settled")
    assert.equal(cbCount, 1, "root settle 触发续推 cb")
  })
})

describe("WorklistExecutor.onChildFinished alias-guard (review#1 directTurn race)", () => {
  it("alias 不在 worklist.items 时 noop（不污染兄弟 item）", () => {
    // 场景：user 在 thread-Reviewer 中输入 "@Coder ..."（含 mention 但 sourceInQueue=false）
    //   - userRootCall (parent=null)
    //     ├── directTurnCall  (parent=userRootCall, replyTo="claude:Reviewer") ← thread agent 自回
    //     └── coderCall       (parent=userRootCall, replyTo="codex:Coder")     ← enqueueResult.queued
    //   - root worklist: parent=userRootCall, items=[Coder]   ← Reviewer 不在 items
    //
    // bug（修前）：directTurn 完成调 onChildFinished(directTurnCall, alias="Reviewer")
    //   childRow.parentCallId = userRootCall → findActiveByParentCallId 找到 root worklist
    //   findIndex("Reviewer") = -1 → fallback currentIndex = 0
    //   → markItemStatus(0, "done") 把 Coder item 标 done，cascade 提前 settle root → 续推错链路
    //
    // expected: alias 不在 items 时 onChildFinished 必须 noop —— 不污染兄弟 item，不 settle worklist
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    let cbCount = 0
    exec.setOnDoneContinuation(() => cbCount++)

    const userRootCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const directTurnCallId = calls.openCall({
      parentCallId: userRootCallId,
      issuerId: "user",
      convenerId: "Reviewer",
      replyTo: "claude:Reviewer",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })

    const rootWlId = worklists.register({
      parentWorklistId: null,
      parentCallId: userRootCallId,
      rootCallId: userRootCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "Coder", status: "pending" }],
    })

    const result = exec.onChildFinished({
      childCallId: directTurnCallId,
      childAlias: "Reviewer",
      childContent: "thread agent reply",
      ok: true,
    })

    assert.equal(result, null, "alias 不在 items 时返回 null (noop)")
    const wl = worklists.get(rootWlId)!
    assert.equal(wl.items[0]?.status, "pending", "兄弟 item Coder 必须仍 pending")
    assert.equal(wl.status, "active", "worklist 不能被错误 settle")
    assert.equal(cbCount, 0, "续推不能被触发")
  })

  it("alias 缺省（undefined）时仍走 currentIndex fallback —— 兼容老路径", () => {
    // alias-guard 只对"显式 alias 但不在 items"生效；alias 缺省（undefined / null / 空）
    // 是另一类 case（老路径 / 单 item worklist），保留 currentIndex fallback。
    const db = setupDb()
    const calls = new CallRegistry({ db })
    const worklists = new WorklistRegistry({ db })
    const exec = new WorklistExecutor({ callRegistry: calls, worklistRegistry: worklists })

    const parentCallId = calls.openCall({
      issuerId: "user",
      convenerId: "user",
      replyTo: "user",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })
    const childCallId = calls.openCall({
      parentCallId,
      issuerId: "user",
      convenerId: "Coder",
      replyTo: "codex:Coder",
      sessionGroupId: "sg-1",
      deadlineAt: "2026-05-05T01:00:00.000Z",
    })

    const rootWlId = worklists.register({
      parentWorklistId: null,
      parentCallId,
      rootCallId: parentCallId,
      sessionGroupId: "sg-1",
      items: [{ alias: "Coder", status: "pending" }],
    })

    const result = exec.onChildFinished({
      childCallId,
      // childAlias intentionally omitted
      childContent: "ok",
      ok: true,
    })

    assert.ok(result, "alias 缺省时按 currentIndex fallback")
    const wl = worklists.get(rootWlId)!
    assert.equal(wl.items[0]?.status, "done", "Coder item 标 done（fallback 正常工作）")
  })
})
