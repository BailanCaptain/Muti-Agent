import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildNormalizedItem } from "./feed-parsers"
import { escapeHtml, mdLink, renderDigest } from "./renderer"
import type { DigestPublicationV2, DigestSummary, SourceFetchResult } from "./types"

const items = [
  buildNormalizedItem(
    "smol-ai",
    "ai",
    'vLLM <b>提速</b> & "引号"',
    "https://a.com/1?x=1&y=2",
    "2026-07-03T00:00:00Z",
    "snippet",
  ),
  buildNormalizedItem(
    "zhihu-hot",
    "hot",
    "热点标题",
    "https://www.zhihu.com/question/123",
    null,
    "desc",
  ),
]
const summary: DigestSummary = {
  overview: ["AI 要点一", "热点要点二"],
  sections: [
    { category: "ai", picks: [{ itemId: items[0].id, summaryZh: "推理优化摘要" }] },
    { category: "hot", picks: [{ itemId: items[1].id, summaryZh: "热点摘要" }] },
  ],
  degraded: false,
}
const results: SourceFetchResult[] = [
  {
    sourceId: "smol-ai",
    status: "ok",
    items: [],
    errors: [],
    attempts: 1,
    fetchedAt: "t",
    durationMs: 1,
  },
  {
    sourceId: "hltv",
    status: "failed",
    items: [],
    errors: ["503"],
    attempts: 1,
    fetchedAt: "t",
    durationMs: 1,
  },
]

const render = () => renderDigest({ businessDate: "2026-07-03", summary, items, results })

describe("B027 publication manifest 渲染闭环", () => {
  it("v2 今日速览只读 publication，summary 里的被拒文案不能绕回邮件", () => {
    const ai = buildNormalizedItem(
      "vllm-blog",
      "ai",
      "vLLM 推理吞吐优化",
      "https://vllm.ai/progress",
      null,
      "engineering progress",
    )
    const publication: DigestPublicationV2 = {
      schemaVersion: 2,
      businessDate: "2026-07-12",
      overview: ["vLLM 推理吞吐取得新进展"],
      overviewRefs: [{ text: "vLLM 推理吞吐取得新进展", itemIds: [ai.id] }],
      sections: [
        {
          category: "ai",
          entries: [{ itemId: ai.id, role: "hero", summaryZh: "推理吞吐提升" }],
        },
      ],
    }
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: ["Tim Cook 致信 Sam Altman 引发热议"],
        sections: [],
        degraded: false,
      },
      publication,
      items: [ai],
      results: [],
    })

    assert.ok(out.html.includes("vLLM 推理吞吐取得新进展"))
    assert.ok(!out.html.includes("Tim Cook 致信 Sam Altman"))
    assert.ok(!out.markdown.includes("Tim Cook 致信 Sam Altman"))
  })

  it("v2 只渲染显式批准的 pick/brief，raw pool 的 rejected/unreviewed 不得补位", () => {
    const good = buildNormalizedItem(
      "reddit-ai",
      "community",
      "vLLM 量化实践复盘",
      "https://reddit.com/r/good",
      null,
      "工程讨论",
    )
    const help = buildNormalizedItem(
      "v2ex-hot",
      "community",
      "奔三了很迷茫，AI 创业该怎么办",
      "https://v2ex.com/t/help",
      null,
      "个人求助",
    )
    const unreviewed = buildNormalizedItem(
      "digg-ai",
      "community",
      "UNREVIEWED AI 热议",
      "https://digg.com/unreviewed",
      null,
      "未审核",
    )
    const publication: DigestPublicationV2 = {
      schemaVersion: 2,
      businessDate: "2026-07-12",
      overview: [],
      sections: [{ category: "community", entries: [{ itemId: good.id, role: "brief" }] }],
    }
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [{ category: "community", picks: [], briefItemIds: [good.id] }],
        degraded: false,
      },
      publication,
      items: [good, help, unreviewed],
      results: [],
    })

    assert.ok(out.markdown.includes(good.title))
    assert.ok(!out.markdown.includes(help.title))
    assert.ok(!out.markdown.includes(unreviewed.title))
    assert.deepEqual(out.displayedItemIds, [good.id])
  })

  it("未进入 publication 的 GitHub/podcast 即使传给旧直渲参数也不得回流", () => {
    const ai = buildNormalizedItem(
      "openai-news",
      "ai",
      "OpenAI 模型发布",
      "https://openai.com/release",
      null,
      "release",
    )
    const github = buildNormalizedItem(
      "github-trending-daily",
      "github",
      "iptv-org/iptv",
      "https://github.com/iptv-org/iptv",
      null,
      "★ +1000 · 100000 total · TypeScript\nIPTV channels",
    )
    const podcast = buildNormalizedItem(
      "podcast-random",
      "podcast",
      "与 AI 无关的闲聊",
      "https://example.com/podcast",
      null,
      "闲聊要点",
    )
    const publication: DigestPublicationV2 = {
      schemaVersion: 2,
      businessDate: "2026-07-12",
      overview: [],
      sections: [
        {
          category: "ai",
          entries: [{ itemId: ai.id, role: "hero", summaryZh: "模型正式发布" }],
        },
      ],
    }
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [{ category: "ai", picks: [{ itemId: ai.id, summaryZh: "模型正式发布" }] }],
        degraded: false,
      },
      publication,
      items: [ai],
      githubItems: [github],
      podcastItems: [podcast],
      results: [],
    })

    assert.ok(out.markdown.includes(ai.title))
    assert.ok(!out.markdown.includes(github.title))
    assert.ok(!out.markdown.includes(podcast.title))
    assert.deepEqual(out.displayedItemIds, [ai.id])
  })

  it("v2 supporting source 保留同报徽章与 lookup；displayed/shown 只记录真实展示事件", () => {
    const primary = buildNormalizedItem(
      "openai-news",
      "ai",
      "OpenAI 推理优化发布",
      "https://openai.com/inference",
      null,
      "release",
    )
    const alternate = buildNormalizedItem(
      "hn-ai",
      "ai",
      "HN 讨论同一推理优化",
      "https://news.ycombinator.com/item?id=1",
      null,
      "discussion",
    )
    const publication: DigestPublicationV2 = {
      schemaVersion: 2,
      businessDate: "2026-07-12",
      overview: [],
      sections: [
        {
          category: "ai",
          entries: [
            {
              itemId: primary.id,
              role: "hero",
              summaryZh: "推理吞吐获得提升",
              displayTag: "推理",
              alsoItemIds: [alternate.id],
            },
          ],
        },
      ],
    }

    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: { overview: [], sections: [], degraded: false },
      publication,
      items: [primary, alternate],
      results: [],
    })

    assert.ok(out.html.includes("2 源同报"))
    assert.ok(out.markdown.includes("2 源同报"))
    assert.deepEqual(new Set(out.displayedItemIds), new Set([primary.id, alternate.id]))
  })
})

