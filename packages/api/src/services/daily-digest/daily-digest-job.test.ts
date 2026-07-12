import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, it } from "node:test"
import {
  type DailyDigestJobDeps,
  createDailyDigestJob,
  isDigestFailureStatus,
} from "./daily-digest-job"
import { createFileDigestLedger } from "./digest-ledger"
import type { EmailSender } from "./email-sender"
import { buildNormalizedItem } from "./feed-parsers"
import { createFileSourceHealthStore } from "./source-health"
import type { TranslateExtrasInput } from "./summarizer"
import type { DigestSource, DigestSummary, NormalizedItem } from "./types"

// 2026-07-03 是周五。GitHub 四榜 07-07 起全常驻（周一门/每月 1 号门都已拆）
const FRI_0800 = new Date("2026-07-03T08:00:00+08:00")
const FRI_0700 = new Date("2026-07-03T07:00:00+08:00")
const SAT_0800 = new Date("2026-07-04T08:00:00+08:00")

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

function makeDeps(overrides: Partial<DailyDigestJobDeps> = {}): DailyDigestJobDeps {
  return {
    ledger: createFileDigestLedger(dir),
    health: createFileSourceHealthStore(dir),
    sources: [okSource("smol-ai")],
    http: { fetchText: async () => "" },
    summarize: async (items) => ({
      ...fakeSummary,
      sections: [
        {
          category: "ai",
          picks: items.slice(0, 3).map((i) => ({ itemId: i.id, summaryZh: "摘要" })),
        },
      ],
    }),
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
    assert.equal((await job.reconcile(SAT_0800)).status, "ok")
    assert.ok(
      fedTitles[1].includes("Fresh interpretability video"),
      "出延迟窗后条目必须回到选材视野",
    )
  })

  it("社区噪声预滤（07-12 小孙）：community 求助帖不进喂样；ai 板块同词条目不受影响", async () => {
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
      !fedTitles[0].some((t) => t.includes("迷茫想听听建议")),
      "community 求助帖不得进喂样池（结构层词表）",
    )
    assert.ok(
      fedTitles[0].includes("MoE 架构落地实践深度讨论"),
      "正常社区讨论帖照常进喂样",
    )
    assert.ok(
      fedTitles[0].includes("转行做 AI 的工程师翻倍——行业调查报告"),
      "词表只限 community 板块——ai 板块同词条目是产业新闻，不得误伤",
    )
  })

  it("反选熔断（德彪 hitrate-r1 P2）：有效反选 >80% 判注入 → 作废+告警；低比例正常生效", async () => {
    const mkCommSource = (n: number): DigestSource => ({
      sourceId: "reddit-ai",
      category: "community",
      async fetch() {
        return Array.from({ length: n }, (_, k) =>
          buildNormalizedItem(
            "reddit-ai",
            "community",
            `社区技术讨论第${k}号`,
            `https://reddit.com/r/burn${k}`,
            "2026-07-03T00:00:00Z",
            "snippet",
          ),
        )
      },
    })
    const run = async (dropCount: number) => {
      const alerts: string[] = []
      // 每次独立 dir：同一测试内两轮 reconcile 同一天，共用 dir 会撞 sent marker
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "f037-fuse-"))
      const deps = makeDeps({
        ledger: createFileDigestLedger(runDir),
        health: createFileSourceHealthStore(runDir),
        baseDir: runDir,
        sources: [mkCommSource(5), okSource("smol-ai")],
        pushAlert: (m) => alerts.push(m),
        summarize: async (items) => {
          const comm = items.filter((i) => i.category === "community")
          const ai = items.filter((i) => i.category === "ai")
          return {
            overview: ["o"],
            sections: [
              { category: "ai" as const, picks: ai.map((i) => ({ itemId: i.id, summaryZh: "s" })) },
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
    // 5/5=100% > 80% → 熔断：反选作废（全部条目存活）+告警
    const fused = await run(5)
    assert.ok(fused.alerts.some((a) => a.includes("反选熔断")), "超阈值必须告警留痕")
    for (let k = 0; k < 5; k++)
      assert.ok(fused.md.includes(`社区技术讨论第${k}号`), `熔断后条目 ${k} 必须存活（fail-open）`)
    // 2/5=40% ≤ 80% → 正常生效：被反选的 2 条移除，其余存活，无熔断告警
    const normal = await run(2)
    assert.ok(!normal.alerts.some((a) => a.includes("反选熔断")), "低比例不得误熔断")
    assert.ok(!normal.md.includes("社区技术讨论第0号"), "被反选条目移除")
    assert.ok(!normal.md.includes("社区技术讨论第1号"), "被反选条目移除")
    assert.ok(normal.md.includes("社区技术讨论第2号"), "未反选条目存活")
  })

  it("DIGEST_FAILURE_STATUSES：三失败态在列、幂等噪音不在列（三拍 r1 P2-1 cron 适配层判定真相源；漏归类由 job.ts 编译期穷尽检查咬）", () => {
    for (const s of ["failed_no_items", "failed_summarize", "send_failed"] as const) {
      assert.ok(isDigestFailureStatus(s), s)
    }
    for (const s of [
      "ok",
      "skipped_not_due",
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
    assert.ok(
      fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8").includes("GitHub 周榜"),
    )
  })

  it("增长榜（日）每天都带：非周一/非 1 号也抓（07-05 分栏改版 #2）", async () => {
    const ghd = okSource("github-trending-daily", "github")
    const job = createDailyDigestJob(makeDeps({ githubDailySources: [ghd] }))
    await job.reconcile(FRI_0800) // 07-03 周五：非周一非 1 号
    assert.equal(ghd.calls.length, 1)
    assert.ok(
      fs
        .readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
        .includes("GitHub 增长榜"),
    )
  })

  it("月榜每天常驻（#27；07-06 小孙「月榜咋没有了」——原每月 1 号门拆掉）；items.jsonl 证据底料落盘（F029）", async () => {
    const ghm = okSource("github-trending-monthly", "github")
    const job = createDailyDigestJob(makeDeps({ githubMonthlySources: [ghm] }))
    await job.reconcile(FRI_0800) // 07-03 平日（非周一非 1 号）也要有月榜
    assert.equal(ghm.calls.length, 1)
    assert.ok(
      fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8").includes("GitHub 月榜"),
    )
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

  it("summarize 降级仍发报（AC11 不丢报）", async () => {
    const sender = makeSender()
    const job = createDailyDigestJob(
      makeDeps({
        sender,
        summarize: async (items) => ({
          overview: ["清单版"],
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
    const gh = buildNormalizedItem(
      "github-trending-daily",
      "github",
      "org/repo",
      "https://github.com/org/repo",
      null,
      "+10 stars today · ★100 · Python · English repo desc",
    )
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
      sections: [{ category: "ai", picks: [{ itemId: picked.id, summaryZh: "摘要" }] }],
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
        sections: [
          {
            category: "ai",
            picks: items.slice(0, 1).map((i) => ({ itemId: i.id, summaryZh: "s" })),
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

  it("跨日已见账本：发送成功落 shown.json；昨天喂过样的条目今天不再回流", async () => {
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
    assert.ok(shown.keys.includes(keyA), "A 喂过样即已见")
    // day2（07-04）：源回流 A + 新条 B → 选材只见 B
    const sink = { items: [] as NormalizedItem[] }
    const day2 = createDailyDigestJob(
      makeDeps({
        sources: [multiSource("s1", [itemA, itemB])],
        summarize: capturingSummarize(sink),
      }),
    )
    assert.equal((await day2.reconcile(SAT_0800)).status, "ok")
    assert.deepEqual(
      sink.items.map((i) => i.title),
      ["story-B"],
    )
  })

  it("修复丢节类目：喂样不烧 shown + notes 透出（德彪 r-final P1-3）", async () => {
    const src = multiSource("s1", [
      { title: "被丢节的候选", url: "https://a.com/lost", publishedAt: "2026-07-02T00:00:00Z" },
    ])
    const deps = makeDeps({
      sources: [src],
      summarize: async () => ({
        overview: ["要点"],
        sections: [],
        degraded: false,
        repairDroppedCategories: ["ai"],
      }),
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    const shown = JSON.parse(
      fs.readFileSync(path.join(dir, "2026-07-03", "shown.json"), "utf8"),
    ) as { keys: string[] }
    assert.equal(shown.keys.length, 0, "丢节类目本期没渲染，喂样不算已见（候选明日回补）")
    const md = fs.readFileSync(path.join(dir, "2026-07-03", "digest.md"), "utf8")
    assert.ok(md.includes("截断已修复"), "缺节要在邮件里透出")
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
    // 实验组：5KB 极小预算逼降密度阶梯打到底 → 速览区整体消失，但报仍发出
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "f037-budget-"))
    const jobB = createDailyDigestJob(
      makeDeps({
        ledger: createFileDigestLedger(dir2),
        health: createFileSourceHealthStore(dir2),
        baseDir: dir2,
        sources: [multiSource("s1", entries)],
        emailByteBudget: 5 * 1024,
      }),
    )
    assert.equal((await jobB.reconcile(FRI_0800)).status, "ok")
    const htmlB = fs.readFileSync(path.join(dir2, "2026-07-03", "digest.html"), "utf8")
    assert.ok(!htmlB.includes("其余速览"), "超预算应降到 0 行速览")
  })
})

describe("#33 播客速递分流（07-10：与 github 同为直渲流）", () => {
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

  it("播客不进 summarize、进邮件与 shown、counts.podcast 落盘", async () => {
    const sender = makeSender()
    const fedCategories: string[] = []
    const deps = makeDeps({
      sender,
      sources: [okSource("smol-ai"), podcastSource()],
      summarize: async (items) => {
        for (const i of items) fedCategories.push(i.category)
        return {
          overview: ["x"],
          sections: [
            {
              category: "ai",
              picks: items.slice(0, 1).map((i) => ({ itemId: i.id, summaryZh: "s" })),
            },
          ],
          degraded: false,
        }
      },
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    // 不喂 LLM
    assert.ok(!fedCategories.includes("podcast"), "播客条目绝不进 summarize")
    // 进邮件（节 + 标题 + 要点）
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("播客速递"))
    assert.ok(html.includes("42章经｜新集"))
    assert.ok(html.includes("要点一"))
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
    assert.equal((await job.reconcile(SAT_0800)).status, "ok")
    const htmlDay2 = fs.readFileSync(path.join(dir, "2026-07-04", "digest.html"), "utf8")
    assert.ok(!htmlDay2.includes("播客速递"), "已上报的集次日不回流")
  })

  it("常规源全空 + 仅播客有新集 → 照发（合成空 summary 不空转 LLM）", async () => {
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
      summarize: async () => {
        summarizeCalls++
        return fakeSummary
      },
    })
    const job = createDailyDigestJob(deps)
    assert.equal((await job.reconcile(FRI_0800)).status, "ok")
    assert.equal(summarizeCalls, 0, "无常规内容不该调 LLM")
    const html = fs.readFileSync(path.join(dir, "2026-07-03", "digest.html"), "utf8")
    assert.ok(html.includes("播客速递"))
  })
})
