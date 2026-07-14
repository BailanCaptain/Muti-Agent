import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import type { SafeHttpClient, SourceFetchContext } from "../types"
import {
  MAX_NEW_EPISODES_PER_RUN,
  PODCAST_FEEDS,
  PODCAST_SOURCE_ID,
  makePodcastSource,
  parseDurationSec,
  parsePodcastFeed,
} from "./podcast"
import type { EpisodeRecord, PodcastEpisodeRef, PodcastTranscriber } from "./podcast-transcribe"
import { episodeCacheKey } from "./podcast-transcribe"

const NOW = new Date("2026-07-10T08:00:00Z")

let baseDir: string
beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "podcast-src-test-"))
})
afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true })
})

/** RSSHub /xiaoyuzhou/podcast/:id 真实形态缩样（07-10 活体抓取核对字段） */
function feedXml(
  episodes: Array<{
    title: string
    link: string
    audio: string
    pubDate: string
    duration?: string
  }>,
): string {
  const items = episodes
    .map(
      (e) =>
        `<item><title>${e.title}</title><link>${e.link}</link><description>&lt;p&gt;shownotes&lt;/p&gt;</description><pubDate>${e.pubDate}</pubDate>${e.duration ? `<itunes:duration>${e.duration}</itunes:duration>` : ""}<enclosure url="${e.audio}" type="audio/mpeg"></enclosure></item>`,
    )
    .join("")
  return `<?xml version="1.0" encoding="UTF-8"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0"><channel><title>42章经</title>${items}</channel></rss>`
}

const FRESH_PUB = "Wed, 08 Jul 2026 13:30:00 GMT" // NOW-2 天，7 天窗内
const STALE_PUB = "Sat, 27 Jun 2026 13:30:00 GMT" // NOW-13 天，窗外

function makeCtx(bodyByUrl: (url: string) => string): SourceFetchContext {
  const http: SafeHttpClient = {
    fetchText: async (url) => bodyByUrl(url),
  }
  return { http, signal: new AbortController().signal, now: () => NOW }
}

function fakeTranscriber(
  state: { calls: PodcastEpisodeRef[] },
  opts: { fail?: boolean } = {},
): PodcastTranscriber {
  return {
    async ensureDigest(ep) {
      state.calls.push(ep)
      if (opts.fail) throw new Error("ffmpeg 未安装或不在 PATH")
      return {
        episodeUrl: ep.episodeUrl,
        enclosureUrl: ep.enclosureUrl,
        title: ep.title,
        podcast: ep.podcast,
        publishedAt: ep.publishedAt,
        durationSec: ep.durationSec,
        transcript: "全文",
        digestZh: "• 要点一\n• 要点二",
        transcribedAt: NOW.toISOString(),
        digestedAt: NOW.toISOString(),
      }
    },
  }
}

function srcConfig(transcriber: PodcastTranscriber, feeds = [{ pid: "p1", name: "42章经" }]) {
  return {
    sttApiKey: "gsk_test",
    baseDir,
    runner: { runPrompt: async () => ({ ok: true, text: "", durationMs: 1 }) },
    feeds,
    transcriber,
  }
}

describe("parseDurationSec", () => {
  it("H:MM:SS / MM:SS / 纯秒 三形态；垃圾 null", () => {
    assert.equal(parseDurationSec("1:10:46"), 4246)
    assert.equal(parseDurationSec("50:20"), 3020)
    assert.equal(parseDurationSec("3020"), 3020)
    assert.equal(parseDurationSec(""), null)
    assert.equal(parseDurationSec("abc"), null)
    assert.equal(parseDurationSec("1:2:3:4"), null)
    assert.equal(parseDurationSec("-5"), null)
  })
})

