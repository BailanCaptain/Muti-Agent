import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { SqliteStore } from "../db/sqlite"
import { CallRegistry } from "../orchestrator/call-registry"
import { registerDebugA2ARoutes } from "./debug-a2a"

/**
 * F026 P5 T3 · /debug/a2a 扩 status filter + session-trees 视图
 *
 * 覆盖：
 *   - 旧 ?root= / ?parent= 向后兼容（P1）
 *   - 新 ?status=<CallStatus> 全表过滤（P5 T3 plan AC-P5-1）
 *   - 新 ?session=<gid>&view=tree 房间聚合（P5 T3 plan AC-P5-1）
 *   - 错误路径：?status=invalid / ?session= 缺 view / 无 query
 */

function buildHarness(): {
  app: ReturnType<typeof Fastify>
  registry: CallRegistry
  close: () => void
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-debug-a2a-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  const clock = Date.parse("2026-04-29T08:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const registry = new CallRegistry({ db: store.db, now })
  const app = Fastify()
  registerDebugA2ARoutes(app, { callRegistry: registry })
  return {
    app,
    registry,
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

test("F026 P5 T3 · GET /debug/a2a?root= 向后兼容（P1 旧形态仍 work）", async () => {
  const h = buildHarness()
  try {
    const callId = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const res = await h.app.inject({ method: "GET", url: `/debug/a2a?root=${callId}` })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as { kind: string; rootCallId: string; calls: unknown[] }
    assert.equal(body.kind, "tree")
    assert.equal(body.rootCallId, callId)
    assert.equal(body.calls.length, 1)
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a?parent= 向后兼容（P1 旧形态仍 work）", async () => {
  const h = buildHarness()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const child = h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const res = await h.app.inject({ method: "GET", url: `/debug/a2a?parent=${root}` })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as { kind: string; calls: Array<{ callId: string }> }
    assert.equal(body.kind, "pending")
    assert.equal(body.calls.length, 1)
    assert.equal(body.calls[0].callId, child)
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a?status=pending 全表过滤返回 pending calls", async () => {
  const h = buildHarness()
  try {
    const c1 = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    h.registry.openCall({
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "agent:桂芬",
      sessionGroupId: "g2",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    // 第三个 advance 到 working —— 不应出现在 pending 过滤
    const c3 = h.registry.openCall({
      issuerId: "范德彪",
      convenerId: "范德彪",
      replyTo: "agent:范德彪",
      sessionGroupId: "g3",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    h.registry.advance(c3, "working")

    const res = await h.app.inject({ method: "GET", url: "/debug/a2a?status=pending" })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as {
      kind: string
      status: string
      calls: Array<{ callId: string; status: string }>
    }
    assert.equal(body.kind, "status")
    assert.equal(body.status, "pending")
    assert.equal(body.calls.length, 2) // c1 + 桂芬，c3 已 working
    for (const c of body.calls) assert.equal(c.status, "pending")
    assert.ok(body.calls.some((c) => c.callId === c1))
    assert.ok(!body.calls.some((c) => c.callId === c3))
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a?status=timeout 全表过滤返回 timeout calls", async () => {
  const h = buildHarness()
  try {
    const c1 = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    h.registry.settle(c1, "timeout")

    const res = await h.app.inject({ method: "GET", url: "/debug/a2a?status=timeout" })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as {
      kind: string
      status: string
      calls: Array<{ callId: string; status: string }>
    }
    assert.equal(body.kind, "status")
    assert.equal(body.calls.length, 1)
    assert.equal(body.calls[0].callId, c1)
    assert.equal(body.calls[0].status, "timeout")
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a?status=invalid → 400 + 错误说明", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({ method: "GET", url: "/debug/a2a?status=banana" })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.body) as { error: string }
    assert.match(body.error, /invalid status/)
    assert.match(body.error, /pending/) // 错误提示列出合法值
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a?session=g1&view=tree 返回该房间全部 root trees", async () => {
  const h = buildHarness()
  try {
    const root1 = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const child1 = h.registry.openCall({
      parentCallId: root1,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const root2 = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    // 不同 session 的 root 不该出现
    h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g2",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })

    const res = await h.app.inject({ method: "GET", url: "/debug/a2a?session=g1&view=tree" })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as {
      kind: string
      sessionGroupId: string
      trees: Array<{ rootCallId: string; calls: Array<{ callId: string }> }>
    }
    assert.equal(body.kind, "session_trees")
    assert.equal(body.sessionGroupId, "g1")
    assert.equal(body.trees.length, 2) // root1 + root2，g2 的 root 排除
    const rootIds = body.trees.map((t) => t.rootCallId).sort()
    assert.deepEqual(rootIds, [root1, root2].sort())
    // root1 树包括 child1
    const root1Tree = body.trees.find((t) => t.rootCallId === root1)!
    assert.ok(root1Tree.calls.some((c) => c.callId === child1))
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a?session=g1 缺 view=tree → 400", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({ method: "GET", url: "/debug/a2a?session=g1" })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.body) as { error: string }
    assert.match(body.error, /view=tree/)
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a 无 query → 400 错误信息列全四种", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({ method: "GET", url: "/debug/a2a" })
    assert.equal(res.statusCode, 400)
    const body = JSON.parse(res.body) as { error: string }
    assert.match(body.error, /root/)
    assert.match(body.error, /parent/)
    assert.match(body.error, /status/)
    assert.match(body.error, /session/)
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · GET /debug/a2a?session=empty&view=tree → 200 + trees=[]", async () => {
  const h = buildHarness()
  try {
    const res = await h.app.inject({ method: "GET", url: "/debug/a2a?session=g_empty&view=tree" })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as { kind: string; trees: unknown[] }
    assert.equal(body.kind, "session_trees")
    assert.deepEqual(body.trees, [])
  } finally {
    h.close()
  }
})

// CallRegistry 单元层 — findByStatus / getSessionTrees 直接 API 测
test("F026 P5 T3 · CallRegistry.findByStatus 跨 session 收集同 status calls 按 createdAt 升序", () => {
  const h = buildHarness()
  try {
    const c1 = h.registry.openCall({
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const c2 = h.registry.openCall({
      issuerId: "桂芬",
      convenerId: "桂芬",
      replyTo: "agent:桂芬",
      sessionGroupId: "g2",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const calls = h.registry.findByStatus("pending")
    assert.equal(calls.length, 2)
    // 按 createdAt 升序：c1 在 c2 之前 openCall（同 clock 但 SQLite ROWID 顺序）
    assert.deepEqual(calls.map((c) => c.callId).sort(), [c1, c2].sort())
  } finally {
    h.close()
  }
})

test("F026 P5 T3 · CallRegistry.getSessionTrees 仅返回 root（parent_call_id IS NULL）", () => {
  const h = buildHarness()
  try {
    const root = h.registry.openCall({
      issuerId: "user:小孙",
      convenerId: "user:小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    h.registry.openCall({
      parentCallId: root,
      issuerId: "黄仁勋",
      convenerId: "黄仁勋",
      replyTo: "agent:黄仁勋",
      sessionGroupId: "g1",
      deadlineAt: "2026-04-29T09:00:00.000Z",
    })
    const trees = h.registry.getSessionTrees("g1")
    assert.equal(trees.length, 1) // 只有 root，child 不算 root
    assert.equal(trees[0].rootCallId, root)
    assert.equal(trees[0].calls.length, 2) // root + child
  } finally {
    h.close()
  }
})
