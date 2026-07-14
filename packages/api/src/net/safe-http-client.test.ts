import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  SafeHttpError,
  buildMultipartBody,
  createSafeHttpClient,
  isBlockedIp,
} from "./safe-http-client"

const PUBLIC_IP = "93.184.216.34"

function fakeFetchOk(body = "hello", status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch
}

/** 依序返回给定 Response 的 fake fetch */
function fakeFetchSeq(responses: Response[]): typeof fetch {
  let i = 0
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    return r.clone()
  }) as unknown as typeof fetch
}

function redirectTo(url: string): Response {
  return new Response(null, { status: 302, headers: { location: url } })
}

function client(overrides: Partial<Parameters<typeof createSafeHttpClient>[0]> = {}) {
  return createSafeHttpClient({
    allowedHosts: ["allowed.com", "other.com"],
    resolveDns: async () => [PUBLIC_IP],
    fetchImpl: fakeFetchOk(),
    ...overrides,
  })
}

async function expectKind(p: Promise<unknown>, kind: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof SafeHttpError, `expected SafeHttpError, got ${String(err)}`)
    assert.equal(err.kind, kind)
    return true
  })
}

// ── F037 原版合同矩阵（自 .worktrees/F037 daily-digest/safe-http-client.test.ts 原样移植，
//    仅 import 路径变更 —— 本文件通过 = 共享化未分叉的证明）──────────────────────

