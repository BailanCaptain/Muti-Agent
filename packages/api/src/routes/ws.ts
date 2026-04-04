import type { FastifyInstance } from "fastify";
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";
import type { ApprovalManager } from "../orchestrator/approval-manager";
import type { MessageService } from "../services/message-service";

type SocketLike = {
  send: (payload: string) => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

function sendSocketEvent(socket: SocketLike, event: RealtimeServerEvent) {
  socket.send(JSON.stringify(event));
}

export type RealtimeBroadcaster = {
  broadcast: (event: RealtimeServerEvent) => void;
};

export function registerWsRoute(
  app: FastifyInstance,
  options: { messages: MessageService; broadcaster: RealtimeBroadcaster; approvals?: ApprovalManager }
) {
  const sockets = new Set<SocketLike>();

  options.broadcaster.broadcast = (event) => {
    // Broadcasts are room-wide fan-out events: snapshots, public callback messages and shared status updates.
    for (const socket of sockets) {
      try {
        sendSocketEvent(socket, event);
      } catch {
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

      socket.on("close", () => {
        sockets.delete(socket as SocketLike);
      });

      socket.on("message", async (raw: Buffer) => {
        const event = JSON.parse(raw.toString()) as RealtimeClientEvent;

        if (event.type === "approval.respond" && options.approvals) {
          options.approvals.respond(
            event.payload.requestId,
            event.payload.granted,
            event.payload.scope,
          );
          return;
        }

        options.messages.handleClientEvent(event, (payload) => sendSocketEvent(socket as SocketLike, payload));
      });
    }
  });
}
