/**
 * F027 P4 hotfix · POST /api/rooms/:id/viewfinder/recompile
 *
 * 真相源：V16.5 §11 viewfinder 编译；scheduler 5min tick 太慢，新房间 / 修改后
 * 小孙浏览器手动触发立即编译；config force=true 重跑全 200 条历史 messages。
 *
 * Body:
 *   { force?: boolean }   默认 false (按 cursor 增量)；true 重跑过去 200 条 messages
 *
 * Response:
 *   { ok: true,  roomId, newMessagesCount, status: "ok" | "skipped_no_messages" }
 *   { ok: false, roomId, newMessagesCount: -1, status: "failed", error: string }
 */

import type { FastifyInstance } from "fastify"

type Recompiler = (
  roomId: string,
  opts?: { force?: boolean },
) => Promise<{
  roomId: string
  newMessagesCount: number
  status: "ok" | "skipped_no_messages" | "failed"
  error?: string
}>

export function registerViewfinderRecompileRoute(
  app: FastifyInstance,
  recompile: Recompiler,
): void {
  app.post("/api/rooms/:id/viewfinder/recompile", async (request, reply) => {
    const params = request.params as { id?: string }
    const body = (request.body ?? {}) as { force?: boolean }
    const roomId = params.id?.trim()
    if (!roomId) {
      reply.code(400)
      return { ok: false, error: "INVALID_ROOM_ID", message: "roomId required" }
    }
    try {
      const result = await recompile(roomId, { force: body.force === true })
      if (result.status === "failed") {
        reply.code(500)
        return { ok: false, ...result }
      }
      return { ok: true, ...result }
    } catch (err) {
      request.log.error({ err, roomId }, "viewfinder recompile threw")
      reply.code(500)
      return {
        ok: false,
        roomId,
        newMessagesCount: -1,
        status: "failed",
        error: (err as Error).message,
      }
    }
  })
}