describe("rest-only section（07-12 德彪 jtw-r1 P1：picks 摘空后整类蒸发+shown 已烧=永久漏报）", () => {
  it("section picks 为空但类目有速览候选 → 保留板块只渲染速览行（标题可见 + restItemIds 进账）", () => {
    const ytOnly = buildNormalizedItem(
      "yt-anthropic",
      "ai",
      "Interpreting AI inner thoughts",
      "https://www.youtube.com/watch?v=aaa",
      null,
      "video",
    )
    const out = renderDigest({
      businessDate: "2026-07-12",
      // ai 板块唯一 pick 被摘除门摘空的形态
      summary: { overview: ["o"], sections: [{ category: "ai", picks: [] }], degraded: false },
      items: [ytOnly],
      results: [],
    })
    assert.ok(out.markdown.includes(ytOnly.title), "摘空板块的条目必须以速览行存活")
    assert.ok(out.restItemIds.includes(ytOnly.id), "速览账必须记到（翻译/shown 依赖）")
  })

  it("速览容量 0（用户关速览/超预算自动降 0）→ rest-only 不保留，无空板块壳（jtw-r2 P2-1 红探针场景）", () => {
    const ytOnly = buildNormalizedItem(
      "yt-anthropic",
      "ai",
      "Interpreting AI inner thoughts",
      "https://www.youtube.com/watch?v=aaa",
      null,
      "video",
    )
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: { overview: [], sections: [{ category: "ai", picks: [] }], degraded: false },
      items: [ytOnly],
      results: [],
      restOverviewRows: 0,
    })
    assert.ok(!out.markdown.includes(ytOnly.title), "容量 0 渲染不出任何速览行")
    assert.equal(out.restItemIds.length, 0)
    assert.ok(!out.html.includes("其余速览"), "不得留下计数 0 的板块空壳")
  })

  it("摘空类目的唯一候选被其它板块 alsoItemIds 占用 → 不保留（jtw-r3：候选谓词必须含 usedIds）", () => {
    const ytOnly = buildNormalizedItem(
      "yt-anthropic",
      "ai",
      "Interpreting AI inner thoughts",
      "https://www.youtube.com/watch?v=aaa",
      null,
      "video",
    )
    const hotItem = buildNormalizedItem(
      "zhihu-hot",
      "hot",
      "热点标题一条",
      "https://www.zhihu.com/question/9",
      null,
      "desc",
    )
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [
          { category: "ai", picks: [] },
          {
            category: "hot",
            // 跨板块 alsoItemIds 把 ai 类目唯一候选占进 usedIds
            picks: [{ itemId: hotItem.id, summaryZh: "热点摘要", alsoItemIds: [ytOnly.id] }],
          },
        ],
        degraded: false,
      },
      items: [ytOnly, hotItem],
      results: [],
    })
    assert.ok(!out.restItemIds.includes(ytOnly.id), "被占用条目不得再进速览账")
    assert.ok(!out.markdown.includes(ytOnly.title), "ai 类目无真实候选，不得以空壳板块形态保留")
    // 空壳的真实表征（德彪 jtw-r3 探针：hasSection=true 而 restItemIds=[]）——板块头不得出现
    assert.ok(!out.markdown.includes("## AI"), "ai 板块头不得以空壳形态渲染")
  })

  it("section picks 空且类目速览候选也空（只剩简报源）→ 板块跳过不渲染空壳", () => {
    const briefing = buildNormalizedItem(
      "smol-ai",
      "ai",
      "not much happened today",
      "https://news.smol.ai/i/9",
      null,
      "briefing",
    )
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: { overview: [], sections: [{ category: "ai", picks: [] }], degraded: false },
      items: [briefing],
      results: [],
    })
    // 简报源不进速览（BRIEFING_SOURCE_IDS 既有语义）→ 该板块无任何可渲染内容 → 跳过
    assert.ok(!out.markdown.includes(briefing.title), "简报源不得以速览行形态出现")
    assert.equal(out.restItemIds.length, 0, "无速览候选时 rest 账必须为空（板块空壳不渲染）")
  })
})

