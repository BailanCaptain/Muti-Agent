import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RealtimeServerEvent } from "@multi-agent/shared";
import type { SessionRepository } from "../db/repositories";
import type { InvocationRegistry } from "../orchestrator/invocation-registry";
import type { SessionService } from "../services/session-service";
import type { RealtimeBroadcaster } from "./ws";

type CallbackBody = {
  invocationId?: string;
  callbackToken?: string;
  content?: string;
};

function assertInvocation(
  registry: InvocationRegistry<{ cancel: () => void }>,
  invocationId: string | undefined,
  callbackToken: string | undefined
) {
  if (!invocationId || !callbackToken) {
    return null;
  }

  // Callback routes only trust the short-lived identity created for the current CLI turn.
  return registry.verifyInvocation(invocationId, callbackToken);
}

export function registerCallbackRoutes(
  app: FastifyInstance,
  options: {
    repository: SessionRepository;
    sessions: SessionService;
    broadcaster: RealtimeBroadcaster;
    getRunningThreadIds: () => Set<string>;
    invocations: InvocationRegistry<{ cancel: () => void }>;
    onPublicMessage?: (options: {
      threadId: string;
      messageId: string;
      content: string;
      invocationId: string;
      emit: (event: RealtimeServerEvent) => void;
    }) => Promise<void> | void;
  }
) {
  app.post("/api/callbacks/post-message", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CallbackBody;
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken);

    if (!invocation) {
      reply.code(401);
      return { error: "Invalid invocation identity." };
    }

    if (!body.content?.trim()) {
      reply.code(400);
      return { error: "Content is required." };
    }

    const thread = options.repository.getThreadById(invocation.threadId);
    if (!thread) {
      reply.code(404);
      return { error: "Thread not found." };
    }

    // Persist first so snapshots and follow-up A2A hops see the same message id and timeline state.
    const message = options.repository.appendMessage(thread.id, "assistant", body.content.trim());
    const activeGroup = options.sessions.getActiveGroup(thread.sessionGroupId, options.getRunningThreadIds());
    const timelineMessage = activeGroup.timeline.find((item) => item.id === message.id);

    if (timelineMessage) {
      const event: RealtimeServerEvent = {
        type: "message.created",
        payload: {
          threadId: thread.id,
          message: timelineMessage
        }
      };
      options.broadcaster.broadcast(event);
    }

    options.broadcaster.broadcast({
      type: "thread_snapshot",
      payload: { activeGroup }
    });

    // Public callback messages re-enter dispatch so an agent can @mention the next agent in the chain.
    await options.onPublicMessage?.({
      threadId: thread.id,
      messageId: message.id,
      content: body.content.trim(),
      invocationId: invocation.invocationId,
      emit: options.broadcaster.broadcast
    });

    return {
      ok: true,
      messageId: message.id
    };
  });

  app.get("/api/callbacks/thread-context", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { invocationId?: string; callbackToken?: string; limit?: string };
    const invocation = assertInvocation(options.invocations, query.invocationId, query.callbackToken);

    if (!invocation) {
      reply.code(401);
      return { error: "Invalid invocation identity." };
    }

    const thread = options.repository.getThreadById(invocation.threadId);
    if (!thread) {
      reply.code(404);
      return { error: "Thread not found." };
    }

    const limit = Math.max(1, Math.min(Number(query.limit ?? 20) || 20, 50));
    const messages = options.repository
      .listRecentMessages(thread.id, limit)
      .reverse()
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt
      }));

    return {
      threadId: thread.id,
      agentId: invocation.agentId,
      expiresAt: invocation.expiresAt,
      messages
    };
  });

  app.get("/api/callbacks/pending-mentions", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { invocationId?: string; callbackToken?: string; limit?: string };
    const invocation = assertInvocation(options.invocations, query.invocationId, query.callbackToken);

    if (!invocation) {
      reply.code(401);
      return { error: "Invalid invocation identity." };
    }

    const thread = options.repository.getThreadById(invocation.threadId);
    if (!thread) {
      reply.code(404);
      return { error: "Thread not found." };
    }

    const limit = Math.max(1, Math.min(Number(query.limit ?? 20) || 20, 50));
    const startedAt = options.repository.getInvocationById(invocation.invocationId)?.startedAt ?? new Date(0).toISOString();
    const mentions = options.repository
      .listPendingMentions(thread.id, invocation.agentId, startedAt, limit)
      .reverse()
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt
      }));

    return {
      threadId: thread.id,
      agentId: invocation.agentId,
      expiresAt: invocation.expiresAt,
      mentions
    };
  });
}
