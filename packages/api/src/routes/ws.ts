import type { FastifyInstance } from "fastify";
import type { OptionVerdict, RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";
import type { ApprovalManager } from "../orchestrator/approval-manager";
import type { MessageService } from "../services/message-service";
import { createLogger } from "../lib/logger";

const log = createLogger("ws");

type SocketLike = {
  send: (payload: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

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
    socket.send(JSON.stringify(event));
    return true;
  } catch (err) {
    log.warn({ err, eventType: event.type }, "socket send failed, evicting");
    return false;
  }
}

export type RealtimeBroadcaster = {
  broadcast: (event: RealtimeServerEvent) => void;
};

export function registerWsRoute(
  app: FastifyInstance,
  options: {
    messages: MessageService;
    broadcaster: RealtimeBroadcaster;
    approvals?: ApprovalManager;
    onDecisionRespond?: (requestId: string, decisions: Array<{optionId: string; verdict: OptionVerdict; modification?: string}>, userInput?: string) => void;
  }
) {
  const sockets = new Set<SocketLike>();

  options.broadcaster.broadcast = (event) => {
    // Broadcasts are room-wide fan-out events: snapshots, public callback messages and shared status updates.
    // sendSocketEvent now swallows exceptions internally and reports success via its return value,
    // so we no longer need the outer try/catch — we just drop any socket that failed to deliver.
    for (const socket of sockets) {
      if (!sendSocketEvent(socket, event)) {
        sockets.delete(socket);
      }
    }
  };

  app.route({
    method: "GET",
    url: "/ws",
    handler: async (_request, reply) => {
      reply.code(426);
      return { error: "Please connect with WebSocket." };
    },
    wsHandler: (socket) => {
      sockets.add(socket as SocketLike);
      log.info({ total: sockets.size }, "client connected");

      let isAlive = true;
      const heartbeatInterval = setInterval(() => {
        if (!isAlive) {
          log.info("heartbeat timeout, terminating connection");
          clearInterval(heartbeatInterval);
          sockets.delete(socket as SocketLike);
          socket.terminate?.();
          return;
        }
        isAlive = false;
        socket.ping?.();
      }, 30_000);

      socket.on("pong", () => { isAlive = true; });

      socket.on("close", () => {
        clearInterval(heartbeatInterval);
        sockets.delete(socket as SocketLike);
        log.info({ total: sockets.size }, "client disconnected");
      });

      socket.on("message", async (raw: Buffer) => {
        let event: RealtimeClientEvent;
        try {
          event = JSON.parse(raw.toString()) as RealtimeClientEvent;
        } catch {
          log.warn("malformed JSON from client, ignoring");
          return;
        }
        log.debug({ type: event.type }, "client event received");

        if (event.type === "approval.respond" && options.approvals) {
          options.approvals.respond(
            event.payload.requestId,
            event.payload.granted,
            event.payload.scope,
          );
          return;
        }

        if (event.type === "decision.respond" && options.onDecisionRespond) {
          options.onDecisionRespond(
            event.payload.requestId,
            event.payload.decisions,
            event.payload.userInput,
          );
          return;
        }

        // Direct per-turn emit: bound to a single socket for the whole agent turn.
        // If the WebSocket silently drops mid-turn (TCP timeout, proxy reset), sendSocketEvent
        // returns false; we evict the socket so later broadcasts skip it, and swallow the result
        // so the message-service processing chain continues even when the client is gone.
        options.messages.handleClientEvent(event, (payload) => {
          const sock = socket as SocketLike;
          if (!sendSocketEvent(sock, payload)) {
            sockets.delete(sock);
          }
        });
      });
    }
  });
}