describe("parsePodcastFeed", () => {
  it("enclosure/duration/pubDate 全解析；缺 enclosure 的 item 跳过", () => {
    const xml = feedXml([
      {
        title: "第一集",
        link: "https://www.xiaoyuzhoufm.com/episode/e1",
        audio: "https://media.xyzcdn.net/p1/a1.m4a",
        pubDate: FRESH_PUB,
        duration: "0:50:20",
      },
    ]).replace(
      "</channel>",
      `<item><title>无音频集</title><link>https://x/e0</link><pubDate>${FRESH_PUB}</pubDate></item></channel>`,
    )
    const eps = parsePodcastFeed(xml, "42章经")
    assert.equal(eps.length, 1)
    assert.equal(eps[0].title, "第一集")
    assert.equal(eps[0].enclosureUrl, "https://media.xyzcdn.net/p1/a1.m4a")
    assert.equal(eps[0].durationSec, 3020)
    assert.equal(eps[0].podcast, "42章经")
    assert.ok(eps[0].publishedAt?.startsWith("2026-07-08"))
  })

  it("坏 XML / 非 RSS → []", () => {
    assert.deepEqual(parsePodcastFeed("not xml <<<", "x"), [])
    assert.deepEqual(parsePodcastFeed("<feed></feed>", "x"), [])
  })
})

