import type {
  OptionVerdict,
  RealtimeClientEvent,
  RealtimeServerEvent,
  SequencedRealtimeServerEvent,
} from "@multi-agent/shared"
import type { FastifyInstance } from "fastify"
import { createLogger } from "../lib/logger"
import type { ApprovalManager } from "../orchestrator/approval-manager"
import type { MessageService } from "../services/message-service"
import { extractSessionGroupId, shouldDeliver } from "./ws-routing"
import type { GroupSequencer } from "./ws-sequencer"

const log = createLogger("ws")

type SocketLike = {
  send: (payload: string) => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
}

// F026 P0 Day2 · socket 订阅状态 — 由 client 的 subscribe 事件写入，broadcast 按此过滤
type SubscribedSocket = SocketLike & { sessionGroupId?: string }

/**
 * Sends a realtime event to a single socket. Returns `true` on success and `false`
 * when the underlying `socket.send()` threw (typical when the WebSocket is in a
 * closed/half-open state). The function NEVER propagates the exception — long-lived
 * emit closures held by the message-service processing chain rely on this guarantee
 * so that a dead client cannot interrupt `overwriteMessage` → `detachRun` →
 * `emitThreadSnapshot` (the B001 "agent stuck as working" bug).
 *
 * Callers that track the socket (e.g. the broadcaster's `sockets` Set) should treat
 * a `false` return as a signal to remove the socket.
 */
export function sendSocketEvent(socket: SocketLike, event: RealtimeServerEvent): boolean {
  try {
    socket.send(JSON.stringify(event))
    return true
  } catch (err) {
    log.warn({ err, eventType: event.type }, "socket send failed, evicting")
    return false
  }
}

export type RealtimeBroadcaster = {
  broadcast: (event: RealtimeServerEvent) => void
}

export function registerWsRoute(
  app: FastifyInstance,
  options: {
    messages: MessageService
    broadcaster: RealtimeBroadcaster
    sequencer: GroupSequencer
    approvals?: ApprovalManager
    onDecisionRespond?: (
      requestId: string,
      decisions: Array<{ optionId: string; verdict: OptionVerdict; modification?: string }>,
      userInput?: string,
    ) => void
  },
) {
  const sockets = new Set<SubscribedSocket>()

  options.broadcaster.broadcast = (event) => {
    // F026 P0 Day2 · I3 sessionGroupId 强过滤：
    //   - 事件带 groupId → 仅发给订阅相同 group 的 socket（strict mode · 未订阅 socket 拒收）
    //   - 事件无 groupId → fan-out 所有 socket（legacy 兼容 · 当前仅 status/preview.auto_open 部分形态）
    const eventGroupId = extractSessionGroupId(event)
    // F031 · 仅 broadcast 通道注 seq/epoch：循环前盖一次，同组 N socket 收同一 seq。
    // 直发通道（下方 handleClientEvent 的 socket-bound emit）不注——直发只达单 socket，
    // 消耗同组计数器会给其他订阅 socket 制造假 gap → catch-up 风暴。
    const outbound: SequencedRealtimeServerEvent = eventGroupId
      ? {
          ...event,
          seq: options.sequencer.next(eventGroupId),
          epoch: options.sequencer.epoch,
        }
      : event
    for (const socket of sockets) {
      if (!shouldDeliver(socket.sessionGroupId, eventGroupId)) continue
      if (!sendSocketEvent(socket, outbound)) {
        sockets.delete(socket)
      }
    }
  }

  app.route({
    method: "GET",
    url: "/ws",
    handler: async (_request, reply) => {
      reply.code(426)
      return { error: "Please connect with WebSocket." }
    },
    wsHandler: (socket) => {
      sockets.add(socket as SubscribedSocket)
      log.info({ total: sockets.size }, "client connected")

      let isAlive = true
      const heartbeatInterval = setInterval(() => {
        if (!isAlive) {
          log.info("heartbeat timeout, terminating connection")
          clearInterval(heartbeatInterval)
          sockets.delete(socket as SubscribedSocket)
          socket.terminate?.()
          return
        }
        isAlive = false
        socket.ping?.()
      }, 30_000)

      socket.on("pong", () => {
        isAlive = true
      })

      socket.on("close", () => {
        clearInterval(heartbeatInterval)
        sockets.delete(socket as SubscribedSocket)
        log.info({ total: sockets.size }, "client disconnected")
      })

      socket.on("message", async (raw: Buffer) => {
        let event: RealtimeClientEvent
        try {
          event = JSON.parse(raw.toString()) as RealtimeClientEvent
        } catch {
          log.warn("malformed JSON from client, ignoring")
          return
        }
        log.debug({ type: event.type }, "client event received")

        if (event.type === "subscribe") {
          // F026 P0 Day2 · client 切房间时 send subscribe；同 socket 再次订阅覆盖旧值
          ;(socket as SubscribedSocket).sessionGroupId = event.payload.sessionGroupId
          log.debug({ sessionGroupId: event.payload.sessionGroupId }, "socket subscribed to group")
          return
        }

        if (event.type === "approval.respond" && options.approvals) {
          options.approvals.respond(
            event.payload.requestId,
            event.payload.granted,
            event.payload.scope,
          )
          return
        }

        if (event.type === "decision.respond" && options.onDecisionRespond) {
          options.onDecisionRespond(
            event.payload.requestId,
            event.payload.decisions,
            event.payload.userInput,
          )
          return
        }

        // Direct per-turn emit: bound to a single socket for the whole agent turn.
        // If the WebSocket silently drops mid-turn (TCP timeout, proxy reset), sendSocketEvent
        // returns false; we evict the socket so later broadcasts skip it, and swallow the result
        // so the message-service processing chain continues even when the client is gone.
        options.messages.handleClientEvent(event, (payload) => {
          const sock = socket as SocketLike
          if (!sendSocketEvent(sock, payload)) {
            sockets.delete(sock)
          }
        })
      })
    },
  })
}
