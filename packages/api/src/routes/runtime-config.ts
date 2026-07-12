import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { MODEL_CATALOG } from "../runtime/model-catalog"
import {
  type RuntimeConfig,
  loadRuntimeConfig,
  saveRuntimeConfig,
  validateRuntimeConfigInput,
} from "../runtime/runtime-config"

export function registerRuntimeConfigRoutes(app: FastifyInstance) {
  app.get("/api/models", async () => ({ catalog: MODEL_CATALOG }))

  app.get("/api/runtime-config", async () => ({ config: loadRuntimeConfig() }))

  app.put("/api/runtime-config", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { config?: unknown } | null
    if (!body || typeof body !== "object" || body.config === undefined) {
      reply.code(400)
      return { error: "Body must include { config: {...} }." }
    }
    // F021 Phase 6 — AC-29: 显式拒绝非法字段，禁止 sanitize 静默丢弃
    const errors = validateRuntimeConfigInput(body.config)
    if (errors.length > 0) {
      reply.code(400)
      return { error: "Invalid runtime config payload.", errors }
    }
    try {
      // F037（德彪 batchB P2 丢写窗）：agent 设置前端不管理 dailyDigest 段——payload
      // 未带该段时保留已存值，防「agent 页旧快照整存」清掉设置页刚存的日报段。
      // 显式清空日报段只走 PUT /api/daily-digest/settings { settings: null }。
      const incoming = { ...(body.config as RuntimeConfig) }
      if (incoming.dailyDigest === undefined) {
        const existing = loadRuntimeConfig().dailyDigest
        if (existing) incoming.dailyDigest = existing
      }
      saveRuntimeConfig(incoming)
    } catch (error) {
      reply.code(500)
      return { error: `Failed to save runtime config: ${(error as Error).message}` }
    }
    return { ok: true, config: loadRuntimeConfig() }
  })
}
