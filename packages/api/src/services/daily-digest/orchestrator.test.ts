import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SafeHttpError } from "../../net/safe-http-client"
import { buildNormalizedItem } from "./feed-parsers"
import { dedupeItems, runAllSources } from "./orchestrator"
import type { DigestSource, SafeHttpClient, SourceFetchResult } from "./types"

const http: SafeHttpClient = { fetchText: async () => "" }

function src(sourceId: string, fetch: DigestSource["fetch"]): DigestSource {
  return { sourceId, category: "ai", fetch }
}

const item = (source: string, url: string, publishedAt: string | null = null) =>
  buildNormalizedItem(source, "ai", `t-${url}`, url, publishedAt, "s")

const github = (
  sourceId: string,
  state: "yes" | "no" | "unknown",
  repo = "owner/shared",
  windowStars = 100,
) => {
  const base = buildNormalizedItem(
    sourceId,
    "github",
    repo,
    `https://github.com/${repo}`,
    null,
    `+${windowStars} stars today · ★1,000 · TypeScript · AI agent`,
  )
  return {
    ...base,
    githubMeta: {
      repo,
      period: sourceId === "github-ai-newcomers" ? ("newcomer" as const) : ("daily" as const),
      windowStars,
      totalStars: 1_000,
      language: "TypeScript",
      description: "AI agent",
      evidence: {
        topics: state === "yes" ? ["ai-agent"] : [],
        metadataStatus: "embedded" as const,
        readmeStatus: "not_requested" as const,
        evidenceComplete: false,
      },
      eligibility: { state, confidence: state === "yes" ? 0.98 : 0, reasons: [state] },
    },
  }
}

