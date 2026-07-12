import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SafeHttpClient } from "../types"
import {
  createRsshubXProvider,
  createTwitterApiIoProvider,
  makeXSource,
  resolveXConfig,
} from "./x-provider"

const NOW = new Date("2026-07-03T12:00:00Z")
const ctx = (http: SafeHttpClient) => ({ http, now: () => NOW })
/** 单测默认零延时（真延时只在限速专项测里用注入时钟验证） */
const NO_PACING = { delayMs: 0, jitterMs: 0 }

const tweet = (id: string, text: string, hoursAgo: number) => ({
  id,
  text,
  createdAt: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
})

describe("createTwitterApiIoProvider", () => {
  it("拉多账号、带 x-api-key、只留近 24h、构造 x.com 链接", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = []
    const http: SafeHttpClient = {
      fetchText: async (url, opts) => {
        seen.push({ url, headers: opts?.headers })
        return JSON.stringify({
          tweets: [tweet("111", "vLLM 新版本发布", 2), tweet("222", "旧闻", 30)],
        })
      },
    }
    const p = createTwitterApiIoProvider({ apiKey: "k-123", pacing: NO_PACING })
    const items = await p.fetchHandles(["karpathy", "sama"], ctx(http))
    assert.equal(seen.length, 2)
    assert.match(seen[0].url, /userName=karpathy/)
    assert.equal(seen[0].headers?.["x-api-key"], "k-123")
    // 每账号 2 条里只留近 24h 的 1 条 × 2 账号
    assert.equal(items.length, 2)
    assert.match(items[0].canonicalUrl, /^https:\/\/x\.com\/karpathy\/status\/111$/)
    assert.match(items[0].title, /^@karpathy: /)
    assert.equal(items[0].category, "community")
    // X 分栏 #3：已知从业者账号挂结构标签
    assert.equal(items[0].topicTag, "从业者")
  })

  it("单账号失败跳过不炸（per-author 隔离）", async () => {
    let call = 0
    const http: SafeHttpClient = {
      fetchText: async () => {
        call += 1
        if (call === 1) throw new Error("429")
        return JSON.stringify({ tweets: [tweet("333", "ok", 1)] })
      },
    }
    const p = createTwitterApiIoProvider({ apiKey: "k", pacing: NO_PACING })
    const items = await p.fetchHandles(["a", "b"], ctx(http))
    assert.equal(items.length, 1)
  })

  it("字段变更（无 tweets）→ 空数组不抛（防御式解析）", async () => {
    const http: SafeHttpClient = { fetchText: async () => JSON.stringify({ unexpected: true }) }
    const p = createTwitterApiIoProvider({ apiKey: "k" })
    assert.deepEqual(await p.fetchHandles(["a"], ctx(http)), [])
  })

  it("部分账号失败 → log 退化比例；已尝试账号全灭 → 抛（德彪 batchA-r1 P2）", async () => {
    const logs: string[] = []
    let call = 0
    const http: SafeHttpClient = {
      fetchText: async () => {
        call += 1
        if (call === 1) throw new Error("404 no user")
        return JSON.stringify({ tweets: [tweet("333", "ok", 1)] })
      },
    }
    const p = createTwitterApiIoProvider({
      apiKey: "k",
      pacing: NO_PACING,
      log: (m) => logs.push(m),
    })
    const items = await p.fetchHandles(["dead", "alive"], ctx(http))
    assert.equal(items.length, 1)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /1\/2 账号抓取失败/)
    assert.match(logs[0], /@dead/)

    // 全灭：抓取异常（≠安静无推文）→ 抛给 orchestrator 记 failed
    const allFail: SafeHttpClient = {
      fetchText: async () => {
        throw new Error("RSSHub down")
      },
    }
    const p2 = createRsshubXProvider({ rsshubBase: "http://127.0.0.1:1200", pacing: NO_PACING })
    await assert.rejects(() => p2.fetchHandles(["a", "b"], ctx(allFail)), /全灭.*2\/2/)
  })
})

describe("makeXSource", () => {
  it("0 tweets → 抛（orchestrator 记 failed，key 失效可观测）", async () => {
    const provider = { providerId: "fake", fetchHandles: async () => [] }
    const src = makeXSource({ provider, handles: ["a"] })
    await assert.rejects(
      src.fetch({
        http: { fetchText: async () => "" },
        signal: new AbortController().signal,
        now: () => NOW,
      }),
    )
  })
})

