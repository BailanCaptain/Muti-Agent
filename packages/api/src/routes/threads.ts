import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionService } from "../services/session-service";

type SendModelBody = {
  model?: string;
};

export function registerThreadRoutes(
  app: FastifyInstance,
  options: {
    sessions: SessionService;
    getRunningThreadIds: () => Set<string>;
    stopThread: (threadId: string) => boolean;
    redisSummary: unknown;
  }
) {
  app.get("/health", async () => ({
    ok: true,
    redis: options.redisSummary
  }));

  app.get("/api/bootstrap", async () => ({
    sessionGroups: options.sessions.listSessionGroups()
  }));

  app.get("/api/providers", async () => ({
    providers: options.sessions.listProviderCatalog(),
    redis: options.redisSummary
  }));

  app.post("/api/session-groups", async () => {
    const groupId = options.sessions.createSessionGroup();
    return { groupId };
  });

  app.get("/api/session-groups/:groupId", async (request) => {
    const params = request.params as { groupId: string };
    return {
      activeGroup: options.sessions.getActiveGroup(params.groupId, options.getRunningThreadIds())
    };
  });

  app.post("/api/threads/:threadId/model", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { threadId: string };
    const body = request.body as SendModelBody;
    const thread = options.sessions.findThread(params.threadId);

    if (!thread) {
      reply.code(404);
      return { error: "会话不存在。" };
    }

    if (options.getRunningThreadIds().has(thread.id)) {
      reply.code(409);
      return { error: "当前会话正在运行，不能修改模型。" };
    }

    options.sessions.updateThread(thread.id, body.model?.trim() || null, thread.nativeSessionId);

    return {
      ok: true,
      activeGroup: options.sessions.getActiveGroup(thread.sessionGroupId, options.getRunningThreadIds())
    };
  });

  app.post("/api/threads/:threadId/stop", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { threadId: string };

    if (!options.stopThread(params.threadId)) {
      reply.code(409);
      return { error: "当前会话没有运行中的调用。" };
    }

    return { ok: true };
  });
}
