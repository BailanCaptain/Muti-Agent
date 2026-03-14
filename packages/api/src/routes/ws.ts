import type { FastifyInstance } from "fastify";
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";
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
  options: { messages: MessageService; broadcaster: RealtimeBroadcaster }
) {
  const sockets = new Set<SocketLike>();

  options.broadcaster.broadcast = (event) => {
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
        options.messages.handleClientEvent(event, (payload) => sendSocketEvent(socket as SocketLike, payload));
      });
    }
  });
}