describe("SafeHttpClient 合同矩阵", () => {
  it("拒 file:// scheme", async () => {
    await expectKind(client().fetchText("file:///etc/passwd"), "scheme")
  })

  it("拒 URL 带 userinfo", async () => {
    await expectKind(client().fetchText("https://u:p@allowed.com/x"), "userinfo")
  })

  it("拒非常规端口", async () => {
    await expectKind(client().fetchText("https://allowed.com:8080/x"), "port")
  })

  it("拒白名单外 host", async () => {
    await expectKind(client().fetchText("https://evil.com/x"), "host_not_allowed")
  })

  it("后缀白名单：子域过、无点边界的伪装域拒", async () => {
    const c = client({ allowedHosts: [], allowedSuffixes: ["owned.com"] })
    assert.equal(await c.fetchText("https://sub.owned.com/x"), "hello")
    await expectKind(c.fetchText("https://evil-owned.com/x"), "host_not_allowed")
  })

  for (const ip of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.3.4",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
  ]) {
    it(`拒 DNS 解析到 ${ip}`, async () => {
      await expectKind(
        client({ resolveDns: async () => [ip] }).fetchText("https://allowed.com/x"),
        "ip_blocked",
      )
    })
  }

  it("多记录 DNS 只要有一条私网即拒（防 rebinding 半开）", async () => {
    await expectKind(
      client({ resolveDns: async () => [PUBLIC_IP, "10.0.0.1"] }).fetchText(
        "https://allowed.com/x",
      ),
      "ip_blocked",
    )
  })

  it("redirect 到白名单外 host 拒", async () => {
    const c = client({ fetchImpl: fakeFetchSeq([redirectTo("https://evil.com/next")]) })
    await expectKind(c.fetchText("https://allowed.com/x"), "host_not_allowed")
  })

  it("redirect 到私网 IP 的白名单 host 也拒（逐跳重做 DNS）", async () => {
    let call = 0
    const c = client({
      resolveDns: async () => (call++ === 0 ? [PUBLIC_IP] : ["10.0.0.1"]),
      fetchImpl: fakeFetchSeq([redirectTo("https://other.com/next")]),
    })
    await expectKind(c.fetchText("https://allowed.com/x"), "ip_blocked")
  })

  it("redirect 缺 Location 拒", async () => {
    const c = client({ fetchImpl: fakeFetchSeq([new Response(null, { status: 302 })]) })
    await expectKind(c.fetchText("https://allowed.com/x"), "redirect_invalid")
  })

  it("超过 3 跳 redirect 拒", async () => {
    const c = client({
      fetchImpl: fakeFetchSeq([
        redirectTo("https://allowed.com/1"),
        redirectTo("https://allowed.com/2"),
        redirectTo("https://allowed.com/3"),
        redirectTo("https://allowed.com/4"),
      ]),
    })
    await expectKind(c.fetchText("https://allowed.com/x"), "redirect_limit")
  })

  it("合法单跳 redirect 放行", async () => {
    const c = client({
      fetchImpl: fakeFetchSeq([
        redirectTo("https://other.com/next"),
        new Response("landed", { status: 200 }),
      ]),
    })
    assert.equal(await c.fetchText("https://allowed.com/x"), "landed")
  })

  it("响应体超 maxBytes 拒", async () => {
    const c = client({ fetchImpl: fakeFetchOk("x".repeat(5000)) })
    await expectKind(c.fetchText("https://allowed.com/x", { maxBytes: 1000 }), "too_large")
  })

  it("非 2xx 拒", async () => {
    const c = client({ fetchImpl: fakeFetchOk("err", 500) })
    await assert.rejects(c.fetchText("https://allowed.com/x"), (err: unknown) => {
      assert.ok(err instanceof SafeHttpError)
      assert.equal(err.kind, "http_status")
      assert.equal((err as SafeHttpError & { status?: number }).status, 500)
      return true
    })
  })

  it("超时 → timeout", async () => {
    const never: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        )
      })) as unknown as typeof fetch
    const c = client({ fetchImpl: never })
    await expectKind(c.fetchText("https://allowed.com/x", { timeoutMs: 50 }), "timeout")
  })

  it("调用方 AbortSignal 可立即取消已启动请求，不等待内部 timeout", async () => {
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    const never: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        notifyStarted?.()
        init?.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        )
      })) as unknown as typeof fetch
    const c = client({ fetchImpl: never })
    const controller = new AbortController()
    const begunAt = Date.now()
    const pending = c.fetchText("https://allowed.com/x", {
      timeoutMs: 120,
      signal: controller.signal,
    } as Parameters<typeof c.fetchText>[1])
    await started
    controller.abort(new Error("source budget exhausted"))

    await expectKind(pending, "timeout")
    assert.ok(Date.now() - begunAt < 80, "外部 abort 不得继续占用内部 timeout 窗口")
  })

  it("调用方 AbortSignal 在 DNS 校验阶段也必须快速释放，不能等 resolver 返回", async () => {
    let notifyDnsStarted: (() => void) | undefined
    const dnsStarted = new Promise<void>((resolve) => {
      notifyDnsStarted = resolve
    })
    const c = client({
      resolveDns: async () => {
        notifyDnsStarted?.()
        await new Promise((resolve) => setTimeout(resolve, 120))
        return [PUBLIC_IP]
      },
    })
    const controller = new AbortController()
    const begunAt = Date.now()
    const pending = c.fetchText("https://allowed.com/x", {
      timeoutMs: 500,
      signal: controller.signal,
    })
    await dnsStarted
    controller.abort(new Error("source budget exhausted"))

    await expectKind(pending, "timeout")
    assert.ok(Date.now() - begunAt < 80, "DNS 校验必须响应外部 abort 并释放调用链")
  })

  // 自 F037 daily-digest 副本收敛（F041 W7）：副本在 F040 提升后长出的 fetchText POST 面
  it("POST method/body 透传（#31 小红书 MCP）；默认仍 GET；校验链同判（白名单外 host 照拒）", async () => {
    const seen: Array<{ method?: string; body?: unknown }> = []
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ method: init?.method, body: init?.body })
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
    const c = client({ fetchImpl })
    await c.fetchText("https://allowed.com/mcp", { method: "POST", body: '{"a":1}' })
    await c.fetchText("https://allowed.com/plain")
    assert.equal(seen[0].method, "POST")
    assert.equal(seen[0].body, '{"a":1}')
    assert.equal(seen[1].method, "GET")
    assert.equal(seen[1].body, undefined)
    await expectKind(
      c.fetchText("https://evil.com/mcp", { method: "POST", body: "{}" }),
      "host_not_allowed",
    )
  })

  it("happy path 200 返回文本", async () => {
    assert.equal(await client().fetchText("https://allowed.com/x"), "hello")
  })

  it("trustedBaseUrls：私网+自定端口的信任锚放行（自建 RSSHub 场景）", async () => {
    const c = client({ trustedBaseUrls: ["http://192.168.1.5:1200"] })
    assert.equal(await c.fetchText("http://192.168.1.5:1200/hupu/nba"), "hello")
  })

  it("trustedBaseUrls：非精确 origin（端口不同）不享受信任", async () => {
    const c = client({ trustedBaseUrls: ["http://192.168.1.5:1200"] })
    await expectKind(c.fetchText("http://192.168.1.5:1300/x"), "port")
  })

  it("trustedBaseUrls：redirect 离开信任 origin 立即恢复全套校验", async () => {
    const c = client({
      trustedBaseUrls: ["http://192.168.1.5:1200"],
      fetchImpl: fakeFetchSeq([redirectTo("http://10.0.0.9/steal")]),
      resolveDns: async () => ["10.0.0.9"],
    })
    await expectKind(c.fetchText("http://192.168.1.5:1200/route"), "host_not_allowed")
  })
})

