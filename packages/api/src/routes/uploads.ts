import type { FastifyInstance } from "fastify"
import { randomUUID } from "node:crypto"
import { createWriteStream, unlinkSync, writeFileSync } from "node:fs"
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

  app.post<{
    Body: { base64: string; mime?: string; meta?: Record<string, unknown> }
  }>("/api/preview/screenshot", async (request, reply) => {
    const { base64, mime = "image/png" } = request.body ?? {}
    if (!base64 || typeof base64 !== "string") {
      return reply.status(400).send({ error: "base64 field is required" })
    }
    if (!ALLOWED_MIMES.has(mime)) {
      return reply.status(400).send({ error: `unsupported mime type: ${mime}` })
    }
    if (base64.length > MAX_BASE64_SIZE) {
      return reply.status(413).send({ error: "base64 payload too large" })
    }

    const buffer = Buffer.from(base64, "base64")
    const ext = MIME_TO_EXT[mime] ?? ".png"
    const name = `screenshot-${randomUUID()}${ext}`
    const dest = path.join(uploadsDir, name)
    writeFileSync(dest, buffer)

    log.info({ name, mime, size: buffer.length }, "screenshot saved")

    return { url: `/uploads/${name}` }
  })
}
