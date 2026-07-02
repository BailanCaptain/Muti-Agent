import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SessionService } from "../services/session-service"
import { registerThreadRoutes } from "./threads"
import { GroupSequencer } from "./ws-sequencer"

/**
 * F031 AC2 · GET /api/session-groups/:groupId 携带 wsWatermark（read-before-build）。
 * fake app 按 (method, path) 收集 handler，直接调用 —— 不起真 Fastify。
 */

type Handler = (request: unknown, reply?: unknown) => Promise<unknown>

function setupRoutes(overrides: { flushActiveStreaming?: (groupId: string) => void } = {}) {
  const handlers = new Map<string, Handler>()
  const record = (method: string) => (path: string, handler: Handler) => {
    handlers.set(`${method} ${path}`, handler)
  }
  const app = {
    get: record("GET"),
    post: record("POST"),
    patch: record("PATCH"),
    delete: record("DELETE"),
    put: record("PUT"),
  }
  const sequencer = new GroupSequencer()
  const sessions = {
    getActiveGroup: (groupId: string) => ({ id: groupId, timeline: [] }),
    listSessionGroups: () => [],
  } as unknown as SessionService
  registerThreadRoutes(app as never, {
    sessions,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => false,
    redisSummary: null,
    sequencer,
    flushActiveStreaming: overrides.flushActiveStreaming,
  })
  return { handlers, sequencer }
}

describe("GET /api/session-groups/:groupId wsWatermark (F031 AC2)", () => {
  it("响应携带 { epoch, seq }，seq = 该组当前水位（未广播过 = 0）", async () => {
    const { handlers, sequencer } = setupRoutes()
    const handler = handlers.get("GET /api/session-groups/:groupId")
    assert.ok(handler, "路由未注册")

    const fresh = (await handler({ params: { groupId: "g1" } })) as {
      wsWatermark?: { epoch: string; seq: number }
    }
    assert.deepEqual(fresh.wsWatermark, { epoch: sequencer.epoch, seq: 0 })

    sequencer.next("g1")
    sequencer.next("g1")
    sequencer.next("g2")
    const after = (await handler({ params: { groupId: "g1" } })) as {
      wsWatermark?: { epoch: string; seq: number }
    }
    assert.deepEqual(after.wsWatermark, { epoch: sequencer.epoch, seq: 2 })
  })

  it("read-before-build：flush 期间新广播消耗 seq，水位线仍是 flush 前的值", async () => {
    let seqRef: GroupSequencer | null = null
    const { handlers, sequencer } = setupRoutes({
      flushActiveStreaming: () => {
        // 模拟快照组装期间有新事件被广播（消耗计数器）——
        // 过投递安全 / 欠投递不安全：水位线必须取 flush 前的值
        seqRef?.next("g1")
      },
    })
    seqRef = sequencer
    sequencer.next("g1") // 组装前水位 = 1
    const handler = handlers.get("GET /api/session-groups/:groupId")
    assert.ok(handler, "路由未注册")

    const res = (await handler({ params: { groupId: "g1" } })) as {
      wsWatermark?: { epoch: string; seq: number }
    }
    assert.equal(res.wsWatermark?.seq, 1, "水位线必须是 flush 前读取的值（read-before-build）")
    assert.equal(sequencer.current("g1"), 2, "flush 内确实消耗了新 seq（测试前提自证）")
  })

  it("/api/bootstrap 不带 wsWatermark（无单组语义，德彪 r1 P2）", async () => {
    const { handlers } = setupRoutes()
    const handler = handlers.get("GET /api/bootstrap")
    assert.ok(handler, "路由未注册")
    const res = (await handler({})) as Record<string, unknown>
    assert.ok(!("wsWatermark" in res), "bootstrap 不应带全局水位线")
  })
})