describe("runAllSources（AC8 单源隔离）", () => {
  it("默认只并发 6 个 source，完成结果仍保持输入顺序", async () => {
    let active = 0
    let maxActive = 0
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const sources = Array.from({ length: 12 }, (_, index) =>
      src(`source-${index}`, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
        return [item(`source-${index}`, `https://a.com/${index}`)]
      }),
    )

    const running = runAllSources(sources, { http, perSourceTimeoutMs: 1_000 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const observedBeforeRelease = maxActive
    releaseGate()
    const { results } = await running

    assert.equal(observedBeforeRelease, 6)
    assert.deepEqual(
      results.map((result) => result.sourceId),
      sources.map((source) => source.sourceId),
    )
  })

  it("显式 sourceConcurrency 生效，排队时间不计入 source 自身预算", async () => {
    let active = 0
    let maxActive = 0
    const sources: DigestSource[] = [
      src("queue-holder", async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 60))
        active -= 1
        return [item("queue-holder", "https://a.com/holder")]
      }),
      {
        sourceId: "short-budget",
        category: "ai",
        timeoutBudgetMs: 30,
        async fetch() {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          active -= 1
          return [item("short-budget", "https://a.com/short")]
        },
      },
    ]

    const { results } = await runAllSources(sources, {
      http,
      perSourceTimeoutMs: 100,
      sourceConcurrency: 1,
    })

    assert.equal(maxActive, 1)
    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok"],
    )
  })

  it("同一 concurrency group 按声明上限执行，组内排队不消耗 source 预算且不阻塞独立源", async () => {
    let groupedActive = 0
    let maxGroupedActive = 0
    let firstGroupedDone = false
    let independentStartedBeforeFirstDone = false
    const grouped = (sourceId: string, holdMs: number, timeoutBudgetMs: number) =>
      ({
        sourceId,
        category: "ai",
        timeoutBudgetMs,
        concurrencyGroup: { key: "youtube-feed", maxConcurrency: 1 },
        async fetch() {
          groupedActive += 1
          maxGroupedActive = Math.max(maxGroupedActive, groupedActive)
          await new Promise((resolve) => setTimeout(resolve, holdMs))
          groupedActive -= 1
          if (sourceId === "yt-first") firstGroupedDone = true
          return [item(sourceId, `https://a.com/${sourceId}`)]
        },
      }) as DigestSource & {
        concurrencyGroup: { key: string; maxConcurrency: number }
      }
    const independent = src("independent", async () => {
      independentStartedBeforeFirstDone = !firstGroupedDone
      return [item("independent", "https://a.com/independent")]
    })

    const { results } = await runAllSources(
      [
        grouped("yt-first", 40, 100),
        grouped("yt-short-budget", 5, 15),
        independent,
        grouped("yt-third", 5, 15),
      ],
      { http, sourceConcurrency: 4, perSourceTimeoutMs: 100 },
    )

    assert.equal(maxGroupedActive, 1)
    assert.equal(independentStartedBeforeFirstDone, true)
    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok", "ok", "ok"],
    )
  })

  it("连续 12 个组内 source 排队时不占满全局 worker，后置独立源仍立即启动", async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let independentStarted = false
    const grouped = Array.from({ length: 12 }, (_, index) => ({
      sourceId: `yt-${index}`,
      category: "ai" as const,
      concurrencyGroup: { key: "youtube-feed", maxConcurrency: 1 },
      async fetch() {
        if (index === 0) await firstGate
        return [item(`yt-${index}`, `https://a.com/yt-${index}`)]
      },
    }))
    const independent = src("independent-after-youtube", async () => {
      independentStarted = true
      return [item("independent-after-youtube", "https://a.com/independent-after-youtube")]
    })

    const running = runAllSources([...grouped, independent], {
      http,
      sourceConcurrency: 6,
      perSourceTimeoutMs: 1_000,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const startedBeforeGroupedRelease = independentStarted
    releaseFirst()
    await running

    assert.equal(startedBeforeGroupedRelease, true)
  })

  it("同组 source 的开始时间遵守最小间隔，等待不消耗 source 预算", async () => {
    const starts: number[] = []
    const sources = Array.from({ length: 3 }, (_, index) => {
      const source = {
        sourceId: `paced-${index}`,
        category: "ai",
        timeoutBudgetMs: 15,
        concurrencyGroup: {
          key: "youtube-feed",
          maxConcurrency: 1,
          minIntervalMs: 40,
        },
        async fetch() {
          starts.push(Date.now())
          return [item(`paced-${index}`, `https://a.com/paced-${index}`)]
        },
      }
      return source as unknown as DigestSource
    })

    const { results } = await runAllSources(sources, {
      http,
      sourceConcurrency: 3,
      perSourceTimeoutMs: 15,
    })

    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok", "ok"],
    )
    assert.ok(starts[1] - starts[0] >= 30, `first gap was ${starts[1] - starts[0]}ms`)
    assert.ok(starts[2] - starts[1] >= 30, `second gap was ${starts[2] - starts[1]}ms`)
  })

  it("组内并发大于 1 时仍逐次保留最小启动间隔", async () => {
    const starts: number[] = []
    const sources = Array.from({ length: 3 }, (_, index) => ({
      sourceId: `parallel-paced-${index}`,
      category: "ai" as const,
      concurrencyGroup: {
        key: "parallel-paced",
        maxConcurrency: 2,
        minIntervalMs: 35,
      },
      async fetch() {
        starts.push(Date.now())
        await new Promise((resolve) => setTimeout(resolve, 80))
        return [item(`parallel-paced-${index}`, `https://a.com/parallel-paced-${index}`)]
      },
    }))

    const { results } = await runAllSources(sources, {
      http,
      sourceConcurrency: 3,
      perSourceTimeoutMs: 150,
    })

    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok", "ok"],
    )
    assert.ok(starts[1] - starts[0] >= 25, `first gap was ${starts[1] - starts[0]}ms`)
    assert.ok(starts[2] - starts[1] >= 25, `second gap was ${starts[2] - starts[1]}ms`)
  })

  it("同 key 的组配置在启动前按最严格上限与间隔聚合，不受 source 顺序影响", async () => {
    let active = 0
    let maxActive = 0
    const starts: number[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const grouped = (
      sourceId: string,
      maxConcurrency: number,
      minIntervalMs: number,
      waitForGate: boolean,
    ): DigestSource => ({
      sourceId,
      category: "ai",
      concurrencyGroup: { key: "shared-upstream", maxConcurrency, minIntervalMs },
      async fetch() {
        starts.push(Date.now())
        active += 1
        maxActive = Math.max(maxActive, active)
        if (waitForGate) await firstGate
        active -= 1
        return [item(sourceId, `https://a.com/${sourceId}`)]
      },
    })

    const running = runAllSources(
      [
        grouped("wide-first", 2, 0, true),
        grouped("wide-second", 2, 0, true),
        grouped("strict-later", 1, 40, false),
      ],
      { http, sourceConcurrency: 3, perSourceTimeoutMs: 200 },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    const maxBeforeRelease = maxActive
    releaseFirst()
    const { results } = await running

    assert.equal(maxBeforeRelease, 1)
    assert.equal(maxActive, 1)
    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok", "ok"],
    )
    assert.ok(starts[1] - starts[0] >= 30, `first gap was ${starts[1] - starts[0]}ms`)
    assert.ok(starts[2] - starts[1] >= 30, `second gap was ${starts[2] - starts[1]}ms`)
  })

  for (const kind of ["network", "timeout"] as const) {
    it(`source-bound HTTP 对 ${kind} 只重试一次，并为未传 signal 的独立 fetcher 注入 source abort`, async () => {
      const signals: Array<AbortSignal | undefined> = []
      let calls = 0
      const sourceHttp: SafeHttpClient = {
        async fetchText(url, opts) {
          calls += 1
          signals.push(opts?.signal)
          if (calls === 1) throw new SafeHttpError(kind, url)
          return "recovered"
        },
      }
      const source: DigestSource = {
        ...src(`recover-${kind}`, async (ctx) => {
          await ctx.http.fetchText(`https://a.com/${kind}`)
          return [item(`recover-${kind}`, `https://a.com/${kind}`)]
        }),
        transientGetRetry: { maxAttempts: 2 },
      }

      const { results } = await runAllSources([source], {
        http: sourceHttp,
        perSourceTimeoutMs: 200,
        transportRetryDelayMs: 0,
      })

      assert.equal(results[0].status, "ok")
      assert.equal(calls, 2)
      assert.equal(signals.length, 2)
      assert.ok(signals.every(Boolean))
      assert.equal(signals[0], signals[1])
    })
  }

  it("source-bound HTTP 不重试永久错误", async () => {
    let calls = 0
    const sourceHttp: SafeHttpClient = {
      async fetchText(url) {
        calls += 1
        throw new SafeHttpError("http_status", url, "status 403", 403)
      },
    }
    const source: DigestSource = {
      ...src("permanent", async (ctx) => {
        await ctx.http.fetchText("https://a.com/permanent")
        return []
      }),
      transientGetRetry: { maxAttempts: 2 },
    }

    const { results } = await runAllSources([source], {
      http: sourceHttp,
      transportRetryDelayMs: 0,
    })

    assert.equal(results[0].status, "failed")
    assert.equal(calls, 1)
  })

  it("source 总预算会中止未显式传 signal 的底层请求，且不会在 abort 后重试", async () => {
    let calls = 0
    let capturedSignal: AbortSignal | undefined
    const sourceHttp: SafeHttpClient = {
      fetchText: async (_url, opts) => {
        calls += 1
        capturedSignal = opts?.signal
        return new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new SafeHttpError("timeout", "https://a.com/pending")),
            { once: true },
          )
        })
      },
    }
    const source = src("pending", async (ctx) => {
      await ctx.http.fetchText("https://a.com/pending")
      return []
    })

    const { results } = await runAllSources([source], {
      http: sourceHttp,
      perSourceTimeoutMs: 30,
      transportRetryDelayMs: 0,
    })

    assert.equal(results[0].status, "timeout")
    assert.equal(calls, 1)
    assert.ok(capturedSignal)
    assert.equal(capturedSignal.aborted, true)
  })

  it("httpDirect 也使用同一 source-bound transport 重试，不误走代理 client", async () => {
    let directCalls = 0
    let proxyCalls = 0
    const proxyHttp: SafeHttpClient = {
      async fetchText() {
        proxyCalls += 1
        throw new Error("must not use proxy client")
      },
    }
    const directHttp: SafeHttpClient = {
      async fetchText(url) {
        directCalls += 1
        if (directCalls === 1) throw new SafeHttpError("network", url)
        return "direct recovered"
      },
    }
    const source: DigestSource = {
      ...src("direct", async (ctx) => {
        await ctx.httpDirect?.fetchText("https://a.com/direct")
        return [item("direct", "https://a.com/direct")]
      }),
      transientGetRetry: { maxAttempts: 2 },
    }

    const { results } = await runAllSources([source], {
      http: proxyHttp,
      httpDirect: directHttp,
      transportRetryDelayMs: 0,
    })

    assert.equal(results[0].status, "ok")
    assert.equal(directCalls, 2)
    assert.equal(proxyCalls, 0)
  })

  it("source-bound HTTP 只给幂等 GET 重试，POST 即使 network 也只调用一次", async () => {
    let calls = 0
    let capturedSignal: AbortSignal | undefined
    const sourceHttp: SafeHttpClient = {
      async fetchText(url, opts) {
        calls += 1
        capturedSignal = opts?.signal
        throw new SafeHttpError("network", url)
      },
    }
    const source: DigestSource = {
      ...src("post-source", async (ctx) => {
        await ctx.http.fetchText("https://a.com/post", {
          method: "POST",
          body: "{}",
        })
        return []
      }),
      transientGetRetry: { maxAttempts: 2 },
    }

    const { results } = await runAllSources([source], {
      http: sourceHttp,
      transportRetryDelayMs: 0,
    })

    assert.equal(results[0].status, "failed")
    assert.equal(calls, 1)
    assert.ok(capturedSignal)
  })

  it("source 在 retry backoff 期间超时会立即停止，不产生第二次请求", async () => {
    let calls = 0
    const sourceHttp: SafeHttpClient = {
      async fetchText(url) {
        calls += 1
        throw new SafeHttpError("network", url)
      },
    }
    const source: DigestSource = {
      ...src("backoff-abort", async (ctx) => {
        await ctx.http.fetchText("https://a.com/backoff")
        return []
      }),
      transientGetRetry: { maxAttempts: 2 },
    }

    const started = Date.now()
    const { results } = await runAllSources([source], {
      http: sourceHttp,
      perSourceTimeoutMs: 30,
      transportRetryDelayMs: 1_000,
    })

    assert.equal(results[0].status, "timeout")
    assert.ok(Date.now() - started < 500)
    assert.equal(calls, 1)
  })

  it("http 与 httpDirect 共享同一枚 retry token，单个 source 最多只有一次额外请求", async () => {
    let proxyCalls = 0
    let directCalls = 0
    const proxyHttp: SafeHttpClient = {
      async fetchText(url) {
        proxyCalls += 1
        if (proxyCalls === 1) throw new SafeHttpError("network", url)
        return "proxy recovered"
      },
    }
    const directHttp: SafeHttpClient = {
      async fetchText(url) {
        directCalls += 1
        if (directCalls === 1) throw new SafeHttpError("network", url)
        return "must not reach a second direct call"
      },
    }
    const source: DigestSource = {
      ...src("shared-token", async (ctx) => {
        await ctx.http.fetchText("https://a.com/proxy")
        await ctx.httpDirect?.fetchText("https://a.com/direct")
        return []
      }),
      transientGetRetry: { maxAttempts: 2 },
    }

    const { results } = await runAllSources([source], {
      http: proxyHttp,
      httpDirect: directHttp,
      transportRetryDelayMs: 0,
    })

    assert.equal(results[0].status, "failed")
    assert.equal(proxyCalls, 2)
    assert.equal(directCalls, 1)
  })

  it("一源抛错、一源超时、一源正常 → 三种 status，正常源条目保留", async () => {
    const sources = [
      src("ok-src", async () => [item("ok-src", "https://a.com/1")]),
      src("boom-src", async () => {
        throw new Error("boom")
      }),
      src("slow-src", () => new Promise(() => {})),
    ]
    const { results, items } = await runAllSources(sources, { http, perSourceTimeoutMs: 100 })
    const by = new Map(results.map((r) => [r.sourceId, r]))
    assert.equal(by.get("ok-src")?.status, "ok")
    assert.equal(by.get("boom-src")?.status, "failed")
    assert.match(by.get("boom-src")?.errors[0] ?? "", /boom/)
    assert.equal(by.get("slow-src")?.status, "timeout")
    assert.equal(items.length, 1)
  })

  it("源自带 timeoutBudgetMs 覆盖默认单源超时（X 限速长跑源不被 45s 掐死）", async () => {
    const slowButBudgeted: DigestSource = {
      sourceId: "x-firsthand",
      category: "community",
      timeoutBudgetMs: 500,
      fetch: () =>
        new Promise((r) => setTimeout(() => r([item("x-firsthand", "https://x.com/a/1")]), 60)),
    }
    const { results } = await runAllSources([slowButBudgeted], { http, perSourceTimeoutMs: 10 })
    assert.equal(results[0].status, "ok")
    assert.equal(results[0].items.length, 1)
  })

  it("健康结果落 store", async () => {
    const recorded: Array<{ date: string; results: SourceFetchResult[] }> = []
    await runAllSources([src("s1", async () => [item("s1", "https://a.com/1")])], {
      http,
      health: {
        record: (date, results) => recorded.push({ date, results }),
        consecutiveFailures: () => 0,
      },
      healthDate: "2026-07-03",
    })
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].date, "2026-07-03")
    assert.equal(recorded[0].results[0].sourceId, "s1")
  })
})

