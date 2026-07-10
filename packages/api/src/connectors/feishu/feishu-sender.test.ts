import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SafeHttpResponse } from "../../net/safe-http-client"
import { createFeishuSender } from "./feishu-sender"

/** F040 T13：FeishuSender 分片 + Bearer + token 失效重试（AC3 回推 / AC6）。 */

type Req = { url: string; method?: string; headers?: Record<string, string>; jsonBody?: unknown }

function fakeHttp(
  responder: (req: Req, i: number) => SafeHttpResponse | Promise<SafeHttpResponse>,
) {
  const reqs: Req[] = []
  return {
    reqs,
    client: {
      async request(url: string, opts?: Record<string, unknown>): Promise<SafeHttpResponse> {
        const req: Req = { url, ...(opts as object) }
        reqs.push(req)
        return responder(req, reqs.length - 1)
      },
      async fetchText() {
        return ""
      },
    },
  }
}

function ok(code = 0): SafeHttpResponse {
  return { status: 200, text: JSON.stringify({ code, msg: code === 0 ? "ok" : "err" }) }
}

function sender(
  http: ReturnType<typeof fakeHttp>,
  tokenSeq: string[] = ["tok_1"],
  onInvalidate?: () => void,
) {
  let ti = 0
  return createFeishuSender({
    http: http.client,
    getToken: async () => tokenSeq[Math.min(ti++, tokenSeq.length - 1)],
    invalidate: onInvalidate ?? (() => {}),
    maxChunk: 2000,
  })
}

/** 从 interactive 卡片请求体里取 markdown 正文（升级后首选通道）。 */
function cardMarkdown(req: Req): string {
  const card = JSON.parse((req.jsonBody as { content: string }).content) as {
    elements: Array<{ tag: string; content: string }>
  }
  assert.equal(card.elements.length, 1)
  assert.equal(card.elements[0].tag, "markdown")
  return card.elements[0].content
}