describe("isBlockedIp 精确段", () => {
  it("公网 IPv4/IPv6 放行", () => {
    assert.equal(isBlockedIp("93.184.216.34"), false)
    assert.equal(isBlockedIp("2606:2800:220:1::1"), false)
  })
  it("边界：9.255.255.255 放行 / 10.0.0.0 拒 / 172.15 放行 / 172.32 放行", () => {
    assert.equal(isBlockedIp("9.255.255.255"), false)
    assert.equal(isBlockedIp("10.0.0.0"), true)
    assert.equal(isBlockedIp("172.15.255.255"), false)
    assert.equal(isBlockedIp("172.31.255.255"), true)
    assert.equal(isBlockedIp("172.32.0.0"), false)
  })
})

// ── F040 加法扩展：request()（飞书 REST 面 —— POST JSON / 业务错误码需要 status+body）──

describe("request() 扩展（F040）", () => {
  function fetchSpy(status = 200, body = '{"code":0}') {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const impl = (async (u: unknown, init?: RequestInit) => {
      calls.push({ url: String(u), init: init ?? {} })
      return new Response(body, { status })
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it("POST happy：透传 method/JSON body/content-type，返回 status+text 不抛", async () => {
    const spy = fetchSpy(200, '{"code":0,"tenant_access_token":"t"}')
    const c = client({ fetchImpl: spy.impl })
    const res = await c.request("https://allowed.com/open-apis/x", {
      method: "POST",
      jsonBody: { app_id: "a", app_secret: "s" },
      headers: { authorization: "Bearer t" },
    })
    assert.equal(res.status, 200)
    assert.ok(res.text.includes("tenant_access_token"))
    assert.equal(spy.calls.length, 1)
    assert.equal(spy.calls[0].init.method, "POST")
    assert.equal(spy.calls[0].init.body, '{"app_id":"a","app_secret":"s"}')
    const headers = spy.calls[0].init.headers as Record<string, string>
    assert.equal(headers["content-type"], "application/json; charset=utf-8")
    assert.equal(headers.authorization, "Bearer t")
  })

  it("非 2xx 不抛：返回 status+text（飞书业务错误码在 body 里）", async () => {
    const c = client({ fetchImpl: fetchSpy(400, '{"code":99991663,"msg":"token invalid"}').impl })
    const res = await c.request("https://allowed.com/open-apis/x", { method: "POST", jsonBody: {} })
    assert.equal(res.status, 400)
    assert.ok(res.text.includes("99991663"))
  })

  it("安全面不因 request() 放松：白名单外 host 仍拒", async () => {
    await expectKind(
      client().request("https://evil.com/x", { method: "POST", jsonBody: {} }),
      "host_not_allowed",
    )
  })

  it("安全面不因 request() 放松：DNS 私网仍拒", async () => {
    await expectKind(
      client({ resolveDns: async () => ["10.0.0.1"] }).request("https://allowed.com/x", {
        method: "POST",
        jsonBody: {},
      }),
      "ip_blocked",
    )
  })

  it("request() 遇 3xx 一律拒不跟随（POST 重放 body 是 footgun）", async () => {
    const c = client({ fetchImpl: fakeFetchSeq([redirectTo("https://other.com/next")]) })
    await expectKind(
      c.request("https://allowed.com/x", { method: "POST", jsonBody: {} }),
      "redirect_invalid",
    )
  })

  it("request() 响应体上限仍生效", async () => {
    const c = client({ fetchImpl: fakeFetchOk("x".repeat(5000)) })
    await expectKind(
      c.request("https://allowed.com/x", { method: "POST", jsonBody: {}, maxBytes: 1000 }),
      "too_large",
    )
  })

  it("request() 超时仍生效", async () => {
    const never: typeof fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        )
      })) as unknown as typeof fetch
    const c = client({ fetchImpl: never })
    await expectKind(
      c.request("https://allowed.com/x", { method: "POST", jsonBody: {}, timeoutMs: 50 }),
      "timeout",
    )
  })

  it("GET request()：不带 body 不带 content-type", async () => {
    const spy = fetchSpy()
    const c = client({ fetchImpl: spy.impl })
    await c.request("https://allowed.com/x")
    assert.equal(spy.calls[0].init.method, "GET")
    assert.equal(spy.calls[0].init.body, undefined)
    const headers = spy.calls[0].init.headers as Record<string, string>
    assert.equal(headers["content-type"], undefined)
  })

  // ── F041 W7 增量：结构化响应（headers/setCookies/finalUrl）+ GET followRedirects ──

  it("结构化响应：headers 键小写、set-cookie 走多值 setCookies 不进 headers、finalUrl=请求 URL", async () => {
    const resp = new Response('{"code":0}', { status: 200 })
    resp.headers.set("X-RateLimit", "10")
    resp.headers.append("set-cookie", "A=1; Path=/")
    resp.headers.append("set-cookie", "B=2; HttpOnly")
    const c = client({ fetchImpl: fakeFetchSeq([resp]) })
    const r = await c.request("https://allowed.com/x")
    assert.equal(r.headers?.["x-ratelimit"], "10")
    assert.equal(
      r.headers?.["set-cookie"],
      undefined,
      "set-cookie 禁入单值 headers（逗号合并损坏语义）",
    )
    assert.deepEqual(r.setCookies, ["A=1; Path=/", "B=2; HttpOnly"])
    assert.equal(r.finalUrl, "https://allowed.com/x")
  })

  it("结构化响应 buffer 路径同暴露 headers/finalUrl", async () => {
    const resp = new Response(new Uint8Array([1, 2]), { status: 200, headers: { "x-k": "v" } })
    const c = client({ fetchImpl: fakeFetchSeq([resp]) })
    const r = await c.request("https://allowed.com/b", { responseAs: "buffer" })
    assert.equal(r.headers?.["x-k"], "v")
    assert.equal(r.finalUrl, "https://allowed.com/b")
    assert.ok(r.bytes instanceof Uint8Array)
  })

  it("followRedirects GET：跟随后 finalUrl=终点（逐跳校验同链）", async () => {
    const c = client({
      fetchImpl: fakeFetchSeq([
        redirectTo("https://other.com/final"),
        new Response("done", { status: 200 }),
      ]),
    })
    const r = await c.request("https://allowed.com/start", { followRedirects: true })
    assert.equal(r.status, 200)
    assert.equal(r.text, "done")
    assert.equal(r.finalUrl, "https://other.com/final")
  })

  it("followRedirects：redirect 到白名单外 host 拒（校验链逐跳活着）", async () => {
    const c = client({ fetchImpl: fakeFetchSeq([redirectTo("https://evil.com/x")]) })
    await expectKind(
      c.request("https://allowed.com/start", { followRedirects: true }),
      "host_not_allowed",
    )
  })

  it("followRedirects：超 3 跳 → redirect_limit", async () => {
    const c = client({
      fetchImpl: fakeFetchSeq([
        redirectTo("https://allowed.com/1"),
        redirectTo("https://allowed.com/2"),
        redirectTo("https://allowed.com/3"),
        redirectTo("https://allowed.com/4"),
      ]),
    })
    await expectKind(
      c.request("https://allowed.com/0", { followRedirects: true }),
      "redirect_limit",
    )
  })

  it("followRedirects 非 GET → TypeError fail-fast（非 GET 重放是 footgun）", async () => {
    const c = client()
    await assert.rejects(
      c.request("https://allowed.com/x", { method: "POST", jsonBody: {}, followRedirects: true }),
      TypeError,
    )
  })
})

