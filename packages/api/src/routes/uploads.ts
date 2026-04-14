import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
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

export function registerUploadRoutes(app: FastifyInstance, uploadsDir: string) {
  app.post("/api/uploads", async (request, reply) => {
    const file = await request.file()
    if (!file) {
      return reply.status(400).send({ error: "no file provided" })
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return reply.status(400).send({ error: `unsupported mime type: ${file.mimetype}` })
    }

    const ext = path.extname(file.filename) || ".png"
    const name = `${randomUUID()}${ext}`
    const dest = path.join(uploadsDir, name)

    await pipeline(file.file, createWriteStream(dest))

    if (file.file.truncated) {
      return reply.status(413).send({ error: "file too large" })
    }

    log.info({ name, mime: file.mimetype, size: file.file.bytesRead }, "file uploaded")

    return { url: `/uploads/${name}` }
  })
}
