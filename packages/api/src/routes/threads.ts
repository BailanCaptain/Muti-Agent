import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { InvalidTimelineCursorError } from "../services/session-service"
import type { SessionService } from "../services/session-service"
import type { GroupSequencer } from "./ws-sequencer"

type SendModelBody = {
  model?: string
}

type DispatchState = {
  hasPendingDispatches: boolean
  dispatchBarrierActive: boolean
}

export function registerThreadRoutes(
  app: FastifyInstance,
  options: {
    sessions: SessionService
    getRunningThreadIds: () => Set<string>
    stopThread: (threadId: string) => boolean
    stopAgent?: (threadId: string, agentId: string) => boolean
    redisSummary: unknown
    getDispatchState?: (groupId: string) => DispatchState
    flushActiveStreaming?: (groupId: string) => void
    // F031 · group snapshot 水位线来源（只读 current，不消耗计数器）
    sequencer: GroupSequencer
  },
) {
  app.get("/health", async () => ({
    ok: true,
    redis: options.redisSummary,
  }))

  app.get("/api/bootstrap", async () => ({
    sessionGroups: options.sessions.listSessionGroups(),
  }))

  app.get("/api/providers", async () => ({
    providers: options.sessions.listProviderCatalog(),
    redis: options.redisSummary,
  }))

  app.post("/api/session-groups", async () => {
    const groupId = options.sessions.createSessionGroup()
    return { groupId }
  })

  // F022 Phase 3.5: 支持 title 手动重命名（AC-14g）+ projectTag 清/设（AC-14h）。
  // body 任一字段都允许独立更新；两者都缺才 400。
  app.patch("/api/session-groups/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string }
    const body = request.body as { projectTag?: string | null; title?: string }

    if (body.projectTag === undefined && body.title === undefined) {
      reply.code(400)
      return { error: "缺少 projectTag 或 title 字段。" }
    }

    if (body.title !== undefined) {
      const trimmed = body.title.trim()
      if (trimmed.length === 0 || trimmed.length > 40) {
        reply.code(400)
        return { error: "title 长度需在 1-40 字之间。" }
      }
      options.sessions.renameSessionGroup(params.id, trimmed)
    }

    if (body.projectTag !== undefined) {
      options.sessions.updateSessionGroupProjectTag(params.id, body.projectTag ?? null)
    }

    return { ok: true }
  })

  // F022 Phase 3.5 (AC-14i): 归档
  app.post("/api/session-groups/:id/archive", async (request: FastifyRequest) => {
    const params = request.params as { id: string }
    options.sessions.archiveSessionGroup(params.id)
    return { ok: true }
  })

  // F022 Phase 3.5 (AC-14i/j): 恢复归档或软删
  app.post("/api/session-groups/:id/restore", async (request: FastifyRequest) => {
    const params = request.params as { id: string }
    options.sessions.restoreSessionGroup(params.id)
    return { ok: true }
  })

  // F022 Phase 3.5 (AC-14j): 软删 — 铁律：不提供物理删除，只支持恢复
  app.delete("/api/session-groups/:id", async (request: FastifyRequest) => {
    const params = request.params as { id: string }
    options.sessions.softDeleteSessionGroup(params.id)
    return { ok: true }
  })

  // F022 Phase 3.5 (AC-14i/j): 归档列表 — 含归档和已删（前端合并展示）。
  // 路径单独命名避免与 GET /api/session-groups/:groupId 参数冲突。
  app.get("/api/archived-session-groups", async () => ({
    sessionGroups: options.sessions.listArchivedSessionGroups(),
  }))

  app.get(
    "/api/session-groups/:groupId/timeline",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { groupId: string }
      const query = request.query as { before?: unknown }
      if (typeof query.before !== "string" || query.before.length === 0) {
        reply.code(400)
        return { error: "Invalid timeline cursor" }
      }

      try {
        return options.sessions.getActiveGroupTimelinePage(params.groupId, query.before, 100)
      } catch (error) {
        if (error instanceof InvalidTimelineCursorError) {
          reply.code(400)
          return { error: error.message }
        }
        throw error
      }
    },
  )

  app.get("/api/session-groups/:groupId", async (request) => {
    const params = request.params as { groupId: string }
    // F031 · read-before-build：水位线必须在快照组装（含 flushActiveStreaming）之前读。
    // 组装期间广播的新事件 seq > 水位线 → 既进快照也走流 = 过投递（offset/messageId
    // 幂等兜底）；反序读取会让客户端把未进快照的事件当"已覆盖"丢弃 = 真丢失。
    const wsWatermark = {
      epoch: options.sequencer.epoch,
      seq: options.sequencer.current(params.groupId),
    }
    options.flushActiveStreaming?.(params.groupId)
    const snapshot = options.sessions.getActiveGroupPage(
      params.groupId,
      options.getRunningThreadIds(),
      options.getDispatchState?.(params.groupId),
      100,
    )
    return {
      ...snapshot,
      wsWatermark,
    }
  })

  app.post("/api/threads/:threadId/model", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { threadId: string }
    const body = request.body as SendModelBody
    const thread = options.sessions.findThread(params.threadId)

    if (!thread) {
      reply.code(404)
      return { error: "会话不存在。" }
    }

    if (options.getRunningThreadIds().has(thread.id)) {
      reply.code(409)
      return { error: "当前会话正在运行，不能修改模型。" }
    }

    options.sessions.updateThread(thread.id, body.model?.trim() || null, thread.nativeSessionId)

    return {
      ok: true,
      activeGroup: options.sessions.getActiveGroup(
        thread.sessionGroupId,
        options.getRunningThreadIds(),
        options.getDispatchState?.(thread.sessionGroupId),
      ),
    }
  })

  app.post("/api/threads/:threadId/stop", async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { threadId: string }

    if (!options.stopThread(params.threadId)) {
      reply.code(409)
      return { error: "当前会话没有运行中的调用。" }
    }

    return { ok: true }
  })

  app.post(
    "/api/threads/:threadId/cancel/:agentId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as { threadId: string; agentId: string }

      if (!options.stopAgent) {
        reply.code(501)
        return { error: "精准取消未启用。" }
      }

      if (!options.stopAgent(params.threadId, params.agentId)) {
        reply.code(409)
        return { error: "该 agent 没有运行中的调用。" }
      }

      return { ok: true }
    },
  )
}