describe("FeishuSender.sendText", () => {
  it("短文单片 → ok，POST messages 端点 + Bearer + interactive markdown 卡片", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    const r = await s.sendText("oc_1", "**你好**")
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 1)
    assert.match(http.reqs[0].url, /\/im\/v1\/messages\?receive_id_type=chat_id$/)
    assert.equal(http.reqs[0].method, "POST")
    assert.equal(http.reqs[0].headers?.authorization, "Bearer tok_1")
    const body = http.reqs[0].jsonBody as { receive_id: string; msg_type: string; content: string }
    assert.equal(body.receive_id, "oc_1")
    // 手机端可读性：markdown 卡片渲染（clowder-ai 同款），不再发裸 text
    assert.equal(body.msg_type, "interactive")
    assert.equal(cardMarkdown(http.reqs[0]), "**你好**")
  })

  it("超长文本 → 分片顺序发送，带 (i/n) 尾标（卡片通道）", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    const long = "字".repeat(5000)
    const r = await s.sendText("oc_1", long)
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 3) // 2000+2000+1000
    const texts = http.reqs.map((q) => cardMarkdown(q))
    assert.match(texts[0], /\(1\/3\)$/)
    assert.match(texts[1], /\(2\/3\)$/)
    assert.match(texts[2], /\(3\/3\)$/)
  })

  it("senderAlias → 卡片带彩色署名头（agent 花名 + 固定配色）", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    const r = await s.sendText("oc_1", "在。", { senderAlias: "范德彪" })
    assert.deepEqual(r, { ok: true })
    const card = JSON.parse((http.reqs[0].jsonBody as { content: string }).content) as {
      header?: { title: { tag: string; content: string }; template: string }
    }
    assert.equal(card.header?.title.content, "范德彪")
    assert.equal(card.header?.title.tag, "plain_text")
    assert.equal(card.header?.template, "orange")
  })

  it("AC-N4：model 有值 → 署名头「花名 · 型号」，配色仍按花名 key", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    await s.sendText("oc_1", "在。", { senderAlias: "范德彪", model: "gpt-5.4" })
    const card = JSON.parse((http.reqs[0].jsonBody as { content: string }).content) as {
      header?: { title: { content: string }; template: string }
    }
    assert.equal(card.header?.title.content, "范德彪 · gpt-5.4")
    assert.equal(card.header?.template, "orange", "配色按花名查表，不受型号后缀影响")
  })

  it("AC-N4：文本兜底前缀带型号【花名 · 型号】；model null 退回【花名】", async () => {
    const http = fakeHttp((_r, i) => (i % 2 === 0 ? ok(230099) : ok()))
    const s = sender(http)
    await s.sendText("oc_1", "在。", { senderAlias: "范德彪", model: "gpt-5.4" })
    const fb1 = JSON.parse((http.reqs[1].jsonBody as { content: string }).content) as {
      text: string
    }
    assert.equal(fb1.text, "【范德彪 · gpt-5.4】\n在。")
    await s.sendText("oc_1", "在。", { senderAlias: "范德彪", model: null })
    const fb2 = JSON.parse((http.reqs[3].jsonBody as { content: string }).content) as {
      text: string
    }
    assert.equal(fb2.text, "【范德彪】\n在。")
  })

  it("未知花名 → 署名头配色兜底 turquoise；无 senderAlias → 无 header", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    await s.sendText("oc_1", "hi", { senderAlias: "新同事" })
    await s.sendText("oc_1", "hi")
    const withAlias = JSON.parse((http.reqs[0].jsonBody as { content: string }).content) as {
      header?: { template: string }
    }
    assert.equal(withAlias.header?.template, "turquoise")
    const withoutAlias = JSON.parse((http.reqs[1].jsonBody as { content: string }).content) as {
      header?: unknown
    }
    assert.equal(withoutAlias.header, undefined)
  })

  it("文本兜底保住署名：【花名】前缀", async () => {
    const http = fakeHttp((_r, i) => (i === 0 ? ok(230099) : ok()))
    const s = sender(http)
    const r = await s.sendText("oc_1", "在。", { senderAlias: "范德彪" })
    assert.deepEqual(r, { ok: true })
    const fallback = JSON.parse((http.reqs[1].jsonBody as { content: string }).content) as {
      text: string
    }
    assert.equal(fallback.text, "【范德彪】\n在。")
  })

  it("卡片被终态拒（业务错误码）→ 同片纯文本兜底一次成功（宁丑勿丢）", async () => {
    const http = fakeHttp((_r, i) => (i === 0 ? ok(230099) : ok()))
    const s = sender(http)
    const r = await s.sendText("oc_1", "hi")
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 2)
    assert.equal((http.reqs[0].jsonBody as { msg_type: string }).msg_type, "interactive")
    const fallback = http.reqs[1].jsonBody as { msg_type: string; content: string }
    assert.equal(fallback.msg_type, "text")
    assert.deepEqual(JSON.parse(fallback.content), { text: "hi" })
  })

  it("卡片终态拒 + 文本兜底也终态拒 → terminal，error 双记", async () => {
    const http = fakeHttp(() => ok(230099))
    const s = sender(http)
    const r = await s.sendText("oc_1", "hi")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, true)
    assert.match(r.error, /card:/)
    assert.match(r.error, /text-fallback:/)
    assert.equal(http.reqs.length, 2)
  })

  it("卡片非终态失败（5xx）→ 不做文本兜底，交出站账本补投", async () => {
    const http = fakeHttp(() => ({ status: 503, text: "" }))
    const s = sender(http)
    const r = await s.sendText("oc_1", "hi")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, false)
    assert.equal(http.reqs.length, 1, "非终态不该击穿到 text 兜底（reconcile 会带卡片重投）")
  })

  it("中片失败 → 停止后续，返回非 terminal", async () => {
    const http = fakeHttp((_r, i) => (i === 1 ? { status: 500, text: "" } : ok()))
    const s = sender(http)
    const r = await s.sendText("oc_1", "字".repeat(5000))
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, false)
    assert.equal(http.reqs.length, 2) // 第 3 片没发
  })

  it("token 失效码 → invalidate + 重试一次成功", async () => {
    let invalidated = 0
    const http = fakeHttp((_r, i) => (i === 0 ? ok(99991663) : ok(0)))
    const s = sender(http, ["tok_stale", "tok_fresh"], () => {
      invalidated += 1
    })
    const r = await s.sendText("oc_1", "hi")
    assert.deepEqual(r, { ok: true })
    assert.equal(invalidated, 1)
    assert.equal(http.reqs.length, 2)
    assert.equal(http.reqs[1].headers?.authorization, "Bearer tok_fresh")
  })

  it("token 失效重试后仍失效 → terminal，且不进文本兜底（r4 P2：凭证问题换通道无解）", async () => {
    const http = fakeHttp(() => ok(99991663))
    const s = sender(http, ["a", "b"])
    const r = await s.sendText("oc_1", "hi")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, true)
    assert.equal(
      http.reqs.length,
      2,
      "只该有 interactive×2（token 重试一次），禁再走 text 兜底白耗网络+双重 invalidate",
    )
    for (const q of http.reqs) {
      assert.equal((q.jsonBody as { msg_type: string }).msg_type, "interactive")
    }
  })

  it("其他业务错误码 → terminal", async () => {
    const http = fakeHttp(() => ok(230001))
    const s = sender(http)
    const r = await s.sendText("oc_1", "hi")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, true)
  })

  it("HTTP 5xx → 非 terminal（可 reconcile 补）", async () => {
    const http = fakeHttp(() => ({ status: 503, text: "" }))
    const s = sender(http)
    const r = await s.sendText("oc_1", "hi")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, false)
  })

  it("HTTP 4xx（非 token）→ terminal", async () => {
    const http = fakeHttp(() => ({ status: 400, text: '{"code":99991400,"msg":"bad"}' }))
    const s = sender(http)
    const r = await s.sendText("oc_1", "hi")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, true)
  })

  it("r2 P1-new：getToken 抛 → 返回非 terminal error 不外抛（sender 合同=SendResult）", async () => {
    const http = fakeHttp(() => ok())
    const s = createFeishuSender({
      http: http.client,
      getToken: async () => {
        throw new Error("token endpoint 500")
      },
      invalidate: () => {},
      maxChunk: 2000,
    })
    const r = await s.sendText("oc_1", "hi") // 不得 throw
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, false)
    assert.match(r.error, /token/)
  })

  it("request 抛（网络/超时）→ 非 terminal", async () => {
    const http = fakeHttp(() => {
      throw new Error("SafeHttp[timeout]")
    })
    const s = sender(http)
    const r = await s.sendText("oc_1", "hi")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, false)
  })
})