describe("createRsshubXProvider（cookie 小号路线，小孙 07-03 拍板 D16）", () => {
  const tweetRss = (pubDate: string) =>
    `<rss><channel><title>Sam Altman</title><item><title>we shipped a new model today</title><link>https://x.com/sama/status/1</link><pubDate>${pubDate}</pubDate><description>we shipped a new model today</description></item></channel></rss>`

  function httpReturning(bodies: Record<string, string>): SafeHttpClient & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      async fetchText(url) {
        calls.push(url)
        const hit = Object.entries(bodies).find(([k]) => url.includes(k))
        if (!hit) throw new Error(`no fixture for ${url}`)
        return hit[1]
      },
    }
  }

  it("近 24h 推文 → x 类目条目，标题带 @handle 前缀；base 尾斜杠归一", async () => {
    const http = httpReturning({ "/twitter/user/sama": tweetRss(NOW.toUTCString()) })
    const provider = createRsshubXProvider({ rsshubBase: "http://127.0.0.1:1200/" })
    const items = await provider.fetchHandles(["sama"], ctx(http))
    assert.equal(items.length, 1)
    assert.equal(items[0].category, "community")
    assert.equal(items[0].sourceId, "x-firsthand")
    assert.ok(items[0].title.startsWith("@sama: "))
    assert.equal(items[0].topicTag, "从业者") // X 分栏 #3
    assert.equal(http.calls[0], "http://127.0.0.1:1200/twitter/user/sama")
  })

  it("机构账号挂「公司」标签；清单外账号不挂（落更多动态）", async () => {
    const http = httpReturning({
      "/twitter/user/OpenAI": tweetRss(NOW.toUTCString()),
      "/twitter/user/newguy": tweetRss(NOW.toUTCString()),
    })
    const provider = createRsshubXProvider({
      rsshubBase: "http://127.0.0.1:1200",
      pacing: NO_PACING,
    })
    const items = await provider.fetchHandles(["OpenAI", "newguy"], ctx(http))
    assert.equal(items.length, 2)
    assert.equal(items[0].topicTag, "公司")
    assert.equal(items[1].topicTag, undefined)
  })

  it("超过 24h 的推文被截走；无日期条目保守保留", async () => {
    const old = new Date(NOW.getTime() - 48 * 3600_000).toUTCString()
    const http = httpReturning({
      "/twitter/user/old": tweetRss(old),
      "/twitter/user/nodate":
        "<rss><channel><item><title>t</title><link>https://x.com/nodate/status/2</link></item></channel></rss>",
    })
    const provider = createRsshubXProvider({
      rsshubBase: "http://127.0.0.1:1200",
      pacing: NO_PACING,
    })
    const items = await provider.fetchHandles(["old", "nodate"], ctx(http))
    assert.equal(items.length, 1)
    assert.ok(items[0].title.startsWith("@nodate: "))
  })

  it("单账号失败跳过不炸整源", async () => {
    const http = httpReturning({ "/twitter/user/good": tweetRss(NOW.toUTCString()) })
    const provider = createRsshubXProvider({
      rsshubBase: "http://127.0.0.1:1200",
      pacing: NO_PACING,
    })
    const items = await provider.fetchHandles(["dead", "good"], ctx(http))
    assert.equal(items.length, 1)
  })
})