describe("communityDropIds 速览反选（07-12 小孙：社区要研究/讨论/进展，求助/八卦滤掉）", () => {
  const mkComm = (src: string, title: string, url: string) =>
    buildNormalizedItem(src, "community", title, url, null, "s", 49)

  it("被反选的 community 条目从速览行移除；未反选的照常存活", () => {
    const noise = mkComm("v2ex-hot", "专科大二想听听建议", "https://v2ex.com/t/1")
    const good = mkComm("reddit-ai", "Scaling laws deep dive", "https://reddit.com/r/2")
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: ["o"],
        sections: [{ category: "community", picks: [] }],
        communityDropIds: [noise.id],
        degraded: false,
      },
      items: [noise, good],
      results: [],
    })
    assert.ok(!out.markdown.includes(noise.title), "被反选条目不得出现在速览行")
    assert.ok(!out.restItemIds.includes(noise.id), "被反选条目不得进速览账")
    assert.ok(out.markdown.includes(good.title), "未反选条目照常存活")
    assert.ok(out.restItemIds.includes(good.id))
  })

  it("唯一候选被反选 → community 节不保留（保留门谓词与 restAll 同式，无空壳）", () => {
    const noise = mkComm("v2ex-hot", "两个 offer 怎么选", "https://v2ex.com/t/3")
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [{ category: "community", picks: [] }],
        communityDropIds: [noise.id],
        degraded: false,
      },
      items: [noise],
      results: [],
    })
    assert.equal(out.restItemIds.length, 0)
    assert.ok(!out.markdown.includes("## 社区动态"), "全员被反选的板块不得以空壳保留")
  })

  it("category 双保险：LLM 误吐非 community 条目 id → 该板块速览不受影响", () => {
    const aiItem = buildNormalizedItem(
      "hn-ai",
      "ai",
      "GPU 融资循环深度分析",
      "https://a.com/gpu",
      null,
      "s",
    )
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [{ category: "ai", picks: [] }],
        communityDropIds: [aiItem.id], // 越界反选：指向 ai 板块条目
        degraded: false,
      },
      items: [aiItem],
      results: [],
    })
    assert.ok(out.markdown.includes(aiItem.title), "非 community 条目不受反选影响")
    assert.ok(out.restItemIds.includes(aiItem.id))
  })

  it("同一条被 pick 又被 drop → 精选照常展示（反选只管未选残余）", () => {
    const picked = mkComm("reddit-ai", "MoE 架构社区实测", "https://reddit.com/r/4")
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [
          { category: "community", picks: [{ itemId: picked.id, summaryZh: "实测摘要" }] },
        ],
        communityDropIds: [picked.id],
        degraded: false,
      },
      items: [picked],
      results: [],
    })
    assert.ok(out.markdown.includes("实测摘要"), "picks 渲染不经过反选集")
  })

  it("审查集合闭合（德彪 hitrate-r1 P1）：LLM 视野外的 community 条目不得补位进速览", () => {
    // 复现形态：喂样上限外的第 37+ 条（fed 不含）——反选管不到它，必须整体拦下
    const fedGood = mkComm("reddit-ai", "Sparse attention 实测讨论", "https://reddit.com/r/f1")
    const fedNoise = mkComm("v2ex-hot", "该不该转行搞 AI", "https://v2ex.com/t/f2")
    const unreviewed = mkComm("digg-ai", "UNREVIEWED_GOSSIP 名人八卦", "https://digg.com/u1")
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [{ category: "community", picks: [] }],
        communityFedIds: [fedGood.id, fedNoise.id], // unreviewed 在视野外
        communityDropIds: [fedNoise.id],
        degraded: false,
      },
      items: [fedGood, fedNoise, unreviewed],
      results: [],
    })
    assert.ok(out.restItemIds.includes(fedGood.id), "审查过且未反选 → 存活")
    assert.ok(!out.restItemIds.includes(fedNoise.id), "审查过且反选 → 移除")
    assert.ok(!out.restItemIds.includes(unreviewed.id), "未审条目不得补位（视野=候选闭合）")
    assert.ok(!out.markdown.includes("UNREVIEWED_GOSSIP"))
    // ai/hot 板块不受 fed 集合约束（fed 只约束 community）
    const aiItem = buildNormalizedItem(
      "hn-ai",
      "ai",
      "推理框架发布",
      "https://a.com/ai1",
      null,
      "s",
    )
    const out2 = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [{ category: "ai", picks: [] }],
        communityFedIds: ["some-community-id"],
        degraded: false,
      },
      items: [aiItem],
      results: [],
    })
    assert.ok(out2.restItemIds.includes(aiItem.id), "fed 集合不得约束非 community 板块")
  })

  it("communityFedIds 缺失（老 summary/降级链）→ fail-open 不限制（速览照旧全量）", () => {
    const a = mkComm("reddit-ai", "常规社区条目甲", "https://reddit.com/r/a")
    const b = mkComm("v2ex-hot", "常规社区条目乙", "https://v2ex.com/t/b")
    const out = renderDigest({
      businessDate: "2026-07-12",
      summary: {
        overview: [],
        sections: [{ category: "community", picks: [] }],
        degraded: false,
      },
      items: [a, b],
      results: [],
    })
    assert.ok(out.restItemIds.includes(a.id))
    assert.ok(out.restItemIds.includes(b.id))
  })
})

