/**
 * F027 P12 · Decision Extractor
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1238-1253 + 范-r2 Q-B-2 GO
 *
 * 两段流程（小孙 2026-05-13 拍 + 范-r2 GO）：
 *   1. 关键词宽召（broad_candidates）—— 宽松，宁多勿少
 *   2. Claude CLI yes/no 短判 —— LLM 二分类承担过滤
 *
 * 模型选择（小孙 2026-05-13 拍）：
 *   - **Sonnet 4.6**（不是 Haiku 4.5）—— 决策识别是语义密集任务，准确度优先
 *   - 订阅模式 quota 不是约束，可用更强模型
 *   - 走 createSonnetRunner（runtime/haiku-runner.ts，接口同 HaikuLike shape）
 *   - HaikuLike interface 名字是历史遗留，实际签名通用 ClaudeRunner shape
 *
 * R-201 真实数据观察（5/8 50 条）：
 *   - 50%+ user 消息是 "go"/"A"/"干掉" 短指令
 *   - 关键词扫单看一句识别不出语义 → 必须 join 上一条 assistant 消息
 *   - "go" + 上下文 "批准合 F026 进 merger-gate" → Sonnet 判 commit
 *   - "什么玩意" + 上下文 → Sonnet 判 non-decision
 *
 * 并发：每候选独立 await Sonnet CLI，限 MAX_CONCURRENCY 防 spawn 风暴
 *   （SessionTitler 实测 claude --print 冷启 18s / 热启 8-9s，14 候选串行=4min 内
 *   RoomCompiler tick 5min 撑得住，并发 4 把总耗时压到 ~30-60s；Sonnet 比 Haiku 慢一些
 *   但仍在窗口内）
 */

import type {
  ActiveCommitForSweep,
  BroadCandidate,
  CandidateJudgment,
  DecisionJudgeProvider,
  DecisionType,
  ExtractorRun,
} from "./types"

// ─── 关键词宽召规则（宁多勿少 — Sonnet 二判过滤） ─────────────────────

/**
 * commit 类（批准/完成/动作执行）：通常是简短确认或完成陈述
 * 宽召原则：宁多勿少，LLM 二判过滤
 */
const COMMIT_KEYWORDS = [
  /\bgo\b/i,
  /搞定/,
  /\bdone\b/i,
  /做完(了|啦)?/,
  /已(经)?合(并|入|了|完)/,
  /合(并|入|完)/, // u-14 "已经合并完了吗" — 宽召（即便是询问 LLM 过滤）
  /已合(?=\s|$|[a-zA-Z])/, // "F026 已合 dev" 简写宽召（已合 + 空格/EOL/英文目标）
  /已完成/,
  /验过了/,
  /验证(过|了)/,
  /通过(了|啦)?/,
  /^(好|嗯|ok|OK)$/,
  /闭环/,
  /推完/,
  /合上/,
  /干掉/,
  /删掉/,
  /^直接删/,
]

/** spec 类（拍板 / 立项 / 选项） */
const SPEC_KEYWORDS = [
  /拍板/,
  /拍了/,
  /决定/,
  /选\s*[A-Da-d1-9]/,
  /用\s*[A-Da-d1-9]/,
  /走\s*[A-Da-d1-9]/,
  /按\s*[A-Da-d1-9]/,
  /按这个走/,
  /按推荐/,
  /应该/,
  /必须/,
  /^@?[一-龥]{1,4}\s+[A-Da-d1-9]\+?$/, // "@黄仁勋 A"（未 strip 形式）
  /^[A-Da-d][+!]?$/, // 单字母 "A" / "A+" / "B!"（strip @ 后）
  /^[1-9]$/, // 单数字 "1" / "2"
]

/** pivot 类（推翻 / 改方向） */
const PIVOT_KEYWORDS = [/改.*不改/, /重做/, /推倒/, /回到/, /换(方向|方案|思路)/, /不要再/]

