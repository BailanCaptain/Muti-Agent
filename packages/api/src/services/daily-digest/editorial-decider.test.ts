import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  EDITORIAL_POLICY_VERSION,
  buildEditorialDecisionSet,
  createEditorialDecider,
  mergeEditorialVotes,
  parseEditorialVotes,
  validateEditorialDecisionSet,
  type EditorialPromptItem,
} from "./editorial-decider"
import type { DigestModelRunner, DigestModelTarget } from "./model-runner"

const primary = {
  provider: "claude",
  model: "claude-opus-primary",
} as const satisfies DigestModelTarget
const fallback = {
  provider: "claude",
  model: "claude-opus-fallback",
} as const satisfies DigestModelTarget
const codex = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
} as const satisfies DigestModelTarget

function item(
  id: string,
  category: EditorialPromptItem["category"] = "ai",
  title = `Title ${id}`,
  snippet = `AI engineering fact for ${id}`,
): EditorialPromptItem {
  return { id, category, source: `source-${id}`, title, snippet }
}

function positiveVote(
  target: EditorialPromptItem,
  basis: "research_result" | "engineering_work" | "product_release" | "technical_discussion" | "ai_industry_event" | "finance_event" =
    "engineering_work",
  inference = false,
) {
  const quote = target.snippet.slice(0, 120)
  return {
    itemId: target.id,
    basis,
    topicTags: inference ? ["inference"] : ["research"],
    organizationTags: ["Example AI"],
    ecosystemTags: ["open_source"],
    regionTags: ["global"],
    evidence: [
      { field: "snippet", quote, supports: "ai_relevance" },
      {
        field: "snippet",
        quote,
        supports: basis === "finance_event" ? "finance_context" : "substantive_fact",
      },
      ...(inference
        ? [{ field: "snippet", quote, supports: "inference_technical" }]
        : []),
    ],
    confidence: 0.91,
  }
}

function negativeVote(
  target: EditorialPromptItem,
  basis: "personal_help" | "complaint" | "gossip" | "reaction_only" | "off_topic",
) {
  return {
    itemId: target.id,
    basis,
    topicTags: ["other"],
    organizationTags: [],
    ecosystemTags: [],
    regionTags: ["global"],
    evidence: [
      { field: "snippet", quote: target.snippet.slice(0, 120), supports: "disqualifier" },
    ],
    confidence: 0.88,
  }
}

function response(...votes: unknown[]): string {
  return JSON.stringify({ votes })
}

describe("parseEditorialVotes", () => {
  it("只信 executor 注入的 reviewer target，并锚定同 ID 原文证据", () => {
    const sakana = item(
      "sakana",
      "community",
      "Sakana AI shares its latest research",
      "We are pleased to share our latest research: Smart Cellular Bricks.",
    )
    const raw = {
      ...positiveVote(sakana, "research_result"),
      reviewerTarget: codex,
      evidence: [
        { field: "snippet", quote: "share   our latest research", supports: "ai_relevance" },
        {
          field: "snippet",
          quote: "Smart Cellular Bricks",
          supports: "substantive_fact",
        },
      ],
    }

    const votes = parseEditorialVotes(response(raw), [sakana], primary)

    assert.equal(votes.length, 1)
    assert.deepEqual(votes[0]?.reviewerTarget, primary)
    assert.equal(votes[0]?.basis, "research_result")
  })

  it("单条跨 ID、改写、超长或超预算证据只淘汰该 ID，不丢同批有效票", () => {
    const a = item("a", "community", "A", "Alpha private help request")
    const b = item("b", "community", "B", "Beta asks for career advice")
    const c = item("c", "community", "C", "Gamma complains about salary")
    const d = item("d", "community", "D", "Delta is only a reaction")
    const e = item("e", "community", "E", "Epsilon asks for career advice")
    const huge = { ...negativeVote(d, "reaction_only"), padding: "x".repeat(1_100) }

    const votes = parseEditorialVotes(
      response(
        {
          ...negativeVote(a, "personal_help"),
          evidence: [
            { field: "snippet", quote: b.snippet, supports: "disqualifier" },
          ],
        },
        {
          ...negativeVote(b, "personal_help"),
          evidence: [
            { field: "snippet", quote: "career guidance", supports: "disqualifier" },
          ],
        },
        {
          ...negativeVote(c, "complaint"),
          evidence: [
            { field: "snippet", quote: "x".repeat(161), supports: "disqualifier" },
          ],
        },
        huge,
        negativeVote(e, "personal_help"),
      ),
      [a, b, c, d, e],
      fallback,
    )

    assert.deepEqual(votes.map((vote) => vote.itemId), ["e"])
  })
})

