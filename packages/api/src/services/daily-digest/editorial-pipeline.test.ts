import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildNormalizedItem } from "./feed-parsers"
import type { DigestModelRunner } from "./model-runner"
import { buildDigestPublication } from "./publication"
import { createDigestSummarizer } from "./summarizer"
import type { EditorialBasis, EditorialTopicTag, NormalizedItem } from "./types"

type Case = {
  item: NormalizedItem
  basis: EditorialBasis
  topicTags: EditorialTopicTag[]
  publish: boolean
}

function makeCase(
  sourceId: string,
  category: "ai" | "community",
  slug: string,
  title: string,
  snippet: string,
  basis: EditorialBasis,
  topicTags: EditorialTopicTag[],
  publish: boolean,
): Case {
  return {
    item: buildNormalizedItem(
      sourceId,
      category,
      title,
      `https://example.com/${slug}`,
      "2026-07-14T00:00:00Z",
      snippet,
    ),
    basis,
    topicTags,
    publish,
  }
}

function rawVote(testCase: Case) {
  const { item, basis, topicTags, publish } = testCase
  const quote = item.rawSnippet.slice(0, 150)
  const evidence = publish
    ? basis === "finance_event"
      ? [
          { field: "snippet", quote, supports: "ai_relevance" },
          { field: "snippet", quote, supports: "finance_context" },
        ]
      : [
          { field: "snippet", quote, supports: "ai_relevance" },
          { field: "snippet", quote, supports: "substantive_fact" },
          ...(topicTags.includes("inference")
            ? [{ field: "snippet", quote, supports: "inference_technical" }]
            : []),
        ]
    : [{ field: "snippet", quote, supports: "disqualifier" }]
  return {
    itemId: item.id,
    basis,
    topicTags,
    organizationTags: [],
    ecosystemTags: [],
    regionTags: ["global"],
    evidence,
    confidence: 0.94,
  }
}