/** AC15：create 响应带 message_id（占位卡要拿 id 供 PATCH）。 */
function okWithId(messageId: string): SafeHttpResponse {
  return {
    status: 200,
    text: JSON.stringify({ code: 0, msg: "ok", data: { message_id: messageId } }),
  }
}

describe("FeishuSender AC15 占位卡（sendPlaceholder / replacePlaceholder / patchCard）", () => {
  it("sendPlaceholder → POST 思考中卡 + 透传 data.message_id", async () => {
    const http = fakeHttp(() => okWithId("om_ph1"))
    const s = sender(http)
    const r = await s.sendPlaceholder?.("oc_1")
    assert.deepEqual(r, { ok: true, messageId: "om_ph1" })
    assert.equal(http.reqs.length, 1)
    assert.equal(http.reqs[0].method, "POST")
    const body = http.reqs[0].jsonBody as { receive_id: string; msg_type: string }
    assert.equal(body.receive_id, "oc_1")
    assert.equal(body.msg_type, "interactive")
    assert.match(cardMarkdown(http.reqs[0]), /思考/)
  })

  it("sendPlaceholder 业务成功但响应缺 message_id → ok:false（没 id 就没法 PATCH，按失败处理）", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    const r = await s.sendPlaceholder?.("oc_1")
    assert.equal(r?.ok, false)
  })

  it("sendText 带 replacePlaceholder → 单片走 PATCH /messages/:id（不再 POST）", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    const r = await s.sendText("oc_1", "终稿", {
      senderAlias: "黄仁勋",
      model: "claude-opus-4-8",
      replacePlaceholder: "om_ph1",
    })
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 1)
    assert.equal(http.reqs[0].method, "PATCH")
    assert.match(http.reqs[0].url, /\/im\/v1\/messages\/om_ph1$/)
    // PATCH body 只有 content（卡片 JSON），署名头随卡片走
    const card = JSON.parse((http.reqs[0].jsonBody as { content: string }).content) as {
      header?: { title: { content: string }; template: string }
    }
    assert.equal(card.header?.title.content, "黄仁勋 · claude-opus-4-8")
    assert.equal(card.header?.template, "blue")
  })

  it("replacePlaceholder 长文本 → 首片 PATCH，余片正常 POST", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    const r = await s.sendText("oc_1", "字".repeat(5000), { replacePlaceholder: "om_ph1" })
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 3)
    assert.equal(http.reqs[0].method, "PATCH")
    assert.equal(http.reqs[1].method, "POST")
    assert.equal(http.reqs[2].method, "POST")
    assert.match(cardMarkdown(http.reqs[0]), /\(1\/3\)$/)
  })

  it("PATCH 终态失败（非 token 业务码）→ 降级 POST 新卡（宁重复勿丢）", async () => {
    const http = fakeHttp((req) => (req.method === "PATCH" ? ok(230001) : ok()))
    const s = sender(http)
    const r = await s.sendText("oc_1", "终稿", { replacePlaceholder: "om_ph1" })
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 2)
    assert.equal(http.reqs[0].method, "PATCH")
    assert.equal(http.reqs[1].method, "POST")
    assert.equal(cardMarkdown(http.reqs[1]), "终稿")
  })

  it("PATCH 非终态失败（5xx）→ 原样返回不降级（占位卡认领已回滚，reconcile 重投再 PATCH）", async () => {
    const http = fakeHttp(() => ({ status: 500, text: "" }))
    const s = sender(http)
    const r = await s.sendText("oc_1", "终稿", { replacePlaceholder: "om_ph1" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.terminal, false)
    assert.equal(http.reqs.length, 1)
    assert.equal(http.reqs[0].method, "PATCH")
  })

  it("P1-2 回归：首片 PATCH 成功 + 余片失败 → ok:false 带 placeholderConsumed:true（部分成功透出）", async () => {
    // 首片 PATCH 变身成功，第二片 POST 5xx —— gateway 凭 placeholderConsumed 不回滚认领
    const http = fakeHttp((req) => (req.method === "PATCH" ? ok() : { status: 500, text: "" }))
    const s = sender(http)
    const r = await s.sendText("oc_1", "字".repeat(5000), { replacePlaceholder: "om_ph1" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.placeholderConsumed, true)
    assert.equal(http.reqs.length, 2)
    assert.equal(http.reqs[0].method, "PATCH")
    assert.equal(http.reqs[1].method, "POST")
  })

  it("P1-2 回归：PATCH 终态失败降级 POST 成功 + 余片失败 → 无 placeholderConsumed（降级不算消费）", async () => {
    // PATCH 230001 终态 → 首片降级 POST（占位卡没动）→ 第二片 5xx；
    // 占位卡未被消费，gateway 应照常回滚认领
    let postSeq = 0
    const http = fakeHttp((req) => {
      if (req.method === "PATCH") return ok(230001)
      postSeq += 1
      return postSeq === 1 ? ok() : { status: 500, text: "" }
    })
    const s = sender(http)
    const r = await s.sendText("oc_1", "字".repeat(5000), { replacePlaceholder: "om_ph1" })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.placeholderConsumed, undefined)
  })

  it("patchCard 直调（失败/超时收尾文案）→ PATCH + 无署名头纯 markdown", async () => {
    const http = fakeHttp(() => ok())
    const s = sender(http)
    const r = await s.patchCard?.("om_ph1", { text: "❌ 这轮没有产出回复" })
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 1)
    assert.equal(http.reqs[0].method, "PATCH")
    assert.match(http.reqs[0].url, /\/messages\/om_ph1$/)
    assert.match(cardMarkdown(http.reqs[0]), /没有产出回复/)
  })
})