describe("mergeEditorialVotes", () => {
  it("Sakana research 双审发布；真实 finance 可进 AI 行业但永不带 inference", () => {
    const sakana = item(
      "sakana",
      "community",
      "Sakana shares research",
      "Sakana AI shares Smart Cellular Bricks research results.",
    )
    const finance = item(
      "finance",
      "ai",
      "Nvidia and CoreWeave circular financing",
      "Nvidia acquired CoreWeave shares in a circular financing transaction.",
    )
    const p = parseEditorialVotes(
      response(
        positiveVote(sakana, "research_result"),
        positiveVote(finance, "finance_event", true),
      ),
      [sakana, finance],
      primary,
    )
    const f = parseEditorialVotes(
      response(
        positiveVote(sakana, "research_result"),
        positiveVote(finance, "finance_event", true),
      ),
      [sakana, finance],
      fallback,
    )

    const decisions = mergeEditorialVotes({ primary: p, fallback: f }, [sakana, finance])

    assert.equal(
      decisions.find((decision) => decision.itemId === "sakana")?.reviewState,
      "eligible",
    )
    assert.equal(decisions.find((decision) => decision.itemId === "sakana")?.contentKind, "research")
    const financeDecision = decisions.find((decision) => decision.itemId === "finance")
    assert.equal(financeDecision?.reviewState, "eligible")
    assert.equal(financeDecision?.contentKind, "finance")
    assert.ok(!financeDecision?.topicTags.includes("inference"))
  })

  it("关键域必须有两个不同 target 的等价票；Codex 只靠与一侧一致形成两票", () => {
    const cuda = item(
      "cuda",
      "ai",
      "CUDA graph batching race postmortem",
      "CUDA graph dynamic batching race was isolated; the fix reduced TTFT.",
    )
    const p = parseEditorialVotes(
      response(positiveVote(cuda, "engineering_work", true)),
      [cuda],
      primary,
    )
    const disagree = parseEditorialVotes(
      response(positiveVote(cuda, "finance_event")),
      [cuda],
      fallback,
    )

    assert.equal(
      mergeEditorialVotes({ primary: p, fallback: disagree }, [cuda])[0]?.reviewState,
      "unreviewed",
    )

    const adjudicator = parseEditorialVotes(
      response(positiveVote(cuda, "technical_discussion", true)),
      [cuda],
      codex,
    )
    const decided = mergeEditorialVotes(
      { primary: p, fallback: disagree, adjudicator },
      [cuda],
    )[0]
    assert.equal(decided?.reviewState, "eligible")
    assert.equal(decided?.contentKind, "engineering")
    assert.ok(decided?.topicTags.includes("inference"))

    const forgedSecond = parseEditorialVotes(
      response(positiveVote(cuda, "engineering_work", true)),
      [cuda],
      primary,
    )
    assert.equal(
      mergeEditorialVotes({ primary: p, fallback: forgedSecond }, [cuda])[0]?.reviewState,
      "unreviewed",
    )
  })

  it("两个明确拒绝票即使 basis 不同也一致；不确定 basis 保持 abstain", () => {
    const noise = item(
      "noise",
      "community",
      "ChatGPT dating route",
      "I used ChatGPT for a blind date route and finally ate hotpot alone.",
    )
    const uncertain = item(
      "uncertain",
      "podcast",
      "Unknown episode",
      "Insufficient excerpt.",
    )
    const p = parseEditorialVotes(
      response(negativeVote(noise, "off_topic"), {
        ...negativeVote(uncertain, "off_topic"),
        basis: "insufficient_context",
      }),
      [noise, uncertain],
      primary,
    )
    const f = parseEditorialVotes(
      response(negativeVote(noise, "reaction_only"), {
        ...negativeVote(uncertain, "off_topic"),
        basis: "mixed_signals",
      }),
      [noise, uncertain],
      fallback,
    )
    const decisions = mergeEditorialVotes({ primary: p, fallback: f }, [noise, uncertain])

    assert.equal(
      decisions.find((decision) => decision.itemId === "noise")?.reviewState,
      "rejected",
    )
    assert.equal(
      decisions.find((decision) => decision.itemId === "uncertain")?.reviewState,
      "unreviewed",
    )
  })
})