describe("转推处理（小孙 07-11 二拍：有价值保留、归属如实、链接落原帖）", () => {
  it("rsshub：RT 条目保留，标题改写「@转推者 转推 原作者: …」；链接=转推 status（登录态自动落原帖）", async () => {
    const body = `<rss><channel><item><title>RT Tibo: usage limits reset across Codex</title><link>https://x.com/sama/status/3</link><pubDate>${NOW.toUTCString()}</pubDate><description>RT Tibo: usage limits reset across Codex full text</description></item><item><title>we shipped a new model today</title><link>https://x.com/sama/status/4</link><pubDate>${NOW.toUTCString()}</pubDate></item></channel></rss>`
    const http: SafeHttpClient = { fetchText: async () => body }
    const provider = createRsshubXProvider({
      rsshubBase: "http://127.0.0.1:1200",
      pacing: NO_PACING,
    })
    const items = await provider.fetchHandles(["sama"], ctx(http))
    assert.equal(items.length, 2)
    assert.equal(items[0].title, "@sama 转推 Tibo: usage limits reset across Codex")
    assert.equal(items[0].canonicalUrl, "https://x.com/sama/status/3")
    assert.ok(items[1].title.startsWith("@sama: we shipped"))
  })

  it("api：retweeted_tweet 对象在 → 链接换原帖、正文换原推全文、标题双向归属", async () => {
    const http: SafeHttpClient = {
      fetchText: async () =>
        JSON.stringify({
          tweets: [
            {
              id: "900",
              text: "RT @tibo: usage limits reset…",
              createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
              retweeted_tweet: {
                id: "800",
                text: "usage limits reset across Codex, full original text",
                author: { userName: "tibo" },
              },
            },
          ],
        }),
    }
    const p = createTwitterApiIoProvider({ apiKey: "k", pacing: NO_PACING })
    const items = await p.fetchHandles(["sama"], ctx(http))
    assert.equal(items.length, 1)
    assert.equal(items[0].canonicalUrl, "https://x.com/tibo/status/800")
    assert.ok(items[0].title.startsWith("@sama 转推 @tibo: usage limits reset across Codex"))
    assert.match(items[0].rawSnippet, /full original text/)
  })

  it("api：转推但缺 retweeted_tweet（字段变更）→ 标题仍改写、链接保持转推 status（防御式）", async () => {
    const http: SafeHttpClient = {
      fetchText: async () =>
        JSON.stringify({ tweets: [tweet("1", "RT @someone: great paper", 1)] }),
    }
    const p = createTwitterApiIoProvider({ apiKey: "k", pacing: NO_PACING })
    const items = await p.fetchHandles(["a"], ctx(http))
    assert.equal(items.length, 1)
    assert.ok(items[0].title.startsWith("@a 转推 @someone: great paper"))
    assert.match(items[0].canonicalUrl, /x\.com\/a\/status\/1/)
  })

  it("api：retweeted_tweet 错型 fail-closed 回落，绝不产 [object Object] 伪链接（德彪 sixq-r1 P2-2）", async () => {
    const rt = (retweeted: unknown) => ({
      id: "77",
      text: "RT @x: something",
      createdAt: new Date(NOW.getTime() - 3600_000).toISOString(),
      retweeted_tweet: retweeted,
    })
    const badShapes: unknown[] = [
      "not-an-object",
      [{ id: "1" }],
      { id: {}, text: "t", author: { userName: {} } }, // 对象字段 → String() 伪串的原病灶
      { id: "not-digits", text: "t", author: { userName: "ok" } }, // id 形态非法
      { id: "123", text: "t", author: { userName: "bad handle!" } }, // handle 形态非法
      { id: "123", text: "", author: { userName: "ok" } }, // 空正文
    ]
    for (const shape of badShapes) {
      const http: SafeHttpClient = {
        fetchText: async () => JSON.stringify({ tweets: [rt(shape)] }),
      }
      const p = createTwitterApiIoProvider({ apiKey: "k", pacing: NO_PACING })
      const items = await p.fetchHandles(["a"], ctx(http))
      assert.equal(items.length, 1)
      assert.equal(items[0].canonicalUrl, "https://x.com/a/status/77", JSON.stringify(shape))
      assert.ok(!items[0].title.includes("[object Object]"), JSON.stringify(shape))
      assert.ok(items[0].title.startsWith("@a 转推 @x: something"), JSON.stringify(shape))
    }
  })

  it("正文中段含 RT 字样不触发改写", async () => {
    const http: SafeHttpClient = {
      fetchText: async () =>
        JSON.stringify({ tweets: [tweet("2", "our new RT kernel is fast", 1)] }),
    }
    const p = createTwitterApiIoProvider({ apiKey: "k", pacing: NO_PACING })
    const items = await p.fetchHandles(["a"], ctx(http))
    assert.ok(items[0].title.startsWith("@a: our new RT kernel"))
  })
})

