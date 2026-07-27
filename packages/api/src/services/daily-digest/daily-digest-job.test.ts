import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, it } from "node:test"
import { createFileAttemptLedger } from "../../lib/attempt-ledger"
import type { EmailSender } from "../../lib/email-sender"
import {
  type DailyDigestJobDeps,
  createDailyDigestJob,
  isDigestFailureStatus,
} from "./daily-digest-job"
import { buildEditorialDecisionSet } from "./editorial-decider"
import { buildNormalizedItem } from "./feed-parsers"
import { writeShownLedger } from "./shown-ledger"
import { createFileSourceHealthStore } from "./source-health"
import { type TranslateExtrasInput, buildEditorialPromptItems } from "./summarizer"
import type {
  DigestSource,
  DigestSummary,
  EditorialAssessment,
  EditorialReviewVote,
  NormalizedItem,
} from "./types"

// 2026-07-03 是周五。GitHub 四榜 07-07 起全常驻（周一门/每月 1 号门都已拆）
const FRI_0800 = new Date("2026-07-03T08:00:00+08:00")
const FRI_0700 = new Date("2026-07-03T07:00:00+08:00")
const SAT_0800 = new Date("2026-07-04T08:00:00+08:00")
const SUN_0800 = new Date("2026-07-05T08:00:00+08:00")
const MON_0900 = new Date("2026-07-27T09:00:00+08:00")

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-job-"))
})

function okSource(
  sourceId: string,
  category: NormalizedItem["category"] = "ai",
): DigestSource & { calls: number[] } {
  const s = {
    sourceId,
    category,
    calls: [] as number[],
    async fetch() {
      s.calls.push(1)
      if (category === "github") {
        return [githubItem(sourceId, `owner/${sourceId}`)]
      }
      return [
        buildNormalizedItem(
          sourceId,
          category,
          `title-${sourceId}`,
          `https://x.com/${sourceId}`,
          "2026-07-03T00:00:00Z",
          "snippet",
        ),
      ]
    },
  }
  return s
}

function githubItem(
  sourceId: string,
  repo: string,
  state: "yes" | "no" | "unknown" = "yes",
): NormalizedItem {
  const period =
    sourceId === "github-ai-newcomers"
      ? "newcomer"
      : sourceId === "github-trending-weekly"
        ? "weekly"
        : sourceId === "github-trending-monthly"
          ? "monthly"
          : "daily"
  const item = buildNormalizedItem(
    sourceId,
    "github",
    repo,
    `https://github.com/${repo}`,
    null,
    `${period === "newcomer" ? "新仓 7 天" : "+100 stars today"} · ★1,000 · TypeScript · ${repo.includes("iptv") ? "IPTV channel list" : "AI agent search"}`,
  )
  return {
    ...item,
    githubMeta: {
      repo,
      period,
      windowStars: 100,
      totalStars: 1_000,
      language: "TypeScript",
      description: repo.includes("iptv") ? "IPTV channel list" : "AI agent search",
      evidence: {
        topics: [],
        metadataStatus: "not_requested",
        readmeStatus: "not_requested",
        evidenceComplete: false,
      },
      eligibility: {
        state,
        confidence: state === "unknown" ? 0 : 0.98,
        reasons: [state === "yes" ? "AI 是核心用途" : "不是 AI 核心用途"],
      },
    },
  }
}

function makeSender(
  behavior: "ok" | "throw" = "ok",
): EmailSender & { sent: Array<{ to: string; subject: string }> } {
  const sent: Array<{ to: string; subject: string }> = []
  return {
    kind: "fake",
    sent,
    async send(mail) {
      if (behavior === "throw") throw new Error("smtp down")
      sent.push({ to: mail.to, subject: mail.subject })
      return { messageId: `m-${sent.length}` }
    },
  }
}

const fakeSummary: DigestSummary = { overview: ["要点"], sections: [], degraded: false }

function approve(items: NormalizedItem[]): EditorialAssessment[] {
  return items.map((item) => ({
    itemId: item.id,
    sourceCategory: item.category,
    reviewState: "eligible",
    topicTags: item.category === "hot" ? ["other"] : ["inference"],
    organizationTags: [],
    ecosystemTags: [],
    regionTags: ["global"],
    contentKind:
      item.category === "community" || item.category === "podcast" ? "discussion" : "engineering",
    confidence: 0.95,
  }))
}

function makeDeps(overrides: Partial<DailyDigestJobDeps> = {}): DailyDigestJobDeps {
  return {
    ledger: createFileAttemptLedger(dir, "[daily-digest]"),
    health: createFileSourceHealthStore(dir),
    sources: [okSource("smol-ai")],
    http: { fetchText: async () => "" },
    summarize: async (items) => {
      const sections: DigestSummary["sections"] = []
      for (const category of ["ai", "hot", "community", "podcast"] as const) {
        const grouped = items.filter((item) => item.category === category)
        if (grouped.length === 0) continue
        if (category === "podcast") {
          sections.push({ category, picks: [], briefItemIds: grouped.map((item) => item.id) })
        } else {
          sections.push({
            category,
            picks: grouped.slice(0, 3).map((item) => ({ itemId: item.id, summaryZh: "摘要" })),
            briefItemIds: grouped.slice(3).map((item) => item.id),
          })
        }
      }
      return { ...fakeSummary, editorialAssessments: approve(items), sections }
    },
    sender: makeSender(),
    recipient: "me@gmail.com",
    baseDir: dir,
    ...overrides,
  }
}