describe("renderDigest（AC2 版式 + AC12 邮件兼容）", () => {
  it("无脚本/无远程图片/table ≤600px/含 color-scheme", () => {
    const { html } = render()
    assert.ok(!html.toLowerCase().includes("<script"))
    assert.ok(!/<img[^>]+src="http/i.test(html))
    assert.ok(html.includes("max-width:600px"))
    assert.ok(html.includes('name="color-scheme"'))
  })

  it("链接严格等于 canonicalUrl（escape 后），标题被转义", () => {
    const { html } = render()
    assert.ok(html.includes(`href="${escapeHtml(items[0].canonicalUrl)}"`))
    assert.ok(html.includes("vLLM &lt;b&gt;提速&lt;/b&gt; &amp; &quot;引号&quot;"))
    assert.ok(!html.includes("<b>提速</b>"))
  })

  it("版式：速览在前 → 板块 → 页脚源健康（失败源明示）", () => {
    const { html } = render()
    const iOverview = html.indexOf("今日速览")
    const iAi = html.indexOf("AI · 人工智能")
    const iFooter = html.indexOf("源健康")
    assert.ok(iOverview > 0 && iAi > iOverview && iFooter > iAi)
    assert.ok(html.includes("hltv(failed)"))
  })

  it("subject 含日期；degraded 加清单版标记 + 提示", () => {
    assert.equal(render().subject, "📰 DailyBrief 2026-07-03")
    const d = renderDigest({
      businessDate: "2026-07-03",
      summary: { ...summary, overview: [], degraded: true },
      items,
      results,
    })
    assert.ok(d.subject.includes("清单版"))
    assert.ok(d.html.includes("清单版"))
  })

  it("markdown 版含链接与源健康", () => {
    const { markdown } = render()
    assert.ok(markdown.includes("[vLLM"))
    assert.ok(markdown.includes("https://a.com/1?x=1&y=2"))
    assert.ok(markdown.includes("源健康"))
  })

  it("githubItems 直接渲染成周榜 section", () => {
    const gh = buildNormalizedItem(
      "github-trending-weekly",
      "github",
      "owner/repo",
      "https://github.com/owner/repo",
      null,
      "+6,989 stars this week · ★8,695 · Python · desc",
    )
    const { html } = renderDigest({
      businessDate: "2026-07-06",
      summary,
      items,
      results,
      githubItems: [gh],
    })
    assert.ok(html.includes("开源榜单"))
    assert.ok(html.includes("◆ 周榜"))
    assert.ok(html.includes("▲ 6,989 本周"))
    assert.ok(html.includes("★8,695"))
    assert.ok(html.includes("Python"))
  })

  it("增长榜/新秀榜状态追加在原数据行；周榜/月榜即使带脏状态也不展示", () => {
    const dailyBase = buildNormalizedItem(
      "github-trending-daily",
      "github",
      "Panniantong/Agent-Reach",
      "https://github.com/Panniantong/Agent-Reach",
      null,
      "+860 stars today · ★12,000 · TypeScript · AI agent search",
    )
    const daily = {
      ...dailyBase,
      githubMeta: {
        repo: "Panniantong/Agent-Reach",
        period: "daily" as const,
        windowStars: 860,
        totalStars: 12_000,
        language: "TypeScript",
        description: "AI agent search",
        evidence: {
          topics: [],
          metadataStatus: "not_requested" as const,
          readmeStatus: "not_requested" as const,
          evidenceComplete: false,
        },
        eligibility: { state: "yes" as const, confidence: 0.98, reasons: ["AI 核心用途"] },
        rankStatus: { kind: "streak" as const, days: 3 },
      },
    }
    const weeklyBase = buildNormalizedItem(
      "github-trending-weekly",
      "github",
      "owner/weekly-ai",
      "https://github.com/owner/weekly-ai",
      null,
      "+2,000 stars this week · ★20,000 · Rust · AI inference runtime",
    )
    const weekly = {
      ...weeklyBase,
      githubMeta: {
        repo: "owner/weekly-ai",
        period: "weekly" as const,
        windowStars: 2_000,
        totalStars: 20_000,
        language: "Rust",
        description: "AI inference runtime",
        evidence: {
          topics: [],
          metadataStatus: "not_requested" as const,
          readmeStatus: "not_requested" as const,
          evidenceComplete: false,
        },
        eligibility: { state: "yes" as const, confidence: 0.98, reasons: ["AI 核心用途"] },
        rankStatus: { kind: "new" as const },
      },
    }

    const { html, markdown } = renderDigest({
      businessDate: "2026-07-13",
      summary,
      items,
      results,
      githubItems: [daily, weekly],
    })
    assert.ok(html.includes("连续 3 日上榜"))
    assert.ok(markdown.includes("连续 3 日上榜"))
    assert.ok(!html.includes(">NEW<"), "周榜不应消费跨日状态")
  })

  it("GitHub 月榜条目 → 板块标题自适应 + 本月数据行（#27）", () => {
    const ghM = buildNormalizedItem(
      "github-trending-monthly",
      "github",
      "owner/mrepo",
      "https://github.com/owner/mrepo",
      null,
      "+12,345 stars this month · ★40,000 · Rust · monthly desc",
    )
    const monthlyOnly = renderDigest({
      businessDate: "2026-08-01",
      summary,
      items,
      results,
      githubItems: [ghM],
    })
    assert.ok(monthlyOnly.html.includes("开源榜单"))
    assert.ok(monthlyOnly.html.includes("▲ 12,345 本月"))
    const ghW = buildNormalizedItem(
      "github-trending-weekly",
      "github",
      "owner/wrepo",
      "https://github.com/owner/wrepo",
      null,
      "+6,989 stars this week · ★8,695 · Python · weekly desc",
    )
    const both = renderDigest({
      businessDate: "2026-06-01",
      summary,
      items,
      results,
      githubItems: [ghW, ghM],
    })
    // 总名固定为「开源榜单」，榜种仍各自一张原名列表卡。
    assert.ok(both.html.includes("AI · 社区动态 · 今日热点 · 开源榜单"))
    assert.ok(!both.html.includes("GitHub 榜单"))
    assert.match(both.markdown, /^## 开源榜单$/m)
    assert.doesNotMatch(both.markdown, /^## GitHub 榜单$/m)
    assert.ok(both.html.includes("◆ 周榜 · 1"))
    assert.ok(both.html.includes("◆ 月榜 · 1"))
    assert.ok(both.html.includes("▲ 6,989 本周"))
    assert.ok(both.html.includes("▲ 12,345 本月"))
    // 周榜卡在月榜卡之前（GH_KIND_ORDER）
    assert.ok(both.html.indexOf("◆ 周榜") < both.html.indexOf("◆ 月榜"))
  })

  it("正文源名走中文 label，不露内部 sourceId", () => {
    const { html } = render()
    assert.ok(html.includes("smol.ai 日报"))
    assert.ok(html.includes("知乎热榜"))
    assert.ok(!html.includes(">smol-ai<"))
  })

  it("深读覆盖 + N 源同报徽章 + 同报 id 全局去重（质量层 2/3）", () => {
    const extra = buildNormalizedItem(
      "hn-ai",
      "ai",
      "HN 讨论同一事件",
      "https://hn.com/x",
      null,
      "s",
    )
    const sum: DigestSummary = {
      overview: ["要点"],
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: items[0].id, summaryZh: "深读前摘要", alsoItemIds: [extra.id] },
            { itemId: extra.id, summaryZh: "重复主条应被抑制" },
          ],
        },
        { category: "hot", picks: [{ itemId: items[1].id, summaryZh: "热点摘要" }] },
      ],
      deepReads: [{ itemId: items[0].id, titleZh: "深读重写标题", summaryZh: "深读三句提炼。" }],
      degraded: false,
    }
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [...items, extra],
      results,
    })
    assert.ok(html.includes("深读重写标题")) // titleZh 覆盖展示标题
    assert.ok(html.includes("深读三句提炼"))
    assert.ok(html.includes("2 源同报"))
    assert.ok(html.includes("Hacker News")) // 同报来源名
    assert.ok(!html.includes("重复主条应被抑制")) // extra 已作同报出现 → 主条被抑制
    assert.ok(html.includes(`href="${escapeHtml(items[0].canonicalUrl)}"`)) // 链接仍走 canonicalUrl
    assert.ok(markdown.includes("2 源同报"))
    assert.ok(markdown.includes("深读重写标题"))
  })

  it("体检行（质量层 4）：扫描/收录/精选计数进刊头与 markdown", () => {
    const { html, markdown } = render()
    // results 2 源 1 失败 → 1/2；items 2 条；picks ai1+hot1 → 精选 2
    assert.ok(html.includes("本期扫描 1/2 源 · 收录 2 条 · 精选 2 条"))
    assert.ok(markdown.includes("本期扫描 1/2 源"))
  })

  it("日期行带星期", () => {
    const { html } = render()
    assert.ok(/2026-07-03[^<]*星期五/.test(html))
  })

  it("信源异常提醒卡顶置（B 项）：失败源中文名 + X 源 cookie 排障提示，位于速览之前", () => {
    const failedResults: SourceFetchResult[] = [
      ...results,
      {
        sourceId: "x-firsthand",
        status: "failed",
        items: [],
        errors: ["x-firsthand(rsshub-twitter): 0 tweets fetched（凭证失效/路由未开/字段变更？）"],
        attempts: 1,
        fetchedAt: "t",
        durationMs: 1,
      },
    ]
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary,
      items,
      results: failedResults,
    })
    assert.ok(html.includes("信源异常"))
    assert.ok(html.includes("X 一手动态"))
    assert.ok(html.includes("auth_token")) // cookie 排障提示
    assert.ok(html.indexOf("信源异常") < html.indexOf("今日速览"))
    assert.ok(markdown.includes("信源异常"))
  })

  it("全部源正常 → 无信源异常提醒卡", () => {
    const okResults = results.map((r) => ({ ...r, status: "ok" as const, errors: [] }))
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary,
      items,
      results: okResults,
    })
    assert.ok(!html.includes("信源异常"))
    assert.ok(!markdown.includes("信源异常"))
  })

  it("notes 出现在页脚（非交易日提示）", () => {
    const { html } = renderDigest({
      businessDate: "2026-07-04",
      summary,
      items,
      results,
      notes: ["今日非 A 股交易日"],
    })
    assert.ok(html.includes("今日非 A 股交易日"))
  })
})