describe("X 限速遍历（B 项防封号：账号间延时 + 预算 + abort）", () => {
  const rssBody = `<rss><channel><item><title>t</title><link>https://x.com/h/status/9</link><pubDate>${NOW.toUTCString()}</pubDate></item></channel></rss>`
  const httpOk = () => {
    const calls: string[] = []
    const http: SafeHttpClient & { calls: string[] } = {
      calls,
      fetchText: async (url) => {
        calls.push(url)
        return rssBody
      },
    }
    return http
  }

  it("账号间 sleep(delay + random*jitter)，共 N-1 次（末位不空等）", async () => {
    const slept: number[] = []
    const http = httpOk()
    const provider = createRsshubXProvider({
      rsshubBase: "http://127.0.0.1:1200",
      pacing: {
        delayMs: 100,
        jitterMs: 50,
        sleep: async (ms) => {
          slept.push(ms)
        },
        random: () => 0.5,
      },
    })
    const items = await provider.fetchHandles(["a", "b", "c"], ctx(http))
    assert.equal(http.calls.length, 3)
    assert.equal(items.length, 3)
    assert.deepEqual(slept, [125, 125])
  })

  it("整源预算到点 → 停抓返回已得（partial 优于整包丢弃）", async () => {
    let t = 0
    const http = httpOk()
    const provider = createRsshubXProvider({
      rsshubBase: "http://127.0.0.1:1200",
      pacing: {
        delayMs: 200,
        jitterMs: 0,
        maxTotalMs: 100,
        clock: () => t,
        sleep: async (ms) => {
          t += ms
        },
      },
    })
    const items = await provider.fetchHandles(["a", "b", "c"], ctx(http))
    assert.equal(http.calls.length, 1) // 第一个账号后 sleep 把钟推过预算 → b/c 不再抓
    assert.equal(items.length, 1)
  })

  it("上游 abort（orchestrator 单源超时）→ 不再发起新请求", async () => {
    const http = httpOk()
    const aborted = new AbortController()
    aborted.abort()
    const provider = createRsshubXProvider({
      rsshubBase: "http://127.0.0.1:1200",
      pacing: NO_PACING,
    })
    const items = await provider.fetchHandles(["a", "b"], {
      http,
      now: () => NOW,
      signal: aborted.signal,
    })
    assert.equal(http.calls.length, 0)
    assert.deepEqual(items, [])
  })

  it("makeXSource 源预算 = provider.maxTotalMs + 60s（缺省 240s+60s）", () => {
    const withBudget = makeXSource({
      provider: { providerId: "p", maxTotalMs: 1000, fetchHandles: async () => [] },
      handles: ["a"],
    })
    assert.equal(withBudget.timeoutBudgetMs, 61_000)
    const withoutBudget = makeXSource({
      provider: { providerId: "p", fetchHandles: async () => [] },
      handles: ["a"],
    })
    assert.equal(withoutBudget.timeoutBudgetMs, 300_000)
  })

  it("rsshub 默认限速 ≈ 人速（4-7s/账号）且预算 8 分钟", () => {
    const provider = createRsshubXProvider({ rsshubBase: "http://127.0.0.1:1200" })
    assert.equal(provider.maxTotalMs, 480_000)
  })
})

describe("resolveXConfig 两条数据路（D16，默认 disabled）", () => {
  it("有 API key → api 模式优先；@ 前缀剥离", () => {
    assert.equal(resolveXConfig({}), null)
    assert.equal(resolveXConfig({ MULTI_AGENT_DIGEST_X_API_KEY: "k" } as NodeJS.ProcessEnv), null)
    const cfg = resolveXConfig({
      MULTI_AGENT_DIGEST_X_API_KEY: "k",
      MULTI_AGENT_DIGEST_X_HANDLES: "@karpathy, sama ,",
      MULTI_AGENT_DIGEST_RSSHUB_BASE: "http://127.0.0.1:1200",
    } as NodeJS.ProcessEnv)
    assert.deepEqual(cfg, { mode: "api", apiKey: "k", handles: ["karpathy", "sama"] })
  })

  it("无 key 有自建 RSSHub → rsshub cookie 模式", () => {
    const cfg = resolveXConfig({
      MULTI_AGENT_DIGEST_X_HANDLES: "@sama",
      MULTI_AGENT_DIGEST_RSSHUB_BASE: "http://127.0.0.1:1200",
    } as NodeJS.ProcessEnv)
    assert.deepEqual(cfg, { mode: "rsshub", handles: ["sama"] })
  })

  it("两条路凭证都缺 → null（handles 单配不启用）", () => {
    assert.equal(
      resolveXConfig({ MULTI_AGENT_DIGEST_X_HANDLES: "@sama" } as NodeJS.ProcessEnv),
      null,
    )
  })
})
