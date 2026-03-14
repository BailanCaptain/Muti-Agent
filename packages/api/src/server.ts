import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";
import { listProviderProfiles } from "./runtime/provider-profiles";
import { runTurn } from "./runtime/cli-orchestrator";
import { getRedisReservation } from "./runtime/redis";
import { SessionService } from "./services/session-service";
import { SessionRepository } from "./storage/repositories";
import { SqliteStore } from "./storage/sqlite";

type SendModelBody = {
  model?: string;
};

function sendSocketEvent(socket: { send: (payload: string) => void }, event: RealtimeServerEvent) {
  socket.send(JSON.stringify(event));
}

export async function createApiServer(options: {
  sqlitePath: string;
  corsOrigin: string;
  redisUrl: string;
}) {
  const app = Fastify({ logger: true });
  const providerProfiles = listProviderProfiles();
  const sqlite = new SqliteStore(options.sqlitePath);
  const repository = new SessionRepository(sqlite);
  const sessions = new SessionService(repository, providerProfiles);
  const activeRuns = new Map<string, ReturnType<typeof runTurn>>();

  await app.register(cors, {
    origin: options.corsOrigin,
    credentials: true
  });
  await app.register(websocket);

  app.get("/health", async () => ({
    ok: true,
    redis: getRedisReservation(options.redisUrl)
  }));

  app.get("/api/bootstrap", async () => ({
    sessionGroups: sessions.listSessionGroups()
  }));

  app.get("/api/providers", async () => ({
    providers: sessions.listProviderCatalog(),
    redis: getRedisReservation(options.redisUrl)
  }));

  app.post("/api/session-groups", async () => {
    const groupId = sessions.createSessionGroup();
    return { groupId };
  });

  app.get("/api/session-groups/:groupId", async (request) => {
    const params = request.params as { groupId: string };
    return {
      activeGroup: sessions.getActiveGroup(params.groupId, new Set(activeRuns.keys()))
    };
  });

  app.post("/api/threads/:threadId/model", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { threadId: string };
    const body = request.body as SendModelBody;
    const thread = sessions.findThread(params.threadId);

    if (!thread) {
      reply.code(404);
      return { error: "会话不存在" };
    }

    if (activeRuns.has(thread.id)) {
      reply.code(409);
      return { error: "当前正在生成，请先停止后再修改模型" };
    }

    sessions.updateThread(thread.id, body.model?.trim() || null, thread.nativeSessionId);

    return {
      ok: true,
      activeGroup: sessions.getActiveGroup(thread.sessionGroupId, new Set(activeRuns.keys()))
    };
  });

  app.post("/api/threads/:threadId/stop", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { threadId: string };
    const run = activeRuns.get(params.threadId);

    if (!run) {
      reply.code(409);
      return { error: "当前会话没有在运行" };
    }

    run.cancel();
    return { ok: true };
  });

  app.route({
    method: "GET",
    url: "/ws",
    handler: async (_request, reply) => {
      reply.code(426);
      return { error: "请使用 WebSocket 连接此地址" };
    },
    wsHandler: (socket) => {
      socket.on("message", async (raw: Buffer) => {
        const event = JSON.parse(raw.toString()) as RealtimeClientEvent;

        if (event.type === "stop_thread") {
          activeRuns.get(event.payload.threadId)?.cancel();
          return;
        }

        if (event.type !== "send_message") {
          return;
        }

        const thread = sessions.findThread(event.payload.threadId);
        if (!thread) {
          sendSocketEvent(socket, {
            type: "status",
            payload: { message: "会话不存在" }
          });
          return;
        }

        if (activeRuns.has(thread.id)) {
          sendSocketEvent(socket, {
            type: "status",
            payload: { message: `${thread.alias} 正在生成，请先停止上一轮` }
          });
          return;
        }

        const history = sessions.listHistory(thread.id);
        sessions.appendUserMessage(thread.id, event.payload.content);
        const assistant = sessions.appendAssistantMessage(thread.id, "");

        sendSocketEvent(socket, {
          type: "thread_snapshot",
          payload: {
            activeGroup: sessions.getActiveGroup(thread.sessionGroupId, new Set(activeRuns.keys()))
          }
        });

        sendSocketEvent(socket, {
          type: "status",
          payload: { message: `已发送给 ${thread.alias}` }
        });

        const run = runTurn({
          provider: thread.provider,
          model: thread.currentModel,
          nativeSessionId: thread.nativeSessionId,
          history,
          userMessage: event.payload.content,
          onAssistantDelta: (delta: string) => {
            sendSocketEvent(socket, {
              type: "assistant_delta",
              payload: { messageId: assistant.id, delta }
            });
          },
          onSession: () => {},
          onModel: () => {}
        });

        activeRuns.set(thread.id, run);

        try {
          const result = await run.promise;
          activeRuns.delete(thread.id);
          sessions.updateThread(thread.id, result.currentModel, result.nativeSessionId);
          sessions.overwriteMessage(assistant.id, result.content || "[空回复]");

          sendSocketEvent(socket, {
            type: "thread_snapshot",
            payload: {
              activeGroup: sessions.getActiveGroup(thread.sessionGroupId, new Set(activeRuns.keys()))
            }
          });
        } catch (error) {
          activeRuns.delete(thread.id);
          sessions.overwriteMessage(
            assistant.id,
            `请求失败：${error instanceof Error ? error.message : "未知错误"}`
          );

          sendSocketEvent(socket, {
            type: "status",
            payload: {
              message: error instanceof Error ? error.message : "未知错误"
            }
          });

          sendSocketEvent(socket, {
            type: "thread_snapshot",
            payload: {
              activeGroup: sessions.getActiveGroup(thread.sessionGroupId, new Set(activeRuns.keys()))
            }
          });
        }
      });
    }
  });

  return app;
}