describe("makePodcastSource fetch", () => {
  it("7 天窗内新集 → 转写 → NormalizedItem（title 前缀/topicTag/category）", async () => {
    const state = { calls: [] as PodcastEpisodeRef[] }
    const src = makePodcastSource(srcConfig(fakeTranscriber(state)))
    const ctx = makeCtx(() =>
      feedXml([
        {
          title: "新集",
          link: "https://www.xiaoyuzhoufm.com/episode/e1",
          audio: "https://media.xyzcdn.net/p1/a1.m4a",
          pubDate: FRESH_PUB,
          duration: "50:20",
        },
        {
          title: "老集",
          link: "https://www.xiaoyuzhoufm.com/episode/e0",
          audio: "https://media.xyzcdn.net/p1/a0.m4a",
          pubDate: STALE_PUB,
          duration: "50:20",
        },
      ]),
    )
    const items = await src.fetch(ctx)
    assert.equal(items.length, 1)
    assert.equal(items[0].category, "podcast")
    assert.equal(items[0].sourceId, PODCAST_SOURCE_ID)
    assert.equal(items[0].title, "42章经｜新集")
    assert.equal(items[0].topicTag, "42章经")
    assert.equal(items[0].canonicalUrl, "https://www.xiaoyuzhoufm.com/episode/e1")
    assert.ok(items[0].rawSnippet.includes("要点一"))
    assert.equal(state.calls.length, 1) // 老集没进转写
  })

  it("单轮新转写 cap；已缓存 digest 的集不占额度", async () => {
    // p1 feed 出 cap+2 个新集，其中 1 个已有缓存 digest
    const eps = Array.from({ length: MAX_NEW_EPISODES_PER_RUN + 2 }, (_, i) => ({
      title: `第${i}集`,
      link: `https://www.xiaoyuzhoufm.com/episode/e${i}`,
      audio: `https://media.xyzcdn.net/p1/a${i}.m4a`,
      pubDate: FRESH_PUB,
      duration: "50:20",
    }))
    const cachedUrl = eps[0].audio
    fs.mkdirSync(path.join(baseDir, "transcripts"), { recursive: true })
    const rec: EpisodeRecord = {
      episodeUrl: eps[0].link,
      enclosureUrl: cachedUrl,
      title: eps[0].title,
      podcast: "42章经",
      publishedAt: "2026-07-08T13:30:00.000Z",
      durationSec: 3020,
      transcript: "已有",
      digestZh: "• 缓存要点",
      transcribedAt: NOW.toISOString(),
      digestedAt: NOW.toISOString(),
    }
    fs.writeFileSync(
      path.join(baseDir, "transcripts", `${episodeCacheKey(cachedUrl)}.json`),
      JSON.stringify(rec),
    )
    const state = { calls: [] as PodcastEpisodeRef[] }
    const src = makePodcastSource(srcConfig(fakeTranscriber(state)))
    const items = await src.fetch(makeCtx(() => feedXml(eps)))
    // 缓存集 + cap 个新转写 = cap+1 条；超额 1 集留下轮
    assert.equal(items.length, MAX_NEW_EPISODES_PER_RUN + 1)
    // ensureDigest 对缓存集也会调（秒回），新转写额度只烧在无缓存集上
    assert.equal(state.calls.length, MAX_NEW_EPISODES_PER_RUN + 1)
  })

  it("一家 feed 挂另一家正常 → 出正常家的集（部分容错）", async () => {
    const state = { calls: [] as PodcastEpisodeRef[] }
    const src = makePodcastSource(
      srcConfig(fakeTranscriber(state), [
        { pid: "dead", name: "挂了" },
        { pid: "alive", name: "活着" },
      ]),
    )
    const ctx = makeCtx((url) => {
      if (url.includes("dead")) throw new Error("HTTP 503")
      return feedXml([
        {
          title: "好集",
          link: "https://www.xiaoyuzhoufm.com/episode/ok",
          audio: "https://media.xyzcdn.net/p2/ok.m4a",
          pubDate: FRESH_PUB,
          duration: "50:20",
        },
      ])
    })
    const items = await src.fetch(ctx)
    assert.equal(items.length, 1)
    assert.equal(items[0].topicTag, "活着")
  })

  it("全部 feed 拉取失败 → 抛错（坏源进 health 告警链）", async () => {
    const src = makePodcastSource(srcConfig(fakeTranscriber({ calls: [] })))
    const ctx = makeCtx(() => {
      throw new Error("HTTP 503")
    })
    await assert.rejects(() => src.fetch(ctx), /全部拉取失败/)
  })

  it("有新集但全转写失败（如 ffmpeg 未装）→ 抛错", async () => {
    const src = makePodcastSource(srcConfig(fakeTranscriber({ calls: [] }, { fail: true })))
    const ctx = makeCtx(() =>
      feedXml([
        {
          title: "新集",
          link: "https://www.xiaoyuzhoufm.com/episode/e1",
          audio: "https://media.xyzcdn.net/p1/a1.m4a",
          pubDate: FRESH_PUB,
          duration: "50:20",
        },
      ]),
    )
    await assert.rejects(() => src.fetch(ctx), /ffmpeg 未安装/)
  })

  it("无新集（全窗外）→ []（健康空，不告警）", async () => {
    const state = { calls: [] as PodcastEpisodeRef[] }
    const src = makePodcastSource(srcConfig(fakeTranscriber(state)))
    const ctx = makeCtx(() =>
      feedXml([
        {
          title: "老集",
          link: "https://www.xiaoyuzhoufm.com/episode/e0",
          audio: "https://media.xyzcdn.net/p1/a0.m4a",
          pubDate: STALE_PUB,
          duration: "50:20",
        },
      ]),
    )
    const items = await src.fetch(ctx)
    assert.deepEqual(items, [])
    assert.equal(state.calls.length, 0)
  })

  it("默认清单 8 家 + 三集慢模型全链保留 96h 极宽保险丝", () => {
    assert.equal(PODCAST_FEEDS.length, 8)
    const src = makePodcastSource(srcConfig(fakeTranscriber({ calls: [] })))
    assert.equal(src.sourceId, PODCAST_SOURCE_ID)
    assert.equal(src.category, "podcast")
    assert.equal(src.timeoutBudgetMs, 96 * 60 * 60_000)
  })
})

