/**
 * F027 P13.2 · Critique Agent (Sonnet 4.6 LLM judge)
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1398-1424
 *
 * 每级 fallback 跑后让 LLM 评估 hits 是否充分回答 query：
 *   - satisfied=true: 当前级 hits 已覆盖 query
 *   - satisfied=false + next_level: 继续下一级搜索
 *   - satisfied=false + next_level=4 + specific_path: 触发 L4 严格读
 *   - satisfied=false + escalate=true: 直接升 L5 不再搜
 *
 * 模型选择（小孙 2026-05-13 拍 5 个 Open #2）：
 *   - **Sonnet 4.6**（同 P12 decision-extractor），准确度优先
 *   - 走 createSonnetRunner（runtime/haiku-runner.ts）
 *
 * 防 hallucination 校验：
 *   1. nextLevel 必须 > 当前 level（防反复推回）
 *   2. nextLevel=4 必须配 specificPath
 *   3. specificPath 必须形如 `wiki/...` 或当前 hits 中已存在的 path 前缀
 */

import type {
  CritiqueAgent,
  CritiqueInput,
  CritiqueVerdict,
} from "./types"

// ─── Claude CLI Runner 抽象（兼容 createHaikuRunner / createSonnetRunner） ──

export interface ClaudeRunner {
  runPrompt(
    prompt: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; text: string; error?: string; durationMs: number }>
}

const DEFAULT_TIMEOUT_MS = 30000
const HITS_EXCERPT_TRUNCATE = 300
const QUERY_TRUNCATE = 400

// ─── Prompt 构造 ────────────────────────────────────────────────────────

export function buildCritiquePrompt(input: CritiqueInput): string {
  const hitsBlock =
    input.hits.length === 0
      ? "（本级 0 命中）"
      : input.hits
          .map((h, i) => {
            const excerpt = h.excerpt.slice(0, HITS_EXCERPT_TRUNCATE)
            return `- [${i + 1}] path: ${h.path}\n  score: ${h.score.toFixed(2)}\n  excerpt: ${excerpt}`
          })
          .join("\n")

  const visitedLine =
    input.visitedLevels.length > 0
      ? `已走过的级: [${input.visitedLevels.join(", ")}]`
      : "（首次评估）"

  const levelDesc: Record<1 | 2 | 3 | 4, string> = {
    1: "Level 1 = 注入的 task_memory_pack（wake-up 自动召回）",
    2: "Level 2 = search_wiki（BM25 + cosine hybrid，wiki 实体）",
    3: "Level 3 = query_messages（FTS5 全文搜历史消息）",
    4: "Level 4 = read_wiki(具体 path)（仅当你能给出 exact path 才触发）",
  }

  return `你是召回评估器。判定下面这级 fallback 的 hits 是否已**充分覆盖** query 的语义，让 agent 不需要再下一级也能正确回答。

[query 主题]
${input.query.slice(0, QUERY_TRUNCATE)}

[trigger 原因]
${input.trigger}

[当前级] ${input.level} — ${levelDesc[input.level]}
${visitedLine}

[本级 hits]
${hitsBlock}

[判定原则]
- 充分覆盖 → satisfied=true（hits 直接含 query 的答案 / 关键事实 / 决策原文）
- 不充分但下一级可能补足 → satisfied=false + next_level（2-5）
- 不充分但你能精确指出"读 wiki 的哪个 file 可以解决" → satisfied=false + next_level=4 + specific_path（必须形如 wiki/...）
- L1-L4 都不可能找到（query 是项目从未出现过的话题）→ satisfied=false + escalate=true

[硬约束]
- next_level 必须严格大于当前级（${input.level}）
- next_level=4 必须配 specific_path（严格模式，不接受 fuzzy path）
- specific_path 只能填本级 hits 中已出现的 path，或形如 "wiki/concepts/..." / "wiki/rules/..." 的标准 wiki 路径

只返回 JSON，不要任何解释或 markdown 包装：
{"satisfied": <bool>, "next_level": <2|3|4|5 或省略>, "specific_path": "<wiki 路径或省略>", "escalate": <bool 或省略>, "reason": "<≤80字>"}`
}