describe("reconcile（D10/D11）", () => {
  it("未到发送时间 → skipped_not_due", async () => {
    const job = createDailyDigestJob(makeDeps())
    assert.equal((await job.reconcile(FRI_0700)).status, "skipped_not_due")
  })

  it("B044：周六、周日自动停发且零抓取；force 保留人工显式补发", async () => {
    const source = okSource("smol-ai")
    const sender = makeSender()
    const job = createDailyDigestJob(makeDeps({ sources: [source], sender }))

    assert.equal((await job.reconcile(SAT_0800)).status, "skipped_weekend")
    assert.equal((await job.reconcile(SUN_0800)).status, "skipped_weekend")
    assert.equal(source.calls.length, 0)
    assert.equal(sender.sent.length, 0)
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-04")))
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-05")))

    assert.equal((await job.reconcile(SAT_0800, { force: true })).status, "ok")
    assert.equal(source.calls.length, 1)
    assert.equal(sender.sent.length, 1)
  })

  it("B045：周一正文只汇总周六/周日，但保留 GitHub 当前四榜快照", async () => {
    const raw = [
      buildNormalizedItem(
        "smol-ai",
        "ai",
        "Friday story",
        "https://example.com/fri",
        "2026-07-24T10:00:00Z",
        "Friday",
      ),
      buildNormalizedItem(
        "smol-ai",
        "ai",
        "Saturday story",
        "https://example.com/sat",
        "2026-07-24T16:30:00Z",
        "Saturday",
      ),
      buildNormalizedItem(
        "smol-ai",
        "ai",
        "Sunday story",
        "https://example.com/sun",
        "2026-07-26T15:59:00Z",
        "Sunday",
      ),
      buildNormalizedItem(
        "smol-ai",
        "ai",
        "Monday story",
        "https://example.com/mon",
        "2026-07-26T16:30:00Z",
        "Monday",
      ),
      buildNormalizedItem(
        "smol-ai",
        "ai",
        "No-date story",
        "https://example.com/no-date",
        null,
        "No date",
      ),
    ]
    const contentSource: DigestSource = {
      sourceId: "smol-ai",
      category: "ai",
      fetch: async () => raw,
    }
    const githubDailySource = okSource("github-trending-daily", "github")
    const githubWeeklySource = okSource("github-trending-weekly", "github")
    const githubNewcomersSource = okSource("github-ai-newcomers", "github")
    const githubMonthlySource = okSource("github-trending-monthly", "github")
    const podcastRaw = [
      buildNormalizedItem(
        "podcast-transcribe",
        "podcast",
        "Friday podcast",
        "https://example.com/podcast-fri",
        "2026-07-24T10:00:00Z",
        "Friday",
      ),
      buildNormalizedItem(
        "podcast-transcribe",
        "podcast",
        "Saturday podcast",
        "https://example.com/podcast-sat",
        "2026-07-24T16:30:00Z",
        "Saturday",
      ),
      buildNormalizedItem(
        "podcast-transcribe",
        "podcast",
        "Sunday podcast",
        "https://example.com/podcast-sun",
        "2026-07-26T15:59:00Z",
        "Sunday",
      ),
      buildNormalizedItem(
        "podcast-transcribe",
        "podcast",
        "Monday podcast",
        "https://example.com/podcast-mon",
        "2026-07-26T16:30:00Z",
        "Monday",
      ),
      buildNormalizedItem(
        "podcast-transcribe",
        "podcast",
        "No-date podcast",
        "https://example.com/podcast-no-date",
        null,
        "No date",
      ),
    ]
    const podcastSource: DigestSource = {
      sourceId: "podcast-transcribe",
      category: "podcast",
      fetch: async () => podcastRaw,
    }
    writeShownLedger(dir, "2026-07-25", [raw[1].dedupeKey])
    writeShownLedger(dir, "2026-07-26", [raw[2].dedupeKey])
    const fed: NormalizedItem[] = []
    const sender = makeSender()
    const job = createDailyDigestJob(
      makeDeps({
        sources: [contentSource, podcastSource],
        githubDailySources: [githubDailySource],
        githubSources: [githubWeeklySource, githubNewcomersSource],
        githubMonthlySources: [githubMonthlySource],
        sender,
        summarize: async (items) => {
          fed.push(...items)
          const aiItems = items.filter((item) => item.category === "ai")
          const podcastItems = items.filter((item) => item.category === "podcast")
          return {
            overview: ["周末两日要点"],
            editorialAssessments: approve(items),
            sections: [
              {
                category: "ai",
                picks: aiItems.map((item) => ({ itemId: item.id, summaryZh: "周末摘要" })),
              },
              {
                category: "podcast",
                picks: [],
                briefItemIds: podcastItems.map((item) => item.id),
              },
            ],
            degraded: false,
          }
        },
      }),
    )

    assert.equal((await job.reconcile(MON_0900)).status, "ok")
    assert.deepEqual(
      fed.filter((item) => item.category === "ai").map((item) => item.title),
      ["Saturday story", "Sunday story"],
    )
    assert.deepEqual(
      fed.filter((item) => item.category === "podcast").map((item) => item.title),
      ["Saturday podcast", "Sunday podcast"],
    )
    for (const source of [
      githubDailySource,
      githubWeeklySource,
      githubNewcomersSource,
      githubMonthlySource,
    ]) {
      assert.equal(source.calls.length, 1)
    }
    assert.equal(sender.sent.length, 1)
    assert.match(sender.sent[0].subject, /周末速览/)
    const firstArchive = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-27", "summary.json"), "utf8"),
    ) as { counts: { content: number; github: number; podcast: number } }
    assert.equal(firstArchive.counts.content, 2)
    assert.equal(firstArchive.counts.github, 4)
    assert.equal(firstArchive.counts.podcast, 2)

    fed.length = 0
    assert.equal((await job.reconcile(MON_0900, { force: true })).status, "ok")
    assert.deepEqual(
      fed.filter((item) => item.category === "ai").map((item) => item.title),
      ["Saturday story", "Sunday story"],
      "周一立即补发也必须保持严格周末窗口",
    )
    assert.deepEqual(
      fed.filter((item) => item.category === "podcast").map((item) => item.title),
      ["Saturday podcast", "Sunday podcast"],
      "播客也必须保持严格周末窗口",
    )
    for (const source of [
      githubDailySource,
      githubWeeklySource,
      githubNewcomersSource,
      githubMonthlySource,
    ]) {
      assert.equal(source.calls.length, 2)
    }
    assert.equal(sender.sent.length, 2)
  })

  it("B044：编辑链无一条新闻获批时，GitHub 榜单不得兜底发送空壳邮件", async () => {
    const sender = makeSender()
    const alerts: string[] = []
    const githubSource = okSource("github-trending-weekly", "github")
    const saturdayContent: DigestSource = {
      sourceId: "smol-ai",
      category: "ai",
      fetch: async () => [
        buildNormalizedItem(
          "smol-ai",
          "ai",
          "Saturday unreviewed story",
          "https://example.com/saturday-unreviewed",
          "2026-07-25T08:00:00Z",
          "Saturday",
        ),
      ],
    }
    const job = createDailyDigestJob(
      makeDeps({
        sources: [saturdayContent],
        sender,
        githubSources: [githubSource],
        pushAlert: (message) => alerts.push(message),
        summarize: async (items) => ({
          overview: [],
          editorialAssessments: items.map((item) => ({
            itemId: item.id,
            sourceCategory: item.category,
            reviewState: "unreviewed" as const,
            rejectReason: "classifier_failure" as const,
            topicTags: [],
            organizationTags: [],
            ecosystemTags: [],
            regionTags: [],
            contentKind: "other" as const,
            confidence: 0,
          })),
          sections: [],
          degraded: false,
        }),
      }),
    )

    assert.equal((await job.reconcile(MON_0900)).status, "failed_summarize")
    assert.equal(sender.sent.length, 0)
    assert.ok(alerts.some((message) => message.includes("新闻正文") && message.includes("不发送")))
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-27")))
    assert.ok(!fs.existsSync(path.join(dir, "ledger", "2026-07-27.json")))
    assert.ok(!fs.existsSync(path.join(dir, "outbound-ledger.jsonl")))
  })

  it("happy path：发送 + sent 落账 + 归档双格式 + 外发账本", async () => {
    const sender = makeSender()
    const deps = makeDeps({ sender })
    const job = createDailyDigestJob(deps)
    const out = await job.reconcile(FRI_0800)
    assert.equal(out.status, "ok")
    assert.equal(sender.sent[0].to, "me@gmail.com")
    assert.ok(sender.sent[0].subject.includes("2026-07-03"))
    assert.ok(deps.ledger.read("2026-07-03").sent)
    assert.ok(fs.existsSync(path.join(dir, "2026-07-03", "digest.html")))
    assert.ok(fs.existsSync(path.join(dir, "2026-07-03", "digest.md")))
    assert.ok(fs.existsSync(path.join(dir, "outbound-ledger.jsonl")))
    // 网页版数据面（07-05）：summary.json 结构化归档（picks/源健康/计数）
    const summaryDoc = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "summary.json"), "utf8"),
    ) as { businessDate: string; summary: { sections: unknown[] }; sourceHealth: unknown[] }
    assert.equal(summaryDoc.businessDate, "2026-07-03")
    assert.equal(summaryDoc.summary.sections.length, 1)
    assert.equal(summaryDoc.sourceHealth.length, 1)
  })

  it("summarize 全败（null）→ failed_summarize：零副作用 + 告警 + 下一触发点真重跑（三拍 r1 P2-3）", async () => {
    const sender = makeSender()
    const alerts: string[] = []
    let calls = 0
    const deps = makeDeps({
      sender,
      pushAlert: (m) => alerts.push(m),
      // 第一轮全败 null，第二轮成功——同一 job 实例连跑两轮，证明安全网重跑真发得出去
      summarize: async (items) =>
        ++calls === 1
          ? null
          : {
              ...fakeSummary,
              editorialAssessments: approve(items),
              sections: [
                {
                  category: "ai",
                  picks: items.slice(0, 3).map((i) => ({ itemId: i.id, summaryZh: "摘要" })),
                },
              ],
            },
    })
    const job = createDailyDigestJob(deps)
    const out = await job.reconcile(FRI_0800)
    assert.equal(out.status, "failed_summarize")
    assert.equal(sender.sent.length, 0)
    assert.ok(alerts.some((a) => a.includes("摘要") && a.includes("不发")))
    // 副作用边界：attempt 不烧、归档/账本/shown 全不落——错写任何一样都会毒化下一轮重跑
    const state = deps.ledger.read("2026-07-03")
    assert.ok(!state.sent)
    assert.equal(state.attempts.length, 0)
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-03", "digest.html")))
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-03", "summary.json")))
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-03", "shown.json")))
    assert.ok(!fs.existsSync(path.join(dir, "outbound-ledger.jsonl")))
    // 安全网：下一整点 reconcile（sent marker 缺失放行）→ 摘要成功 → 正常发出并落账
    const out2 = await job.reconcile(FRI_0800)
    assert.equal(out2.status, "ok")
    assert.equal(sender.sent.length, 1)
    assert.ok(deps.ledger.read("2026-07-03").sent)
  })

  it("yt 24h 延迟窗：太新视频本期不进报不烧 shown，次日字幕就绪后进报（07-12 小孙增强）", async () => {
    // 发布于 FRI_0800（=07-03T00:00Z）前 4h：首轮在延迟窗内；次日 SAT_0800 距发布 28h 放行
    const freshYt: DigestSource & { fetched: number } = {
      sourceId: "yt-anthropic",
      category: "ai",
      fetched: 0,
      async fetch() {
        freshYt.fetched++
        return [
          buildNormalizedItem(
            "yt-anthropic",
            "ai",
            "Fresh interpretability video",
            "https://www.youtube.com/watch?v=fresh1",
            "2026-07-02T20:00:00Z",
            "video",
          ),
        ]
      },
    }
    const fedTitles: string[][] = []
    const deps = makeDeps({
      sources: [freshYt, okSource("smol-ai")],
      summarize: async (items) => {
        fedTitles.push(items.map((i) => i.title))
        return {
          ...fakeSummary,
          editorialAssessments: approve(items),
          sections: [
            {
              category: "ai",
              picks: items.slice(0, 3).map((i) => ({ itemId: i.id, summaryZh: "摘要" })),
            },
          ],
        }
      },
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.ok(
      !fedTitles[0].includes("Fresh interpretability video"),
      "24h 内的 yt 条目不得进喂样池",
    )
    const shownDay1 = path.join(dir, "2026-07-03", "shown.json")
    assert.ok(fs.existsSync(shownDay1))
    assert.ok(
      !fs.readFileSync(shownDay1, "utf8").includes("watch?v=fresh1"),
      "延迟窗条目不得烧 shown（否则次日被已见账本压制=永久漏报）",
    )
    // 次日：同一条目距发布 28h → 出延迟窗，正常进喂样池
    assert.equal((await job.reconcile(SAT_0800, { force: true })).status, "ok")
    assert.ok(
      fedTitles[1].includes("Fresh interpretability video"),
      "出延迟窗后条目必须回到选材视野",
    )
  })

  it("B032 社区候选不再被语义词表预删：求助帖与技术帖都进审核视野", async () => {
    const commSource: DigestSource = {
      sourceId: "v2ex-hot",
      category: "community",
      async fetch() {
        return [
          buildNormalizedItem(
            "v2ex-hot",
            "community",
            "专科大二，喜欢底层开发，但有点迷茫想听听建议",
            "https://v2ex.com/t/noise1",
            "2026-07-03T00:00:00Z",
            "编程 代码 正文科技词穿透正向表的形态",
          ),
          buildNormalizedItem(
            "v2ex-hot",
            "community",
            "MoE 架构落地实践深度讨论",
            "https://v2ex.com/t/good1",
            "2026-07-03T00:00:00Z",
            "snippet",
          ),
        ]
      },
    }
    const aiSource: DigestSource = {
      sourceId: "hn-ai",
      category: "ai",
      async fetch() {
        return [
          buildNormalizedItem(
            "hn-ai",
            "ai",
            "转行做 AI 的工程师翻倍——行业调查报告", // 「转行」在词表；非 community 板块必须放行
            "https://a.com/report",
            "2026-07-03T00:00:00Z",
            "snippet",
          ),
        ]
      },
    }
    const fedTitles: string[][] = []
    const deps = makeDeps({
      sources: [commSource, aiSource],
      summarize: async (items) => {
        fedTitles.push(items.map((i) => i.title))
        return {
          ...fakeSummary,
          editorialAssessments: approve(items),
          sections: [
            {
              category: "ai",
              picks: items
                .filter((i) => i.category === "ai")
                .map((i) => ({ itemId: i.id, summaryZh: "摘要" })),
            },
          ],
        }
      },
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.ok(
      fedTitles[0].some((t) => t.includes("迷茫想听听建议")),
      "求助性质必须由 EditorialDecider 判 reject，不能在审核前靠词表删掉",
    )
    assert.ok(fedTitles[0].includes("MoE 架构落地实践深度讨论"), "正常社区讨论帖照常进喂样")
    assert.ok(
      fedTitles[0].includes("转行做 AI 的工程师翻倍——行业调查报告"),
      "AI 板块同词条目同样保留送审",
    )
  })

  it("反选熔断（B027 fail-closed）：异常反选只作废拒绝结论，不把未正向批准条目重新放出", async () => {
    const mkCommSource = (n: number): DigestSource => ({
      sourceId: "reddit-ai",
      category: "community",
      async fetch() {
        return Array.from({ length: n }, (_, k) =>
          buildNormalizedItem(
            "reddit-ai",
            "community",
            `大模型推理技术讨论第${k}号`,
            `https://reddit.com/r/burn${k}`,
            "2026-07-03T00:00:00Z",
            "基于 vLLM 与 SGLang 的 128K 上下文推理基准：连续批处理吞吐提升 22%，并附 CUDA kernel 与调度参数。",
          ),
        )
      },
    })
    const run = async (dropCount: number) => {
      const alerts: string[] = []
      // 每次独立 dir：同一测试内两轮 reconcile 同一天，共用 dir 会撞 sent marker
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-fuse-"))
      const deps = makeDeps({
        ledger: createFileAttemptLedger(runDir, "[daily-digest]"),
        health: createFileSourceHealthStore(runDir),
        baseDir: runDir,
        sources: [mkCommSource(5), okSource("smol-ai")],
        pushAlert: (m) => alerts.push(m),
        summarize: async (items) => {
          const comm = items.filter((i) => i.category === "community")
          const ai = items.filter((i) => i.category === "ai")
          return {
            overview: ["o"],
            editorialAssessments: approve(items),
            sections: [
              { category: "ai" as const, picks: ai.map((i) => ({ itemId: i.id, summaryZh: "s" })) },
              {
                category: "community" as const,
                picks: [],
                briefItemIds: comm.slice(dropCount).map((i) => i.id),
              },
            ],
            communityFedIds: comm.map((i) => i.id),
            communityDropIds: comm.slice(0, dropCount).map((i) => i.id),
            degraded: false,
          }
        },
      })
      const job = createDailyDigestJob(deps)
      assert.equal((await job.reconcile(FRI_0800)).status, "ok")
      const md = fs.readFileSync(path.join(runDir, "2026-07-03", "digest.md"), "utf8")
      return { alerts, md }
    }
    // 5/5=100% > 80% → 熔断：反选结论作废+告警；但没有任何正向批准，仍然一个都不发布
    const fused = await run(5)
    assert.ok(
      fused.alerts.some((a) => a.includes("反选熔断")),
      "超阈值必须告警留痕",
    )
    for (let k = 0; k < 5; k++)
      assert.ok(
        !fused.md.includes(`大模型推理技术讨论第${k}号`),
        `熔断不能把未正向批准的条目 ${k} 重新放出`,
      )
    // 2/5=40% ≤ 80% → 正常生效：被反选的 2 条移除，其余存活，无熔断告警
    const normal = await run(2)
    assert.ok(!normal.alerts.some((a) => a.includes("反选熔断")), "低比例不得误熔断")
    assert.ok(!normal.md.includes("大模型推理技术讨论第0号"), "被反选条目移除")
    assert.ok(!normal.md.includes("大模型推理技术讨论第1号"), "被反选条目移除")
    assert.ok(normal.md.includes("大模型推理技术讨论第2号"), "未反选条目存活")
  })

  it("DIGEST_FAILURE_STATUSES：三失败态在列、幂等噪音不在列（三拍 r1 P2-1 cron 适配层判定真相源；漏归类由 job.ts 编译期穷尽检查咬）", () => {
    for (const s of ["failed_no_items", "failed_summarize", "send_failed"] as const) {
      assert.ok(isDigestFailureStatus(s), s)
    }
    for (const s of [
      "ok",
      "skipped_not_due",
      "skipped_weekend",
      "skipped_already_sent",
      "skipped_needs_manual",
    ] as const) {
      assert.ok(!isDigestFailureStatus(s), s)
    }
  })

  it("并发双触发同一天 → 只发一封（德彪 P1r1-P1：跨触发点互斥）", async () => {
    const sender = makeSender()
    // 慢 summarize 拉大竞态窗口：无互斥时两路都会走到 send
    const deps = makeDeps({
      sender,
      summarize: async (items) => {
        await new Promise((r) => setTimeout(r, 50))
        return {
          overview: ["x"],
          editorialAssessments: approve(items),
          sections: [
            { category: "ai", picks: items.map((i) => ({ itemId: i.id, summaryZh: "s" })) },
          ],
          degraded: false,
        }
      },
    })
    const job = createDailyDigestJob(deps)
    const [a, b] = await Promise.all([job.reconcile(FRI_0800), job.reconcile(FRI_0800)])
    assert.equal(sender.sent.length, 1, "并发下只允许一次外发")
    assert.deepEqual([a.status, b.status].sort(), ["ok", "skipped_already_sent"])
  })

  it("已 sent → skipped_already_sent（幂等，不重发）", async () => {
    const sender = makeSender()
    const job = createDailyDigestJob(makeDeps({ sender }))
    await job.reconcile(FRI_0800)
    assert.equal((await job.reconcile(FRI_0800)).status, "skipped_already_sent")
    assert.equal(sender.sent.length, 1)
  })

  it("发送失败烧 attempt；第二次重试 note 标可能重复；两次后转人工", async () => {
    const alerts: string[] = []
    const deps = makeDeps({ sender: makeSender("throw"), pushAlert: (m) => alerts.push(m) })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "send_failed")
    assert.equal((await job.reconcile(FRI_0800)).status, "send_failed")
    const st = deps.ledger.read("2026-07-03")
    assert.equal(st.attempts.length, 2)
    assert.match(st.attempts[1].note, /可能重复/)
    assert.equal((await job.reconcile(FRI_0800)).status, "skipped_needs_manual")
    assert.ok(alerts.some((a) => a.includes("人工")))
  })

  it("全部内容源为空 → failed_no_items 且不烧 attempt（构建失败可无限重试）", async () => {
    const boom: DigestSource = {
      sourceId: "s",
      category: "ai",
      fetch: async () => {
        throw new Error("all down")
      },
    }
    const deps = makeDeps({ sources: [boom] })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "failed_no_items")
    assert.equal(deps.ledger.read("2026-07-03").attempts.length, 0)
  })

  it("GitHub 周榜每天常驻（07-07 小孙「增长、周榜、月榜都要」——周一门拆掉）", async () => {
    const gh = okSource("github-trending-weekly", "github")
    const job = createDailyDigestJob(makeDeps({ githubSources: [gh] }))
    await job.reconcile(FRI_0800) // 周五也带
    assert.equal(gh.calls.length, 1)
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("开源榜单"))
    assert.ok(html.includes(">周榜 · 1 条</td>"))
  })

  it("增长榜（日）每天都带：非周一/非 1 号也抓（07-05 分栏改版 #2）", async () => {
    const ghd = okSource("github-trending-daily", "github")
    const job = createDailyDigestJob(makeDeps({ githubDailySources: [ghd] }))
    await job.reconcile(FRI_0800) // 07-03 周五：非周一非 1 号
    assert.equal(ghd.calls.length, 1)
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("开源榜单"))
    assert.ok(html.includes(">增长榜 · 今日 · 1 条</td>"))
  })

  it("月榜每天常驻（#27；07-06 小孙「月榜咋没有了」——原每月 1 号门拆掉）；items.jsonl 证据底料落盘（F029）", async () => {
    const ghm = okSource("github-trending-monthly", "github")
    const job = createDailyDigestJob(makeDeps({ githubMonthlySources: [ghm] }))
    await job.reconcile(FRI_0800) // 07-03 平日（非周一非 1 号）也要有月榜
    assert.equal(ghm.calls.length, 1)
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("开源榜单"))
    assert.ok(html.includes(">月榜 · 1 条</td>"))
    // F029 证据底料：内容源 + github 源全量逐行 JSONL 可解析
    const lines = fs
      .readFileSync(path.join(dir, "2026-07-03", "items.jsonl"), "utf8")
      .trim()
      .split("\n")
    assert.equal(lines.length, 2) // smol-ai 1 条 + 月榜 1 条
    const parsed = lines.map((l) => JSON.parse(l) as NormalizedItem)
    assert.ok(parsed.some((i) => i.sourceId === "github-trending-monthly"))
    assert.ok(parsed.every((i) => i.canonicalUrl.startsWith("https://")))
  })

  it("GitHub 原始候选保留审计，但只有 AI eligibility=yes 进入开源榜单", async () => {
    const agentReach = githubItem("github-trending-daily", "Panniantong/Agent-Reach", "yes")
    const iptv = githubItem("github-trending-daily", "Free-TV/IPTV", "no")
    const githubSource: DigestSource = {
      sourceId: "github-trending-daily",
      category: "github",
      fetch: async () => [agentReach, iptv],
    }
    const job = createDailyDigestJob(makeDeps({ githubDailySources: [githubSource] }))

    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("Panniantong/Agent-Reach"))
    assert.ok(!html.includes("Free-TV/IPTV"))

    const raw = fs
      .readFileSync(path.join(dir, "2026-07-03", "items.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as NormalizedItem)
    assert.ok(
      raw.some((item) => item.title === "Free-TV/IPTV"),
      "拒绝项仍是可审计抓取证据",
    )
    const summaryDoc = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "summary.json"), "utf8"),
    ) as {
      githubItemIds: string[]
      githubEligibilityAudit: Array<{ itemId: string; state: string; reasons: string[] }>
    }
    assert.deepEqual(summaryDoc.githubItemIds, [agentReach.id])
    assert.ok(
      summaryDoc.githubEligibilityAudit.some(
        (entry) => entry.itemId === iptv.id && entry.state === "no" && entry.reasons.length > 0,
      ),
    )
  })

  it("增长榜连续上榜只加状态不隐藏；快照只按自然日推进", async () => {
    const changingContent: DigestSource = {
      sourceId: "hn-ai",
      category: "ai",
      async fetch(ctx) {
        const date = ctx.now().toISOString().slice(0, 10)
        return [
          buildNormalizedItem(
            "hn-ai",
            "ai",
            `AI progress ${date}`,
            `https://example.com/${date}`,
            `${date}T00:00:00Z`,
            "AI research progress",
          ),
        ]
      },
    }
    const agentReach = githubItem("github-trending-daily", "Panniantong/Agent-Reach", "yes")
    const githubSource: DigestSource = {
      sourceId: "github-trending-daily",
      category: "github",
      fetch: async () => [agentReach],
    }
    const job = createDailyDigestJob(
      makeDeps({ sources: [changingContent], githubDailySources: [githubSource] }),
    )

    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.ok(fs.existsSync(path.join(dir, "2026-07-03", "github-rank.json")))
    assert.ok(fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8").includes("NEW"))

    assert.equal((await job.reconcile(SAT_0800, { force: true })).status, "ok")
    const day2Html = fs.readFileSync(path.join(dir, "2026-07-04", "digest.html"), "utf8")
    assert.ok(day2Html.includes("Panniantong/Agent-Reach"), "连续上榜不是跨日去重条件")
    assert.ok(day2Html.includes("连续 2 日上榜"))
  })

  it("发送失败不写 GitHub 上榜快照", async () => {
    const githubSource: DigestSource = {
      sourceId: "github-trending-daily",
      category: "github",
      fetch: async () => [githubItem("github-trending-daily", "Panniantong/Agent-Reach", "yes")],
    }
    const job = createDailyDigestJob(
      makeDeps({ githubDailySources: [githubSource], sender: makeSender("throw") }),
    )
    assert.equal((await job.reconcile(FRI_0800)).status, "send_failed")
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-03", "github-rank.json")))
  })

  it("注入的有效 degraded 摘要保持旧归档兼容并可发送", async () => {
    const sender = makeSender()
    const job = createDailyDigestJob(
      makeDeps({
        sender,
        summarize: async (items) => ({
          overview: ["清单版"],
          editorialAssessments: approve(items),
          sections: [
            { category: "ai", picks: items.map((i) => ({ itemId: i.id, summaryZh: i.title })) },
          ],
          degraded: true,
        }),
      }),
    )
    const out = await job.reconcile(FRI_0800)
    assert.equal(out.status, "ok")
    assert.equal(out.degraded, true)
    assert.ok(sender.sent[0].subject.includes("清单版"))
  })
})

