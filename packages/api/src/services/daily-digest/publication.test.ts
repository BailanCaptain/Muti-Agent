import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildNormalizedItem } from "./feed-parsers"
import { buildEditorialDecisionSet, type EditorialPromptItem } from "./editorial-decider"
import {
  assertValidDigestPublication,
  buildDigestPublication,
  getPublishedItemIds,
  validateDigestOverviewDensity,
} from "./publication"
import type {
  DigestPublicationV2,
  DigestSummary,
  EditorialAssessment,
  EditorialDecision,
  EditorialReviewVote,
  NormalizedItem,
} from "./types"

const item = (id: string, category: NormalizedItem["category"], title: string): NormalizedItem => {
  const built = buildNormalizedItem(
    `source-${id}`,
    category,
    title,
    `https://example.com/${id}`,
    "2026-07-12T00:00:00Z",
    title,
  )
  return { ...built, id }
}

const eligible = (i: NormalizedItem): EditorialAssessment => ({
  itemId: i.id,
  sourceCategory: i.category,
  reviewState: "eligible",
  topicTags: i.category === "github" ? ["other"] : ["research"],
  organizationTags: [],
  ecosystemTags: [],
  regionTags: [],
  contentKind: "research",
  confidence: 0.9,
})

const b032Decision = (
  target: NormalizedItem,
  reviewState: "eligible" | "rejected",
  basis: "research_result" | "personal_help" = "research_result",
): EditorialDecision => {
  const rejected = reviewState === "rejected"
  const evidence = rejected
    ? [{ field: "title" as const, quote: target.title, supports: "disqualifier" as const }]
    : [
        { field: "title" as const, quote: target.title, supports: "ai_relevance" as const },
        { field: "title" as const, quote: target.title, supports: "substantive_fact" as const },
      ]
  const vote = (
    model: string,
    reviewerSlot: "review_a" | "review_b",
  ): EditorialReviewVote => ({
    itemId: target.id,
    basis,
    topicTags: rejected ? ["other"] : ["research"],
    organizationTags: [],
    ecosystemTags: [],
    regionTags: ["global"],
    evidence,
    confidence: 0.95,
    reviewerTarget: { provider: "claude" as const, model },
    reviewerSlot,
  })
  return {
    itemId: target.id,
    sourceCategory: target.category,
    reviewState,
    ...(rejected ? { rejectReason: "help" as const } : {}),
    basis,
    topicTags: rejected ? ["other"] : ["research"],
    organizationTags: [],
    ecosystemTags: [],
    regionTags: ["global"],
    contentKind: rejected ? "help" : "research",
    confidence: 0.95,
    reviewMode: "multi_target",
    votes: [vote("claude-a", "review_a"), vote("claude-b", "review_b")],
  }
}

