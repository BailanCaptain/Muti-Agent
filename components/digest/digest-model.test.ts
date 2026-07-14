import { DIGEST_GH_KINDS } from "@multi-agent/shared"
import { describe, expect, it } from "vitest"
import {
  ALL_TAB,
  type DigestDayResponse,
  buildTabs,
  checkLine,
  filterByTab,
  githubGroups,
  githubMetaLine,
  overviewOf,
  podcastEpisodes,
  rawItems,
  resolvePicks,
  safeExternalHref,
  splitGhSnippet,
  tabOf,
} from "./digest-model"

const day: DigestDayResponse = {
  businessDate: "2026-07-05",
  labels: {
    "hn-ai": "Hacker News",
    "vllm-blog": "vLLM 博客",
    "x-firsthand": "X 一手动态",
    "zhihu-hot": "知乎热榜",
    "github-trending-daily": "GitHub 增长榜",
    "github-trending-weekly": "GitHub 周榜",
  },
  items: [
    {
      id: "a1",
      category: "ai",
      sourceId: "hn-ai",
      title: "vLLM 提速",
      canonicalUrl: "https://a/1",
      publishedAt: "2026-07-05T01:00:00Z",
      rawSnippet: "s",
      engagement: 320,
    },
    {
      id: "a2",
      category: "ai",
      sourceId: "vllm-blog",
      title: "官方博文",
      canonicalUrl: "https://a/2",
      publishedAt: "2026-07-05T02:00:00Z",
      rawSnippet: "s",
    },
    {
      id: "x1",
      category: "x",
      sourceId: "x-firsthand",
      title: "@OpenAI: 发布",
      canonicalUrl: "https://x/1",
      publishedAt: null,
      rawSnippet: "s",
      topicTag: "公司",
    },
    {
      id: "x2",
      category: "x",
      sourceId: "x-firsthand",
      title: "@karpathy: 洞见",
      canonicalUrl: "https://x/2",
      publishedAt: null,
      rawSnippet: "s",
      topicTag: "从业者",
    },
    {
      id: "x3",
      category: "x",
      sourceId: "x-firsthand",
      title: "@newguy: 新人",
      canonicalUrl: "https://x/3",
      publishedAt: null,
      rawSnippet: "s",
    },
    {
      id: "h1",
      category: "hot",
      sourceId: "zhihu-hot",
      title: "热点",
      canonicalUrl: "https://h/1",
      publishedAt: null,
      rawSnippet: "s",
      engagement: 999,
    },
    {
      id: "g1",
      category: "github",
      sourceId: "github-trending-daily",
      title: "o/daily",
      canonicalUrl: "https://g/1",
      publishedAt: null,
      rawSnippet: "+320 stars today · ★9,000 · Go · 快工具",
    },
    {
      id: "g2",
      category: "github",
      sourceId: "github-trending-weekly",
      title: "o/weekly",
      canonicalUrl: "https://g/2",
      publishedAt: null,
      rawSnippet: "+6,989 stars this week · ★8,695 · Python · 周榜项目",
    },
  ],
  summary: {
    businessDate: "2026-07-05",
    degraded: false,
    counts: { content: 6, github: 2 },
    sourceHealth: [
      { sourceId: "hn-ai", status: "ok", itemCount: 2, durationMs: 5, error: null },
      { sourceId: "zhihu-hot", status: "failed", itemCount: 0, durationMs: 5, error: "503" },
    ],
    summary: {
      degraded: false,
      overview: ["要点"],
      deepReads: [{ itemId: "a2", titleZh: "深读标题", summaryZh: "深读摘要" }],
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: "a1", summaryZh: "摘要一", tag: "推理", alsoItemIds: ["a2"] },
            { itemId: "a2", summaryZh: "摘要二", tag: "推理" },
            { itemId: "ghost", summaryZh: "找不到 item 的 pick 应被丢弃" },
          ],
        },
        {
          category: "x",
          picks: [
            { itemId: "x1", summaryZh: "s" },
            { itemId: "x2", summaryZh: "s" },
            { itemId: "x3", summaryZh: "s" },
          ],
        },
      ],
    },
  },
}