describe("buildEditorialDecisionSet", () => {
  it("由服务端冻结 policyVersion 与稳定 inputHash；原文变化会改变 hash", () => {
    const target = item("hash", "ai", "Hash title", "Hash body")
    const p = parseEditorialVotes(
      response(positiveVote(target, "research_result")),
      [target],
      primary,
    )
    const f = parseEditorialVotes(
      response(positiveVote(target, "research_result")),
      [target],
      fallback,
    )
    const decisions = mergeEditorialVotes({ primary: p, fallback: f }, [target])

    const first = buildEditorialDecisionSet([target], decisions)
    const same = buildEditorialDecisionSet([target], decisions)
    const changed = buildEditorialDecisionSet([{ ...target, snippet: "Changed body" }], decisions)

    assert.equal(first.schemaVersion, 1)
    assert.equal(first.policyVersion, EDITORIAL_POLICY_VERSION)
    assert.match(first.inputHash, /^[a-f0-9]{64}$/)
    assert.equal(first.inputHash, same.inputHash)
    assert.notEqual(first.inputHash, changed.inputHash)
  })
})

describe("validateEditorialDecisionSet", () => {
  it("同一条目每个 reviewer slot 只能有一票，不能用不同 target 冒充两次 review_a", () => {
    const target = item(
      "duplicate-slot",
      "ai",
      "vLLM scheduler benchmark",
      "vLLM scheduler improved inference throughput and reduced TTFT.",
    )
    const firstA = parseEditorialVotes(
      response(positiveVote(target, "technical_discussion", true)),
      [target],
      primary,
      "review_a",
    )
    const forgedSecondA = parseEditorialVotes(
      response(positiveVote(target, "technical_discussion", true)),
      [target],
      fallback,
      "review_a",
    )
    const decisions = mergeEditorialVotes({ primary: [...firstA, ...forgedSecondA] }, [target])
    const forged = buildEditorialDecisionSet([target], decisions)

    assert.equal(validateEditorialDecisionSet(forged, [target]), null)
  })

  it("同一 slot 在整个批次内冻结到同一 target，跨条目互换 A/B 必须失败关闭", () => {
    const first = item("slot-map-a", "ai", "First", "First AI research result.")
    const second = item("slot-map-b", "ai", "Second", "Second AI research result.")
    const firstVotes = [
      ...parseEditorialVotes(
        response(positiveVote(first, "research_result")),
        [first],
        primary,
        "review_a",
      ),
      ...parseEditorialVotes(
        response(positiveVote(first, "research_result")),
        [first],
        fallback,
        "review_b",
      ),
    ]
    const swappedSecondVotes = [
      ...parseEditorialVotes(
        response(positiveVote(second, "research_result")),
        [second],
        fallback,
        "review_a",
      ),
      ...parseEditorialVotes(
        response(positiveVote(second, "research_result")),
        [second],
        primary,
        "review_b",
      ),
    ]
    const decisions = mergeEditorialVotes(
      { primary: [...firstVotes, ...swappedSecondVotes] },
      [first, second],
    )

    assert.equal(
      validateEditorialDecisionSet(buildEditorialDecisionSet([first, second], decisions), [
        first,
        second,
      ]),
      null,
    )
  })

  it("合法 A/B 拓扑保留；降级时 pass1 单条缺票后可由 pass2/pass3 收敛", () => {
    const normal = item("valid-topology", "ai", "Normal", "Normal AI research result.")
    const normalA = parseEditorialVotes(
      response(positiveVote(normal, "research_result")),
      [normal],
      primary,
      "review_a",
    )
    const normalB = parseEditorialVotes(
      response(positiveVote(normal, "research_result")),
      [normal],
      fallback,
      "review_b",
    )
    const normalSet = buildEditorialDecisionSet(
      [normal],
      mergeEditorialVotes({ primary: normalA, fallback: normalB }, [normal]),
    )
    assert.equal(validateEditorialDecisionSet(normalSet, [normal])?.decisions[0]?.reviewState, "eligible")

    const degraded = item(
      "valid-pass2-pass3",
      "ai",
      "Degraded",
      "vLLM inference scheduler improved throughput.",
    )
    const pass2 = parseEditorialVotes(
      response(positiveVote(degraded, "technical_discussion", true)),
      [degraded],
      codex,
      "codex_pass_2",
    )
    const pass3 = parseEditorialVotes(
      response(positiveVote(degraded, "technical_discussion", true)),
      [degraded],
      codex,
      "codex_pass_3",
    )
    const degradedIds = new Set([degraded.id])
    const degradedSet = buildEditorialDecisionSet(
      [degraded],
      mergeEditorialVotes({ adjudicator: [...pass2, ...pass3] }, [degraded], {
        allowSameTargetConsensusItemIds: degradedIds,
        degradedItemIds: degradedIds,
      }),
    )
    const trustedDegraded = validateEditorialDecisionSet(degradedSet, [degraded])
    assert.equal(trustedDegraded?.reviewMode, "degraded_same_target")
    assert.equal(trustedDegraded?.decisions[0]?.reviewState, "eligible")
    assert.deepEqual(
      trustedDegraded?.decisions[0]?.votes.map((vote) => vote.reviewerSlot),
      ["codex_pass_2", "codex_pass_3"],
    )
  })
})