describe("F040 P3 AC16：rawBody / responseAs buffer / multipart 构造", () => {
  it("rawBody → body 原样 Uint8Array + content-type 用构造方的（不猜不覆写）", async () => {
    let seen: { body?: unknown; ct?: string } = {}
    const c = client({
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        seen = {
          body: init?.body,
          ct: (init?.headers as Record<string, string>)["content-type"],
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const r = await c.request("https://allowed.com/upload", {
      method: "POST",
      rawBody: { contentType: "multipart/form-data; boundary=xyz", body: data },
    })
    assert.equal(r.status, 200)
    assert.ok(seen.body instanceof Uint8Array)
    assert.deepEqual(Array.from(seen.body as Uint8Array), Array.from(data))
    assert.equal(seen.ct, "multipart/form-data; boundary=xyz")
  })

  it("jsonBody + rawBody 同给 → TypeError fail-fast", async () => {
    const c = client()
    await assert.rejects(
      c.request("https://allowed.com/x", {
        method: "POST",
        jsonBody: { a: 1 },
        rawBody: { contentType: "t", body: new Uint8Array(0) },
      }),
      TypeError,
    )
  })

  it("responseAs buffer → bytes 二进制保真（含 0x00/高位），text 空串", async () => {
    const bin = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x89, 0x50])
    const c = client({
      fetchImpl: (async () => new Response(bin, { status: 200 })) as unknown as typeof fetch,
    })
    const r = await c.request("https://allowed.com/dl", { responseAs: "buffer" })
    assert.equal(r.status, 200)
    assert.equal(r.text, "")
    assert.deepEqual(Array.from(r.bytes ?? []), Array.from(bin))
  })

  it("responseAs buffer 也吃 maxBytes 闸（too_large）", async () => {
    const c = client({
      fetchImpl: (async () =>
        new Response(new Uint8Array(5000), { status: 200 })) as unknown as typeof fetch,
    })
    await expectKind(
      c.request("https://allowed.com/dl", { responseAs: "buffer", maxBytes: 1024 }),
      "too_large",
    )
  })

  it("buildMultipartBody：结构完整（boundary 恰好出现在结构位）+ 二进制嵌入保真 + 文件名转义", () => {
    const data = new Uint8Array([0x00, 0x0d, 0x0a, 0xff, 0x89])
    const { contentType, body } = buildMultipartBody(
      { image_type: "message" },
      { field: "image", filename: '周报"v2\r\n.png', contentType: "image/png", data },
    )
    const m = contentType.match(/^multipart\/form-data; boundary=(.+)$/)
    assert.ok(m, "contentType 应带 boundary")
    const text = new TextDecoder("utf-8", { fatal: false }).decode(body)
    // 字段部分
    assert.match(text, /content-disposition: form-data; name="image_type"\r\n\r\nmessage\r\n/)
    // 文件头：引号与 CRLF 已转义
    assert.match(text, /filename="周报%22v2 {2}\.png"/)
    assert.match(text, /content-type: image\/png\r\n\r\n/)
    // 收尾
    assert.ok(text.includes(`--${m?.[1]}--`))
    // 二进制字节完整嵌入（在文件头之后原样出现）
    const idx = findBytes(body, data)
    assert.ok(idx > 0, "二进制数据应原样嵌入")
  })
})

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}