describe("digest-model（网页版分栏纯函数层）", () => {
  it("resolvePicks：join + 幽灵丢弃 + 深读覆盖 + 同报来源名", () => {
    const ai = resolvePicks(day, "ai")
    expect(ai.length).toBe(2)
    expect(ai[0].alsoLabels).toEqual(["vLLM 博客"])
    expect(ai[1].deep?.titleZh).toBe("深读标题")
  })

  it("tabOf/buildTabs：x 走 topicTag 结构分区；单组板块不出 tabs", () => {
    const x = resolvePicks(day, "community")
    expect(tabOf("community", x[0])).toBe("科技公司")
    expect(tabOf("community", x[1])).toBe("科技从业者")
    expect(tabOf("community", x[2])).toBe("更多动态")
    expect(buildTabs("community", x)).toEqual([ALL_TAB, "科技公司", "科技从业者", "更多动态"])
    // ai 全是「推理」单组 → 不出 tabs
    expect(buildTabs("ai", resolvePicks(day, "ai"))).toEqual([])
  })

  it("filterByTab：全部 = 原序全量；分栏 = 精确过滤", () => {
    const x = resolvePicks(day, "community")
    expect(filterByTab("community", x, ALL_TAB).length).toBe(3)
    expect(filterByTab("community", x, "科技公司").map((r) => r.item.id)).toEqual(["x1"])
  })

  it("githubGroups：按榜种分组全量不限量；splitGhSnippet 解析今日/本周", () => {
    expect(DIGEST_GH_KINDS.map((kind) => kind.label)).toEqual([
      "增长榜 · 今日",
      "周榜",
      "新秀 · 7 天新仓",
      "月榜",
    ])
    const groups = githubGroups(day)
    expect(groups.map((g) => g.label)).toEqual(["增长榜 · 今日", "周榜"])
    expect(splitGhSnippet(day.items[6].rawSnippet).meta).toBe("▲ 320 今日　★9,000　Go")
    expect(splitGhSnippet(day.items[7].rawSnippet).meta).toBe("▲ 6,989 本周　★8,695　Python")
  })

  it("GitHub 状态沿用原数据行：仅增长榜/新秀榜显示，周榜/月榜忽略脏状态", () => {
    const daily = {
      ...day.items[6],
      githubMeta: { rankStatus: { kind: "streak" as const, days: 2 } },
    }
    const weekly = {
      ...day.items[7],
      githubMeta: { rankStatus: { kind: "new" as const } },
    }
    expect(githubMetaLine(daily)).toBe("▲ 320 今日　★9,000　Go　连续 2 日上榜")
    expect(githubMetaLine(weekly)).toBe("▲ 6,989 本周　★8,695　Python")
    const newcomer = {
      ...day.items[6],
      sourceId: "github-ai-newcomers",
      rawSnippet: "新仓 7 天 ★1,200 · AI agent search",
      githubMeta: { rankStatus: { kind: "returning" as const } },
    }
    expect(githubMetaLine(newcomer)).toBe("新仓 7 天　★1,200　重新上榜")
  })

  it("rawItems：互动量倒序，无互动量按时间倒序垫底", () => {
    expect(rawItems(day, "ai").map((i) => i.id)).toEqual(["a1", "a2"])
  })

  it("B027 v2：picks/raw/GitHub 只按 publication join，raw pool 未审核条目不得在网页回流", () => {
    const v2: DigestDayResponse = {
      ...day,
      summary: day.summary && {
        ...day.summary,
        schemaVersion: 2,
        publication: {
          schemaVersion: 2,
          businessDate: day.businessDate,
          overview: ["要点"],
          sections: [
            {
              category: "ai",
              entries: [{ itemId: "a1", role: "hero", summaryZh: "摘要一", displayTag: "推理" }],
            },
            { category: "github", entries: [{ itemId: "g2", role: "list" }] },
          ],
        },
      },
    }

    expect(resolvePicks(v2, "ai").map((pick) => pick.item.id)).toEqual(["a1"])
    expect(rawItems(v2, "ai").map((item) => item.id)).toEqual(["a1"])
    expect(githubGroups(v2).flatMap((group) => group.items.map((item) => item.id))).toEqual(["g2"])
  })

  it("B027 v2 fail-closed：schemaVersion=2 但 publication 缺失时不回落 raw discovery", () => {
    const broken: DigestDayResponse = {
      ...day,
      summary: day.summary && { ...day.summary, schemaVersion: 2 },
    }
    expect(resolvePicks(broken, "ai")).toEqual([])
    expect(rawItems(broken, "ai")).toEqual([])
    expect(githubGroups(broken)).toEqual([])
  })

  it("B027 overview：v2 只读 publication；缺失 fail-closed；legacy 才回落 summary", () => {
    const v2: DigestDayResponse = {
      ...day,
      summary: day.summary && {
        ...day.summary,
        schemaVersion: 2,
        summary: { ...day.summary.summary, overview: ["被拒内容的旧速览"] },
        publication: {
          schemaVersion: 2,
          businessDate: day.businessDate,
          overview: ["最终获批速览"],
          sections: [],
        },
      },
    }
    expect(overviewOf(v2)).toEqual(["最终获批速览"])
    expect(
      overviewOf({
        ...v2,
        summary: v2.summary && { ...v2.summary, publication: undefined },
      }),
    ).toEqual([])
    expect(overviewOf(day)).toEqual(["要点"])
  })

  it("checkLine：收录走 counts 预滤后口径（德彪 r-final P2-1）+ 开源榜单单列", () => {
    expect(checkLine(day)).toBe("本期扫描 1/2 源 · 收录 8 条 · 精选 6 条 · 开源榜单 2 条")
  })

  it("checkLine：老归档无 counts 回落全量数（无 GitHub 段）", () => {
    const legacy: DigestDayResponse = {
      ...day,
      summary: day.summary ? { ...day.summary, counts: undefined as never } : null,
    }
    expect(checkLine(legacy)).toBe("本期扫描 1/2 源 · 收录 8 条 · 精选 6 条")
  })

  it("B027 checkLine：v2 精选只按最终 publication 卡片计数，预算裁掉/审核拒绝不回流", () => {
    const v2: DigestDayResponse = {
      ...day,
      summary: day.summary && {
        ...day.summary,
        schemaVersion: 2,
        counts: { content: 6, github: 2 },
        publication: {
          schemaVersion: 2,
          businessDate: day.businessDate,
          overview: [],
          sections: [
            {
              category: "ai",
              entries: [
                { itemId: "a1", role: "hero", summaryZh: "摘要一" },
                { itemId: "a2", role: "brief" },
              ],
            },
            { category: "github", entries: [{ itemId: "g1", role: "list" }] },
          ],
        },
      },
    }

    expect(checkLine(v2)).toBe("本期扫描 1/2 源 · 收录 8 条 · 精选 1 条 · 开源榜单 2 条")
  })

  it("safeExternalHref：只放行 http(s)——React 只拦 javascript:，data: 要自己守（P2-3）", () => {
    expect(safeExternalHref("https://a.com/x")).toBe("https://a.com/x")
    expect(safeExternalHref("HTTP://a.com/x")).toBe("HTTP://a.com/x")
    expect(safeExternalHref("data:text/html,<b>x</b>")).toBe("#")
    expect(safeExternalHref("javascript:alert(1)")).toBe("#")
  })

  it("社区平台 tab（07-06 改版）：reddit 条目归 Reddit 组，与 X 结构组同场；旧归档 x 类目归一", () => {
    const withReddit: DigestDayResponse = {
      ...day,
      items: [
        ...day.items,
        {
          id: "r1",
          category: "community",
          sourceId: "reddit-ai",
          title: "LocalLLaMA 热帖",
          canonicalUrl: "https://r/1",
          publishedAt: null,
          rawSnippet: "s",
        },
      ],
      summary: day.summary && {
        ...day.summary,
        summary: {
          ...day.summary.summary,
          sections: day.summary.summary.sections.map((s) =>
            // 故意保留旧类目名 "x"：混合旧 section + 新条目验证读取侧归一
            s.category === "x"
              ? { ...s, picks: [...s.picks, { itemId: "r1", summaryZh: "s" }] }
              : s,
          ),
        },
      },
    }
    const c = resolvePicks(withReddit, "community")
    expect(c.length).toBe(4)
    expect(tabOf("community", c[3])).toBe("Reddit")
    expect(buildTabs("community", c)).toEqual([
      ALL_TAB,
      "科技公司",
      "科技从业者",
      "更多动态",
      "Reddit",
    ])
    expect(rawItems(withReddit, "community").map((i) => i.id)).toContain("r1")
  })
})