describe("设置页动态件（F037 §5：force 补发 + runtimeSettings 每轮现读）", () => {
  it("force：跳过 not_due / already_sent，二次补发真发第二封（账本 note 标 manual）", async () => {
    const sender = makeSender()
    const job = createDailyDigestJob(makeDeps({ sender }))
    // 07:00 未到点：force 照发
    assert.equal((await job.reconcile(FRI_0700, { force: true })).status, "ok")
    assert.equal(sender.sent.length, 1)
    // 已发过：常规轮幂等跳过，force 再发一封
    assert.equal((await job.reconcile(FRI_0800)).status, "skipped_already_sent")
    assert.equal((await job.reconcile(FRI_0800, { force: true })).status, "ok")
    assert.equal(sender.sent.length, 2)
    const ledger = JSON.parse(
      fs.readFileSync(path.join(dir, "ledger", "2026-07-03.json"), "utf8"),
    ) as { attempts: Array<{ note: string }> }
    assert.ok(ledger.attempts.some((a) => a.note.includes("manual")))
    assert.ok(ledger.attempts.some((a) => a.note.includes("manual_resend")))
  })

  it("runtimeSettings：sendTime/recipient/sender 每轮现读覆盖静态 deps", async () => {
    const staticSender = makeSender()
    const dynamicSender = makeSender()
    const job = createDailyDigestJob(
      makeDeps({
        sender: staticSender,
        recipient: "static@x.com",
        sendTime: "09:00", // 静态值：07:00 不该发
        runtimeSettings: () => ({
          sendTime: "06:30", // 覆盖后 07:00 已到点
          recipient: "dynamic@x.com",
          sender: dynamicSender,
        }),
      }),
    )
    assert.equal((await job.reconcile(FRI_0700)).status, "ok")
    assert.equal(staticSender.sent.length, 0)
    assert.equal(dynamicSender.sent.length, 1)
    assert.equal(dynamicSender.sent[0].to, "dynamic@x.com")
  })
})

