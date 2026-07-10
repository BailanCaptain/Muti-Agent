import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { SafeHttpClient, SafeHttpResponse } from "../../net/safe-http-client"
import { downloadFeishuMedia } from "./feishu-media"

/**
 * F040 P3 AC16：入站媒体下载落盘。fake http（记录 URL/头，返回受控字节），真临时目录。
 * 钉住：resources 端点形状 + Bearer + buffer 读法 + UUID 落盘名（原名绝不进文件系统）+
 * ext 白名单 + 失败降级返回 ok:false 不抛。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-media-"))
after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

function fakeHttp(responder: (url: string, opts: Record<string, unknown>) => SafeHttpResponse) {
  const calls: Array<{ url: string; opts: Record<string, unknown> }> = []
  const client = {
    async request(url: string, opts?: Record<string, unknown>): Promise<SafeHttpResponse> {
      const rec = { url, opts: opts ?? {} }
      calls.push(rec)
      return responder(url, rec.opts)
    },
    async fetchText() {
      return ""
    },
  } as unknown as SafeHttpClient
  return { client, calls }
}

const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])

describe("downloadFeishuMedia（AC16 入站）", () => {
  it("成功：resources 端点 + Bearer + buffer 读法 → UUID 落盘 + /uploads URL + 字节保真", async () => {
    const { client, calls } = fakeHttp(() => ({ status: 200, text: "", bytes: BYTES }))
    const dir = path.join(tmpRoot, "ok")
    const r = await downloadFeishuMedia(
      { http: client, getToken: async () => "tok_x", mediaDir: dir },
      { messageId: "om_1", kind: "image", key: "img_v3_k", name: "照片.png" },
    )
    assert.ok(r.ok)
    if (!r.ok) return
    assert.match(r.url, /^\/uploads\/feishu-[0-9a-f-]{36}\.png$/)
    assert.match(
      calls[0].url,
      /\/im\/v1\/messages\/om_1\/resources\/img_v3_k\?type=image$/,
    )
    assert.equal(
      (calls[0].opts.headers as Record<string, string>).authorization,
      "Bearer tok_x",
    )
    assert.equal(calls[0].opts.responseAs, "buffer")
    const onDisk = fs.readFileSync(path.join(dir, path.basename(r.url)))
    assert.deepEqual(Array.from(onDisk), Array.from(BYTES))
  })

  it("落盘名：ext 白名单未命中（.exe）→ file 兜 .bin；原名绝不进文件系统", async () => {
    const { client } = fakeHttp(() => ({ status: 200, text: "", bytes: BYTES }))
    const dir = path.join(tmpRoot, "ext")
    const r = await downloadFeishuMedia(
      { http: client, getToken: async () => "t", mediaDir: dir },
      { messageId: "om_2", kind: "file", key: "f_k", name: "../../逃逸\\木马.exe" },
    )
    assert.ok(r.ok)
    if (!r.ok) return
    assert.match(r.url, /^\/uploads\/feishu-[0-9a-f-]{36}\.bin$/)
    const files = fs.readdirSync(dir)
    assert.equal(files.length, 1)
    assert.doesNotMatch(files[0], /逃逸|木马|exe|\.\./)
  })

  it("下载 http 非 200 / 空体 → ok:false（caller 降级纯文本标签）", async () => {
    const { client } = fakeHttp(() => ({ status: 404, text: "" }))
    const r = await downloadFeishuMedia(
      { http: client, getToken: async () => "t", mediaDir: path.join(tmpRoot, "e1") },
      { messageId: "om_3", kind: "image", key: "k", name: "x.png" },
    )
    assert.equal(r.ok, false)
  })

  it("http 抛（超限/网络）→ ok:false 不外抛", async () => {
    const client = {
      async request(): Promise<SafeHttpResponse> {
        throw new Error("too_large")
      },
      async fetchText() {
        return ""
      },
    } as unknown as SafeHttpClient
    const r = await downloadFeishuMedia(
      { http: client, getToken: async () => "t", mediaDir: path.join(tmpRoot, "e2") },
      { messageId: "om_4", kind: "file", key: "k", name: "big.zip" },
    )
    assert.equal(r.ok, false)
  })
})