describe("B027 publication manifest 是唯一发布真相源", () => {
  it("raw pool 中 rejected/unreviewed/community 求助和未批准 podcast 不会自动进入 publication", () => {
    const good = item("good", "community", "vLLM 量化实践复盘")
    const help = item("help", "community", "奔三了很迷茫，AI 创业该怎么办")
    const unreviewed = item("unreviewed", "community", "未经审核的 AI 热议")
    const podcast = item("podcast", "podcast", "与 AI 无关的一期闲聊")
    const summary: DigestSummary = {
      overview: [],
      editorialAssessments: [eligible(good)],
      sections: [{ category: "community", picks: [], briefItemIds: [good.id] }],
      communityDropIds: [help.id],
      degraded: false,
    }

    const { publication, audit } = buildDigestPublication({
      businessDate: "2026-07-12",
      summary,
      items: [good, help, unreviewed, podcast],
      podcastItemIds: [],
      githubItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [good.id])
    assert.equal(audit.assessments.find((a) => a.itemId === help.id)?.reviewState, "rejected")
    assert.equal(
      audit.assessments.find((a) => a.itemId === unreviewed.id)?.reviewState,
      "unreviewed",
    )
    assert.equal(audit.assessments.find((a) => a.itemId === podcast.id)?.reviewState, "unreviewed")
  })

  it("社区速览标题必须能独立表达 AI 进展，不能用人物反应短句代替事件", () => {
    const reaction = {
      ...item("reaction", "community", "@sama: clarity is nice"),
      rawSnippet:
        "clarity is nice Tibo: GPT-5.6 Sol will stay in ChatGPT Go, Plus and Pro subscriptions.",
    }
    const release = item(
      "release-brief",
      "community",
      "GPT-5.6 Sol will remain available in ChatGPT subscriptions",
    )
    const releaseAssessment = (target: NormalizedItem): EditorialAssessment => ({
      ...eligible(target),
      topicTags: ["model_release"],
      contentKind: "release",
    })
    const summary: DigestSummary = {
      overview: [],
      editorialAssessments: [releaseAssessment(reaction), releaseAssessment(release)],
      sections: [
        {
          category: "community",
          picks: [],
          briefItemIds: [reaction.id, release.id],
        },
      ],
      degraded: false,
    }

    const { publication } = buildDigestPublication({
      businessDate: "2026-07-14",
      summary,
      items: [reaction, release],
      githubItemIds: [],
      podcastItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [release.id])
  })

  it("社区精选也必须有原始 AI 实质，不能靠模型伪造 eligible 与摘要包装纯 reaction", () => {
    const reaction = {
      ...item("reaction-pick", "community", "@gdb: nice!"),
      rawSnippet: "nice!",
    }
    const engineering = {
      ...item("engineering-pick", "community", "@gdb: you can just create things"),
      rawSnippet:
        "A developer asked GPT-5.6 Sol in Cursor to set up Blender MCP, build a floating MacBook, and render the scene without prior Blender experience.",
    }
    const approved = (target: NormalizedItem): EditorialAssessment => ({
      ...eligible(target),
      topicTags: ["agent"],
      contentKind: "engineering",
    })
    const summary: DigestSummary = {
      overview: [],
      editorialAssessments: [approved(reaction), approved(engineering)],
      sections: [
        {
          category: "community",
          picks: [
            {
              itemId: reaction.id,
              summaryZh: "模型伪造的工程摘要不应覆盖空洞原文",
            },
            {
              itemId: engineering.id,
              summaryZh: "GPT-5.6 Sol 通过 Blender MCP 自动完成建模与渲染。",
            },
          ],
        },
      ],
      degraded: false,
    }

    const { publication, audit } = buildDigestPublication({
      businessDate: "2026-07-14",
      summary,
      items: [reaction, engineering],
      githubItemIds: [],
      podcastItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [engineering.id])
    assert.equal(
      audit.assessments.find((assessment) => assessment.itemId === reaction.id)?.reviewState,
      "rejected",
    )
  })

  it("社区最终门拒绝被模型伪标为 AI 讨论的个人求助、职场抱怨和生活闲聊", () => {
    const careerHelp = item(
      "career-help",
      "community",
      "刚毕业拿到两个 AI 岗位 offer，一个做模型应用一个做销售，大家会选哪个",
    )
    const workComplaint = item(
      "work-complaint",
      "community",
      "做了半年大模型应用，每天加班到凌晨，工资还没有同学高",
    )
    const lifeChatter = item(
      "life-chatter",
      "community",
      "周末用 ChatGPT 规划相亲路线，最后还是一个人吃了火锅",
    )
    const realDiscussion = item(
      "real-discussion",
      "community",
      "vLLM 与 SGLang 在长上下文推理中的调度和吞吐差异讨论",
    )
    const modelApproved = (target: NormalizedItem): EditorialAssessment => ({
      ...eligible(target),
      topicTags: ["agent"],
      contentKind: "discussion",
    })
    const candidates = [careerHelp, workComplaint, lifeChatter, realDiscussion]
    const summary: DigestSummary = {
      overview: [],
      editorialAssessments: candidates.map(modelApproved),
      sections: [
        {
          category: "community",
          picks: candidates.map((target) => ({
            itemId: target.id,
            summaryZh: "模型生成的摘要不得覆盖原始内容性质。",
          })),
        },
      ],
      degraded: false,
    }

    const { publication, audit } = buildDigestPublication({
      businessDate: "2026-07-14",
      summary,
      items: candidates,
      githubItemIds: [],
      podcastItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [realDiscussion.id])
    for (const rejected of [careerHelp, workComplaint, lifeChatter]) {
      assert.equal(
        audit.assessments.find((assessment) => assessment.itemId === rejected.id)?.reviewState,
        "rejected",
      )
    }
  })

  it("社区最终门同时检查 rawSnippet 内容性质，且长纯 reaction 不能靠字数和 AI 实体穿透", () => {
    const careerBody = {
      ...item("career-body", "community", "AI 岗位选择讨论"),
      rawSnippet: "刚毕业拿到两个岗位，一个做模型应用一个做销售，大家会选哪个",
    }
    const complaintBody = {
      ...item("complaint-body", "community", "Claude Code 使用体验复盘"),
      rawSnippet: "做了半年大模型应用，每天加班到凌晨，工资还没有同学高",
    }
    const lifeBody = {
      ...item("life-body", "community", "ChatGPT 周末路线规划体验"),
      rawSnippet: "周末用 ChatGPT 规划相亲路线，最后还是一个人吃了火锅",
    }
    const longReaction = item(
      "long-reaction",
      "community",
      "GPT-5.6 Sol is absolutely amazing and I love it",
    )
    const vllmReaction = item(
      "vllm-reaction",
      "community",
      "vLLM is absolutely amazing and I love it so much",
    )
    const gptDebugReaction = item(
      "gpt-debug-reaction",
      "community",
      "GPT-5.6 Sol is absolutely amazing and I love how it can debug anything",
    )
    const vllmBatchingReaction = item(
      "vllm-batching-reaction",
      "community",
      "vLLM batching is absolutely amazing and I love it",
    )
    const chineseBatchingReaction = item(
      "vllm-batching-reaction-zh",
      "community",
      "vLLM 的 batching 太惊艳了，真的太喜欢了",
    )
    const realDiscussion = item(
      "body-real-discussion",
      "community",
      "vLLM 与 SGLang 在长上下文推理中的调度和吞吐差异讨论",
    )
    const gdbEngineering = {
      ...item("body-gdb", "community", "@gdb: you can just create things"),
      rawSnippet:
        "A developer asked GPT-5.6 Sol in Cursor to set up Blender MCP, build a floating MacBook, and render the scene without prior Blender experience.",
    }
    const recommenderResearch = {
      ...item("recommender-research", "community", "相亲平台推荐模型的离线评测"),
      rawSnippet: "我们用大模型构建相亲推荐系统，公开了数据集，并完成排序算法与基线的 A/B 测试。",
    }
    const cudaIncident = {
      ...item("cuda-incident", "community", "推理故障复盘"),
      rawSnippet: "团队每天加班排查，最终定位到 CUDA graph 与动态 batching 的竞态条件。",
    }
    const modelApproved = (target: NormalizedItem): EditorialAssessment => ({
      ...eligible(target),
      topicTags: ["agent"],
      contentKind: "discussion",
    })
    const candidates = [
      careerBody,
      complaintBody,
      lifeBody,
      longReaction,
      vllmReaction,
      gptDebugReaction,
      vllmBatchingReaction,
      chineseBatchingReaction,
      realDiscussion,
      gdbEngineering,
      recommenderResearch,
      cudaIncident,
    ]
    const summary: DigestSummary = {
      overview: [],
      editorialAssessments: candidates.map(modelApproved),
      sections: [
        {
          category: "community",
          picks: candidates.map((target) => ({
            itemId: target.id,
            summaryZh: "模型生成的摘要不得改变原始内容性质。",
          })),
        },
      ],
      degraded: false,
    }

    const { publication, audit } = buildDigestPublication({
      businessDate: "2026-07-14",
      summary,
      items: candidates,
      githubItemIds: [],
      podcastItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [
      realDiscussion.id,
      gdbEngineering.id,
      recommenderResearch.id,
      cudaIncident.id,
    ])
    for (const rejected of [
      careerBody,
      complaintBody,
      lifeBody,
      longReaction,
      vllmReaction,
      gptDebugReaction,
      vllmBatchingReaction,
      chineseBatchingReaction,
    ]) {
      assert.equal(
        audit.assessments.find((assessment) => assessment.itemId === rejected.id)?.reviewState,
        "rejected",
      )
    }
  })

  it("同日同时保留推理与其他 AI 内容，推理突出但不独占", () => {
    const inference = item("inference", "ai", "vLLM KV cache 量化")
    const release = item("release", "ai", "OpenAI 发布新模型")
    const summary: DigestSummary = {
      overview: [],
      editorialAssessments: [
        { ...eligible(inference), topicTags: ["inference"], contentKind: "engineering" },
        { ...eligible(release), topicTags: ["model_release"], contentKind: "release" },
      ],
      sections: [
        {
          category: "ai",
          picks: [
            { itemId: inference.id, summaryZh: "推理吞吐提升", tag: "推理" },
            { itemId: release.id, summaryZh: "模型正式发布", tag: "OpenAI" },
          ],
        },
      ],
      degraded: false,
    }
    const { publication } = buildDigestPublication({
      businessDate: "2026-07-12",
      summary,
      items: [inference, release],
      githubItemIds: [],
      podcastItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [inference.id, release.id])
    assert.deepEqual(
      publication.sections[0].entries.map((entry) => entry.displayTag),
      ["推理", "OpenAI"],
    )
  })

  it("真实链路硬否决：融资误标不得进推理，社区八卦/抱怨即使被模型批准也不得发布或进速览", () => {
    const finance = item(
      "finance",
      "ai",
      "Nvidia, CoreWeave, and Nebius: Inside the Circular Financing of the GPU Boom",
    )
    const safe = item("safe", "community", "vLLM KV cache 量化与吞吐实践讨论")
    const gossip = item("gossip", "community", "Tim Cook 致信 Sam Altman")
    const complaint = item("complaint", "community", "奔三了，感觉自己飘忽不定")
    const modelApproved = (
      target: NormalizedItem,
      contentKind: EditorialAssessment["contentKind"],
      topicTags: EditorialAssessment["topicTags"],
    ): EditorialAssessment => ({
      itemId: target.id,
      sourceCategory: target.category,
      reviewState: "eligible",
      topicTags,
      organizationTags: [],
      ecosystemTags: [],
      regionTags: ["global"],
      contentKind,
      confidence: 0.95,
    })
    const summary: DigestSummary = {
      overview: ["Tim Cook 致信 Sam Altman 引发热议"],
      overviewRefs: [{ text: "Tim Cook 致信 Sam Altman 引发热议", itemIds: [gossip.id] }],
      editorialAssessments: [
        // 故意模拟 LLM 错判：结构层仍必须识别融资，不得相信展示 tag。
        modelApproved(finance, "engineering", ["inference"]),
        modelApproved(safe, "discussion", ["inference"]),
        modelApproved(gossip, "discussion", ["model_release"]),
        modelApproved(complaint, "discussion", ["agent"]),
      ],
      sections: [
        {
          category: "ai",
          picks: [{ itemId: finance.id, summaryZh: "GPU 热潮的循环融资模式", tag: "推理" }],
        },
        {
          category: "community",
          picks: [],
          briefItemIds: [safe.id, gossip.id, complaint.id],
        },
      ],
      degraded: false,
    }

    const { publication, audit } = buildDigestPublication({
      businessDate: "2026-07-12",
      summary,
      items: [finance, safe, gossip, complaint],
      githubItemIds: [],
      podcastItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [finance.id, safe.id])
    assert.equal(publication.sections[0].entries[0].displayTag, "其他")
    assert.deepEqual(publication.overview, [])
    assert.equal(audit.assessments.find((a) => a.itemId === gossip.id)?.reviewState, "rejected")
    assert.equal(audit.assessments.find((a) => a.itemId === complaint.id)?.reviewState, "rejected")
  })

  it("validator 拒绝跨 category 引用、重复展示和 rejected/unreviewed 发布", () => {
    const ai = item("ai", "ai", "模型发布")
    const community = item("community", "community", "AI 讨论")
    const base: DigestPublicationV2 = {
      schemaVersion: 2,
      businessDate: "2026-07-12",
      overview: [],
      sections: [{ category: "ai", entries: [{ itemId: community.id, role: "brief" }] }],
    }
    const assessments: EditorialAssessment[] = [
      eligible(ai),
      { ...eligible(community), reviewState: "unreviewed" },
    ]

    assert.throws(
      () => assertValidDigestPublication(base, [ai, community], assessments),
      /category mismatch|unreviewed/,
    )

    const duplicate: DigestPublicationV2 = {
      ...base,
      sections: [
        {
          category: "ai",
          entries: [
            { itemId: ai.id, role: "hero" },
            { itemId: ai.id, role: "brief" },
          ],
        },
      ],
    }
    assert.throws(
      () => assertValidDigestPublication(duplicate, [ai, community], assessments),
      /duplicate/,
    )
  })
})

describe("B032 decision set 是新生产路径唯一审核真相", () => {
  it("终态 publication 仍须保住 5–8 条速览；旧摘要兼容路径不被新门禁误伤", () => {
    const targets = Array.from({ length: 5 }, (_, index) =>
      item(`overview-${index + 1}`, "ai", `AI research result ${index + 1}`),
    )
    const promptItems: EditorialPromptItem[] = targets.map((target) => ({
      id: target.id,
      category: target.category,
      source: target.sourceId,
      title: target.title,
      snippet: target.rawSnippet.slice(0, 400),
    }))
    const summary: DigestSummary = {
      overview: [],
      editorialDecisionSet: buildEditorialDecisionSet(
        promptItems,
        targets.map((target) => b032Decision(target, "eligible")),
      ),
      sections: [],
      degraded: false,
    }
    const publication: DigestPublicationV2 = {
      schemaVersion: 2,
      businessDate: "2026-07-14",
      overview: ["1", "2", "3", "4"],
      sections: [],
    }

    assert.deepEqual(validateDigestOverviewDensity(publication, summary), {
      valid: false,
      actual: 4,
      requiredMin: 5,
      allowedMax: 8,
      approvedCount: 5,
    })
    const completeOverview = ["1", "2", "3", "4", "5"]
    assert.equal(
      validateDigestOverviewDensity(
        {
          ...publication,
          overview: completeOverview,
          overviewRefs: targets.map((target, index) => ({
            text: completeOverview[index],
            itemIds: [target.id],
          })),
        },
        summary,
      ).valid,
      true,
    )
    assert.equal(
      validateDigestOverviewDensity(publication, {
        overview: [],
        sections: [],
        degraded: false,
      }).valid,
      true,
    )
  })

  it("拒绝不同速览共享同一条目 ID，即使全局唯一 ID 数量已经达到速览条数", () => {
    const targets = Array.from({ length: 5 }, (_, index) =>
      item(`overlap-${index + 1}`, "ai", `AI research result ${index + 1}`),
    )
    const promptItems: EditorialPromptItem[] = targets.map((target) => ({
      id: target.id,
      category: target.category,
      source: target.sourceId,
      title: target.title,
      snippet: target.rawSnippet.slice(0, 400),
    }))
    const summary: DigestSummary = {
      overview: [],
      editorialDecisionSet: buildEditorialDecisionSet(
        promptItems,
        targets.map((target) => b032Decision(target, "eligible")),
      ),
      sections: [],
      degraded: false,
    }
    const overview = targets.map((_, index) => `速览 ${index + 1}`)
    const publication: DigestPublicationV2 = {
      schemaVersion: 2,
      businessDate: "2026-07-15",
      overview,
      overviewRefs: targets.map((target, index) => ({
        text: overview[index],
        itemIds: index === 0 ? [targets[0].id] : [targets[0].id, target.id],
      })),
      sections: [
        {
          category: "ai",
          entries: targets.map((target) => ({ itemId: target.id, role: "brief" as const })),
        },
      ],
    }

    assert.equal(validateDigestOverviewDensity(publication, summary).valid, false)
    assert.throws(
      () => assertValidDigestPublication(publication, targets, targets.map(eligible)),
      /overview.*(?:reused|overlap)|(?:reused|overlap).*overview/i,
    )
  })

  it("忽略冲突 legacy 字段与语义正则；set 缺失 ID 保持 unreviewed 不回退", () => {
    const sakana = {
      ...item("sakana", "community", "Sakana AI shares its latest research"),
      rawSnippet: "We are pleased to share our latest research: Smart Cellular Bricks.",
    }
    const shortResearch = {
      ...item("short-research", "community", "Sakana research"),
      rawSnippet: "Sakana AI published reproducible Smart Cellular Bricks experiments.",
    }
    const help = item("help-b032", "community", "专科大二，喜欢底层开发，迷茫想听建议")
    const legacyOnly = item("legacy-only", "community", "旧审核声称可发布的 AI 动态")
    const all = [sakana, shortResearch, help, legacyOnly]
    const promptItems: EditorialPromptItem[] = all.map((target) => ({
      id: target.id,
      category: target.category,
      source: target.sourceId,
      title: target.title,
      snippet: target.rawSnippet.slice(0, 400),
    }))
    const editorialDecisionSet = buildEditorialDecisionSet(promptItems, [
      b032Decision(sakana, "eligible"),
      b032Decision(shortResearch, "eligible"),
      b032Decision(help, "rejected", "personal_help"),
      // legacyOnly 故意缺决定：必须保持 unreviewed，不能回读 legacy eligible。
    ])
    const summary: DigestSummary = {
      overview: [],
      editorialDecisionSet,
      // 全部与新 set 冲突：B032 路径必须整体忽略，不能逐 ID 混合。
      editorialAssessments: [
        { ...eligible(sakana), reviewState: "rejected", rejectReason: "low_signal" },
        { ...eligible(shortResearch), reviewState: "rejected", rejectReason: "low_signal" },
        eligible(help),
        eligible(legacyOnly),
      ],
      communityDropIds: [sakana.id, shortResearch.id],
      sections: [
        {
          category: "community",
          picks: [
            { itemId: sakana.id, summaryZh: "Sakana AI 发布细胞砖块研究。" },
            { itemId: help.id, summaryZh: "个人求助。" },
            { itemId: legacyOnly.id, summaryZh: "旧审核条目。" },
          ],
          briefItemIds: [shortResearch.id],
        },
      ],
      degraded: false,
    }

    const { publication, audit } = buildDigestPublication({
      businessDate: "2026-07-14",
      summary,
      items: all,
      githubItemIds: [],
      podcastItemIds: [],
    })

    assert.deepEqual(getPublishedItemIds(publication), [sakana.id, shortResearch.id])
    assert.equal(audit.policyVersion, "F037-B032-v1")
    assert.equal(audit.assessments.find((entry) => entry.itemId === help.id)?.reviewState, "rejected")
    assert.equal(
      audit.assessments.find((entry) => entry.itemId === legacyOnly.id)?.reviewState,
      "unreviewed",
    )
  })

  it("错误 schema/policy/hash、零票或伪造同 target 共识均不得授权发布", () => {
    const target = item("forged-b032", "ai", "vLLM inference scheduler benchmark")
    const promptItems: EditorialPromptItem[] = [
      {
        id: target.id,
        category: target.category,
        source: target.sourceId,
        title: target.title,
        snippet: target.rawSnippet.slice(0, 400),
      },
    ]
    const valid = buildEditorialDecisionSet(promptItems, [b032Decision(target, "eligible")])
    const firstTarget = valid.decisions[0].votes[0].reviewerTarget
    const variants: Array<[string, unknown]> = [
      ["schema", { ...valid, schemaVersion: 999 }],
      ["policy", { ...valid, policyVersion: "forged-policy" }],
      ["hash", { ...valid, inputHash: "not-a-hash" }],
      [
        "zero-votes",
        {
          ...valid,
          decisions: valid.decisions.map((decision) => ({ ...decision, votes: [] })),
        },
      ],
      [
        "same-target",
        {
          ...valid,
          decisions: valid.decisions.map((decision) => ({
            ...decision,
            votes: decision.votes.map((vote, index) =>
              index === 1 ? { ...vote, reviewerTarget: firstTarget } : vote,
            ),
          })),
        },
      ],
    ]

    for (const [label, forged] of variants) {
      const summary: DigestSummary = {
        overview: [],
        editorialDecisionSet:
          forged as NonNullable<DigestSummary["editorialDecisionSet"]>,
        editorialAssessments: [eligible(target)],
        sections: [
          {
            category: "ai",
            picks: [{ itemId: target.id, summaryZh: "伪造审核不应发布。" }],
          },
        ],
        degraded: false,
      }
      const { publication, audit } = buildDigestPublication({
        businessDate: "2026-07-14",
        summary,
        items: [target],
        githubItemIds: [],
        podcastItemIds: [],
      })

      assert.deepEqual(getPublishedItemIds(publication), [], label)
      assert.equal(audit.policyVersion, "F037-B032-v1", label)
      assert.equal(audit.assessments[0]?.reviewState, "unreviewed", label)
    }
  })

  it("畸形 decision set 失败关闭为 unreviewed，不抛异常、不回退 legacy", () => {
    const target = item("malformed-b032", "community", "Sakana AI research result")
    const summary: DigestSummary = {
      overview: [],
      editorialDecisionSet: {} as NonNullable<DigestSummary["editorialDecisionSet"]>,
      editorialAssessments: [eligible(target)],
      sections: [
        {
          category: "community",
          picks: [{ itemId: target.id, summaryZh: "畸形审核不应发布。" }],
        },
      ],
      degraded: false,
    }

    assert.doesNotThrow(() => {
      const { publication, audit } = buildDigestPublication({
        businessDate: "2026-07-14",
        summary,
        items: [target],
        githubItemIds: [],
        podcastItemIds: [],
      })
      assert.deepEqual(getPublishedItemIds(publication), [])
      assert.equal(audit.assessments[0]?.reviewState, "unreviewed")
    })
  })
})