describe("中文化补全接线（07-06 小孙：github 英文介绍 / 速览标题太扯）", () => {
  const mkFixtures = () => {
    const en = buildNormalizedItem(
      "hn-ai",
      "ai",
      "English rest story",
      "https://e.com/1",
      "2026-07-03T00:00:00Z",
      "s",
    )
    const zhItem = buildNormalizedItem(
      "hn-ai",
      "ai",
      "中文速览条",
      "https://e.com/2",
      "2026-07-03T00:01:00Z",
      "s",
    )
    const picked = buildNormalizedItem(
      "hn-ai",
      "ai",
      "Picked",
      "https://e.com/3",
      "2026-07-03T00:02:00Z",
      "s",
    )
    const ghBase = githubItem("github-trending-daily", "org/repo")
    const gh: NormalizedItem = {
      ...ghBase,
      rawSnippet: "+10 stars today · ★100 · Python · English repo desc",
      githubMeta: {
        ...ghBase.githubMeta!,
        windowStars: 10,
        totalStars: 100,
        language: "Python",
        description: "English repo desc",
      },
    }
    const src: DigestSource = {
      sourceId: "hn-ai",
      category: "ai",
      fetch: async () => [en, zhItem, picked],
    }
    const ghSrc: DigestSource = {
      sourceId: "github-trending-daily",
      category: "github",
      fetch: async () => [gh],
    }
    const summarize = async (): Promise<DigestSummary> => ({
      overview: [],
      degraded: false,
      editorialAssessments: approve([en, zhItem, picked]),
      sections: [
        {
          category: "ai",
          picks: [{ itemId: picked.id, summaryZh: "摘要" }],
          briefItemIds: [en.id, zhItem.id],
        },
      ],
    })
    return { en, zhItem, picked, gh, src, ghSrc, summarize }
  }

  it("产出并进 summary.json + 二次渲染进邮件；desc 提取 meta 前缀 + 已中文条预滤", async () => {
    const f = mkFixtures()
    let gotInput: TranslateExtrasInput | null = null
    const job = createDailyDigestJob(
      makeDeps({
        sources: [f.src],
        githubDailySources: [f.ghSrc],
        summarize: f.summarize,
        translateExtras: async (input) => {
          gotInput = input
          return {
            githubDescZh: { [f.gh.id]: "中文仓库描述" },
            restTitleZh: { [f.en.id]: "英文条的中文标题" },
          }
        },
      }),
    )
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.ok(gotInput, "translateExtras 应被调用")
    const input = gotInput as unknown as TranslateExtrasInput
    assert.deepEqual(input.github, [{ id: f.gh.id, name: "org/repo", desc: "English repo desc" }])
    assert.deepEqual(
      input.titles.map((t) => t.id),
      [f.en.id],
      "中文速览条不该送翻译",
    )
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("中文仓库描述"))
    assert.ok(!html.includes("English repo desc"))
    assert.ok(html.includes("英文条的中文标题"))
    const doc = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "summary.json"), "utf8"),
    ) as {
      summary: { githubDescZh?: Record<string, string>; restTitleZh?: Record<string, string> }
    }
    assert.equal(doc.summary.githubDescZh?.[f.gh.id], "中文仓库描述")
    assert.equal(doc.summary.restTitleZh?.[f.en.id], "英文条的中文标题")
  })

  it("translateExtras 抛错 → fail-open 保留英文照发（不烧报）", async () => {
    const f = mkFixtures()
    const sender = makeSender()
    const job = createDailyDigestJob(
      makeDeps({
        sources: [f.src],
        githubDailySources: [f.ghSrc],
        summarize: f.summarize,
        sender,
        translateExtras: async () => {
          throw new Error("llm down")
        },
      }),
    )
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.equal(sender.sent.length, 1)
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("English repo desc"))
  })
})

