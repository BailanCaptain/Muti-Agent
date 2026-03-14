import crypto from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { PROVIDER_ALIASES } from "@multi-agent/shared";
import { SessionRepository } from "./db/repositories";
import { SqliteStore } from "./db/sqlite";
import { AppEventBus } from "./events/event-bus";
import { DispatchOrchestrator } from "./orchestrator/dispatch";
import { InvocationRegistry } from "./orchestrator/invocation-registry";
import { registerMcpServer } from "./mcp/server";
import { registerCallbackRoutes } from "./routes/callbacks";
import { registerMessageRoutes } from "./routes/messages";
import { registerThreadRoutes } from "./routes/threads";
import { registerWsRoute, type RealtimeBroadcaster } from "./routes/ws";
import { listProviderProfiles } from "./runtime/provider-profiles";
import { getRedisReservation } from "./runtime/redis";
import { MessageService } from "./services/message-service";
import { SessionService } from "./services/session-service";

export async function createApiServer(options: {
  apiBaseUrl: string;
  sqlitePath: string;
  corsOrigin: string;
  redisUrl: string;
}) {
  const app = Fastify({ logger: true });
  const providerProfiles = listProviderProfiles();
  const sqlite = new SqliteStore(options.sqlitePath);
  const repository = new SessionRepository(sqlite);
  const sessions = new SessionService(repository, providerProfiles);
  const eventBus = new AppEventBus();
  const broadcaster: RealtimeBroadcaster = {
    broadcast: () => {}
  };
  const invocations = new InvocationRegistry<ReturnType<typeof import("./runtime/cli-orchestrator").runTurn>>();
  const dispatch = new DispatchOrchestrator(sessions, PROVIDER_ALIASES);
  const messages = new MessageService(sessions, dispatch, invocations, eventBus, options.apiBaseUrl);
  const redisSummary = getRedisReservation(options.redisUrl);

  eventBus.on("invocation.started", (event) => {
    repository.createInvocation({
      id: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      callbackToken: event.callbackToken,
      status: event.status,
      startedAt: event.createdAt,
      finishedAt: null,
      exitCode: null,
      lastActivityAt: event.createdAt
    });

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: event.type,
      payload: JSON.stringify(event),
      createdAt: event.createdAt
    });
  });

  eventBus.on("invocation.activity", (event) => {
    repository.updateInvocation(event.invocationId, {
      status: event.status,
      lastActivityAt: event.createdAt
    });

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: `${event.type}.${event.stream}`,
      payload: JSON.stringify({
        status: event.status,
        chunkPreview: event.chunk.slice(0, 500)
      }),
      createdAt: event.createdAt
    });
  });

  eventBus.on("invocation.finished", (event) => {
    repository.updateInvocation(event.invocationId, {
      status: event.status,
      finishedAt: event.createdAt,
      exitCode: event.exitCode,
      lastActivityAt: event.createdAt
    });

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: event.type,
      payload: JSON.stringify(event),
      createdAt: event.createdAt
    });
  });

  eventBus.on("invocation.failed", (event) => {
    repository.updateInvocation(event.invocationId, {
      status: event.status,
      finishedAt: event.createdAt,
      exitCode: event.exitCode,
      lastActivityAt: event.createdAt
    });

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: event.type,
      payload: JSON.stringify(event),
      createdAt: event.createdAt
    });
  });

  await app.register(cors, {
    origin: options.corsOrigin,
    credentials: true
  });
  await app.register(websocket);

  registerThreadRoutes(app, {
    sessions,
    getRunningThreadIds: () => new Set(invocations.keys()),
    stopThread: (threadId) => {
      const run = invocations.get(threadId);
      if (!run) {
        return false;
      }

      run.cancel();
      return true;
    },
    redisSummary
  });
  registerMessageRoutes(app);
  registerCallbackRoutes(app, {
    repository,
    sessions,
    broadcaster,
    getRunningThreadIds: () => new Set(invocations.keys()),
    invocations,
    onPublicMessage: (options) => messages.handleAgentPublicMessage(options)
  });
  registerWsRoute(app, { messages, broadcaster });
  registerMcpServer(app);

  Object.assign(app, {
    multiAgentContext: {
      repository,
      sessions,
      invocations
    }
  });

  return app;
}
