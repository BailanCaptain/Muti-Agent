import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SafeHttpError, createSafeHttpClient, isBlockedIp } from "./safe-http-client"

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
    await expectKind(c.fetchText("https://allowed.com/x"), "http_status")
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
    assert.equal(isBlockedIp("172.32.0.0"), false)
    assert.equal(isBlockedIp("172.31.255.255"), true)
  })
})