/** reject 类（否决 / 不要 / 跳过 / 不用做某事）—— 不要求行首，宽召后 LLM 过滤 */
const REJECT_KEYWORDS = [
  /否决/,
  /不(要|用|做|管|看)\s*[^？?，,]?/, // "不用管 4" 命中；"不要紧" 也命中（LLM 过滤）
  /跳过/,
  /放弃/,
  /\bskip\b/i,
  /(不|别)再/,
]

const ALL_RULES: Array<{ type: DecisionType; patterns: RegExp[] }> = [
  { type: "spec", patterns: SPEC_KEYWORDS },
  { type: "pivot", patterns: PIVOT_KEYWORDS },
  { type: "reject", patterns: REJECT_KEYWORDS },
  { type: "commit", patterns: COMMIT_KEYWORDS },
]

const CONTENT_TRUNCATE = 500
const PREV_TRUNCATE = 800

export interface MessageInput {
  messageId: string
  threadId: string
  authorAlias: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  createdAt: string
}

export interface ExtractBroadOptions {
  /** 只看 user/assistant 消息，跳过 system/tool */
  includeSystemTool?: boolean
}

/**
 * 宽召：扫所有 user 消息（assistant 通常是 agent 报告不算决策来源），
 * 命中任一关键词模式即入 broad_candidates。每条候选 join 上一条 assistant message。
 *
 * 输入 messages 必须按时间升序；输出 candidates 也升序。
 */
export function extractBroadCandidates(
  messages: ReadonlyArray<MessageInput>,
  opts: ExtractBroadOptions = {},
): BroadCandidate[] {
  const candidates: BroadCandidate[] = []
  let lastAssistant: MessageInput | null = null

  for (const msg of messages) {
    if (msg.role === "assistant") {
      lastAssistant = msg
      continue
    }
    if (msg.role === "user") {
      const matched = matchKeyword(msg.content)
      if (matched) {
        candidates.push({
          messageId: msg.messageId,
          authorAlias: msg.authorAlias,
          createdAt: msg.createdAt,
          content: msg.content.slice(0, CONTENT_TRUNCATE),
          matchedKeyword: matched,
          prevAssistantContent: lastAssistant
            ? lastAssistant.content.slice(0, PREV_TRUNCATE)
            : null,
          prevAssistantId: lastAssistant?.messageId ?? null,
        })
      }
      continue
    }
    if (opts.includeSystemTool) {
      // system / tool 消息默认跳过（不是决策来源）
    }
  }
  return candidates
}

function matchKeyword(content: string): string | null {
  // 先去掉 @mention 前缀方便短指令识别
  const stripped = content.replace(/^@\S+\s+/, "").trim()
  if (stripped.length === 0) return null
  for (const rule of ALL_RULES) {
    for (const p of rule.patterns) {
      if (p.test(stripped)) {
        return `${rule.type}:${p.source.slice(0, 30)}`
      }
    }
  }
  return null
}

// ─── Claude CLI Runner 接入（DecisionJudgeProvider impl） ────────────
// 生产用 createSonnetRunner（小孙拍：决策识别走 Sonnet 4.6 不是 Haiku 4.5）。
// HaikuLike 名字是历史遗留 type alias，shape 与 ClaudeRunner 通用 runPrompt 一致。

/** Claude CLI runner 抽象（兼容 createHaikuRunner / createSonnetRunner 返回的 HaikuRunner） */
export interface HaikuLike {
  runPrompt(
    prompt: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; text: string; error?: string; durationMs: number }>
}

export interface HaikuJudgeOptions {
  /** Claude CLI 单次调用超时；默认 30s（Sonnet 比 Haiku 慢一些，留余量） */
  timeoutMs?: number
}

const HAIKU_DEFAULT_TIMEOUT = 30000