describe("createEditorialDecider", () => {
  function scriptedTargetRunner(
    outputs: readonly string[],
    calls: Array<{ targetIndex: number; prompt: string }>,
  ): DigestModelRunner {
    const targets = [primary, fallback, codex] as const
    return {
      targets,
      async runPrompt() {
        throw new Error("editorial decider must name the target")
      },
      async runTargetPrompt(targetIndex, prompt) {
        calls.push({ targetIndex, prompt })
        return {
          ok: true,
          text: outputs[targetIndex] ?? '{"votes":[]}',
          durationMs: (targetIndex + 1) * 10,
        }
      },
    }
  }

  it("A/B 独立看原文，Codex 一次只收冲突 ID，reviewer 身份由 executor 冻结", async () => {
    const sakana = item(
      "sakana",
      "community",
      "Sakana shares research",
      "Sakana AI shares Smart Cellular Bricks research results.",
    )
    const cuda = item(
      "cuda",
      "ai",
      "CUDA graph batching race postmortem",
      "CUDA graph dynamic batching race was isolated; the fix reduced TTFT.",
    )
    const reaction = item(
      "reaction",
      "community",
      "vLLM is amazing",
      "vLLM batching is amazing and I really love it.",
    )
    const hot = item(
      "hot",
      "hot",
      "ChatGPT Sites public beta",
      "ChatGPT Sites entered public beta with publishing and collaboration features.",
    )
    const primaryOutput = JSON.stringify({
      marker: "PRIMARY_JUDGMENT_SENTINEL",
      votes: [
        positiveVote(sakana, "research_result"),
        positiveVote(cuda, "engineering_work", true),
        negativeVote(reaction, "reaction_only"),
        positiveVote(hot, "product_release"),
      ],
    })
    const fallbackOutput = response(
      positiveVote(sakana, "research_result"),
      positiveVote(cuda, "finance_event"),
      negativeVote(reaction, "off_topic"),
    )
    const codexOutput = response(positiveVote(cuda, "technical_discussion", true))
    const calls: Array<{ targetIndex: number; prompt: string }> = []
    const decider = createEditorialDecider({
      runner: scriptedTargetRunner([primaryOutput, fallbackOutput, codexOutput], calls),
    })

    const set = await decider.decide([sakana, cuda, reaction, hot], "2026-07-14")

    assert.ok(set)
    assert.deepEqual(calls.map((call) => call.targetIndex), [0, 1, 2])
    assert.ok(calls[0]?.prompt.includes('"id":"hot"'))
    assert.ok(!calls[1]?.prompt.includes('"id":"hot"'), "已被 A 明确判断的 hot 不进 B")
    assert.ok(calls[1]?.prompt.includes('"id":"sakana"'))
    assert.ok(!calls[1]?.prompt.includes("PRIMARY_JUDGMENT_SENTINEL"))
    assert.ok(calls[2]?.prompt.includes('"id":"cuda"'))
    assert.ok(!calls[2]?.prompt.includes('"id":"sakana"'))
    assert.ok(!calls[2]?.prompt.includes('"id":"reaction"'))
    assert.ok(!calls[2]?.prompt.includes("PRIMARY_JUDGMENT_SENTINEL"))
    assert.equal(set?.decisions.find((entry) => entry.itemId === "sakana")?.reviewState, "eligible")
    assert.equal(set?.decisions.find((entry) => entry.itemId === "reaction")?.reviewState, "rejected")
    const cudaDecision = set?.decisions.find((entry) => entry.itemId === "cuda")
    assert.equal(cudaDecision?.reviewState, "eligible")
    assert.deepEqual(
      cudaDecision?.votes.map((vote) => vote.reviewerTarget),
      [primary, fallback, codex],
    )
  })

  it("关键域 A/B 无分歧时固定两次批调用，不调用 Codex", async () => {
    const vllm = item(
      "vllm",
      "ai",
      "vLLM long-context scheduling",
      "vLLM compared long-context scheduling throughput and TTFT.",
    )
    const same = response(positiveVote(vllm, "technical_discussion", true))
    const calls: Array<{ targetIndex: number; prompt: string }> = []
    const decider = createEditorialDecider({
      runner: scriptedTargetRunner([same, same, response()], calls),
    })

    const set = await decider.decide([vllm], "2026-07-14")

    assert.equal(set?.decisions[0]?.reviewState, "eligible")
    assert.deepEqual(calls.map((call) => call.targetIndex), [0, 1])
  })

  it("Claude runner 全部失败时由同一 Codex fresh A/B/C 收敛，并明示降级而非伪装双模型", async () => {
    const cuda = item(
      "cuda-degraded",
      "ai",
      "CUDA graph batching race postmortem",
      "CUDA graph dynamic batching race was isolated; the fix reduced TTFT.",
    )
    const codexOutputs = [
      JSON.stringify({
        marker: "CODEX_PASS_1_SENTINEL",
        votes: [positiveVote(cuda, "engineering_work", true)],
      }),
      response(positiveVote(cuda, "finance_event")),
      response(positiveVote(cuda, "technical_discussion", true)),
    ]
    const calls: Array<{ targetIndex: number; prompt: string }> = []
    const targets = [primary, fallback, codex] as const
    const runner: DigestModelRunner = {
      targets,
      async runPrompt() {
        throw new Error("editorial decider must name the target")
      },
      async runTargetPrompt(targetIndex, prompt) {
        calls.push({ targetIndex, prompt })
        if (targetIndex < 2) {
          return { ok: false, text: "", durationMs: 10, error: "provider-error" }
        }
        return { ok: true, text: codexOutputs.shift() ?? response(), durationMs: 20 }
      },
    }
    const decider = createEditorialDecider({ runner })

    const set = await decider.decide([cuda], "2026-07-14")

    assert.deepEqual(calls.map((call) => call.targetIndex), [0, 1, 2, 2, 2])
    assert.ok(!calls[3]?.prompt.includes("CODEX_PASS_1_SENTINEL"))
    assert.ok(!calls[4]?.prompt.includes("CODEX_PASS_1_SENTINEL"))
    assert.equal(set?.reviewMode, "degraded_same_target")
    const decision = set?.decisions[0]
    assert.equal(decision?.reviewState, "eligible")
    assert.equal(decision?.reviewMode, "degraded_same_target")
    assert.deepEqual(
      decision?.votes.map((vote) => vote.reviewerSlot),
      ["codex_pass_1", "codex_pass_2", "codex_pass_3"],
    )
    assert.ok(
      decision?.votes.every((vote) => vote.reviewerTarget.model === "gpt-5.6-sol"),
    )
  })

  it("Claude 返回坏结构不是 unavailable，不得偷启同模型双审", async () => {
    const target = item(
      "invalid-claude",
      "ai",
      "vLLM scheduler",
      "vLLM scheduler improved throughput and TTFT.",
    )
    const calls: Array<{ targetIndex: number; prompt: string }> = []
    const targets = [primary, fallback, codex] as const
    const runner: DigestModelRunner = {
      targets,
      async runPrompt() {
        throw new Error("editorial decider must name the target")
      },
      async runTargetPrompt(targetIndex, prompt) {
        calls.push({ targetIndex, prompt })
        if (targetIndex < 2) return { ok: true, text: "not-json", durationMs: 10 }
        return {
          ok: true,
          text: response(positiveVote(target, "technical_discussion", true)),
          durationMs: 20,
        }
      },
    }

    const set = await createEditorialDecider({ runner }).decide([target], "2026-07-14")

    assert.deepEqual(calls.map((call) => call.targetIndex), [0, 1, 2])
    assert.equal(set?.reviewMode, "multi_target")
    assert.equal(set?.decisions[0]?.reviewState, "unreviewed")
  })

  it("两个 Claude 都 exit-0 空输出时不得进入同 Codex 双票降级", async () => {
    const target = item(
      "empty-claude",
      "ai",
      "vLLM scheduler",
      "vLLM scheduler improved inference throughput and TTFT.",
    )
    const calls: number[] = []
    const targets = [primary, fallback, codex] as const
    const runner: DigestModelRunner = {
      targets,
      async runPrompt() {
        throw new Error("editorial decider must name the target")
      },
      async runTargetPrompt(targetIndex) {
        calls.push(targetIndex)
        if (targetIndex < 2) {
          return { ok: false, text: "", durationMs: 10, error: "empty-output" }
        }
        return {
          ok: true,
          text: response(positiveVote(target, "technical_discussion", true)),
          durationMs: 20,
        }
      },
    }

    const set = await createEditorialDecider({ runner }).decide([target], "2026-07-14")

    assert.deepEqual(calls, [0, 1, 2])
    assert.equal(set?.reviewMode, "multi_target")
    assert.equal(set?.decisions[0]?.reviewState, "unreviewed")
  })
})
