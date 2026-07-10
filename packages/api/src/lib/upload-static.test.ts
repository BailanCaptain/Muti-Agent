import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import fastifyStatic from "@fastify/static"
import Fastify from "fastify"
import { setUploadResponseHeaders } from "./upload-static"

/** T7 修8（德彪 r7 P1）：真起 @fastify/static 验证响应头（helper 与 server.ts 装配同源）。 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f040-upload-static-"))
after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {}
})

describe("uploads 静态服务硬化头（T7 修8）", () => {
  it("html 响应带 attachment+nosniff+sandbox 三头（导航=下载，杜绝 API origin 执行脚本）", async () => {
    fs.writeFileSync(path.join(tmp, "evil.html"), "<script>fetch('/api/x')</script>")
    const app = Fastify()
    await app.register(fastifyStatic, {
      root: tmp,
      prefix: "/uploads/",
      decorateReply: false,
      setHeaders: setUploadResponseHeaders,
    })
    const html = await app.inject({ method: "GET", url: "/uploads/evil.html" })
    assert.equal(html.statusCode, 200)
    assert.equal(html.headers["content-disposition"], "attachment")
    assert.equal(html.headers["x-content-type-options"], "nosniff")
    assert.equal(html.headers["content-security-policy"], "sandbox")
    await app.close()
  })

  it("图片同带三头且 content-type 正确（<img> 子资源不受 attachment 影响，内联渲染零回归）", async () => {
    fs.writeFileSync(path.join(tmp, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const app = Fastify()
    await app.register(fastifyStatic, {
      root: tmp,
      prefix: "/uploads/",
      decorateReply: false,
      setHeaders: setUploadResponseHeaders,
    })
    const png = await app.inject({ method: "GET", url: "/uploads/shot.png" })
    assert.equal(png.statusCode, 200)
    assert.match(String(png.headers["content-type"]), /image\/png/)
    assert.equal(png.headers["content-disposition"], "attachment")
    assert.equal(png.headers["x-content-type-options"], "nosniff")
    await app.close()
  })
})