describe("dedupeItems 跨源去重", () => {
  it("同 dedupeKey 保留 publishedAt 较新者", () => {
    const older = item("src-a", "https://espn.com/story/1?utm_source=rss", "2026-07-01T00:00:00Z")
    const newer = item("src-b", "https://ESPN.com/story/1/", "2026-07-02T00:00:00Z")
    assert.equal(older.dedupeKey, newer.dedupeKey)
    const out = dedupeItems([older, newer])
    assert.equal(out.length, 1)
    assert.equal(out[0].sourceId, "src-b")
  })
  it("publishedAt null 视为最旧", () => {
    const noDate = item("src-a", "https://a.com/x", null)
    const dated = item("src-b", "https://a.com/x", "2026-07-01T00:00:00Z")
    assert.equal(dedupeItems([dated, noDate])[0].sourceId, "src-b")
  })

  it("同仓跨榜先保留可发布判定；同为 yes 时仍由既有源顺序决定榜种", () => {
    const dailyUnknown = github("github-trending-daily", "unknown")
    const newcomerYes = github("github-ai-newcomers", "yes")
    assert.equal(dedupeItems([dailyUnknown, newcomerYes])[0].sourceId, "github-ai-newcomers")

    const dailyYes = github("github-trending-daily", "yes")
    assert.equal(dedupeItems([dailyYes, newcomerYes])[0].sourceId, "github-trending-daily")

    const allFour = dedupeItems([
      dailyYes,
      github("github-trending-weekly", "yes"),
      newcomerYes,
      github("github-trending-monthly", "yes"),
    ])
    assert.deepEqual(
      allFour.map((item) => item.sourceId),
      ["github-trending-daily"],
      "同一期同仓只出现一次；同为 yes 时保持日→周→新秀→月的既有优先顺序",
    )

    const dailyNo = github("github-trending-daily", "no")
    assert.equal(
      dedupeItems([dailyNo, newcomerYes])[0].githubMeta?.eligibility.state,
      "no",
      "yes/no 证据冲突必须 fail-closed，不能让噪声 topic 覆盖硬否决",
    )
  })

  it("后续榜种用更强证据替换时必须回到该榜原排序位置，不能继承旧 Map 插槽", () => {
    const dailyUnknown = github("github-trending-daily", "unknown", "owner/shared", 200)
    const newcomerTop = github("github-ai-newcomers", "yes", "owner/top", 300)
    const newcomerReplacement = github("github-ai-newcomers", "yes", "owner/shared", 200)
    const newcomerTail = github("github-ai-newcomers", "yes", "owner/tail", 100)

    const out = dedupeItems([dailyUnknown, newcomerTop, newcomerReplacement, newcomerTail])

    assert.deepEqual(
      out.map((item) => item.githubMeta?.repo),
      ["owner/top", "owner/shared", "owner/tail"],
      "daily unknown 被 newcomer yes 替换后，应保持新秀榜按真实增星降序",
    )
  })
})