describe("选材预滤链（E1/E2，07-07 小孙「重复信息」「政治去除」）", () => {
  function multiSource(
    sourceId: string,
    entries: Array<{ title: string; url: string; publishedAt: string | null }>,
  ): DigestSource {
    return {
      sourceId,
      category: "ai",
      async fetch() {
        return entries.map((e) =>
          buildNormalizedItem(sourceId, "ai", e.title, e.url, e.publishedAt, "snippet"),
        )
      },
    }
  }

  function capturingSummarize(sink: { items: NormalizedItem[] }) {
    return async (items: NormalizedItem[]): Promise<DigestSummary> => {
      sink.items = items
      return {
        overview: ["o"],
        editorialAssessments: approve(items),
        sections: [
          {
            category: "ai",
            picks: items.slice(0, 1).map((i) => ({ itemId: i.id, summaryZh: "s" })),
            briefItemIds: items.slice(1).map((i) => i.id),
          },
        ],
        degraded: false,
      }
    }
  }

  it("7 天新鲜窗：旧档案条目不进 summarize；无日期保守保留；items.jsonl 证据底料仍全量", async () => {
    const sink = { items: [] as NormalizedItem[] }
    const src = multiSource("archive-src", [
      { title: "fresh", url: "https://a.com/fresh", publishedAt: "2026-07-02T00:00:00Z" },
      { title: "stale", url: "https://a.com/stale", publishedAt: "2026-05-01T00:00:00Z" },
      { title: "undated", url: "https://a.com/undated", publishedAt: null },
    ])
    const job = createDailyDigestJob(
      makeDeps({ sources: [src], summarize: capturingSummarize(sink) }),
    )
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.deepEqual(sink.items.map((i) => i.title).sort(), ["fresh", "undated"])
    const lines = fs
      .readFileSync(path.join(dir, "2026-07-03", "items.jsonl"), "utf8")
      .trim()
      .split("\n")
    assert.equal(lines.length, 3, "语料库要全量（选材口味不改写证据）")
  })

  it("政治词表硬滤：政治条目不进 summarize（语料库保留原样）", async () => {
    const sink = { items: [] as NormalizedItem[] }
    const src = multiSource("news-src", [
      { title: "vLLM 发布新版本", url: "https://a.com/vllm", publishedAt: "2026-07-02T08:00:00Z" },
      {
        title: "边境地区遭无人机袭击",
        url: "https://a.com/war",
        publishedAt: "2026-07-02T09:00:00Z",
      },
    ])
    const job = createDailyDigestJob(
      makeDeps({ sources: [src], summarize: capturingSummarize(sink) }),
    )
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.deepEqual(
      sink.items.map((i) => i.title),
      ["vLLM 发布新版本"],
    )
    const corpus = fs.readFileSync(path.join(dir, "2026-07-03", "items.jsonl"), "utf8")
    assert.ok(corpus.includes("无人机袭击"), "证据底料不受选材过滤影响")
  })

  it("跨日已见账本：发送成功落 shown.json；昨天发布的条目今天不再回流", async () => {
    const itemA = { title: "story-A", url: "https://a.com/A", publishedAt: "2026-07-02T00:00:00Z" }
    const itemB = { title: "story-B", url: "https://a.com/B", publishedAt: "2026-07-03T12:00:00Z" }
    // day1（07-03）：只有 A，发送成功
    const day1 = createDailyDigestJob(makeDeps({ sources: [multiSource("s1", [itemA])] }))
    assert.equal((await day1.reconcile(FRI_0800)).status, "ok")
    const shown = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "shown.json"), "utf8"),
    ) as { keys: string[] }
    const keyA = buildNormalizedItem(
      "s1",
      "ai",
      itemA.title,
      itemA.url,
      itemA.publishedAt,
      "x",
    ).dedupeKey
    assert.ok(shown.keys.includes(keyA), "A 实际发布后进入已见账本")
    // day2（07-04）：源回流 A + 新条 B → 选材只见 B
    const sink = { items: [] as NormalizedItem[] }
    const day2 = createDailyDigestJob(
      makeDeps({
        sources: [multiSource("s1", [itemA, itemB])],
        summarize: capturingSummarize(sink),
      }),
    )
    assert.equal((await day2.reconcile(SAT_0800, { force: true })).status, "ok")
    assert.deepEqual(
      sink.items.map((i) => i.title),
      ["story-B"],
    )
  })

  it("正式首发日忽略此前试发去重，首发实际发布项从次日起成为跨日去重基线", async () => {
    const itemA = {
      title: "trial-story-A",
      url: "https://a.com/formal-A",
      publishedAt: "2026-07-13T00:00:00Z",
    }
    const itemB = {
      title: "formal-story-B",
      url: "https://a.com/formal-B",
      publishedAt: "2026-07-15T00:00:00Z",
    }
    const itemC = {
      title: "next-day-story-C",
      url: "https://a.com/formal-C",
      publishedAt: "2026-07-16T00:00:00Z",
    }
    const shownLedgerNotBefore = "2026-07-15"

    const trial = createDailyDigestJob(
      makeDeps({
        sources: [multiSource("formal-src", [itemA])],
        shownLedgerNotBefore,
      }),
    )
    assert.equal((await trial.reconcile(new Date("2026-07-14T08:00:00+08:00"))).status, "ok")

    const launchSink = { items: [] as NormalizedItem[] }
    const launch = createDailyDigestJob(
      makeDeps({
        sources: [multiSource("formal-src", [itemA, itemB])],
        summarize: capturingSummarize(launchSink),
        shownLedgerNotBefore,
      }),
    )
    assert.equal((await launch.reconcile(new Date("2026-07-15T08:00:00+08:00"))).status, "ok")
    assert.deepEqual(
      launchSink.items.map((item) => item.title),
      ["trial-story-A", "formal-story-B"],
      "7 月 15 日正式首发不得被此前试发账本压制",
    )

    const dayAfterSink = { items: [] as NormalizedItem[] }
    const dayAfter = createDailyDigestJob(
      makeDeps({
        sources: [multiSource("formal-src", [itemA, itemB, itemC])],
        summarize: capturingSummarize(dayAfterSink),
        shownLedgerNotBefore,
      }),
    )
    assert.equal((await dayAfter.reconcile(new Date("2026-07-16T08:00:00+08:00"))).status, "ok")
    assert.deepEqual(
      dayAfterSink.items.map((item) => item.title),
      ["next-day-story-C"],
    )
    assert.ok(fs.existsSync(path.join(dir, "2026-07-14", "shown.json")))
  })

  it("B027：archive、邮件与 shown 只消费最终 publication；未审核条目留证据但不发布不烧账", async () => {
    const entries = [
      { title: "精选推理", url: "https://a.com/pick", publishedAt: "2026-07-02T01:00:00Z" },
      { title: "批准速览", url: "https://a.com/brief", publishedAt: "2026-07-02T02:00:00Z" },
      {
        title: "UNREVIEWED 不得补位",
        url: "https://a.com/unreviewed",
        publishedAt: "2026-07-02T03:00:00Z",
      },
    ]
    const job = createDailyDigestJob(
      makeDeps({
        sources: [multiSource("editorial-src", entries)],
        summarize: async (fed) => ({
          overview: ["要点"],
          editorialAssessments: approve(fed.slice(0, 2)),
          sections: [
            {
              category: "ai",
              picks: [{ itemId: fed[0].id, summaryZh: "精选摘要", tag: "推理" }],
              briefItemIds: [fed[1].id],
            },
          ],
          degraded: false,
        }),
      }),
    )

    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    const dayDir = path.join(dir, "2026-07-03")
    const md = fs.readFileSync(path.join(dayDir, "digest.md"), "utf8")
    assert.ok(md.includes("精选推理"))
    assert.ok(md.includes("批准速览"))
    assert.ok(!md.includes("UNREVIEWED 不得补位"))

    const archive = JSON.parse(fs.readFileSync(path.join(dayDir, "summary.json"), "utf8")) as {
      publication?: {
        schemaVersion: number
        sections: Array<{ entries: Array<{ itemId: string }> }>
      }
      counts?: { content: number; scanned?: number }
    }
    assert.equal(archive.publication?.schemaVersion, 2)
    const publishedIds = archive.publication?.sections.flatMap((section) =>
      section.entries.map((entry) => entry.itemId),
    )
    assert.equal(publishedIds?.length, 2)
    assert.equal(archive.counts?.content, 2, "分栏计数必须等于最终 publication")
    assert.equal(archive.counts?.scanned, 3, "收录口径保留审核前候选数，与邮件刊头一致")

    const corpus = fs.readFileSync(path.join(dayDir, "items.jsonl"), "utf8")
    assert.ok(corpus.includes("UNREVIEWED 不得补位"), "raw 证据池仍保留未审核条目")
    const shown = JSON.parse(fs.readFileSync(path.join(dayDir, "shown.json"), "utf8")) as {
      keys: string[]
    }
    const normalized = entries.map((entry) =>
      buildNormalizedItem(
        "editorial-src",
        "ai",
        entry.title,
        entry.url,
        entry.publishedAt,
        "snippet",
      ),
    )
    assert.ok(shown.keys.includes(normalized[0].dedupeKey))
    assert.ok(shown.keys.includes(normalized[1].dedupeKey))
    assert.ok(!shown.keys.includes(normalized[2].dedupeKey), "未实际发布条目不得烧 shown")

    const outbound = fs
      .readFileSync(path.join(dir, "outbound-ledger.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { sections: Record<string, number> })
    assert.equal(outbound.at(-1)?.sections.ai, 2, "外发账本必须按最终 publication 的实际条目计数")
  })

  it("B027：结构策略把最终 publication 清空时不得发送空日报或写 sent", async () => {
    const sender = makeSender()
    const communitySource: DigestSource = {
      sourceId: "community-only",
      category: "community",
      async fetch() {
        return [
          buildNormalizedItem(
            "community-only",
            "community",
            "奔三 感觉自己漂泊不定 怎么规划人生",
            "https://example.com/life",
            "2026-07-02T03:00:00Z",
            "AI 创业后仍然迷茫，想听人生建议",
          ),
        ]
      },
    }
    const deps = makeDeps({
      sender,
      sources: [communitySource],
      summarize: async (fed) => ({
        overview: ["人生规划求助"],
        overviewRefs: [{ text: "人生规划求助", itemIds: [fed[0].id] }],
        editorialAssessments: [
          {
            itemId: fed[0].id,
            sourceCategory: "community",
            reviewState: "eligible",
            topicTags: ["agent"],
            organizationTags: [],
            ecosystemTags: [],
            regionTags: ["cn"],
            contentKind: "discussion",
            confidence: 0.99,
          },
        ],
        sections: [
          {
            category: "community",
            picks: [{ itemId: fed[0].id, summaryZh: "人生规划求助" }],
          },
        ],
        degraded: false,
      }),
    })
    const job = createDailyDigestJob(deps)

    const out = await job.reconcile(FRI_0800)

    assert.equal(out.status, "failed_summarize")
    assert.equal(sender.sent.length, 0)
    assert.equal(deps.ledger.read("2026-07-03").sent, null)
  })

  it("B032：Claude 全挂的降级模式中，推理未决只摘条目并告警，不拖死其余非空日报", async () => {
    const alerts: string[] = []
    const inferenceSource: DigestSource = {
      sourceId: "vllm-blog",
      category: "ai",
      async fetch() {
        return [
          buildNormalizedItem(
            "vllm-blog",
            "ai",
            "vLLM KV cache 推理吞吐优化",
            "https://example.com/inference-unresolved",
            "2026-07-03T00:00:00Z",
            "vLLM serving throughput latency KV cache benchmark",
          ),
        ]
      },
    }
    const hotSource: DigestSource = {
      sourceId: "tech-hot",
      category: "hot",
      async fetch() {
        return [
          buildNormalizedItem(
            "tech-hot",
            "hot",
            "科技产业今日进展",
            "https://example.com/hot-publish",
            "2026-07-03T00:00:00Z",
            "产业发布具体进展",
          ),
        ]
      },
    }
    const deps = makeDeps({
      sources: [inferenceSource, hotSource],
      pushAlert: (message) => alerts.push(message),
      summarize: async (fed) => {
        const inference = fed.find((entry) => entry.category === "ai")!
        const hot = fed.find((entry) => entry.category === "hot")!
        const hotVote: EditorialReviewVote = {
          itemId: hot.id,
          basis: "ai_industry_event",
          topicTags: ["other"],
          organizationTags: [],
          ecosystemTags: [],
          regionTags: ["cn"],
          evidence: [
            {
              field: "snippet",
              quote: hot.rawSnippet.slice(0, 160),
              supports: "substantive_fact",
            },
          ],
          confidence: 0.9,
          reviewerTarget: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
          reviewerSlot: "codex_pass_1",
        }
        const editorialDecisionSet = buildEditorialDecisionSet(buildEditorialPromptItems(fed), [
          {
            itemId: inference.id,
            sourceCategory: "ai",
            reviewState: "unreviewed",
            rejectReason: "classifier_failure",
            topicTags: [],
            organizationTags: [],
            ecosystemTags: [],
            regionTags: [],
            contentKind: "other",
            confidence: 0,
            reviewMode: "degraded_same_target",
            votes: [],
          },
          {
            itemId: hot.id,
            sourceCategory: "hot",
            reviewState: "eligible",
            basis: "ai_industry_event",
            topicTags: ["other"],
            organizationTags: [],
            ecosystemTags: [],
            regionTags: ["cn"],
            contentKind: "industry",
            confidence: 0.9,
            reviewMode: "degraded_same_target",
            votes: [hotVote],
          },
        ])
        return {
          overview: ["科技产业今日进展"],
          overviewRefs: [{ text: "科技产业今日进展", itemIds: [hot.id] }],
          editorialDecisionSet,
          sections: [
            {
              category: "hot",
              picks: [{ itemId: hot.id, summaryZh: "科技产业发布新进展。", tag: "科技" }],
            },
          ],
          degraded: false,
        }
      },
    })

    const out = await createDailyDigestJob(deps).reconcile(FRI_0800)

    assert.equal(out.status, "ok")
    assert.ok(alerts.some((message) => message.includes("inference_review_unresolved")))
    const markdown = fs.readFileSync(path.join(dir, "2026-07-03", "digest.md"), "utf8")
    assert.ok(markdown.includes("推理候选审核未决"))
    const archive = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "summary.json"), "utf8"),
    ) as {
      schemaVersion: number
      summary?: { editorialDecisionSet?: { schemaVersion: number; reviewMode: string } }
    }
    assert.equal(archive.schemaVersion, 2, "B032 不得抬升既有归档外层 schema")
    assert.equal(archive.summary?.editorialDecisionSet?.schemaVersion, 1)
    assert.equal(archive.summary?.editorialDecisionSet?.reviewMode, "degraded_same_target")
  })

  it("B032：五条获批内容若终态速览不足五条，必须失败关闭而不是发送缩水日报", async () => {
    const alerts: string[] = []
    const sender = makeSender()
    const source: DigestSource = {
      sourceId: "ai-research",
      category: "ai",
      async fetch() {
        return Array.from({ length: 5 }, (_, index) =>
          buildNormalizedItem(
            "ai-research",
            "ai",
            `AI research result ${index + 1}`,
            `https://example.com/research-${index + 1}`,
            "2026-07-03T00:00:00Z",
            `Researchers published reproducible experiment ${index + 1} with technical results.`,
          ),
        )
      },
    }
    const deps = makeDeps({
      sources: [source],
      sender,
      pushAlert: (message) => alerts.push(message),
      summarize: async (fed) => {
        const decisions = fed.map((target) => {
          const vote: EditorialReviewVote = {
            itemId: target.id,
            basis: "research_result",
            topicTags: ["research"],
            organizationTags: [],
            ecosystemTags: [],
            regionTags: ["global"],
            evidence: [
              { field: "snippet", quote: target.rawSnippet, supports: "ai_relevance" },
              { field: "snippet", quote: target.rawSnippet, supports: "substantive_fact" },
            ],
            confidence: 0.95,
            reviewerTarget: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
            reviewerSlot: "codex_pass_1",
          }
          const secondVote: EditorialReviewVote = {
            ...vote,
            evidence: vote.evidence.map((entry) => ({ ...entry })),
            reviewerSlot: "codex_pass_2",
          }
          return {
            itemId: target.id,
            sourceCategory: target.category,
            reviewState: "eligible" as const,
            basis: "research_result" as const,
            topicTags: ["research" as const],
            organizationTags: [],
            ecosystemTags: [],
            regionTags: ["global" as const],
            contentKind: "research" as const,
            confidence: 0.95,
            reviewMode: "degraded_same_target" as const,
            votes: [vote, secondVote],
          }
        })
        const overviewRefs = fed.slice(0, 4).map((target, index) => ({
          text: `速览 ${index + 1}`,
          itemIds: [target.id],
        }))
        return {
          overview: overviewRefs.map((entry) => entry.text),
          overviewRefs,
          editorialDecisionSet: buildEditorialDecisionSet(
            buildEditorialPromptItems(fed),
            decisions,
          ),
          sections: [
            {
              category: "ai",
              picks: fed.map((target) => ({
                itemId: target.id,
                summaryZh: `${target.title} 发布了可复现实验结果。`,
              })),
            },
          ],
          degraded: false,
        }
      },
    })

    const out = await createDailyDigestJob(deps).reconcile(FRI_0800)

    assert.equal(out.status, "failed_summarize")
    assert.equal(sender.sent.length, 0)
    assert.ok(
      alerts.some((message) => message.includes("实际 4 条，要求 5-8 条")),
      alerts.join("\n"),
    )
    assert.equal(deps.ledger.read("2026-07-03").sent, null)
  })

  it("B032：畸形 decision set 在 job 边界失败关闭并告警，不得抛异常或发送", async () => {
    const alerts: string[] = []
    const sender = makeSender()
    const source: DigestSource = {
      sourceId: "tech-hot",
      category: "hot",
      async fetch() {
        return [
          buildNormalizedItem(
            "tech-hot",
            "hot",
            "AI 产品发布进展",
            "https://example.com/malformed-decision-set",
            "2026-07-03T00:00:00Z",
            "AI 产品发布了具体功能进展。",
          ),
        ]
      },
    }
    const deps = makeDeps({
      sources: [source],
      sender,
      pushAlert: (message) => alerts.push(message),
      summarize: async (fed) => ({
        overview: [],
        editorialDecisionSet: {} as NonNullable<DigestSummary["editorialDecisionSet"]>,
        sections: [
          {
            category: "hot",
            picks: [{ itemId: fed[0].id, summaryZh: "AI 产品发布了具体功能。" }],
          },
        ],
        degraded: false,
      }),
    })

    const out = await createDailyDigestJob(deps).reconcile(FRI_0800)

    assert.equal(out.status, "failed_summarize")
    assert.equal(sender.sent.length, 0)
    assert.ok(alerts.some((message) => message.includes("editorial_decision_set_invalid")))
  })

  it("修复丢节类目：未发布候选不烧 shown + notes 透出（德彪 r-final P1-3）", async () => {
    const src = multiSource("s1", [
      { title: "被丢节的候选", url: "https://a.com/lost", publishedAt: "2026-07-02T00:00:00Z" },
    ])
    const hotSource: DigestSource = {
      sourceId: "hot-source",
      category: "hot",
      async fetch() {
        return [
          buildNormalizedItem(
            "hot-source",
            "hot",
            "实际发布的热点",
            "https://a.com/hot",
            "2026-07-02T01:00:00Z",
            "AI 产业进展",
          ),
        ]
      },
    }
    const deps = makeDeps({
      sources: [src, hotSource],
      summarize: async (items) => {
        const hot = items.find((item) => item.category === "hot")
        assert.ok(hot)
        return {
          overview: ["要点"],
          editorialAssessments: approve([hot]),
          sections: [
            {
              category: "hot",
              picks: [{ itemId: hot.id, summaryZh: "热点摘要" }],
            },
          ],
          degraded: false,
          repairDroppedCategories: ["ai"],
        }
      },
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    const shown = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "shown.json"), "utf8"),
    ) as { keys: string[] }
    const lost = buildNormalizedItem(
      "s1",
      "ai",
      "被丢节的候选",
      "https://a.com/lost",
      "2026-07-02T00:00:00Z",
      "snippet",
    )
    assert.ok(!shown.keys.includes(lost.dedupeKey), "丢节候选未发布，不得烧已见（候选明日回补）")
    assert.equal(shown.keys.length, 1, "只有实际发布的热点进入已见账本")
    const md = fs.readFileSync(path.join(dir, "2026-07-03", "digest.md"), "utf8")
    assert.ok(md.includes("截断已修复"), "缺节要在邮件里透出")
  })

  it("仅有速览且终态密度裁为 0 时不得发送空日报", async () => {
    const sender = makeSender()
    const deps = makeDeps({
      sender,
      runtimeSettings: () => ({ restOverviewRows: 0 }),
      summarize: async (items) => ({
        overview: [],
        editorialAssessments: approve(items),
        sections: [
          {
            category: "ai",
            picks: [],
            briefItemIds: items.map((item) => item.id),
          },
        ],
        degraded: false,
      }),
    })
    const job = createDailyDigestJob(deps)

    const out = await job.reconcile(FRI_0800)

    assert.equal(out.status, "failed_summarize")
    assert.equal(sender.sent.length, 0)
    assert.equal(deps.ledger.read("2026-07-03").sent, null)
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-03", "digest.html")))
  })

  it("终态密度裁剪不得让合格非推理 AI 消失后只发送推理", async () => {
    const sender = makeSender()
    const alerts: string[] = []
    const inference = buildNormalizedItem(
      "ai-mixed",
      "ai",
      "vLLM KV cache 量化提升推理吞吐",
      "https://a.com/inference",
      "2026-07-02T01:00:00Z",
      "推理服务吞吐与延迟优化",
    )
    const modelRelease = buildNormalizedItem(
      "ai-mixed",
      "ai",
      "新模型能力与评测进展",
      "https://a.com/model-release",
      "2026-07-02T02:00:00Z",
      "模型发布与评测结果",
    )
    const mixedSource: DigestSource = {
      sourceId: "ai-mixed",
      category: "ai",
      fetch: async () => [inference, modelRelease],
    }
    const deps = makeDeps({
      sender,
      pushAlert: (message) => alerts.push(message),
      sources: [mixedSource],
      runtimeSettings: () => ({ restOverviewRows: 0 }),
      summarize: async () => ({
        overview: [],
        editorialAssessments: [
          {
            itemId: inference.id,
            sourceCategory: "ai",
            reviewState: "eligible",
            topicTags: ["inference"],
            organizationTags: [],
            ecosystemTags: ["open_source"],
            regionTags: ["global"],
            contentKind: "engineering",
            confidence: 0.99,
          },
          {
            itemId: modelRelease.id,
            sourceCategory: "ai",
            reviewState: "eligible",
            topicTags: ["model_release"],
            organizationTags: [],
            ecosystemTags: [],
            regionTags: ["global"],
            contentKind: "release",
            confidence: 0.99,
          },
        ],
        sections: [
          {
            category: "ai",
            picks: [{ itemId: inference.id, summaryZh: "推理优化摘要", tag: "推理" }],
            briefItemIds: [modelRelease.id],
          },
        ],
        degraded: false,
      }),
    })

    const out = await createDailyDigestJob(deps).reconcile(FRI_0800)

    assert.equal(out.status, "failed_summarize")
    assert.equal(sender.sent.length, 0)
    assert.equal(deps.ledger.read("2026-07-03").sent, null)
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-03", "digest.html")))
    assert.ok(alerts.some((message) => message.includes("非推理")))
  })

  it("构建成功但发送失败 → 不落 shown.json（失败不烧已见）", async () => {
    const src = multiSource("s1", [
      { title: "t", url: "https://a.com/t", publishedAt: "2026-07-02T00:00:00Z" },
    ])
    const job = createDailyDigestJob(makeDeps({ sources: [src], sender: makeSender("throw") }))
    assert.equal((await job.reconcile(FRI_0800)).status, "send_failed")
    assert.equal(fs.existsSync(path.join(dir, "2026-07-03", "shown.json")), false)
  })

  it("邮件字节预算（07-07 v4 104KB 字节被 Gmail 裁尾）：超预算自动降速览密度到 0 行", async () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      title: `条目标题-${i}`,
      url: `https://a.com/${i}`,
      publishedAt: "2026-07-02T00:00:00Z",
    }))
    // 对照组：默认预算（96KB）下 15 条只精选 3 条 → 有「其余速览」区
    const jobA = createDailyDigestJob(makeDeps({ sources: [multiSource("s1", entries)] }))
    assert.equal((await jobA.reconcile(FRI_0800)).status, "ok")
    const htmlA = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(htmlA.includes("其余速览"), "对照组应有速览区")
    // 实验组：12.5KiB 预算位于「3 行仍超、0 行可发」之间，逼降密度阶梯打到底
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "f037-budget-"))
    const emailByteBudget = 12_800
    const jobB = createDailyDigestJob(
      makeDeps({
        ledger: createFileAttemptLedger(dir2, "[daily-digest]"),
        health: createFileSourceHealthStore(dir2),
        baseDir: dir2,
        sources: [multiSource("s1", entries)],
        emailByteBudget,
      }),
    )
    assert.equal((await jobB.reconcile(FRI_0800)).status, "ok")
    const htmlB = fs.readFileSync(path.join(dir2, "2026-07-03", "digest.html"), "utf8")
    assert.ok(!htmlB.includes("其余速览"), "超预算应降到 0 行速览")
    assert.ok(Buffer.byteLength(htmlB, "utf8") <= emailByteBudget, "终态 HTML 必须守住硬预算")
    const archiveB = JSON.parse(
      fs.readFileSync(path.join(dir2, "2026-07-03", "summary.json"), "utf8"),
    ) as { publication: { sections: Array<{ entries: unknown[] }> } }
    const finalPublishedCount = archiveB.publication.sections.reduce(
      (count, section) => count + section.entries.length,
      0,
    )
    const shownB = JSON.parse(
      fs.readFileSync(path.join(dir2, "2026-07-03", "shown.json"), "utf8"),
    ) as { keys: string[] }
    assert.equal(finalPublishedCount, 3, "预算裁掉的 brief 必须同步从最终 publication 删除")
    assert.equal(shownB.keys.length, finalPublishedCount, "shown 必须与最终实际发布集合严格同源")
  })

  it("B045：周一自动降到 0 行速览时不得把密度隐藏误报为无合资格内容", async () => {
    const aiItem = buildNormalizedItem(
      "weekend-ai",
      "ai",
      "周末 AI 精选",
      "https://a.com/weekend-ai",
      "2026-07-26T00:00:00Z",
      "snippet",
    )
    const communityItems = Array.from({ length: 12 }, (_, i) =>
      buildNormalizedItem(
        "weekend-community",
        "community",
        `开源社区发布大模型推理吞吐优化技术方案-${i}`,
        `https://a.com/weekend-community-${i}`,
        "2026-07-26T00:00:00Z",
        "snippet",
      ),
    )
    const aiSource: DigestSource = {
      sourceId: "weekend-ai",
      category: "ai",
      fetch: async () => [aiItem],
    }
    const communitySource: DigestSource = {
      sourceId: "weekend-community",
      category: "community",
      fetch: async () => communityItems,
    }
    const budgetDir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-weekend-budget-"))
    const emailByteBudget = 22_500
    const diagnostics: string[] = []
    const job = createDailyDigestJob(
      makeDeps({
        ledger: createFileAttemptLedger(budgetDir, "[daily-digest]"),
        health: createFileSourceHealthStore(budgetDir),
        baseDir: budgetDir,
        sources: [aiSource, communitySource],
        emailByteBudget,
        log: (message) => diagnostics.push(message),
        pushAlert: (message) => diagnostics.push(message),
        summarize: async (items) => ({
          overview: ["周末摘要"],
          editorialAssessments: approve(items),
          sections: [
            {
              category: "ai",
              picks: [{ itemId: aiItem.id, summaryZh: "AI 精选摘要" }],
            },
            {
              category: "community",
              picks: [],
              briefItemIds: communityItems.map((item) => item.id),
            },
          ],
          degraded: false,
        }),
      }),
    )

    assert.equal(
      (await job.reconcile(MON_0900)).status,
      "ok",
      diagnostics.join("\n"),
    )
    const html = fs.readFileSync(path.join(budgetDir, "2026-07-27", "digest.html"), "utf8")
    assert.ok(!html.includes("其余速览"), "实验预算应把周一速览自动降到 0 行")
    assert.ok(!html.includes("本周末暂无合资格的社区动态"))
    assert.ok(html.includes("本周末有合资格内容，因邮件密度设置未展开"))
    assert.ok(Buffer.byteLength(html, "utf8") <= emailByteBudget)
  })

  it("B035：密度阶梯耗尽后仍超 98KiB 必须 fail-closed，禁止 Gmail 裁断正文", async () => {
    const sender = makeSender()
    const alerts: string[] = []
    const longTitle = "超长标题".repeat(10_000)
    const longTitleSource: DigestSource = {
      sourceId: "long-title",
      category: "ai",
      async fetch() {
        return [
          buildNormalizedItem(
            "long-title",
            "ai",
            longTitle,
            "https://example.com/long-title",
            "2026-07-02T00:00:00Z",
            "合法但异常长的上游标题",
          ),
        ]
      },
    }
    const deps = makeDeps({
      sender,
      sources: [longTitleSource],
      pushAlert: (message) => alerts.push(message),
    })

    const out = await createDailyDigestJob(deps).reconcile(FRI_0800)

    assert.equal(out.status, "failed_summarize")
    assert.equal(sender.sent.length, 0, "超预算正文不得交给 SMTP")
    assert.equal(deps.ledger.read("2026-07-03").sent, null)
    assert.equal(deps.ledger.read("2026-07-03").attempts.length, 0)
    assert.ok(!fs.existsSync(path.join(dir, "2026-07-03", "digest.html")))
    assert.ok(!fs.existsSync(path.join(dir, "outbound-ledger.jsonl")))
    assert.ok(alerts.some((message) => message.includes("HTML") && message.includes("不发送")))
  })
})

