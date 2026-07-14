export type GithubAiEligibilityState = "yes" | "no" | "unknown"

export interface GithubRepoEvidence {
  repo: string
  description: string
  topics: string[]
  readme: string | null
  /** topics/README 的预期证据面是否完整；false 时弱信号必须 unknown，不能猜 yes。 */
  evidenceComplete: boolean
}

export interface GithubAiEligibility {
  state: GithubAiEligibilityState
  confidence: number
  reasons: string[]
}

const STRONG_TOPICS = new Set([
  "llm",
  "large-language-model",
  "large-language-models",
  "machine-learning",
  "deep-learning",
  "generative-ai",
  "artificial-intelligence",
  "model-context-protocol",
  "ai-agent",
  "ai-agents",
  "rag",
  "retrieval-augmented-generation",
  "inference",
  "vllm",
  "sglang",
  "transformers",
  "pytorch",
  "tensorflow",
  "diffusion-models",
  "computer-vision",
  "natural-language-processing",
  "ai-coding",
])
// `mcp` 也可指 Minecraft Coder Pack；必须由 description/README 的 Model Context
// Protocol / MCP server 事实消歧，不能仅凭 topic 直接准入。
const WEAK_TOPICS = new Set([
  "ai",
  "agent",
  "agents",
  "assistant",
  "skills",
  "claude",
  "openai",
  "mcp",
])

const HARD_NON_AI_RE =
  /(?:\biptv\b|television channels?|tv playlist|wallpapers?|\bweMod\b|monitoring agent|observability agent|background daemon|collects? (?:cpu|memory|disk) metrics|static portfolio|no ai functionality|conventional static)/i
const INCIDENTAL_AI_RE =
  /\b(?:built|made|developed|created|generated|written|implemented|vibe[- ]?coded)\s+(?:by|with|using)\s+(?:an?\s+)?(?:ai|chatgpt|claude code|codex)\b/gi
const STRONG_CORE_RE =
  /(?:\bllm\b|large language model|model context protocol|\bmcp server\b|\bai agents?\b|\bai coding (?:agent|assistant)|coding agents?|\brag\b|retrieval[- ]augmented|\binference (?:engine|runtime|server|framework|optimization)|model serving|foundation model|machine learning|deep learning|neural network|transformer model|model training|fine[- ]tuning|vector (?:database|search)|embedding model|computer vision|natural language processing|diffusion model|agentic (?:workflow|system|framework)|AI penetration testing tool)/i
const CODING_ASSISTANT_CORE_RE =
  /(?:(?:plugins?|extensions?|integrations?|skills?|hooks?|workflows?|toolkits?)(?:\s+(?:and|,)\s+(?:plugins?|extensions?|integrations?|skills?|hooks?|workflows?|toolkits?))?\s+(?:for|to)\s+(?:claude code|codex)\b|\b(?:claude code|codex)(?:\s+(?:cli|coding agent))?\s+(?:plugins?|extensions?|integrations?|skills?|hooks?|workflows?|toolkits?)\b|\b(?:extends?|integrates? with)\s+(?:claude code|codex)\b)/i

function yes(reason: string, confidence: number): GithubAiEligibility {
  return { state: "yes", confidence, reasons: [reason] }
}

function no(reason: string, confidence: number): GithubAiEligibility {
  return { state: "no", confidence, reasons: [reason] }
}

function unknown(reason: string): GithubAiEligibility {
  return { state: "unknown", confidence: 0, reasons: [reason] }
}

/**
 * AI 判定只做准入，不产排名分数。强 topic 可直接裁决；弱 topic 必须由 description/README
 * 证明 AI 是仓库核心用途。证据不全时 fail-closed 为 unknown。
 */
export async function assessGithubAiEligibility(
  evidence: GithubRepoEvidence,
): Promise<GithubAiEligibility> {
  const topics = evidence.topics.map((topic) => topic.toLowerCase())
  const contentText = `${evidence.description}\n${evidence.readme ?? ""}`
  const text = `${evidence.repo}\n${contentText}`
  const contentWithoutDevelopmentAttribution = contentText.replace(INCIDENTAL_AI_RE, " ")
  const hasDevelopmentAttribution = contentWithoutDevelopmentAttribution !== contentText
  const hasCoreEvidence = (candidate: string): boolean =>
    STRONG_CORE_RE.test(candidate) || CODING_ASSISTANT_CORE_RE.test(candidate)

  if (HARD_NON_AI_RE.test(text)) return no("仓库核心用途命中明确非 AI 产品/基础设施", 0.99)
  if (hasDevelopmentAttribution && !hasCoreEvidence(contentWithoutDevelopmentAttribution)) {
    return no("AI 仅是制作方式，不是仓库核心能力", 0.98)
  }

  const strongTopic = topics.find((topic) => STRONG_TOPICS.has(topic))
  if (strongTopic) return yes(`强 AI topic：${strongTopic}`, 0.98)
  if (hasCoreEvidence(contentText)) return yes("description/README 表明 AI 是核心用途", 0.92)

  const weakSignal =
    topics.some((topic) => WEAK_TOPICS.has(topic)) || /\b(?:ai|agent|assistant)\b/i.test(text)
  if (!evidence.evidenceComplete) {
    return unknown(
      weakSignal ? "只有弱 AI 信号且 topics/README 证据不完整" : "缺少完整 topics/README 证据",
    )
  }
  if (weakSignal) return no("弱 AI/agent 词缺少核心用途佐证", 0.85)
  return no("完整证据中没有 AI 核心用途", 0.95)
}

export function isGithubPublishable(assessment: GithubAiEligibility): boolean {
  return assessment.state === "yes"
}
