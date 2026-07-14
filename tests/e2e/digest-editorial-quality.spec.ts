import { expect, test } from "@playwright/test"

const businessDate = "2026-07-13"

const day = {
  businessDate,
  labels: {
    "ai-source": "AI 研究源",
    "v2ex-hot": "V2EX 热议",
    "github-trending-daily": "GitHub 增长榜",
  },
  items: [
    {
      id: "ai-inference",
      category: "ai",
      sourceId: "ai-source",
      title: "vLLM KV cache 量化提升推理吞吐",
      canonicalUrl: "https://example.com/inference",
      publishedAt: "2026-07-13T01:00:00Z",
      rawSnippet: "serving latency throughput",
    },
    {
      id: "ai-release",
      category: "ai",
      sourceId: "ai-source",
      title: "新模型能力与评测进展",
      canonicalUrl: "https://example.com/release",
      publishedAt: "2026-07-13T02:00:00Z",
      rawSnippet: "model release",
    },
    {
      id: "community-good",
      category: "community",
      sourceId: "v2ex-hot",
      title: "社区复现大模型推理服务优化",
      canonicalUrl: "https://example.com/community-good",
      publishedAt: "2026-07-13T03:00:00Z",
      rawSnippet: "技术讨论与基准",
    },
    {
      id: "community-noise",
      category: "community",
      sourceId: "v2ex-hot",
      title: "奔三了，感觉自己飘忽不定",
      canonicalUrl: "https://example.com/community-noise",
      publishedAt: "2026-07-13T04:00:00Z",
      rawSnippet: "人生求助",
    },
    {
      id: "agent-reach",
      category: "github",
      sourceId: "github-trending-daily",
      title: "owner/Agent-Reach",
      canonicalUrl: "https://github.com/owner/Agent-Reach",
      publishedAt: null,
      rawSnippet: "+123 stars today · ★1,000 · TypeScript · AI agent search",
      githubMeta: { rankStatus: { kind: "new" } },
    },
    {
      id: "iptv",
      category: "github",
      sourceId: "github-trending-daily",
      title: "owner/iptv",
      canonicalUrl: "https://github.com/owner/iptv",
      publishedAt: null,
      rawSnippet: "+999 stars today · ★9,999 · IPTV channel list",
    },
  ],
  summary: {
    schemaVersion: 2,
    businessDate,
    degraded: false,
    summary: {
      overview: ["旧 summary 里的未批准速览不得回流"],
      sections: [
        {
          category: "community",
          picks: [{ itemId: "community-noise", summaryZh: "人生求助" }],
        },
      ],
      degraded: false,
    },
    publication: {
      schemaVersion: 2,
      businessDate,
      overview: ["最终发布清单同时保留推理与其他 AI 进展"],
      sections: [
        {
          category: "ai",
          entries: [
            {
              itemId: "ai-inference",
              role: "hero",
              displayTag: "推理",
              summaryZh: "推理吞吐与延迟获得改进。",
            },
            {
              itemId: "ai-release",
              role: "card",
              displayTag: "研究",
              summaryZh: "模型能力和评测出现新进展。",
            },
          ],
        },
        {
          category: "community",
          entries: [
            {
              itemId: "community-good",
              role: "hero",
              summaryZh: "社区给出可复现的推理服务基准。",
            },
          ],
        },
        {
          category: "github",
          entries: [{ itemId: "agent-reach", role: "list" }],
        },
      ],
    },
    sourceHealth: [
      { sourceId: "ai-source", status: "ok", itemCount: 6, durationMs: 10, error: null },
    ],
    counts: { content: 3, github: 1, podcast: 0, scanned: 6 },
    githubItemIds: ["agent-reach"],
  },
}

test("F037 v2 日报只展示 publication：推理不独占、社区噪声/IPTV 不回流、状态同排", async ({
  page,
}) => {
  await page.route("**/api/daily-digest/**", async (route) => {
    if (route.request().url().endsWith("/dates")) {
      await route.fulfill({ json: { dates: [businessDate] } })
      return
    }
    await route.fulfill({ json: day })
  })

  await page.goto(`/digest/${businessDate}`)

  await expect(page.getByRole("heading", { name: "每日简报", exact: true })).toBeVisible()
  await expect(page.getByText("最终发布清单同时保留推理与其他 AI 进展")).toBeVisible()
  await expect(page.getByText("vLLM KV cache 量化提升推理吞吐").first()).toBeVisible()
  await expect(page.getByText("新模型能力与评测进展").first()).toBeVisible()
  await expect(page.getByText("社区复现大模型推理服务优化").first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "开源榜单", exact: true })).toBeVisible()
  await expect(page.getByText(/开源榜单 1 条/)).toBeVisible()
  const agentReachRow = page.getByRole("listitem").filter({ hasText: "owner/Agent-Reach" })
  await expect(agentReachRow).toBeVisible()
  await expect(agentReachRow).toContainText("▲ 123 今日 ★1,000 TypeScript NEW")

  await expect(page.getByText("旧 summary 里的未批准速览不得回流")).toHaveCount(0)
  await expect(page.getByText("奔三了，感觉自己飘忽不定")).toHaveCount(0)
  await expect(page.getByText("owner/iptv")).toHaveCount(0)
})

test("B030 设置页保留两列并只读展示 Codex 最终兜底，保存不写入固定层", async ({
  page,
  request,
}) => {
  await page.goto("/digest/settings")

  await expect(page.getByLabel("主力模型")).toBeVisible()
  await expect(page.getByLabel("兜底模型")).toBeVisible()
  await expect(page.getByRole("note", { name: "模型最终兜底" })).toHaveText(
    "最终兜底：GPT-5.6 Sol · Codex · high，仅前两层均失败时启用",
  )

  await page.getByLabel("主力模型").fill("claude-opus-4-9")
  const putRequest = page.waitForRequest(
    (req) => req.url().endsWith("/api/daily-digest/settings") && req.method() === "PUT",
  )
  await page.getByRole("button", { name: "保存设置" }).click()
  const sent = await putRequest
  expect(sent.postDataJSON()).toEqual({ settings: { primaryModel: "claude-opus-4-9" } })
  expect(JSON.stringify(sent.postDataJSON())).not.toContain("emergencyFallback")
  await expect(page.getByText("已保存（下一轮日报生效）")).toBeVisible()

  const apiPort = process.env.E2E_API_PORT ?? "8999"
  const stored = await request.get(`http://localhost:${apiPort}/api/daily-digest/settings`)
  expect(stored.ok()).toBe(true)
  const body = await stored.json()
  expect(body.stored).toEqual({ primaryModel: "claude-opus-4-9" })
  expect(body.emergencyFallback).toEqual({
    provider: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
  })

  if (process.env.B030_EVIDENCE === "1") {
    await page.screenshot({
      path: ".agents/acceptance/F037/B030-settings-final-fallback.png",
      fullPage: true,
    })
  }
})