describe("health 计数三分法（德彪 r1 P2-2 红测）", () => {
  it("缓存成功 + 当日新集全失败 → 仍抛错（旧缓存不得掩盖 STT/ffmpeg 故障）", async () => {
    const eps = [
      {
        title: "缓存集",
        link: "https://www.xiaoyuzhoufm.com/episode/c1",
        audio: "https://media.xyzcdn.net/p1/c1.m4a",
        pubDate: FRESH_PUB,
        duration: "50:20",
      },
      {
        title: "新集",
        link: "https://www.xiaoyuzhoufm.com/episode/n1",
        audio: "https://media.xyzcdn.net/p1/n1.m4a",
        pubDate: FRESH_PUB,
        duration: "50:20",
      },
    ]
    // 缓存集已有 digest
    fs.mkdirSync(path.join(baseDir, "transcripts"), { recursive: true })
    fs.writeFileSync(
      path.join(baseDir, "transcripts", `${episodeCacheKey(eps[0].audio)}.json`),
      JSON.stringify({
        episodeUrl: eps[0].link,
        enclosureUrl: eps[0].audio,
        title: eps[0].title,
        podcast: "42章经",
        publishedAt: "2026-07-08T13:30:00.000Z",
        durationSec: 3020,
        transcript: "有",
        digestZh: "• 缓存要点",
        transcribedAt: NOW.toISOString(),
        digestedAt: NOW.toISOString(),
      }),
    )
    // transcriber：缓存集秒回、新集失败（模拟 ffmpeg 故障）
    const failNew: PodcastTranscriber = {
      async ensureDigest(ep) {
        if (ep.enclosureUrl === eps[0].audio) {
          return {
            episodeUrl: ep.episodeUrl,
            enclosureUrl: ep.enclosureUrl,
            title: ep.title,
            podcast: ep.podcast,
            publishedAt: ep.publishedAt,
            durationSec: ep.durationSec,
            transcript: "有",
            digestZh: "• 缓存要点",
            transcribedAt: NOW.toISOString(),
            digestedAt: NOW.toISOString(),
          }
        }
        throw new Error("ffmpeg exit 1：boom")
      },
    }
    const src = makePodcastSource(srcConfig(failNew))
    await assert.rejects(() => src.fetch(makeCtx(() => feedXml(eps))), /ffmpeg exit 1/)
  })

  it("超 3h 集 = 策略 skip：不进失败分母、不抛、不转写", async () => {
    const state = { calls: [] as PodcastEpisodeRef[] }
    const src = makePodcastSource(srcConfig(fakeTranscriber(state)))
    const items = await src.fetch(
      makeCtx(() =>
        feedXml([
          {
            title: "马拉松集",
            link: "https://www.xiaoyuzhoufm.com/episode/m1",
            audio: "https://media.xyzcdn.net/p1/m1.m4a",
            pubDate: FRESH_PUB,
            duration: "3:30:00",
          },
        ]),
      ),
    )
    assert.deepEqual(items, [])
    assert.equal(state.calls.length, 0, "超长集不该进转写")
  })

  it("orchestrator 预算掐断（signal abort）→ 快停向上抛，零 feed 拉取（r2：预 abort 不并发拉 feed）", async () => {
    const ac = new AbortController()
    ac.abort()
    const state = { calls: [] as PodcastEpisodeRef[] }
    let feedFetches = 0
    const src = makePodcastSource(srcConfig(fakeTranscriber(state)))
    const ctx = {
      http: {
        fetchText: async () => {
          feedFetches++
          return feedXml([
            {
              title: "新集",
              link: "https://www.xiaoyuzhoufm.com/episode/e1",
              audio: "https://media.xyzcdn.net/p1/a1.m4a",
              pubDate: FRESH_PUB,
              duration: "50:20",
            },
          ])
        },
      },
      signal: ac.signal,
      now: () => NOW,
    }
    await assert.rejects(() => src.fetch(ctx))
    assert.equal(state.calls.length, 0, "abort 后不启动新集工作")
    assert.equal(feedFetches, 0, "预 abort 连 feed 都不拉（德彪 r2 P1）")
  })
})