export function buildJudgePrompt(
  c: BroadCandidate,
  opts: { activeCommits?: ReadonlyArray<ActiveCommitForSweep> } = {},
): string {
  const prev = c.prevAssistantContent
    ? `[上一条 assistant 消息]\n${c.prevAssistantContent}\n`
    : "（无上一条 assistant）\n"

  // P4 C-auto-2: 注入当前 active commit 决策列表，让 LLM 判 supersedes
  const activeCommits = opts.activeCommits ?? []
  const sweepBlock =
    activeCommits.length > 0
      ? `\n[当前 active commit 决策列表]（如本次新决策完成了其中任一项，列出 decision_id）\n${activeCommits.map((c) => `- D-${c.decisionId} (${c.decidedAt}): ${c.content}`).join("\n")}\n`
      : "\n[当前 active commit 决策列表] 空\n"

  return `你是房间决策识别器。判定下面这条 user 消息是否构成"决策"。

判定标准：
- 是决策：用户拍板了 spec（立项/选方案）/ pivot（改方向）/ commit（批准/完成）/ reject（否决/不要）
- 不是决策：询问 / 评论 / 事实陈述 / 情绪宣泄 / 闲聊

注意：
- 短指令如 "go" / "A" / "好" / "不用" 必须结合"上一条 assistant 消息"判定语义
- 上下文不足时返回 is_decision=false + reason="上下文不足"
- 如本次新决策（is_decision=true）完成了 [当前 active commit 决策列表] 中的某些条目，在 supersedes_decision_ids 列出。例如：旧决策"进 merger-gate"，本次"F026 已合 dev" → 列 [<进 merger-gate 的 id>]

[上下文]
${prev}${sweepBlock}
[user 消息]
${c.content}

只返回 JSON，不要任何解释或 markdown 包装：
{"is_decision": <bool>, "type": "spec|pivot|commit|reject", "content": "<结合上下文补全的决策内容，≤80字>", "confidence": <0-1>, "supersedes_decision_ids": [<decision_id 数组，只填 [当前 active commit 决策列表] 里存在的 id>], "reason": "<不是决策时填原因>"}`
}

export class HaikuDecisionJudge implements DecisionJudgeProvider {
  constructor(
    private readonly haiku: HaikuLike,
    private readonly defaultTimeoutMs: number = HAIKU_DEFAULT_TIMEOUT,
  ) {}

  async judge(input: {
    candidate: BroadCandidate
    timeoutMs?: number
    activeCommits?: ReadonlyArray<ActiveCommitForSweep>
  }): Promise<CandidateJudgment> {
    const prompt = buildJudgePrompt(input.candidate, { activeCommits: input.activeCommits })
    const result = await this.haiku.runPrompt(prompt, {
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
    })
    if (!result.ok) {
      // Sonnet CLI 失败 → 上层标 unresolved（不阻塞 RoomCompiler tick）
      throw new Error(`haiku-failed: ${result.error ?? "unknown"}`)
    }
    return parseJudgmentJson(result.text, input.candidate, input.activeCommits)
  }
}

/**
 * Parse Claude CLI JSON output。容忍 markdown code fence 包裹 / 前后空白。
 * 解析失败抛 Error 让上层标 unresolved。
 *
 * P4 C-auto-2: 支持解析 supersedes_decision_ids 字段。如果 activeCommits 传入，
 * 自动过滤 LLM 返回的 ids — 只保留确实在 activeCommits 中的（防 hallucination）。
 */