describe("#33 播客速递编辑门禁（B027：单集也要正向批准）", () => {
  const podcastSource = (title = "新集"): DigestSource => ({
    sourceId: "podcast-transcribe",
    category: "podcast",
    async fetch() {
      return [
        {
          ...buildNormalizedItem(
            "podcast-transcribe",
            "podcast",
            `42章经｜${title}`,
            "https://www.xiaoyuzhoufm.com/episode/e1",
            "2026-07-02T13:30:00Z",
            "• 要点一：AI 下半场\n• 要点二：嘉宾判断",
          ),
          topicTag: "42章经",
        },
      ]
    },
  })

  it("播客进入 summarize；只发布明确批准的 AI 单集，未批准单集只留 raw 证据", async () => {
    const sender = makeSender()
    const fedCategories: string[] = []
    const mixedPodcastSource: DigestSource = {
      sourceId: "podcast-transcribe",
      category: "podcast",
      async fetch() {
        return [
          buildNormalizedItem(
            "podcast-transcribe",
            "podcast",
            "42章经｜大模型推理服务优化",
            "https://www.xiaoyuzhoufm.com/episode/ai",
            "2026-07-02T13:30:00Z",
            "vLLM、KV cache 与吞吐实践",
          ),
          buildNormalizedItem(
            "podcast-transcribe",
            "podcast",
            "42章经｜旅行闲聊",
            "https://www.xiaoyuzhoufm.com/episode/chat",
            "2026-07-02T14:30:00Z",
            "旅行见闻与生活闲聊",
          ),
        ]
      },
    }
    const deps = makeDeps({
      sender,
      sources: [okSource("smol-ai"), mixedPodcastSource],
      summarize: async (items) => {
        for (const i of items) fedCategories.push(i.category)
        const ai = items.filter((item) => item.category === "ai")
        const podcasts = items.filter((item) => item.category === "podcast")
        return {
          overview: ["x"],
          editorialAssessments: approve([...ai, podcasts[0]]),
          sections: [
            {
              category: "ai",
              picks: ai.slice(0, 1).map((i) => ({ itemId: i.id, summaryZh: "s" })),
            },
            { category: "podcast", picks: [], briefItemIds: [podcasts[0].id] },
          ],
          degraded: false,
        }
      },
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.ok(fedCategories.includes("podcast"), "播客单集必须进入编辑审核视野")
    // 进邮件（节 + 标题 + 要点）
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("播客速递"))
    assert.ok(html.includes("42章经｜大模型推理服务优化"))
    assert.ok(!html.includes("42章经｜旅行闲聊"), "未获批准的闲聊单集不得直出")
    // counts.podcast 落盘（网页版 checkLine 口径）
    const doc = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "summary.json"), "utf8"),
    ) as {
      counts: { podcast?: number }
    }
    assert.equal(doc.counts.podcast, 1)
    // items.jsonl 语料含播客（F029 底料）
    const corpus = fs.readFileSync(path.join(dir, "2026-07-03", "items.jsonl"), "utf8")
    assert.ok(corpus.includes("podcast-transcribe"))
    assert.ok(corpus.includes("42章经｜旅行闲聊"), "未发布单集仍保留为审计证据")
  })

  it("发送成功烧 shown → 次日同集不再成节（跨日去重）", async () => {
    // content 源每轮出新 URL（现实：每天有新文章），播客源固定同集（缓存直出语义）
    let n = 0
    const freshContent: DigestSource = {
      sourceId: "smol-ai",
      category: "ai",
      async fetch() {
        n++
        return [
          buildNormalizedItem(
            "smol-ai",
            "ai",
            `每日新文 ${n}`,
            `https://x.com/post-${n}`,
            "2026-07-03T00:00:00Z",
            "snippet",
          ),
        ]
      },
    }
    const deps = makeDeps({ sources: [freshContent, podcastSource()] })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    const htmlDay1 = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(htmlDay1.includes("播客速递"))
    // 次日：源仍返回同集（缓存直出的语义），shown 账本应压掉 → 无播客节
    assert.equal((await job.reconcile(SAT_0800, { force: true })).status, "ok")
    const htmlDay2 = fs.readFileSync(path.join(dir, "2026-07-04", "digest.html"), "utf8")
    assert.ok(!htmlDay2.includes("播客速递"), "已上报的集次日不回流")
  })

  it("常规源全空 + 仅播客有新集 → 仍经审核后照发", async () => {
    let summarizeCalls = 0
    const emptySource: DigestSource = {
      sourceId: "smol-ai",
      category: "ai",
      async fetch() {
        return []
      },
    }
    const deps = makeDeps({
      sources: [emptySource, podcastSource()],
      summarize: async (items) => {
        summarizeCalls++
        const podcasts = items.filter((item) => item.category === "podcast")
        return {
          ...fakeSummary,
          editorialAssessments: approve(podcasts),
          sections: [
            { category: "podcast", picks: [], briefItemIds: podcasts.map((item) => item.id) },
          ],
        }
      },
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.equal(summarizeCalls, 1, "只有播客时也必须走一次编辑审核")
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("播客速递"))
  })
})