/** AC16 出站：上传响应带 key。 */
function okWithData(data: Record<string, unknown>): SafeHttpResponse {
  return { status: 200, text: JSON.stringify({ code: 0, msg: "ok", data }) }
}

describe("FeishuSender AC16 sendMedia（上传拿 key → 发媒体消息）", () => {
  it("image：multipart POST /images（image_type=message）→ image_key → msg_type=image", async () => {
    const http = fakeHttp((req) =>
      req.url.endsWith("/im/v1/images") ? okWithData({ image_key: "img_k9" }) : ok(),
    )
    const s = sender(http)
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const r = await s.sendMedia?.("oc_1", { kind: "image", name: "截图.png", data })
    assert.deepEqual(r, { ok: true })
    assert.equal(http.reqs.length, 2)
    // 上传：multipart rawBody + boundary content-type
    assert.match(http.reqs[0].url, /\/im\/v1\/images$/)
    const raw = (http.reqs[0] as unknown as { rawBody?: { contentType: string; body: Uint8Array } })
      .rawBody
    assert.ok(raw, "上传应走 rawBody multipart")
    assert.match(raw?.contentType ?? "", /^multipart\/form-data; boundary=/)
    const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(raw?.body)
    assert.match(bodyText, /name="image_type"\r\n\r\nmessage/)
    // 发消息：msg_type=image + image_key
    const msg = http.reqs[1].jsonBody as { msg_type: string; content: string }
    assert.equal(msg.msg_type, "image")
    assert.deepEqual(JSON.parse(msg.content), { image_key: "img_k9" })
  })

  it("file：file_type 按扩展名映射（pdf）+ file_name 字段 → file_key → msg_type=file", async () => {
    const http = fakeHttp((req) =>
      req.url.endsWith("/im/v1/files") ? okWithData({ file_key: "file_k7" }) : ok(),
    )
    const s = sender(http)
    const r = await s.sendMedia?.("oc_1", {
      kind: "file",
      name: "周报.pdf",
      data: new Uint8Array([1, 2, 3]),
    })
    assert.deepEqual(r, { ok: true })
    const raw = (http.reqs[0] as unknown as { rawBody?: { body: Uint8Array } }).rawBody
    const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(raw?.body)
    assert.match(bodyText, /name="file_type"\r\n\r\npdf/)
    assert.match(bodyText, /name="file_name"\r\n\r\n周报\.pdf/)
    const msg = http.reqs[1].jsonBody as { msg_type: string; content: string }
    assert.equal(msg.msg_type, "file")
    assert.deepEqual(JSON.parse(msg.content), { file_key: "file_k7" })
  })

  it("未知扩展名 → file_type=stream", async () => {
    const http = fakeHttp((req) =>
      req.url.endsWith("/im/v1/files") ? okWithData({ file_key: "k" }) : ok(),
    )
    const s = sender(http)
    await s.sendMedia?.("oc_1", { kind: "file", name: "数据.xyz", data: new Uint8Array(1) })
    const raw = (http.reqs[0] as unknown as { rawBody?: { body: Uint8Array } }).rawBody
    const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(raw?.body)
    assert.match(bodyText, /name="file_type"\r\n\r\nstream/)
  })

  it("上传失败 / 响应缺 key → ok:false（不发消息）", async () => {
    const httpFail = fakeHttp(() => ok(230002))
    const s1 = sender(httpFail)
    const r1 = await s1.sendMedia?.("oc_1", {
      kind: "image",
      name: "x.png",
      data: new Uint8Array(1),
    })
    assert.equal(r1?.ok, false)
    assert.equal(httpFail.reqs.length, 1, "上传失败不该再发消息")

    const httpNoKey = fakeHttp(() => ok())
    const s2 = sender(httpNoKey)
    const r2 = await s2.sendMedia?.("oc_1", {
      kind: "image",
      name: "x.png",
      data: new Uint8Array(1),
    })
    assert.equal(r2?.ok, false)
    assert.equal(httpNoKey.reqs.length, 1)
  })
})