// ─── Parse 解析 + 防 hallucination 校验 ─────────────────────────────────

const WIKI_PATH_PREFIX = /^wiki\/[a-z][\w/-]*\.md$/i

export function parseCritiqueJson(raw: string, input: CritiqueInput): CritiqueVerdict {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const jsonText = fenced ? fenced[1].trim() : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(
      `critique-parse-failed: ${err instanceof Error ? err.message : String(err)} (raw len=${raw.length})`,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("critique-parse-failed: not an object")
  }
  const obj = parsed as Record<string, unknown>

  const satisfied = obj.satisfied === true
  const reasonRaw = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 200) : ""
  const reason = reasonRaw || (satisfied ? "satisfied" : "not_satisfied")

  if (satisfied) {
    return { satisfied: true, reason }
  }

  // satisfied=false → escalate 或 next_level 二选一
  const escalate = obj.escalate === true
  if (escalate) {
    return { satisfied: false, escalate: true, reason }
  }

  const nextLevelRaw = obj.next_level
  if (
    typeof nextLevelRaw !== "number" ||
    !Number.isInteger(nextLevelRaw) ||
    nextLevelRaw < 2 ||
    nextLevelRaw > 5
  ) {
    throw new Error(
      `critique-parse-failed: invalid next_level "${String(nextLevelRaw)}"（需要 2-5 整数或 escalate=true）`,
    )
  }
  const nextLevel = nextLevelRaw as 2 | 3 | 4 | 5

  // 防"反复推回"：nextLevel 必须严格 > current level
  if (nextLevel <= input.level) {
    throw new Error(
      `critique-parse-failed: next_level=${nextLevel} <= current level=${input.level}（防反复）`,
    )
  }

  // 范-r1 P2-2 修：next_level=5 转 escalate verdict（防 executor fall through 不识别）
  // L5 在 V16.5 chap 12 阶梯里是 "提示不确定 / 请求人工裁决"，不是继续搜索
  if (nextLevel === 5) {
    return { satisfied: false, escalate: true, reason }
  }

  // next_level=4 → specific_path 必须存在且严格合法（小孙 Open #3 拍 strict）
  // 范-r1 P2-1 修：移除"hits 中已存在 path"放宽（messages/... path 进 readWiki 注定返 null）
  if (nextLevel === 4) {
    const sp = obj.specific_path
    if (typeof sp !== "string" || sp.trim().length === 0) {
      throw new Error("critique-parse-failed: next_level=4 必须配 specific_path（严格模式）")
    }
    const path = sp.trim()
    if (!WIKI_PATH_PREFIX.test(path)) {
      throw new Error(
        `critique-parse-failed: specific_path="${path}" 不合法（严格模式：必须形如 wiki/...md）`,
      )
    }
    return { satisfied: false, nextLevel: 4, specificPath: path, reason }
  }

  return { satisfied: false, nextLevel, reason }
}

// ─── LlmCritiqueAgent 实现 ──────────────────────────────────────────────

export interface LlmCritiqueAgentOptions {
  /** Claude CLI 单次调用超时；默认 30s */
  timeoutMs?: number
}

export class LlmCritiqueAgent implements CritiqueAgent {
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly opts: LlmCritiqueAgentOptions = {},
  ) {}

  async evaluate(input: CritiqueInput): Promise<CritiqueVerdict> {
    const prompt = buildCritiquePrompt(input)
    const result = await this.runner.runPrompt(prompt, {
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    if (!result.ok) {
      throw new Error(`critique-runner-failed: ${result.error ?? "unknown"}`)
    }
    return parseCritiqueJson(result.text, input)
  }
}
