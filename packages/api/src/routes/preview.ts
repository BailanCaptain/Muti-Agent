import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import type { RealtimeServerEvent } from "@multi-agent/shared"
import { validatePort } from "../preview/port-validator"
import { createLogger } from "../lib/logger"

const log = createLogger("preview-routes")

const EXT_MAP: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" }

interface PreviewRouteOpts {
  gatewayPort: number
  runtimePorts?: number[]
  uploadsDir: string
  broadcast: (event: RealtimeServerEvent) => void
}

export function registerPreviewRoutes(app: FastifyInstance, opts: PreviewRouteOpts) {
  const { gatewayPort, runtimePorts, uploadsDir, broadcast } = opts
  const gatewayAvailable = gatewayPort > 0

  app.get("/api/preview/status", async () => {
    return { available: gatewayAvailable, gatewayPort }
  })

  app.post<{ Body: { port: number; host?: string } }>(
    "/api/preview/validate-port",
    async (req) => {
      const { port, host } = req.body
      return validatePort(port, { host, gatewaySelfPort: gatewayPort, runtimePorts })
    },
  )

  app.post<{ Body: { port: number; path?: string; sessionGroupId?: string } }>(
    "/api/preview/auto-open",
    async (req) => {
      if (!gatewayAvailable) {
        return { allowed: false, reason: "Preview gateway unavailable" }
      }
      const { port, path: previewPath, sessionGroupId } = req.body
      const result = validatePort(port, {
        host: "localhost",
        gatewaySelfPort: gatewayPort,
        runtimePorts,
      })
      if (!result.allowed) return result

      broadcast({
        type: "preview.auto_open",
        payload: {
          port,
          path: previewPath,
          sessionGroupId,
          gatewayPort,
        },
      })
      log.info({ port, path: previewPath, sessionGroupId }, "Auto-open broadcast")
      return { allowed: true, port, path: previewPath }
    },
  )

  app.post<{ Body: { dataUrl: string; sessionGroupId?: string } }>(
    "/api/preview/screenshot",
    async (req, reply) => {
      const { dataUrl } = req.body
      const match = dataUrl?.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/)
      if (!match) {
        return reply
          .status(400)
          .send({ error: "Invalid data URL — expected data:image/{png|jpeg|webp};base64,..." })
      }
      const ext = EXT_MAP[match[1]!] ?? "png"
      const buffer = Buffer.from(match[2]!, "base64")
      mkdirSync(uploadsDir, { recursive: true })
      const filename = `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
      writeFileSync(path.join(uploadsDir, filename), buffer)
      log.info({ filename, size: buffer.length }, "Screenshot saved")
      return { url: `/uploads/${filename}` }
    },
  )
}