describe("分栏改版（小孙 07-05 #1-#5）", () => {
  const mk = (src: string, cat: "ai" | "hot" | "community", title: string, url: string) =>
    buildNormalizedItem(src, cat, title, url, "2026-07-03T00:00:00Z", "s")

  it("ai 子栏：tag 分组 + 固定顺序（推理最前）+ 计数 + md 三级标题", () => {
    const hero = mk("smol-ai", "ai", "焦点条目", "https://a.com/h")
    const a1 = mk("hn-ai", "ai", "推理条目一", "https://a.com/i1")
    const a2 = mk("vllm-blog", "ai", "推理条目二", "https://a.com/i2")
    const a3 = mk("openai-news", "ai", "OpenAI 条目", "https://a.com/o1")
    const a4 = mk("hf-blog", "ai", "开源条目", "https://a.com/s1")
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: hero.id, summaryZh: "焦点摘要" },
            { itemId: a3.id, summaryZh: "摘要三", tag: "OpenAI" },
            { itemId: a1.id, summaryZh: "摘要一", tag: "推理" },
            { itemId: a2.id, summaryZh: "摘要二", tag: "推理" },
            { itemId: a4.id, summaryZh: "摘要四", tag: "开源" },
          ],
        },
      ],
    }
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, a1, a2, a3, a4],
      results,
    })
    assert.ok(html.includes("推理 · 2 条"))
    assert.ok(html.includes("OpenAI · 1 条"))
    assert.ok(html.includes("开源 · 1 条"))
    // 顺序：推理 < OpenAI < 开源（section-tags 固定序，与 LLM 输出顺序无关）
    assert.ok(html.indexOf("推理 · 2 条") < html.indexOf("OpenAI · 1 条"))
    assert.ok(html.indexOf("OpenAI · 1 条") < html.indexOf("开源 · 1 条"))
    assert.ok(markdown.includes("### 推理"))
    assert.ok(markdown.includes("### OpenAI"))
  })

  it("单组不出子标题（未打标/清单版回落旧版扁平观感）", () => {
    const hero = mk("smol-ai", "ai", "焦点", "https://b.com/h")
    const a1 = mk("hn-ai", "ai", "条目一", "https://b.com/1")
    const a2 = mk("hn-ai", "ai", "条目二", "https://b.com/2")
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: hero.id, summaryZh: "s" },
            { itemId: a1.id, summaryZh: "s1" },
            { itemId: a2.id, summaryZh: "s2" },
          ],
        },
      ],
    }
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, a1, a2],
      results,
    })
    assert.ok(!html.includes("其他 · 2 条"))
  })

  it("X 子栏：topicTag 结构分区（公司/从业者/更多动态）", () => {
    const hero = mk("x-firsthand", "community", "@sama: 焦点动态", "https://x.com/s/1")
    const org = {
      ...mk("x-firsthand", "community", "@OpenAI: 发布", "https://x.com/o/2"),
      topicTag: "公司",
    }
    const person = {
      ...mk("x-firsthand", "community", "@karpathy: 洞见", "https://x.com/k/3"),
      topicTag: "从业者",
    }
    const unknown = mk("x-firsthand", "community", "@newguy: 新人", "https://x.com/n/4")
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "community",
          picks: [
            { itemId: hero.id, summaryZh: "焦点" },
            { itemId: org.id, summaryZh: "s" },
            { itemId: person.id, summaryZh: "s" },
            { itemId: unknown.id, summaryZh: "s" },
          ],
        },
      ],
    }
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, org, person, unknown],
      results,
    })
    assert.ok(html.includes("科技公司 · 1 条"))
    assert.ok(html.includes("科技从业者 · 1 条"))
    assert.ok(html.includes("更多动态 · 1 条"))
    assert.ok(html.indexOf("科技公司 · 1 条") < html.indexOf("科技从业者 · 1 条"))
  })

  it("排版均衡：双列窄卡摘要 clamp 80；奇数组最长条整宽先行", () => {
    const hero = mk("smol-ai", "ai", "焦点", "https://c.com/h")
    const long = mk("hn-ai", "ai", "长文条目", "https://c.com/long")
    const s1 = mk("hn-ai", "ai", "短条目一", "https://c.com/s1")
    const s2 = mk("hn-ai", "ai", "短条目二", "https://c.com/s2")
    const longSummary = "这条摘要非常长，".repeat(20) // 160 字符
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: hero.id, summaryZh: "焦点" },
            { itemId: s1.id, summaryZh: "短摘要一", tag: "推理" },
            { itemId: long.id, summaryZh: longSummary, tag: "推理" },
            { itemId: s2.id, summaryZh: "短摘要二", tag: "推理" },
          ],
        },
      ],
    }
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, long, s1, s2],
      results,
    })
    // 最长条被提为整宽卡（不落单、不撑歪双列），出现在两短条之前
    assert.ok(html.indexOf("长文条目") < html.indexOf("短条目一"))
    // 整宽卡不截断（全文保留）
    assert.ok(html.includes(longSummary))
    // 双列窄卡若带长摘要则会截断出省略号 —— 此处两短卡摘要不足 80 不受影响
    assert.ok(html.includes("短摘要一"))
    assert.ok(html.includes("短摘要二"))
  })

  it("双列窄卡长摘要截 80 出省略号", () => {
    const hero = mk("smol-ai", "ai", "焦点", "https://d.com/h")
    const l1 = mk("hn-ai", "ai", "窄卡一", "https://d.com/1")
    const l2 = mk("hn-ai", "ai", "窄卡二", "https://d.com/2")
    const long1 = "甲".repeat(120)
    const long2 = "乙".repeat(121)
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: hero.id, summaryZh: "焦点" },
            { itemId: l1.id, summaryZh: long1, tag: "推理" },
            { itemId: l2.id, summaryZh: long2, tag: "推理" },
          ],
        },
      ],
    }
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, l1, l2],
      results,
    })
    assert.ok(html.includes(`${"甲".repeat(79)}…`))
    assert.ok(!html.includes("甲".repeat(120)))
  })

  it("webBaseUrl 配置 → 刊头/页脚/markdown 带网页版链接；未配置不出", () => {
    const withWeb = renderDigest({
      businessDate: "2026-07-03",
      summary,
      items,
      results,
      webBaseUrl: "http://localhost:3000/",
    })
    assert.ok(withWeb.html.includes("网页版全量分栏"))
    assert.ok(withWeb.html.includes('href="http://localhost:3000/digest/2026-07-03"'))
    assert.ok(withWeb.markdown.includes("网页版：http://localhost:3000/digest/2026-07-03"))
    const without = render()
    assert.ok(!without.html.includes("网页版全量分栏"))
  })

  it("其余速览（邮件自足）：未精选条目压紧凑行区，12 行帽 + 已选排除 + 回目录", () => {
    const hero = mk("smol-ai", "ai", "焦点", "https://r.com/h")
    const picked = mk("hn-ai", "ai", "被选条目", "https://r.com/p")
    const extras = Array.from({ length: 14 }, (_, i) =>
      mk("hn-ai", "ai", `未选条目${i}`, `https://r.com/e${i}`),
    )
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: hero.id, summaryZh: "s" },
            { itemId: picked.id, summaryZh: "s" },
          ],
        },
      ],
    }
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, picked, ...extras],
      results,
    })
    assert.ok(html.includes("◇ 其余速览 · TOP 12 / 共 14 条"))
    assert.equal((html.match(/未选条目/g) ?? []).length, 12) // 14 条帽到 12
    assert.ok(!html.includes("未选条目13"))
    assert.ok(html.includes('href="#top"')) // 每节尾回目录
    assert.ok(html.includes('name="top"')) // 刊头锚点
    assert.ok(markdown.includes("### 其余速览（共 14 条）"))
    assert.ok(markdown.includes("未选条目0"))
  })

  it("邮件密度（设置页）：restOverviewRows 调帽，0 = 整区关掉", () => {
    const hero = mk("smol-ai", "ai", "焦点", "https://d.com/h")
    const extras = Array.from({ length: 6 }, (_, i) =>
      mk("hn-ai", "ai", `未选条目${i}`, `https://d.com/e${i}`),
    )
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [{ category: "ai", picks: [{ itemId: hero.id, summaryZh: "s" }] }],
    }
    const dense = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, ...extras],
      results,
      restOverviewRows: 2,
    })
    assert.ok(dense.html.includes("◇ 其余速览 · TOP 2 / 共 6 条"))
    assert.equal((dense.html.match(/未选条目/g) ?? []).length, 2)
    const off = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, ...extras],
      results,
      restOverviewRows: 0,
    })
    assert.ok(!off.html.includes("其余速览"))
    assert.ok(!off.markdown.includes("其余速览"))
  })

  it("导览子栏目录：≥2 组板块出锚点链接行，子栏标题带同名锚点", () => {
    const hero = mk("smol-ai", "ai", "焦点条目", "https://n.com/h")
    const a1 = mk("hn-ai", "ai", "推理条目", "https://n.com/1")
    const a2 = mk("openai-news", "ai", "OpenAI 条目", "https://n.com/2")
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: hero.id, summaryZh: "s" },
            { itemId: a1.id, summaryZh: "s", tag: "推理" },
            { itemId: a2.id, summaryZh: "s", tag: "OpenAI" },
          ],
        },
      ],
    }
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, a1, a2],
      results,
    })
    assert.ok(html.includes('name="sub-ai-0"')) // 子栏锚点
    assert.ok(html.includes('href="#sub-ai-0"')) // 导览目录链接
    assert.ok(html.includes('href="#sub-ai-1"'))
    // 目录行文案：板块名 + 子栏名 + 计数
    assert.ok(/AI 前沿<\/td>[\s\S]*?推理&nbsp;1/.test(html))
  })

  it("GitHub 增长榜（日）：榜单卡 + ▲ N 今日 + 每种榜限量（日榜 6）", () => {
    const ghd = Array.from({ length: 8 }, (_, i) =>
      buildNormalizedItem(
        "github-trending-daily",
        "github",
        `owner/daily-${i}`,
        `https://github.com/owner/daily-${i}`,
        null,
        `+${320 - i} stars today · ★9,000 · Go · daily desc ${i}`,
      ),
    )
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary,
      items,
      results,
      githubItems: ghd,
    })
    assert.ok(html.includes("开源榜单"))
    assert.ok(html.includes("◆ 增长榜 · 今日"))
    assert.ok(html.includes("◆ 增长榜 · 今日 · 6")) // cap 6
    assert.ok(html.includes("▲ 320 今日"))
    assert.ok(html.includes("owner/daily-5"))
    assert.ok(!html.includes("owner/daily-6")) // 第 7 条被限量截走
  })
})

