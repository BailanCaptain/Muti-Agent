import type { FastifyInstance } from "fastify"
import "@fastify/multipart"
import { randomUUID } from "node:crypto"
import { createWriteStream, unlinkSync } from "node:fs"
import { pipeline } from "node:stream/promises"
import path from "node:path"
import { createLogger } from "../lib/logger"

const log = createLogger("uploads")
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
])

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
}

const MAX_BASE64_SIZE = 10 * 1024 * 1024

export function registerUploadRoutes(app: FastifyInstance, uploadsDir: string) {
  app.post("/api/uploads", async (request, reply) => {
    const file = await request.file()
    if (!file) {
      return reply.status(400).send({ error: "no file provided" })
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return reply.status(400).send({ error: `unsupported mime type: ${file.mimetype}` })
    }

    const ext = MIME_TO_EXT[file.mimetype] ?? ".png"
    const name = `${randomUUID()}${ext}`
    const dest = path.join(uploadsDir, name)

    await pipeline(file.file, createWriteStream(dest))

    if (file.file.truncated) {
      try { unlinkSync(dest) } catch {}
      return reply.status(413).send({ error: "file too large" })
    }

    log.info({ name, mime: file.mimetype, size: file.file.bytesRead }, "file uploaded")

    return { url: `/uploads/${name}` }
  })

  // Screenshot endpoint moved to routes/preview.ts (AC-22)
}
