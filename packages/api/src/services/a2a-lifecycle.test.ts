import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { SqliteStore } from "../db/sqlite"
import { CallRegistry } from "../orchestrator/call-registry"
import { A2ALifecycleService } from "./a2a-lifecycle"

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-a2a-lifecycle-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  let clock = Date.parse("2026-04-26T15:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const tick = (ms: number) => {
    clock += ms
  }
  const registry = new CallRegistry({ db: store.db, now })
  const lifecycle = new A2ALifecycleService(registry)
  const openCall = () =>
    registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "小孙",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "group-A",
      deadlineAt: "2026-04-26T15:30:00.000Z",
    })
  const status = (callId: string) =>
    (
      store.db.prepare("SELECT status FROM a2a_calls WHERE call_id = ?").get(callId) as
        | { status: string }
        | undefined
    )?.status ?? null
  return {
    registry,
    lifecycle,
    openCall,
    status,
    tick,
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

test("F026-P1 settle wiring · advance + settleDone moves status pending → working → done", () => {
  const h = tmp()
  try {
    const callId = h.openCall()
    assert.equal(h.status(callId), "pending")
    h.lifecycle.advance(callId)
    assert.equal(h.status(callId), "working")
    h.lifecycle.settleDone(callId)
    assert.equal(h.status(callId), "done")
  } finally {
    h.close()
  }
})

test("F026-P1 settle wiring · settleFailed and settleTimeout walk distinct terminal branches", () => {
  const h = tmp()
  try {
    const a = h.openCall()
    const b = h.openCall()
    h.lifecycle.advance(a)
    h.lifecycle.settleFailed(a)
    h.lifecycle.advance(b)
    h.lifecycle.settleTimeout(b)
    assert.equal(h.status(a), "failed")
    assert.equal(h.status(b), "timeout")
  } finally {
    h.close()
  }
})

test("F026-P1 settle wiring · re-settling a terminal call is a CAS noop (no throw, no overwrite)", () => {
  const h = tmp()
  try {
    const callId = h.openCall()
    h.lifecycle.advance(callId)
    h.lifecycle.settleDone(callId)
    h.tick(60_000)
    // second settle (e.g. cleanup timer firing after a successful turn) must
    // not flip status back, must not crash, must not bump updated_at
    const before = (h.registry.get(callId) as { updatedAt: string } | null)?.updatedAt
    h.lifecycle.settleDone(callId)
    h.lifecycle.settleFailed(callId)
    h.lifecycle.settleTimeout(callId)
    assert.equal(h.status(callId), "done")
    const after = (h.registry.get(callId) as { updatedAt: string } | null)?.updatedAt
    assert.equal(after, before, "terminal row updated_at must not change on noop settle")
  } finally {
    h.close()
  }
})

test("F026-P1 settle wiring · undefined callId is a noop on every method (classic / no-gateway-hook compatibility)", () => {
  const h = tmp()
  try {
    // No throw on undefined — used for legacy dispatches that never went through
    // the gateway (no hook installed / pre-gateway path).
    assert.doesNotThrow(() => h.lifecycle.advance(undefined))
    assert.doesNotThrow(() => h.lifecycle.settleDone(undefined))
    assert.doesNotThrow(() => h.lifecycle.settleFailed(undefined))
    assert.doesNotThrow(() => h.lifecycle.settleTimeout(undefined))
  } finally {
    h.close()
  }
})

test("F026-P1 settle wiring · settle on unknown callId returns false but does not throw (CAS guard)", () => {
  const h = tmp()
  try {
    // Defensive: cleanup timer fires on an invocation whose callId was never
    // opened (e.g. classic path injected an invocation without registry write).
    assert.doesNotThrow(() => h.lifecycle.settleDone("call-does-not-exist"))
    assert.doesNotThrow(() => h.lifecycle.settleFailed("call-does-not-exist"))
    assert.doesNotThrow(() => h.lifecycle.settleTimeout("call-does-not-exist"))
  } finally {
    h.close()
  }
})

// -----------------------------------------------------------------------------
// F026 P2 Step 1A · openRootCall (user-root call constructor)
//
// Why this exists:
//   handleSendMessage 入口（message-service.ts:835）调 enqueuePublicMentions
//   时不传 parentCallId，user 派发出的所有 child call 都是 orphan root —— call
//   tree 永远从 agent 起步，user 不在树上。R-080 实证：黄仁勋 [Call: @桂芬] →
//   桂芬 done 后链尾闭环时无法回追 user，续推机制（Step 1B）无锚点。
//
//   1A 锁住的契约：lifecycle 必须暴露 openRootCall API，让 user 入口建
//   issuerId="user" parentCallId=null 的 root call，作为整棵 tree 的源点。
// -----------------------------------------------------------------------------

test("F026 P2 Step 1A · openRootCall opens user-root call (parent null, issuer/convener/replyTo = user, status pending)", () => {
  const h = tmp()
  try {
    const callId = h.lifecycle.openRootCall({
      issuerAlias: "user",
      sessionGroupId: "group-A",
      deadlineAt: "2026-04-26T15:30:00.000Z",
    })

    const row = h.registry.get(callId)
    assert.ok(row, "openRootCall must produce a registered call row")
    assert.equal(row!.parentCallId, null, "user-root call has no parent")
    assert.equal(row!.rootCallId, callId, "self is root (rootCallId === callId)")
    assert.equal(row!.issuerId, "user")
    assert.equal(row!.replyTo, "user")
    assert.equal(row!.convenerId, "user")
    assert.equal(row!.status, "pending")
    assert.equal(row!.sessionGroupId, "group-A")
    assert.equal(row!.deadlineAt, "2026-04-26T15:30:00.000Z")
  } finally {
    h.close()
  }
})

test("F026 P2 Step 1A · openRootCall produces a callId usable as parentCallId for child openCall (tree接通)", () => {
  const h = tmp()
  try {
    const userRoot = h.lifecycle.openRootCall({
      issuerAlias: "user",
      sessionGroupId: "group-B",
      deadlineAt: "2026-04-26T15:30:00.000Z",
    })

    // 模拟 gateway 派发 黄仁勋 时建 child call 挂到 user-root
    const huangCall = h.registry.openCall({
      parentCallId: userRoot,
      issuerId: "黄仁勋",
      convenerId: "user",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "group-B",
      deadlineAt: "2026-04-26T15:30:00.000Z",
    })

    // 黄仁勋 reply 含 [Call: @桂芬] 时建 grandchild
    const guifenCall = h.registry.openCall({
      parentCallId: huangCall,
      issuerId: "桂芬",
      convenerId: "user",
      replyTo: "agent:桂芬",
      sessionGroupId: "group-B",
      deadlineAt: "2026-04-26T15:30:00.000Z",
    })

    const tree = h.registry.getTree(userRoot)
    assert.equal(tree.length, 3, "tree must contain user-root + 黄仁勋 + 桂芬")
    const byId = new Map(tree.map((r) => [r.callId, r]))
    assert.equal(byId.get(userRoot)!.parentCallId, null)
    assert.equal(byId.get(huangCall)!.parentCallId, userRoot)
    assert.equal(byId.get(guifenCall)!.parentCallId, huangCall)
    for (const row of tree) {
      assert.equal(row.rootCallId, userRoot, "every node shares user-root as rootCallId")
    }
  } finally {
    h.close()
  }
})

// -----------------------------------------------------------------------------
// F026 P2 Step 1A.2 · openCall (child-call constructor for directTurn path)
//
// Why this exists:
//   handleSendMessage 入口 sourceInQueue=false 路径下（用户 @ 不含 thread agent /
//   或没 @ 任何人），thread agent 自己回 directTurn。这条 child call 不走
//   a2a-gateway（gateway 只处理 mention 派发），message-service 必须自建 child
//   call 挂在 user-root 下，并把 callId 透 dispatchedCallId 给 runThreadTurn。
//
//   1A.2 锁住的契约：lifecycle 必须暴露对称的 openCall API（thin wrapper of
//   registry.openCall），让 caller 不用拿 registry 直接动手。
// -----------------------------------------------------------------------------

test("F026 P2 Step 1A.2 · openCall builds child call linked to user-root (parentCallId 接通, rootCallId 共享)", () => {
  const h = tmp()
  try {
    const userRoot = h.lifecycle.openRootCall({
      issuerAlias: "user",
      sessionGroupId: "group-1A2",
      deadlineAt: "2026-04-26T15:30:00.000Z",
    })

    const directTurnChild = h.lifecycle.openCall({
      parentCallId: userRoot,
      issuerAlias: "user",
      sessionGroupId: "group-1A2",
      deadlineAt: "2026-04-26T15:30:00.000Z",
    })

    const row = h.registry.get(directTurnChild)
    assert.ok(row, "openCall must produce a registered call row")
    assert.equal(row!.parentCallId, userRoot, "child must link to user-root")
    assert.equal(row!.rootCallId, userRoot, "child shares user-root as rootCallId")
    assert.equal(row!.issuerId, "user", "directTurn child issuer is 'user' (user dispatches thread agent to reply)")
    assert.equal(row!.replyTo, "user")
    assert.equal(row!.convenerId, "user")
    assert.equal(row!.status, "pending", "newly opened child starts pending")
  } finally {
    h.close()
  }
})