describe("中文化补全（07-06 小孙：github 英文介绍 / 速览标题）+ 速览治理", () => {
  it("mdLink：text 方括号转义 + URL 圆括号百分号编码（markdown 结构注入面）", () => {
    const out = mdLink("标题[x] 前缀](破坏", "https://a.com/p(1)")
    assert.ok(out.endsWith("(https://a.com/p%281%29)"))
    assert.ok(out.includes("\\[x\\]"))
    assert.ok(!out.includes("[x]"))
  })

  it("mdLink：反斜杠先行转义 + 非 http(s) URL 落 #（德彪 r-final P1-1 md 面链接注入）", () => {
    // 攻击串：title 自带 `\]`——旧实现只转义方括号，产出「字面反斜杠+未转义 ]」，
    // 链接文本被提前闭合，title 里的括号段被 markdown 解析成链接目标（钓鱼注入）
    const legit = "https://legit.example/"
    const out = mdLink("evil\\](https://attacker.example/pwn", legit)
    assert.ok(out.endsWith(`](${legit})`), "链接目标必须是 canonicalUrl")
    const text = out.slice(1, out.length - `](${legit})`.length)
    const unescaped = text.replace(/\\[\\[\]]/g, "")
    assert.ok(
      !unescaped.includes("]") && !unescaped.includes("["),
      "文本区方括号必须全部处于转义态（不可提前闭合）",
    )
    assert.equal(mdLink("t", "javascript:alert(1)"), "[t](#)", "md 面与 safeHref 同 scheme 门")
    assert.equal(mdLink("t", "ftp://a.com/x"), "[t](#)")
  })

  it("githubDescZh 含 · 分隔符/语言样片段也不污染 meta（结构化传递不回拼 parser）", () => {
    const gh = buildNormalizedItem(
      "github-trending-daily",
      "github",
      "org/tricky",
      "https://github.com/org/tricky",
      null,
      "+1,234 stars today · ★10,000 · Python · An English description",
    )
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [],
      githubDescZh: { [gh.id]: "Go · 一个刁钻的中文描述" },
    }
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [],
      results: [],
      githubItems: [gh],
    })
    assert.ok(html.includes("▲ 1,234 今日　★10,000　Python"))
    assert.ok(html.includes("Go · 一个刁钻的中文描述"))
    assert.ok(!html.includes("An English description"))
    assert.ok(markdown.includes("Go · 一个刁钻的中文描述"))
  })

  it("githubDescZh：榜单卡英文 desc 换中文，meta 数据行保留", () => {
    const gh = buildNormalizedItem(
      "github-trending-daily",
      "github",
      "org/repo",
      "https://github.com/org/repo",
      null,
      "+1,234 stars today · ★10,000 · Python · An English description of repo",
    )
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [],
      githubDescZh: { [gh.id]: "一个英文仓库的中文描述" },
    }
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [],
      results: [],
      githubItems: [gh],
    })
    assert.ok(html.includes("一个英文仓库的中文描述"))
    assert.ok(!html.includes("An English description"))
    assert.ok(html.includes("▲ 1,234 今日"))
  })

  it("其余速览：restTitleZh 换中文标题；smol-ai 简报型未精选不进速览；restItemIds 回传", () => {
    const picked = buildNormalizedItem("hn-ai", "ai", "Picked story", "https://a.com/p", null, "s")
    const restEn = buildNormalizedItem(
      "hn-ai",
      "ai",
      "Second English story",
      "https://a.com/r",
      null,
      "s",
    )
    const brief = buildNormalizedItem(
      "smol-ai",
      "ai",
      "not much happened today",
      "https://news.smol.ai/x",
      null,
      "s",
    )
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [{ category: "ai", picks: [{ itemId: picked.id, summaryZh: "s" }] }],
      restTitleZh: { [restEn.id]: "第二条的中文标题" },
    }
    const r = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [picked, restEn, brief],
      results: [],
    })
    assert.ok(r.html.includes("第二条的中文标题"))
    assert.ok(!r.html.includes("Second English story"))
    assert.ok(!r.html.includes("not much happened today"))
    assert.deepEqual(r.restItemIds, [restEn.id])
    assert.ok(r.markdown.includes("第二条的中文标题"))
  })

  it("社区板块平台子栏：Reddit/V2EX 平台组与 X 结构组同场（07-06 改版）", () => {
    const hero = buildNormalizedItem(
      "x-firsthand",
      "community",
      "@sama: hi",
      "https://x.com/1",
      null,
      "s",
    )
    const reddit = buildNormalizedItem(
      "reddit-ai",
      "community",
      "LocalLLaMA 热帖",
      "https://reddit.com/1",
      null,
      "s",
    )
    const v2ex = buildNormalizedItem(
      "v2ex-hot",
      "community",
      "V2EX 热议帖",
      "https://v2ex.com/t/1",
      null,
      "s",
    )
    const sum: DigestSummary = {
      overview: [],
      degraded: false,
      sections: [
        {
          category: "community",
          picks: [hero, reddit, v2ex].map((i) => ({ itemId: i.id, summaryZh: "s" })),
        },
      ],
    }
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary: sum,
      items: [hero, reddit, v2ex],
      results: [],
    })
    assert.ok(html.includes("社区动态"))
    assert.ok(html.includes("COMMUNITY PULSE"))
    assert.ok(html.includes("Reddit · 1 条"))
    assert.ok(html.includes("V2EX · 1 条"))
    assert.ok(html.indexOf("Reddit · 1 条") < html.indexOf("V2EX · 1 条"))
    assert.ok(markdown.includes("### Reddit"))
  })
})