describe("B032 production pipeline semantic matrix", () => {
  it("Claude 全挂时 7 条 AI 进展全保留、7 条求助/抱怨/八卦全拒绝，融资不得冒充推理", async () => {
    const cases: Case[] = [
      makeCase(
        "x-sakana",
        "community",
        "sakana-research",
        "Sakana AI shares its latest research",
        "We are pleased to share our latest research: Smart Cellular Bricks with new experimental results.",
        "research_result",
        ["research"],
        true,
      ),
      makeCase(
        "hn-ai",
        "ai",
        "gpu-finance",
        "Nvidia, CoreWeave, and Nebius: circular financing of the GPU boom",
        "Nvidia invested in CoreWeave, which then purchased Nvidia GPU capacity in a circular financing arrangement.",
        "finance_event",
        ["other"],
        true,
      ),
      makeCase(
        "vllm-blog",
        "ai",
        "vllm-sglang",
        "vLLM and SGLang improve serving throughput",
        "vLLM and SGLang published scheduler, KV-cache and continuous-batching improvements with lower inference latency.",
        "technical_discussion",
        ["inference"],
        true,
      ),
      makeCase(
        "reddit-ai",
        "ai",
        "cuda-race",
        "CUDA batching race condition postmortem",
        "Engineers reproduced and fixed a CUDA dynamic-batching race condition that corrupted inference requests.",
        "engineering_work",
        ["inference"],
        true,
      ),
      makeCase(
        "x-firsthand",
        "community",
        "blender-agent",
        "GPT + Cursor + Blender MCP agent engineering",
        "The team built a GPT agent in Cursor that controls Blender through MCP and published the implementation details.",
        "engineering_work",
        ["agent"],
        true,
      ),
      makeCase(
        "reddit-ai",
        "community",
        "recommender-ab",
        "Recommender model A/B study",
        "Researchers compared two recommender models in an A/B experiment and reported accuracy and retention results.",
        "research_result",
        ["research"],
        true,
      ),
      makeCase(
        "openai-news",
        "ai",
        "sites-beta",
        "ChatGPT Sites enters public beta",
        "ChatGPT Sites entered public beta with publishing, collaboration and workspace integration features.",
        "product_release",
        ["model_release"],
        true,
      ),
      makeCase(
        "v2ex-hot",
        "community",
        "student-help",
        "专科大二，喜欢底层开发，但有点迷茫想听听建议",
        "个人职业求助：应该继续学底层还是转 AI，想听听大家建议。",
        "personal_help",
        ["other"],
        false,
      ),
      makeCase(
        "v2ex-hot",
        "community",
        "turning-thirty",
        "奔三了，感觉自己飘忽不定",
        "最近工作和生活都很迷茫，感觉自己一直飘忽不定。",
        "off_topic",
        ["other"],
        false,
      ),
      makeCase(
        "reddit-ai",
        "community",
        "cook-letter",
        "Tim Cook wrote a letter to Sam Altman",
        "People are speculating about a private letter from Tim Cook to Sam Altman without technical details.",
        "gossip",
        ["other"],
        false,
      ),
      makeCase(
        "reddit-ai",
        "community",
        "vllm-praise",
        "vLLM is absolutely amazing",
        "I love vLLM; it is amazing and everyone should use it.",
        "reaction_only",
        ["other"],
        false,
      ),
      makeCase(
        "reddit-ai",
        "community",
        "gpt-debug-praise",
        "GPT can debug everything now",
        "Wow, GPT is incredible at debugging; no reproducible case or engineering detail was provided.",
        "reaction_only",
        ["other"],
        false,
      ),
      makeCase(
        "v2ex-hot",
        "community",
        "cuda-salary",
        "写 CUDA 这么累，工资还不涨",
        "抱怨 CUDA 工作压力和薪资，没有任何故障复盘或技术进展。",
        "complaint",
        ["other"],
        false,
      ),
      makeCase(
        "reddit-ai",
        "community",
        "chatgpt-dating",
        "Used ChatGPT to choose a hotpot place for my date",
        "A personal dating story about asking ChatGPT where to eat hotpot; no AI research or engineering discussion.",
        "off_topic",
        ["other"],
        false,
      ),
    ]

    const approved = cases.filter((entry) => entry.publish)
    const rejected = cases.filter((entry) => !entry.publish)
    const reviewJson = JSON.stringify({ votes: cases.map(rawVote) })
    const ai = approved.filter((entry) => entry.item.category === "ai")
    const community = approved.filter((entry) => entry.item.category === "community")
    const composerJson = JSON.stringify({
      overview: approved.slice(0, 5).map((entry, index) => ({
        text: `今日 AI 与工程进展 ${index + 1}`,
        itemIds: [entry.item.id],
      })),
      sections: [
        {
          category: "ai",
          picks: ai.map((entry) => ({
            itemId: entry.item.id,
            summaryZh: `摘要：${entry.item.title}`,
          })),
        },
        {
          category: "community",
          picks: community.map((entry) => ({
            itemId: entry.item.id,
            summaryZh: `摘要：${entry.item.title}`,
          })),
        },
      ],
    })
    const targets = [
      { provider: "claude", model: "claude-primary" },
      { provider: "claude", model: "claude-fallback" },
      { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    ] as const
    let codexCall = 0
    const prompts: string[] = []
    const modelRunner: DigestModelRunner = {
      targets,
      async runPrompt() {
        throw new Error("target-aware production path expected")
      },
      async runTargetPrompt(targetIndex, prompt) {
        prompts.push(prompt)
        if (targetIndex < 2) {
          return { ok: false, text: "", durationMs: 1, error: "provider-error" }
        }
        codexCall += 1
        return {
          ok: true,
          text: codexCall <= 2 ? reviewJson : composerJson,
          durationMs: 1,
        }
      },
    }

    const summary = await createDigestSummarizer({ runner: modelRunner }).summarize(
      cases.map((entry) => entry.item),
      "2026-07-14",
    )
    assert.ok(summary)
    assert.ok(summary.overview.length >= 5 && summary.overview.length <= 8)
    const { publication, audit } = buildDigestPublication({
      businessDate: "2026-07-14",
      summary,
      items: cases.map((entry) => entry.item),
      githubItemIds: [],
      podcastItemIds: [],
    })

    const publishedIds = new Set(
      publication.sections.flatMap((section) =>
        section.entries.flatMap((entry) => [entry.itemId, ...(entry.alsoItemIds ?? [])]),
      ),
    )
    assert.deepEqual(
      [...publishedIds].sort(),
      approved.map((entry) => entry.item.id).sort(),
    )
    for (const entry of rejected) assert.ok(!publishedIds.has(entry.item.id), entry.item.title)

    const decisions = new Map(summary.editorialDecisionSet?.decisions.map((d) => [d.itemId, d]))
    const finance = cases.find((entry) => entry.basis === "finance_event")!
    assert.equal(decisions.get(finance.item.id)?.contentKind, "finance")
    assert.ok(!decisions.get(finance.item.id)?.topicTags.includes("inference"))
    assert.equal(summary.editorialDecisionSet?.reviewMode, "degraded_same_target")
    assert.equal(audit.policyVersion, "F037-B032-v1")

    const composerPrompt = prompts.find((prompt) => prompt.includes("DigestComposer")) ?? ""
    for (const entry of approved) assert.ok(composerPrompt.includes(entry.item.title))
    for (const entry of rejected) assert.ok(!composerPrompt.includes(entry.item.title))
  })
})
