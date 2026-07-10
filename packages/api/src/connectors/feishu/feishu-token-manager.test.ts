import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SafeHttpResponse } from "../../net/safe-http-client"
import { FeishuTokenManager } from "./feishu-token-manager"

/** F040 T12：tenant_access_token 缓存 + 提前 300s 刷新 + 并发单飞 + code≠0 抛（AC6 后半）。 */

function fakeHttp(responses: Array<{ code: number; token?: string; expire?: number }>) {
  let i = 0
  const calls: string[] = []
  return {
    calls,
    client: {
      async request(url: string): Promise<SafeHttpResponse> {
        calls.push(url)
        const r = responses[Math.min(i, responses.length - 1)]
        i += 1
        return {
          status: 200,
          text: JSON.stringify({
            code: r.code,
            msg: r.code === 0 ? "ok" : "bad",
            tenant_access_token: r.token,
            expire: r.expire,
          }),
        }
      },
      async fetchText() {
        return ""
      },
    },
  }
}

function mgr(http: ReturnType<typeof fakeHttp>, nowRef: { t: number }) {
  return new FeishuTokenManager({
    appId: "cli_a",
    appSecret: "secret",
    http: http.client,
    now: () => nowRef.t,
  })
}

describe("FeishuTokenManager", () => {
  it("首取 → 请求 token 端点，返回 token", async () => {
    const http = fakeHttp([{ code: 0, token: "t_1", expire: 7200 }])
    const now = { t: 1000 }
    const m = mgr(http, now)
    assert.equal(await m.getToken(), "t_1")
    assert.equal(http.calls.length, 1)
    assert.match(http.calls[0], /auth\/v3\/tenant_access_token\/internal$/)
  })

  it("缓存命中 → 不重复请求", async () => {
    const http = fakeHttp([{ code: 0, token: "t_1", expire: 7200 }])
    const now = { t: 1000 }
    const m = mgr(http, now)
    await m.getToken()
    await m.getToken()
    assert.equal(http.calls.length, 1)
  })

  it("过期前 300s 内 → 刷新", async () => {
    const http = fakeHttp([
      { code: 0, token: "t_1", expire: 7200 },
      { code: 0, token: "t_2", expire: 7200 },
    ])
    const now = { t: 0 }
    const m = mgr(http, now)
    assert.equal(await m.getToken(), "t_1")
    // expiresAt = 0 + (7200-300)*1000 = 6_900_000ms。推进到刷新窗口内
    now.t = 6_900_001
    assert.equal(await m.getToken(), "t_2")
    assert.equal(http.calls.length, 2)
  })

  it("并发单飞：同时多次 getToken 只发一次请求", async () => {
    const http = fakeHttp([{ code: 0, token: "t_1", expire: 7200 }])
    const now = { t: 1000 }
    const m = mgr(http, now)
    const [a, b, c] = await Promise.all([m.getToken(), m.getToken(), m.getToken()])
    assert.equal(a, "t_1")
    assert.equal(b, "t_1")
    assert.equal(c, "t_1")
    assert.equal(http.calls.length, 1)
  })

  it("code≠0 → 抛结构化错，不缓存", async () => {
    const http = fakeHttp([
      { code: 99991000 },
      { code: 0, token: "t_ok", expire: 7200 },
    ])
    const now = { t: 1000 }
    const m = mgr(http, now)
    await assert.rejects(m.getToken(), /99991000/)
    // 下次重试成功
    assert.equal(await m.getToken(), "t_ok")
  })

  it("invalidate() → 强制下次刷新", async () => {
    const http = fakeHttp([
      { code: 0, token: "t_1", expire: 7200 },
      { code: 0, token: "t_2", expire: 7200 },
    ])
    const now = { t: 1000 }
    const m = mgr(http, now)
    assert.equal(await m.getToken(), "t_1")
    m.invalidate()
    assert.equal(await m.getToken(), "t_2")
    assert.equal(http.calls.length, 2)
  })
})