describe("mdLink 控制字符折叠（德彪 DE-r2 P2：外部源 title/url 无 sanitize 闸）", () => {
  it("title 换行折叠成空格、url 控制字符剥除+空格编码 —— md 列表行结构不被打断", () => {
    const title = "前半\n后半"
    const url = "https://a.com/pa th\nx"
    const out = mdLink(title, url)
    assert.equal(out.includes(String.fromCharCode(10)), false, "输出不得含换行")
    assert.ok(out.startsWith("[前半 后半]("))
    assert.ok(out.includes("https://a.com/pa%20thx"))
  })
})

describe("#33 播客速递节（07-10：有新集才出现）", () => {
  const pod = {
    ...buildNormalizedItem(
      "podcast-transcribe",
      "podcast",
      "42章经｜对谈某某：AI 下半场",
      "https://www.xiaoyuzhoufm.com/episode/e1",
      "2026-07-02T13:30:00Z",
      "• 要点一：应用为王\n• 要点二：嘉宾判断明年爆发",
    ),
    topicTag: "42章经",
  }

  it("有 podcastItems：节 + 导览芯片 + 卡片标题/要点 + md 面", () => {
    const { html, markdown } = renderDigest({
      businessDate: "2026-07-03",
      summary,
      items,
      results,
      podcastItems: [pod],
    })
    assert.ok(html.includes("播客速递"))
    assert.ok(html.includes("PODCAST DIGEST"))
    assert.ok(html.includes("42章经｜对谈某某：AI 下半场"))
    assert.ok(html.includes("要点一：应用为王"))
    assert.ok(html.includes('href="https://www.xiaoyuzhoufm.com/episode/e1"'))
    assert.ok(markdown.includes("## 播客速递"))
    assert.ok(markdown.includes("[42章经｜对谈某某：AI 下半场]"))
  })

  it("无 podcastItems：整节消失（导览无芯片、正文无节头）", () => {
    const { html, markdown } = render()
    assert.ok(!html.includes("播客速递"))
    assert.ok(!markdown.includes("## 播客速递"))
  })

  it("体检行收录数含播客", () => {
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary,
      items,
      results,
      podcastItems: [pod],
    })
    // items 2 条 + 播客 1 集 = 收录 3 条
    assert.ok(html.includes("收录 3 条"))
  })
})