describe("#33 播客速递（07-10）", () => {
  const withPodcast = {
    ...day,
    items: [
      ...day.items,
      {
        id: "p1",
        category: "podcast",
        sourceId: "podcast-transcribe",
        title: "42章经｜旧集",
        canonicalUrl: "https://www.xiaoyuzhoufm.com/episode/e1",
        publishedAt: "2026-07-01T13:30:00.000Z",
        rawSnippet: "• 要点",
        topicTag: "42章经",
      },
      {
        id: "p2",
        category: "podcast",
        sourceId: "podcast-transcribe",
        title: "硅谷101｜新集",
        canonicalUrl: "https://www.xiaoyuzhoufm.com/episode/e2",
        publishedAt: "2026-07-04T13:30:00.000Z",
        rawSnippet: "• 要点",
        topicTag: "硅谷101",
      },
    ],
    summary: day.summary && {
      ...day.summary,
      counts: { content: 6, github: 2, podcast: 2 },
    },
  }

  it("podcastEpisodes：只取 podcast 类目，新集在前", () => {
    expect(podcastEpisodes(withPodcast).map((e) => e.id)).toEqual(["p2", "p1"])
    expect(podcastEpisodes(day)).toEqual([])
  })

  it("checkLine：收录含播客 + 播客单列；老归档无 podcast 键不受影响", () => {
    expect(checkLine(withPodcast)).toBe(
      "本期扫描 1/2 源 · 收录 10 条 · 精选 6 条 · 开源榜单 2 条 · 播客 2 集",
    )
    expect(checkLine(day)).toBe("本期扫描 1/2 源 · 收录 8 条 · 精选 6 条 · 开源榜单 2 条")
  })
})

