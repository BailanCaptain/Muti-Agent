import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { RealtimeServerEvent } from "@multi-agent/shared"
import type { MessageService } from "../services/message-service"
import { type RealtimeBroadcaster, registerWsRoute, sendSocketEvent } from "./ws"
import { GroupSequencer } from "./ws-sequencer"

// B001 regression: 长 agent turn 期间 WebSocket 可能进入半开状态；
// 此时 socket.send() 可能同步抛异常。sendSocketEvent 必须吞掉异常，
// 返回 false，以防止异常冒泡破坏 message-service 的处理链
// （例如中断 overwriteMessage + detachRun + emitThreadSnapshot 序列）。
describe("sendSocketEvent (B001 regression)", () => {
  const makeEvent = (): RealtimeServerEvent => ({
    type: "status",
    payload: { message: "probe" },
  })

  it("returns true and delivers payload on a healthy socket", () => {
    const sent: string[] = []
    const socket = {
      send: (payload: string) => {
        sent.push(payload)
      },
      on: () => undefined,
    }

    const ok = sendSocketEvent(socket, makeEvent())

    assert.equal(ok, true)
    assert.equal(sent.length, 1)
    const parsed = JSON.parse(sent[0]) as RealtimeServerEvent
    assert.equal(parsed.type, "status")
  })

  it("returns false instead of throwing when socket.send throws", () => {
    const socket = {
      send: () => {
        throw new Error("WebSocket is not open: readyState 3 (CLOSED)")
      },
      on: () => undefined,
    }

    let thrown: unknown = null
    let result: boolean | undefined
    try {
      result = sendSocketEvent(socket, makeEvent())
    } catch (err) {
      thrown = err
    }

    assert.equal(thrown, null, "sendSocketEvent must not propagate send() exceptions")
    assert.equal(result, false, "sendSocketEvent must report delivery failure to caller")
  })

  it("isolates throwing sockets so subsequent calls continue normally", () => {
    // Simulates the processing chain: first emit fails (broken socket),
    // but the next emit to a different socket (e.g. emitThreadSnapshot after
    // detachRun) must still succeed.
    const deadSocket = {
      send: () => {
        throw new Error("socket closed")
      },
      on: () => undefined,
    }
    const liveDelivery: string[] = []
    const liveSocket = {
      send: (payload: string) => {
        liveDelivery.push(payload)
      },
      on: () => undefined,
    }

    const first = sendSocketEvent(deadSocket, makeEvent())
    const second = sendSocketEvent(liveSocket, makeEvent())

    assert.equal(first, false)
    assert.equal(second, true)
    assert.equal(liveDelivery.length, 1)
  })
})

/**
 * F031 · broadcast 咽喉 seq/epoch 注入。
 * fake app 捕获 app.route 配置直接调 wsHandler —— 测真闭包（订阅过滤 + 注入 + 逐 socket 发送），
 * 不起真 Fastify。
 */

type CapturedRoute = { wsHandler: (socket: unknown) => void }

class FakeSocket {
  sent: Array<Record<string, unknown>> = []
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>)
  }

  on(event: string, listener: (...args: unknown[]) => void) {
    const arr = this.listeners.get(event) ?? []
    arr.push(listener)
    this.listeners.set(event, arr)
  }

  fire(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) {
      l(...args)
    }
  }

  ping() {}
  terminate() {}
}

function deltaEvent(groupId: string, delta = "x"): RealtimeServerEvent {
  return {
    type: "assistant_delta",
    payload: { sessionGroupId: groupId, messageId: "m1", delta },
  }
}

function setupWsRoute() {
  let captured: CapturedRoute | null = null
  const app = { route: (cfg: unknown) => { captured = cfg as CapturedRoute } }
  const broadcaster: RealtimeBroadcaster = { broadcast: () => {} }
  const sequencer = new GroupSequencer()
  registerWsRoute(app as never, {
    messages: { handleClientEvent: () => {} } as unknown as MessageService,
    broadcaster,
    sequencer,
  })
  const sockets: FakeSocket[] = []
  const connect = (groupId?: string) => {
    const sock = new FakeSocket()
    assert.ok(captured, "app.route 未被调用")
    captured.wsHandler(sock)
    if (groupId) {
      sock.fire(
        "message",
        Buffer.from(JSON.stringify({ type: "subscribe", payload: { sessionGroupId: groupId } })),
      )
    }
    sockets.push(sock)
    return sock
  }
  // wsHandler 每连接建 30s 心跳 interval；close 清掉，防测试进程挂住
  const teardown = () => {
    for (const sock of sockets) sock.fire("close")
  }
  return { broadcaster, sequencer, connect, teardown }
}

describe("registerWsRoute broadcast seq/epoch 注入 (F031 AC1)", () => {
  it("带 groupId 事件：同组 N socket 收同一 seq + epoch，异组不收", () => {
    const { broadcaster, sequencer, connect, teardown } = setupWsRoute()
    const a1 = connect("g1")
    const a2 = connect("g1")
    const b = connect("g2")

    broadcaster.broadcast(deltaEvent("g1"))

    assert.equal(a1.sent.length, 1)
    assert.equal(a2.sent.length, 1)
    assert.equal(b.sent.length, 0)
    assert.equal(a1.sent[0].seq, 1)
    assert.equal(a2.sent[0].seq, 1)
    assert.equal(a1.sent[0].epoch, sequencer.epoch)
    teardown()
  })

  it("连续 broadcast 同组 seq 递增；不同组独立计数", () => {
    const { broadcaster, connect, teardown } = setupWsRoute()
    const a = connect("g1")
    const b = connect("g2")

    broadcaster.broadcast(deltaEvent("g1"))
    broadcaster.broadcast(deltaEvent("g1"))
    broadcaster.broadcast(deltaEvent("g2"))

    assert.equal(a.sent[0].seq, 1)
    assert.equal(a.sent[1].seq, 2)
    assert.equal(b.sent[0].seq, 1)
    teardown()
  })

  it("无 groupId 事件：fan-out 所有 socket 且不带 seq/epoch", () => {
    const { broadcaster, connect, teardown } = setupWsRoute()
    const a = connect("g1")
    const b = connect("g2")

    broadcaster.broadcast({ type: "status", payload: { message: "hello" } })

    assert.equal(a.sent.length, 1)
    assert.equal(b.sent.length, 1)
    assert.ok(!("seq" in a.sent[0]), "无 groupId 事件不应注 seq")
    assert.ok(!("epoch" in a.sent[0]), "无 groupId 事件不应注 epoch")
    teardown()
  })

  it("直发通道（sendSocketEvent）不注 seq —— 固化双通道契约", () => {
    const sock = new FakeSocket()
    sendSocketEvent(sock as never, deltaEvent("g1"))
    assert.equal(sock.sent.length, 1)
    assert.ok(
      !("seq" in sock.sent[0]),
      "直发事件不应带 seq（消耗同组计数器会给其他 socket 造假 gap）",
    )
  })

  it("send 抛错的 socket 被逐出，后续 broadcast 其余 socket seq 连续（evict 场景服务端半边）", () => {
    const { broadcaster, connect, teardown } = setupWsRoute()
    const healthy = connect("g1")
    const dead = connect("g1")
    dead.send = () => {
      throw new Error("half-open")
    }

    broadcaster.broadcast(deltaEvent("g1"))
    broadcaster.broadcast(deltaEvent("g1"))

    assert.equal(healthy.sent.length, 2)
    assert.equal(healthy.sent[0].seq, 1)
    assert.equal(healthy.sent[1].seq, 2)
    teardown()
  })
})
