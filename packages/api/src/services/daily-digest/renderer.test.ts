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
  it("邮件视觉 v5.2：顶部恢复原版深墨刊头，速览恢复小圆点", () => {
    const { html } = render()
    assert.ok(
      html.includes("background-color:#fffaf5;border:1px solid #ded4ca;border-radius:20px"),
      "邮件整体仍应保留当前暖白纸面",
    )
    assert.ok(
      html.includes(
        "background-color:#24211f;border:1px solid #24211f;border-top:6px solid #c65d2e;border-radius:16px",
      ),
      "顶部刊头应以最初原版的深墨构图为基础",
    )
    assert.ok(
      html.includes(
        "font-size:38px;font-weight:700;letter-spacing:1px;color:#ffffff;line-height:46px",
      ),
      "每日简报应使用高对比大标题",
    )
    assert.ok(
      html.includes("width:52px;border-collapse:collapse") &&
        html.includes("height:2px;background-color:#c65d2e"),
      "标题下应以 Outlook 稳定的小表格恢复原版陶土短线",
    )
    assert.ok(
      html.includes("font-size:14px;line-height:25px;color:#514c48"),
      "正文应保持约 14px/175% 的阅读规格，并用 Outlook 可预测的像素行高",
    )
    assert.ok(
      html.includes('<span style="color:#c65d2e;font-weight:700;">·</span>'),
      "今日速览应恢复小圆点项目符号",
    )
    assert.ok(!html.includes('<span style="color:#c65d2e;">—</span>'))
  })

  it("邮件视觉 v5.1：恢复上一版结构，并加深来源、榜单数据与文章标题", () => {
    const hackerNews = buildNormalizedItem(
      "hn-ai",
      "ai",
      "Hacker News 条目",
      "https://news.ycombinator.com/item?id=1",
      null,
      "Hacker News 条目摘要",
    )
    const openAi = buildNormalizedItem(
      "openai-news",
      "ai",
      "OpenAI 条目",
      "https://openai.com/news/example",
      null,
      "OpenAI 条目摘要",
    )
    const githubWeekly = buildNormalizedItem(
      "github-trending-weekly",
      "github",
      "owner/weekly-repo",
      "https://github.com/owner/weekly-repo",
      null,
      "+7,596 stars this week · ★16,709 · C# · 开源项目摘要",
    )
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: {
        ...summary,
        sections: [
          {
            category: "ai",
            picks: [
              ...(summary.sections[0]?.picks ?? []),
              { itemId: hackerNews.id, summaryZh: "Hacker News 条目摘要" },
              { itemId: openAi.id, summaryZh: "OpenAI 条目摘要" },
            ],
          },
          { category: "hot", picks: [{ itemId: items[1].id, summaryZh: "热点摘要" }] },
        ],
      },
      items: [...items, hackerNews, openAi],
      results,
      githubItems: [githubWeekly],
    })
    assert.ok(
      html.includes(
        'font-size:12px;font-weight:700;line-height:18px;letter-spacing:2px;color:#8a3a00;padding:0;">ARTIFICIAL INTELLIGENCE',
      ),
      "板块标题应恢复上一版的陶土英文眉题",
    )
    assert.ok(
      html.includes(
        "background-color:#f6eee7;border:1px solid #ded4ca;border-top:3px solid #c65d2e;border-radius:16px",
      ),
      "焦点稿应恢复上一版的顶部细强调线",
    )
    assert.ok(!html.includes("border-left:5px solid #c65d2e"), "不得保留新版左侧粗色条")
    assert.ok(
      html.includes("font-size:20px;font-weight:700;line-height:30px;color:#161513"),
      "焦点标题应恢复上一版尺寸，同时使用更深的暖墨标题色",
    )
    assert.match(
      html,
      /color:#8a3a00;padding:18px 18px 8px 18px;\">Hacker News · 02/,
      "Hacker News 来源与编号应加深",
    )
    assert.match(
      html,
      /color:#8a3a00;padding:18px 18px 8px 18px;\">OpenAI · 03/,
      "OpenAI 来源与编号应加深",
    )
    assert.match(
      html,
      /color:#8a3a00;padding:8px 0 0 0;\">▲ 7,596 本周　★16,709　C#/,
      "GitHub 涨幅、星数和语言应加深",
    )
  })

  it("无脚本/无远程图片/table ≤600px/含 color-scheme", () => {
    const { html } = render()
    assert.ok(!html.toLowerCase().includes("<script"))
    assert.ok(!/<img[^>]+src="http/i.test(html))
    assert.ok(html.includes("max-width:600px"))
    assert.ok(html.includes('name="color-scheme"'))
    const modernHtml = html.replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/gi, "")
    assert.doesNotMatch(
      modernHtml,
      /<style/i,
      "现代客户端仍应保持全内联；唯一 style 只能位于 Outlook 条件注释中",
    )
    assert.doesNotMatch(
      html,
      /<link|@media|display:\s*(?:flex|grid)|oklch\(/i,
      "邮件必须保持 table 布局，不依赖客户端易剥离的现代样式能力",
    )
    const fixedWidths = [...html.matchAll(/(?:width="(\d+)"|width:(\d+)px)/g)].map((match) =>
      Number(match[1] ?? match[2]),
    )
    assert.ok(fixedWidths.length > 0)
    assert.ok(
      fixedWidths.every((width) => width <= 600),
      "所有固定宽度都必须守住 600px 上限",
    )
    const frameMatch = html.match(
      /(<table\b[^>]*\bwidth="600"[^>]*>)<tr><td style="padding:(\d+)px(?: (\d+)px)?;">\n<table role="presentation" width="(\d+)"/,
    )
    assert.ok(frameMatch, "应能解析邮件主表的边框、内边距与正文宽度")
    const borderWidth = Number(frameMatch[1].match(/border:(\d+)px solid/)?.[1] ?? 0)
    const horizontalPadding = Number(frameMatch[3] ?? frameMatch[2])
    const contentWidth = Number(frameMatch[4])
    assert.ok(
      contentWidth + horizontalPadding * 2 + borderWidth * 2 <= 600,
      "邮件主表的实际盒模型宽度也必须守住 600px 上限",
    )
  })

  it("B035/B036：Windows 经典 Outlook 保留 96-DPI/字体/行高兜底，刊头不依赖动态 VML", () => {
    const { html } = render()

    assert.ok(html.includes('xmlns:o="urn:schemas-microsoft-com:office:office"'))
    assert.ok(html.includes("<!--[if mso]>"), "Outlook Classic 必须有独立 MSO 条件分支")
    assert.ok(html.includes("<o:PixelsPerInch>96</o:PixelsPerInch>"), "Windows DPI 必须归一到 96")
    assert.ok(html.includes("mso-table-lspace:0pt;mso-table-rspace:0pt"))
    assert.ok(html.includes("mso-line-height-rule:exactly"))
    assert.ok(html.includes("mso-fareast-font-family:SimSun"))
    assert.ok(html.includes("'SimSun'"), "Windows 中文标题必须有衬线字体落点")
    assert.doesNotMatch(html, /<v:(?:roundrect|textbox)\b/i, "动态多行刊头不得进入 VML story")
    assert.doesNotMatch(html, /mso-fit-shape-to-text:true/i)
    assert.doesNotMatch(
      html,
      /\.masthead-table\{background-color:transparent!important\}/,
      "Outlook 不得撤掉刊头 table 自身的深墨背景",
    )
    assert.ok(html.includes('class="masthead-content-table"'))
    const mastheadTable = html.match(/<table class="masthead-table"[^>]*>/)?.[0]
    assert.ok(mastheadTable, "应保留单一、可独立渲染的刊头 table")
    assert.match(mastheadTable, /bgcolor="#24211f"/)
    assert.match(mastheadTable, /background-color:#24211f/)
    assert.match(mastheadTable, /border-top:6px solid #c65d2e/)
    assert.doesNotMatch(
      html,
      /<td style="padding:(?:18|20|22)px;"><table class="card-content-table"/,
      "hero/wide/col 外层卡片必须直接承载内容行，避免每条新闻重复一层完整 table",
    )
    assert.ok(html.includes('class="hero-badge-table"'))
    assert.doesNotMatch(
      html,
      /display:inline-block;background-color:#8a3a00/,
      "焦点徽标的间距必须落在 table/td，不能依赖 Word 不稳定的 inline span padding",
    )

    assert.doesNotMatch(
      html,
      /line-height:\d+%/,
      "百分比行高在 Word HTML 引擎中会膨胀，必须换成等值像素行高",
    )
    assert.doesNotMatch(
      html,
      /white-space:nowrap/,
      "Classic Outlook 对 nowrap/word-break 组合支持不一致，目录不得被强制撑宽",
    )
    assert.ok(
      html.includes("overflow-wrap:anywhere;word-break:break-word"),
      "现代客户端必须保留长 token 断词；Classic Outlook 再由条件样式覆盖为 break-all",
    )

    assert.match(html, /<body\b[^>]*bgcolor="#eee7df"/i)
    const backgroundTables = [
      ...html.matchAll(/<table\b[^>]*style="[^"]*background-color:(#[0-9a-f]{6})[^"]*"[^>]*>/gi),
    ]
    assert.ok(backgroundTables.length >= 5, "fixture 应覆盖外框、刊头、导航与卡片背景")
    for (const match of backgroundTables) {
      const tag = match[0]
      const color = match[1]
      assert.ok(
        tag.toLowerCase().includes(`bgcolor="${color.toLowerCase()}"`),
        `带 CSS 背景色的 table 必须有 Outlook HTML bgcolor 兜底：${tag}`,
      )
    }
  })

  it("B036：回目录只跳到普通 table 内的唯一可见 Word 书签", () => {
    const { html } = render()
    const bookmark = html.match(
      /<a id="([A-Za-z][A-Za-z0-9_]*)" name="\1"[^>]*>MULTI-AGENT · DAILY BRIEF<\/a>/,
    )
    assert.ok(bookmark, "顶部可见眉题本身应承载符合 Word 命名规则的 name+id 书签")
    assert.equal(bookmark[1], "DigestTop")
    assert.equal((html.match(/(?:id|name)="DigestTop"/g) ?? []).length, 2, "顶部书签必须唯一")

    const targetIndex = html.indexOf('id="DigestTop"')
    const backLinks = [...html.matchAll(/<a href="([^"]+)"[^>]*>↑ 回目录<\/a>/g)]
    assert.ok(backLinks.length > 0)
    assert.ok(backLinks.every((match) => match[1] === "#DigestTop"))
    assert.ok(backLinks.every((match) => targetIndex < (match.index ?? -1)))
    assert.doesNotMatch(html, /href="#top"|<a name="top"><\/a>/)
  })

  it("B036：GitHub 条目间距附着在真实内容行，不生成 Outlook 灰色空矩形", () => {
    const githubItems = [
      ["owner/meta-and-desc", "+1,000 stars this week · ★10,000 · TypeScript · 仓库摘要"],
      ["owner/meta-only", "+2,000 stars this week · ★20,000"],
      ["owner/desc-only", "不可解析的普通描述"],
      ["owner/title-only", ""],
      ["owner/last-sentinel", "+5,000 stars this week · ★50,000 · TypeScript · 末条摘要"],
    ].map(([title, snippet]) =>
      buildNormalizedItem(
        "github-trending-weekly",
        "github",
        title,
        `https://github.com/${title}`,
        null,
        snippet,
      ),
    )
    const { html } = renderDigest({
      businessDate: "2026-07-03",
      summary: { overview: [], sections: [], degraded: false },
      items: [],
      githubItems,
      results: [],
    })

    const cardStart = html.indexOf('<table class="card-content-table"')
    const cardEnd = html.indexOf("</table>", cardStart)
    assert.ok(cardStart >= 0 && cardEnd > cardStart, "fixture 应生成一张 GitHub 榜单卡")
    const listCard = html.slice(cardStart, cardEnd + "</table>".length)
    assert.doesNotMatch(
      listCard,
      /<tr><td\b[^>]*height="12"[^>]*>\s*&nbsp;\s*<\/td><\/tr>/,
      "独立 &nbsp; spacer 会被 Word 画成有底色的固定高矩形",
    )
    assert.equal(
      (listCard.match(/border-top:1px solid #ded4ca;padding:12px 0 0 0/g) ?? []).length,
      4,
      "后续四条仍应保留真实分隔线与上间距",
    )
    assert.equal(
      (listCard.match(/padding-bottom:12px/g) ?? []).length,
      4,
      "四个非末条的几何间距应各自迁到最后一个真实内容单元格",
    )
    assert.match(
      listCard,
      /padding:8px 0 0 0;padding-bottom:12px;">仓库摘要<\/td>/,
      "meta+desc 的间距应附着到 desc",
    )
    assert.match(
      listCard,
      /class="github-meta-row"[^>]*padding-bottom:12px;">▲ 2,000 本周　★20,000<\/td>/,
      "meta-only 的间距应附着到 meta",
    )
    assert.match(
      listCard,
      /padding:8px 0 0 0;padding-bottom:12px;">不可解析的普通描述<\/td>/,
      "desc-only 的间距应附着到 desc",
    )
    assert.match(
      listCard,
      /padding:12px 0 0 0;padding-bottom:12px;">[\s\S]*?owner\/title-only<\/a><\/td>/,
      "title-only 的间距应附着到 title",
    )
  })

  it("B036：双栏中央 gutter 是明确暖白底的空结构列，不生成 Outlook 灰色竖块", () => {
    const items = ["焦点条目", "左侧小卡", "右侧小卡"].map((title, index) =>
      buildNormalizedItem(
        "smol-ai",
        "ai",
        title,
        `https://example.com/two-col-${index}`,
        null,
        `${title}摘要`,
      ),
    )
    const { html } = renderDigest({
      businessDate: "2026-07-16",
      summary: {
        overview: [],
        sections: [
          {
            category: "ai",
            picks: items.map((item) => ({ itemId: item.id, summaryZh: `${item.title}摘要` })),
          },
        ],
        degraded: false,
      },
      items,
      results: [],
    })
    const gutters = [...html.matchAll(/<td width="16"[^>]*>[\s\S]*?<\/td>/g)].map(
      (match) => match[0],
    )

    assert.ok(gutters.length > 0, "fixture 必须覆盖至少一组双栏小卡")
    for (const gutter of gutters) {
      assert.match(gutter, /bgcolor="#fffaf5"/, "Word 单元格必须明确归属暖白纸面")
      assert.match(gutter, /background-color:#fffaf5/, "现代客户端与 Outlook 应使用同一表面色")
      assert.match(gutter, />\s*<\/td>$/, "结构 gutter 不得含会被 Word 画成实体块的文本节点")
      assert.doesNotMatch(gutter, /&nbsp;/)
    }
  })

  it("B036 A：Classic Outlook 延续原版完整卡片视觉，只让圆角自然降级", () => {
    const fixtureItems = ["焦点条目", "推理左卡", "推理右卡", "OpenAI 左卡", "OpenAI 右卡"].map(
      (title, index) =>
        buildNormalizedItem(
          "smol-ai",
          "ai",
          title,
          `https://example.com/outlook-editorial-${index}`,
          null,
          `${title}摘要`,
        ),
    )
    const tags = ["推理", "推理", "推理", "OpenAI", "OpenAI"]
    const { html } = renderDigest({
      businessDate: "2026-07-16",
      summary: {
        overview: ["今日速览"],
        sections: [
          {
            category: "ai",
            picks: fixtureItems.map((item, index) => ({
              itemId: item.id,
              summaryZh: `${item.title}摘要`,
              tag: tags[index],
            })),
          },
        ],
        degraded: false,
      },
      items: fixtureItems,
      results: [],
    })

    assert.match(html, /\/\* OUTLOOK_VISUAL_START \*\//)
    assert.match(html, /\.outlook-paper\{border:1px solid #ded4ca!important\}/)
    assert.match(
      html,
      /\.masthead-table\{background-color:#24211f!important;border:1px solid #24211f!important;border-top:6px solid #c65d2e!important\}/,
    )
    assert.match(
      html,
      /\.outlook-nav-shell\{background-color:#f6eee7!important;border:1px solid #ded4ca!important\}/,
    )
    assert.match(
      html,
      /\.outlook-nav-chip\{background-color:#fffaf5!important;border:1px solid #ded4ca!important\}/,
    )
    assert.match(
      html,
      /\.outlook-story-card,\.outlook-list-card\{background-color:#fffdf9!important;border:1px solid #ded4ca!important\}/,
    )
    assert.match(
      html,
      /\.outlook-rest-card\{background-color:#f8eee7!important;border:1px solid #ded4ca!important\}/,
    )
    assert.match(
      html,
      /\.outlook-hero-card\{background-color:#f6eee7!important;border:1px solid #ded4ca!important;border-top:3px solid #c65d2e!important\}/,
    )
    assert.match(
      html,
      /\.outlook-subheading\{background-color:#f8eee7!important;border:0!important;border-bottom:1px solid #ded4ca!important\}/,
    )
    assert.match(
      html,
      /\.outlook-card-summary\{font-size:14px!important;line-height:25px!important\}/,
    )
    assert.ok(html.includes('class="outlook-nav-grid"'))
    assert.ok(html.includes('class="outlook-nav-chip"'))
    assert.ok(html.includes('class="digest-sans outlook-story-card"'))
    assert.ok(html.includes('class="outlook-subheading"'))
    assert.ok(html.includes('class="outlook-card-summary"'))
    assert.doesNotMatch(html, /box-shadow:|linear-gradient\(/i)
  })

  it("B036 V4：所有仍含 nbsp 的结构空 cell 都有明确不透明底色", () => {
    const { html } = render()
    const structuralCells = [
      ...html.matchAll(/<td\b[^>]*font-size:0[^>]*>\s*&nbsp;\s*<\/td>/gi),
    ].map((match) => match[0])

    assert.ok(structuralCells.length > 0, "fixture 应覆盖刊头规则等有意的结构 cell")
    for (const cell of structuralCells) {
      assert.match(cell, /bgcolor="#[0-9a-f]{6}"/i, `结构 cell 缺少 Outlook bgcolor：${cell}`)
      assert.match(
        cell,
        /background-color:#[0-9a-f]{6}/i,
        `结构 cell 缺少现代客户端背景色：${cell}`,
      )
    }
  })

  it("B036 A：同类内容卡一律完整四边框，不残留报刊左轨或混合边框", () => {
    const { html } = render()
    const outlookCss = html.match(
      /\/\* OUTLOOK_VISUAL_START \*\/([\s\S]*?)\/\* OUTLOOK_VISUAL_END \*\//,
    )?.[1]

    assert.ok(outlookCss, "邮件必须包含 Classic Outlook 专用视觉规则")
    assert.match(
      outlookCss,
      /\.outlook-story-card,\.outlook-list-card\{background-color:#fffdf9!important;border:1px solid #ded4ca!important\}/,
    )
    assert.match(
      outlookCss,
      /\.outlook-rest-card\{background-color:#f8eee7!important;border:1px solid #ded4ca!important\}/,
    )
    assert.match(
      outlookCss,
      /\.outlook-subheading\{background-color:#f8eee7!important;border:0!important;border-bottom:1px solid #ded4ca!important\}/,
    )
    assert.doesNotMatch(
      outlookCss,
      /border-left:3px solid|\.outlook-nav-grid\{border-top:/,
      "不得残留 V4/V4.1 的左轨或报刊导航顶线",
    )
  })

  it("B035：双栏长 ASCII token 只给 Outlook 断词样式，不注入污染复制内容的字符", () => {
    const heroItem = buildNormalizedItem(
      "smol-ai",
      "ai",
      "焦点条目",
      "https://example.com/hero",
      null,
      "hero",
    )
    const peerItem = buildNormalizedItem(
      "smol-ai",
      "ai",
      "普通双栏条目",
      "https://example.com/peer",
      null,
      "peer",
    )
    const longTitle = "WWWWWWWWWWWWW"
    const longItem = buildNormalizedItem(
      "smol-ai",
      "ai",
      longTitle,
      "https://example.com/long-token",
      null,
      "long token",
    )
    const { html } = renderDigest({
      businessDate: "2026-07-16",
      summary: {
        overview: [],
        sections: [
          {
            category: "ai",
            picks: [
              { itemId: heroItem.id, summaryZh: "焦点摘要" },
              { itemId: peerItem.id, summaryZh: "普通摘要" },
              { itemId: longItem.id, summaryZh: "长 token 摘要" },
            ],
          },
        ],
        degraded: false,
      },
      items: [heroItem, peerItem, longItem],
      results: [],
    })

    assert.ok(html.includes(longTitle), "正文标题必须保持原始文本")
    assert.ok(!html.includes("&#8203;"), "不得向可复制标题注入零宽字符")
    assert.ok(html.includes(".outlook-break-long{word-break:break-all!important}"))
    assert.match(
      html,
      /<td width="272"[^>]*><table[^>]*bgcolor="#fffdf9"[^>]*table-layout:fixed/,
      "普通长 token 双栏卡仍须固定布局，避免把全部英文卡误降为单栏",
    )
    assert.match(
      html,
      new RegExp(`<td class="outlook-break-long"[^>]*><a[^>]*>${longTitle}</a></td>`),
      "13 个宽 ASCII 字符已经能撑破 272px 双栏，必须只在 Outlook 上启用 break-all",
    )
    assert.ok(html.includes('href="https://example.com/long-token"'), "canonical href 不得改变")

    const assertLongTitleGuard = (document: string, href: string, title: string) => {
      const anchor = `<a href="${href}"`
      const anchorIndex = document.indexOf(anchor)
      assert.ok(anchorIndex >= 0, `缺少长标题链接 ${href}`)
      const cellStart = document.lastIndexOf("<td", anchorIndex)
      const cellEnd = document.indexOf(">", cellStart)
      assert.ok(
        document.slice(cellStart, cellEnd + 1).includes('class="outlook-break-long"'),
        `Classic Outlook 断词类必须覆盖 ${href}`,
      )
      const anchorEnd = document.indexOf("</a>", anchorIndex)
      const anchorHtml = document.slice(anchorIndex, anchorEnd + 4)
      assert.ok(anchorHtml.includes("overflow-wrap:anywhere;word-break:break-word"))
      assert.ok(anchorHtml.includes(`>${title}</a>`), "长标题可复制文本必须原样保留")
    }

    const wideItem = buildNormalizedItem(
      "smol-ai",
      "ai",
      longTitle,
      "https://example.com/wide-token",
      null,
      "wide",
    )
    const widePeers = [1, 2].map((index) =>
      buildNormalizedItem(
        "smol-ai",
        "ai",
        `普通整宽同组条目 ${index}`,
        `https://example.com/wide-peer-${index}`,
        null,
        "peer",
      ),
    )
    const wideHtml = renderDigest({
      businessDate: "2026-07-16",
      summary: {
        overview: [],
        sections: [
          {
            category: "ai",
            picks: [
              { itemId: heroItem.id, summaryZh: "焦点摘要" },
              { itemId: wideItem.id, summaryZh: "整宽长摘要".repeat(12) },
              ...widePeers.map((item) => ({ itemId: item.id, summaryZh: "短摘要" })),
            ],
          },
        ],
        degraded: false,
      },
      items: [heroItem, wideItem, ...widePeers],
      results: [],
      restOverviewRows: 0,
    }).html
    assertLongTitleGuard(wideHtml, "https://example.com/wide-token", longTitle)

    const githubItem = buildNormalizedItem(
      "github-trending-daily",
      "github",
      longTitle,
      "https://example.com/github-token",
      null,
      "+1,000 stars today · ★10,000 · TypeScript · description",
    )
    const githubHtml = renderDigest({
      businessDate: "2026-07-16",
      summary: { overview: [], degraded: false, sections: [] },
      items: [],
      githubItems: [githubItem],
      results: [],
      restOverviewRows: 0,
    }).html
    assertLongTitleGuard(githubHtml, "https://example.com/github-token", longTitle)
  })

  it("B037：双栏标题含超长 URL 时，两卡顺序整宽，避免 Outlook 同行高度留白", () => {
    const heroItem = buildNormalizedItem(
      "smol-ai",
      "community",
      "社区焦点",
      "https://example.com/hero",
      null,
      "hero",
    )
    const peerItem = buildNormalizedItem(
      "x-firsthand",
      "community",
      "@gdb: team is responding to feedback and iterating quickly.",
      "https://x.com/gdb/status/2078004399675503093",
      null,
      "peer",
    )
    const longUrlTitle =
      "@DrJimFan: Re How it's done: https://x.com/DrJimFan/status/2077414142340988962?s=20"
    const longUrlItem = buildNormalizedItem(
      "x-firsthand",
      "community",
      longUrlTitle,
      "https://x.com/DrJimFan/status/2078150496683213151",
      null,
      "long URL",
    )
    const { html } = renderDigest({
      businessDate: "2026-07-18",
      summary: {
        overview: [],
        sections: [
          {
            category: "community",
            picks: [
              { itemId: heroItem.id, summaryZh: "焦点摘要" },
              { itemId: peerItem.id, summaryZh: "短摘要" },
              { itemId: longUrlItem.id, summaryZh: "长 URL 摘要" },
            ],
          },
        ],
        degraded: false,
      },
      items: [heroItem, peerItem, longUrlItem],
      results: [],
    })

    const directWideRows =
      html.match(
        /<tr><td style="padding:0 0 16px 0;"><table class="digest-sans outlook-story-card"/g,
      ) ?? []
    const narrowCells = html.match(/<td width="272"/g) ?? []
    assert.equal(directWideRows.length, 2, "超长 URL 配对必须拆成两个独立 Outlook table row")
    assert.equal(narrowCells.length, 0, "超长 URL 配对不得进入 272px twoColRow")
    const escapedLongUrlTitle = longUrlTitle.replace("'", "&#39;")
    assert.match(
      html,
      new RegExp(
        `<td class="outlook-break-long"[^>]*><a[^>]*>${escapedLongUrlTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</a></td>`,
      ),
      "整宽卡仍须保留 Outlook 断词防线",
    )
    assert.ok(html.includes('href="https://x.com/gdb/status/2078004399675503093"'))
    assert.ok(html.includes('href="https://x.com/DrJimFan/status/2078150496683213151"'))
  })

  it("B035：摘要降密度不得从 emoji 代理对中间截断", () => {
    const hero = buildNormalizedItem(
      "smol-ai",
      "ai",
      "焦点",
      "https://example.com/emoji-hero",
      null,
      "hero",
    )
    const emoji = buildNormalizedItem(
      "smol-ai",
      "ai",
      "Emoji 摘要",
      "https://example.com/emoji-summary",
      null,
      "emoji",
    )
    const peer = buildNormalizedItem(
      "smol-ai",
      "ai",
      "配对摘要",
      "https://example.com/emoji-peer",
      null,
      "peer",
    )
    const emojiSummary = `${"界".repeat(78)}😀尾巴`
    const { html } = renderDigest({
      businessDate: "2026-07-16",
      summary: {
        overview: [],
        degraded: false,
        sections: [
          {
            category: "ai",
            picks: [
              { itemId: hero.id, summaryZh: "焦点摘要" },
              { itemId: emoji.id, summaryZh: emojiSummary },
              { itemId: peer.id, summaryZh: "配对摘要" },
            ],
          },
        ],
      },
      items: [hero, emoji, peer],
      results: [],
      restOverviewRows: 0,
    })

    assert.ok(html.includes(`${"界".repeat(78)}😀…`), "80 字摘要应保留完整 emoji 后再加省略号")
    assert.doesNotMatch(
      html,
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      "HTML 不得含孤立 UTF-16 surrogate",
    )
  })

  it("B035：正式上限 34 篇正文 + 22 个仓库 + 4 个播客即使分组最碎也守住 98KiB", () => {
    const title = "模型推理基础设施与智能体工程可靠性持续演进".repeat(2)
    const summaryText = `摘要：${"界".repeat(300)}`.slice(0, 300)
    const githubDescText = `仓库：${"界".repeat(120)}`.slice(0, 120)
    const aiTags = ["推理", "OpenAI", "Anthropic", "Google", "Meta", "国产", "开源", "研究", "其他"]
    const hotTags = ["科技", "财经", "社会", "民生", "体育", "娱乐", "国际", "其他"]
    const communityVariants: Array<readonly [string, string | undefined]> = [
      ["reddit-ai", undefined],
      ["x-firsthand", "公司"],
      ["x-firsthand", "从业者"],
      ["x-firsthand", undefined],
      ["reddit-ai", undefined],
      ["digg-ai", undefined],
      ["v2ex-hot", undefined],
      ["xiaohongshu", undefined],
      ["community-fallback", undefined],
      ["community-fallback", undefined],
      ["community-fallback", undefined],
      ["community-fallback", undefined],
    ]
    const specs = [
      ["ai", "smol-ai", 12],
      ["hot", "zhihu-hot", 10],
      ["community", "reddit-ai", 12],
    ] as const
    let itemNo = 0
    const groups = specs.map(([category, sourceId, count]) => {
      const entries = Array.from({ length: count }, (_, localIndex) => {
        itemNo += 1
        const [resolvedSourceId, topicTag] =
          category === "community" ? communityVariants[localIndex] : [sourceId, undefined]
        const item = buildNormalizedItem(
          resolvedSourceId,
          category,
          `${title}${itemNo}`,
          `https://example.com/dense/${itemNo}`,
          null,
          "dense",
        )
        return topicTag ? { ...item, topicTag } : item
      })
      return { category, entries }
    })
    const denseItems = groups.flatMap((group) => group.entries)
    const githubDescZh: Record<string, string> = {}
    const githubItems = (
      [
        ["github-trending-daily", 6, "today"],
        ["github-trending-weekly", 6, "this week"],
        ["github-ai-newcomers", 4, "new"],
        ["github-trending-monthly", 6, "this month"],
      ] as const
    ).flatMap(([sourceId, count, period]) => {
      return Array.from({ length: count }, (_, index) => {
        const snippet =
          period === "new"
            ? "新仓 7 天 · ★10,000 · English description"
            : `+1,000 stars ${period} · ★10,000 · TypeScript · English description`
        const item = buildNormalizedItem(
          sourceId,
          "github",
          `owner/repository-${sourceId}-${index}`,
          `https://github.com/owner/repository-${sourceId}-${index}`,
          null,
          snippet,
        )
        githubDescZh[item.id] = githubDescText
        return item
      })
    })
    const podcastItems = Array.from({ length: 4 }, (_, index) =>
      buildNormalizedItem(
        "podcast",
        "podcast",
        `播客节目｜第 ${index + 1} 期`,
        `https://example.com/podcast/${index + 1}`,
        null,
        `· ${"播客要点覆盖模型训练推理与工程实践".repeat(30)}`.slice(0, 600),
      ),
    )
    const rendered = renderDigest({
      businessDate: "2026-07-16",
      summary: {
        overview: Array.from({ length: 8 }, () => summaryText),
        degraded: false,
        sections: groups.map((group) => ({
          category: group.category,
          picks: group.entries.map((item, localIndex) => {
            const tags =
              group.category === "ai" ? aiTags : group.category === "hot" ? hotTags : null
            const tag = tags
              ? localIndex === 0
                ? tags[0]
                : tags[Math.min(localIndex - 1, tags.length - 1)]
              : undefined
            return { itemId: item.id, summaryZh: summaryText, ...(tag ? { tag } : {}) }
          }),
        })),
        githubDescZh,
      },
      items: denseItems,
      githubItems,
      podcastItems,
      results: [],
      restOverviewRows: 0,
    })

    const bytes = Buffer.byteLength(rendered.html, "utf8")
    assert.equal(
      rendered.displayedItemIds.length,
      60,
      "体积探针必须覆盖正文、仓库和播客正式选择上限",
    )
    for (const item of [...denseItems, ...githubItems, ...podcastItems]) {
      assert.ok(rendered.html.includes(escapeHtml(item.title)), `HTML 不得丢标题：${item.id}`)
      assert.ok(
        rendered.html.includes(`href="${escapeHtml(item.canonicalUrl)}"`),
        `HTML 不得丢链接：${item.id}`,
      )
    }
    assert.ok(rendered.markdown.includes(summaryText), "自适应密度不得裁剪 Markdown 归档正文")
    assert.ok(bytes <= 98 * 1024, `0 行速览仍不得越过 Gmail 裁剪预算，实际 ${bytes} bytes`)
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
    assert.ok(
      html.includes(
        'href="https://r.com/e0" style="color:#161513;text-decoration:none;">未选条目0</a>',
      ),
      "其余速览里的文章标题也应使用统一的深暖墨色",
    )
    assert.ok(!html.includes("未选条目13"))
    assert.ok(html.includes('href="#DigestTop"')) // 每节尾回目录
    assert.ok(html.includes('id="DigestTop" name="DigestTop"')) // 可见刊头 Word 书签
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