describe("#33 播客 P2-1（07-11 德彪 r1）：网页与邮件同口径", () => {
  it("德彪反例：items 有旧播客底料但本期渲染清单为空 → 网页也不显示", () => {
    const dayOldPodcast = {
      ...day,
      items: [
        ...day.items,
        {
          id: "old",
          category: "podcast",
          sourceId: "podcast-transcribe",
          title: "42章经｜昨日旧集",
          canonicalUrl: "https://www.xiaoyuzhoufm.com/episode/old",
          publishedAt: "2026-07-01T13:30:00.000Z",
          rawSnippet: "• 要点",
        },
      ],
      summary: day.summary && {
        ...day.summary,
        counts: { content: 6, github: 2, podcast: 0 },
        podcastItemIds: [], // 本期实际渲染清单：空
      },
    }
    expect(podcastEpisodes(dayOldPodcast)).toEqual([])
  })

  it("podcastItemIds 只放行清单内的集；老归档（无该键）回落全量", () => {
    const two = [
      {
        id: "p1",
        category: "podcast",
        sourceId: "podcast-transcribe",
        title: "a",
        canonicalUrl: "https://x/1",
        publishedAt: null,
        rawSnippet: "s",
      },
      {
        id: "p2",
        category: "podcast",
        sourceId: "podcast-transcribe",
        title: "b",
        canonicalUrl: "https://x/2",
        publishedAt: null,
        rawSnippet: "s",
      },
    ]
    const scoped = {
      ...day,
      items: [...day.items, ...two],
      summary: day.summary && { ...day.summary, podcastItemIds: ["p2"] },
    }
    expect(podcastEpisodes(scoped).map((e) => e.id)).toEqual(["p2"])
    const legacy = { ...day, items: [...day.items, ...two] } // 无 podcastItemIds
    expect(
      podcastEpisodes(legacy)
        .map((e) => e.id)
        .sort(),
    ).toEqual(["p1", "p2"])
  })
})