export function parseJudgmentJson(
  raw: string,
  candidate: BroadCandidate,
  activeCommits?: ReadonlyArray<ActiveCommitForSweep>,
): CandidateJudgment {
  const trimmed = raw.trim()
  // 剥 ```json ... ``` fence
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const jsonText = fenced ? fenced[1].trim() : trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err) {
    throw new Error(
      `parse-failed: ${err instanceof Error ? err.message : String(err)} (raw len=${raw.length})`,
    )
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("parse-failed: not an object")
  }
  const obj = parsed as Record<string, unknown>
  const isDecision = obj.is_decision === true
  if (!isDecision) {
    return {
      isDecision: false,
      reason: typeof obj.reason === "string" ? obj.reason : "haiku 判 non-decision",
    }
  }
  const type = obj.type
  if (type !== "spec" && type !== "pivot" && type !== "commit" && type !== "reject") {
    throw new Error(`parse-failed: invalid type "${String(type)}"`)
  }
  const content =
    typeof obj.content === "string" && obj.content.trim().length > 0
      ? obj.content.trim().slice(0, 200)
      : candidate.content.slice(0, 80)
  const confidence =
    typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
      ? obj.confidence
      : undefined

  // P4 C-auto-2: 解析 supersedes_decision_ids + 校验 ids 都在 activeCommits 内
  let supersedesDecisionIds: number[] | undefined
  if (Array.isArray(obj.supersedes_decision_ids)) {
    const raw = obj.supersedes_decision_ids.filter(
      (x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0,
    )
    if (activeCommits && activeCommits.length > 0) {
      // 严格校验：LLM 返的 id 必须在 caller 传入的 active commits 列表内
      const validIds = new Set(activeCommits.map((c) => c.decisionId))
      supersedesDecisionIds = raw.filter((id) => validIds.has(id))
    } else {
      // 没传 activeCommits → 不允许任何 supersedes（LLM 不该凭空生成）
      supersedesDecisionIds = []
    }
    if (supersedesDecisionIds.length === 0) supersedesDecisionIds = undefined
  }

  return { isDecision: true, type, content, confidence, supersedesDecisionIds }
}

// ─── runExtractor 编排：宽召 → 限并发 judge → 收集 ExtractorRun ──────

export interface RunExtractorOptions {
  /** Claude CLI 并发上限；默认 4（spawn child process 风险控制） */
  maxConcurrency?: number
  /** 每候选 timeout；默认 30s */
  judgeTimeoutMs?: number
  /**
   * P4 C-auto-2: 房间当前 active commit 决策列表，喂给 LLM 让其判定
   * 本次新 commit 是否完成（supersede）旧 commit。
   * caller compile-fn 通常从 ledger.getActiveByType(roomId, 'commit') 拉。
   */
  activeCommits?: ReadonlyArray<ActiveCommitForSweep>
}

const DEFAULT_CONCURRENCY = 4

export async function runExtractor(
  judge: DecisionJudgeProvider,
  candidates: ReadonlyArray<BroadCandidate>,
  opts: RunExtractorOptions = {},
): Promise<ExtractorRun> {
  const concurrency = Math.max(1, opts.maxConcurrency ?? DEFAULT_CONCURRENCY)
  const timeoutMs = opts.judgeTimeoutMs
  const activeCommits = opts.activeCommits

  const resolvedDecisions: ExtractorRun["resolvedDecisions"] = []
  const resolvedNonDecisions: ExtractorRun["resolvedNonDecisions"] = []
  const unresolved: ExtractorRun["unresolved"] = []

  const queue = candidates.slice()
  const workers: Promise<void>[] = []

  const consume = async () => {
    while (queue.length > 0) {
      const cand = queue.shift()
      if (!cand) break
      try {
        const judgment = await judge.judge({ candidate: cand, timeoutMs, activeCommits })
        if (judgment.isDecision) {
          resolvedDecisions.push({ candidate: cand, judgment })
        } else {
          resolvedNonDecisions.push({
            candidate: cand,
            reason: judgment.reason ?? "haiku 判 non-decision",
          })
        }
      } catch (err) {
        unresolved.push({
          candidate: cand,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  for (let i = 0; i < Math.min(concurrency, candidates.length); i++) {
    workers.push(consume())
  }
  await Promise.all(workers)

  return {
    broadCandidates: candidates.slice(),
    resolvedDecisions,
    resolvedNonDecisions,
    unresolved,
  }
}
