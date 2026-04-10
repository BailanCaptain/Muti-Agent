import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { RealtimeServerEvent } from "@multi-agent/shared"
import { sendSocketEvent } from "./ws"

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
