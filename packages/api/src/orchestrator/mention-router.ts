import { randomUUID } from "node:crypto"
import type { Provider } from "@multi-agent/shared"

export type MentionRouteResult = {
  provider: Provider | null
}

export type MentionMatch = {
  provider: Provider
  alias: string
  index: number
}

export type MentionMatchMode = "line-start" | "anywhere"

/**
 * Provider → @mention 别名（单名严格匹配）。
 * 只有这一个名字能路由，不接受 provider 代号作为 fallback。
 */
export type ProviderAliases = Record<Provider, string>

export function resolveMention(content: string, aliases: ProviderAliases) {
  const trimmed = content.trim().toLowerCase()

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider]
    const pattern = alias.startsWith("@") ? alias : `@${alias}`
    if (trimmed.startsWith(pattern.toLowerCase())) {
      return { provider } satisfies MentionRouteResult
    }
  }

  return { provider: null } satisfies MentionRouteResult
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Shared terminator: characters that may legitimately follow an @alias.
// Includes Markdown emphasis chars (* _ ~) so that **@alias** and *@alias* are matched correctly.
const MENTION_TERMINATOR = String.raw`(?=$|[\s*_~:,.!?;()\[\]{}<>，。！？；：“”‘’、])`

function buildMentionPattern(candidate: string, mode: MentionMatchMode) {
  // Candidates may or may not already start with "@" — strip it for regex assembly.
  const bare = candidate.startsWith("@") ? candidate.slice(1) : candidate
  const escaped = escapeRegex(bare)

  if (mode === "anywhere") {
    // User text may mention agents mid-sentence; avoid matching inside email/domain-like strings.
    return new RegExp(String.raw`(?<![\w.-])@` + escaped + MENTION_TERMINATOR, "gi")
  }

  // Agent-authored messages only trigger A2A on line-leading mentions.
  // Prefix allows whitespace and Markdown emphasis chars before the @.
  return new RegExp(String.raw`(?:^|\n)[\s*_~]*@` + escaped + MENTION_TERMINATOR, "gi")
}

/**
 * F026 ADR-003 Layer 1 — hard-negative masking.
 *
 * Replace Markdown contexts that should never trigger A2A with space characters,
 * preserving byte offsets so downstream regex .index values remain valid.
 *
 * Covered contexts:
 *   - fenced code blocks (``` ... ``` / ~~~ ... ~~~)
 *   - inline code `...`
 *   - blockquote lines (^> ...)
 *   - table rows (line starts with | and contains another |)
 *
 * Emphasis wrappers (**@X** / *@X*) and introductory suffixes (@X 是/老师/...)
 * are handled in the post-match pass (rejectMatchByContext) because they need
 * per-match context awareness, not whole-line masking.
 */
function maskHardNegativeRanges(content: string): string {
  // 必须按 UTF-16 code unit 索引（与 String#indexOf / RegExp match.index / line.length 对齐）。
  // 不要用 [...content]，它按 codepoint 切，emoji 等 surrogate pair 会让 out.length < content.length，
  // 下游用 line.length / offset 寻址 out[i] 时错位 → fence 起止符漏掩、fence 外真派发 @ 误掩。
  const out: string[] = new Array(content.length)
  for (let i = 0; i < content.length; i++) out[i] = content[i]

  // Fenced code blocks — line-level state machine
  const lines = content.split("\n")
  let inFence = false
  let offset = 0
  for (const line of lines) {
    const trimmed = line.trimStart()
    const isFenceLine = /^(```|~~~)/.test(trimmed)
    if (isFenceLine) {
      inFence = !inFence
      // Also mask the fence marker line itself to neutralize any @ in lang tag etc.
      for (let i = offset; i < offset + line.length; i++) out[i] = out[i] === "\n" ? "\n" : " "
    } else if (inFence) {
      for (let i = offset; i < offset + line.length; i++) out[i] = out[i] === "\n" ? "\n" : " "
    }
    offset += line.length + 1 // +1 for the split "\n"
  }

  // Inline code: walk through masked-by-fence output, find backtick pairs that
  // do NOT already live inside a masked span.
  const inlineSnapshot = out.join("")
  const inlineRe = /`([^`\n]*)`/g
  for (const m of inlineSnapshot.matchAll(inlineRe)) {
    const start = m.index ?? 0
    for (let i = start; i < start + m[0].length; i++) {
      if (out[i] !== "\n") out[i] = " "
    }
  }

  // Blockquote lines
  const blockquoteRe = /(^|\n)(\s*>[^\n]*)/g
  for (const bq of content.matchAll(blockquoteRe)) {
    const idx = bq.index ?? 0
    const lineStart = idx + bq[1].length
    const lineEnd = lineStart + bq[2].length
    for (let i = lineStart; i < lineEnd; i++) {
      if (out[i] !== "\n") out[i] = " "
    }
  }

  // Table rows: a line with at least 2 pipe chars and not a simple sentence.
  // Heuristic: trimmed line starts with "|" and contains another "|".
  let ofs = 0
  for (const line of content.split("\n")) {
    const trim = line.trim()
    if (trim.startsWith("|") && trim.indexOf("|", 1) !== -1) {
      for (let i = ofs; i < ofs + line.length; i++) {
        if (out[i] !== "\n") out[i] = " "
      }
    }
    ofs += line.length + 1
  }

  return out.join("")
}

/**
 * F026 ADR-003 Layer 1 post-match — emphasis + introductory suffix rejection.
 *
 * Given an @-match's position and the original (unmasked) content, decide
 * whether this match should still count as a real mention.
 */
function rejectMatchByContext(content: string, matchStart: number, matchEnd: number): boolean {
  // Emphasis wrapping — **@X** or *@X* or ~~@X~~.
  // Look left past whitespace at the @ mark (or the fence chars that precede it
  // in line-start mode) and right from the last alias char.
  const atPos = content.indexOf("@", matchStart)
  if (atPos === -1) return false

  // Walk left skipping whitespace & newline to find non-space prev char.
  let lp = atPos - 1
  while (lp >= 0 && /[\s]/.test(content[lp])) lp--
  const prevChar = lp >= 0 ? content[lp] : ""
  const nextChar = matchEnd < content.length ? content[matchEnd] : ""
  if ((prevChar === "*" && nextChar === "*") || (prevChar === "_" && nextChar === "_")) {
    return true
  }

  // Introductory preposition before @X: 与/和/及/跟/向/对/给/听听/我跟
  // Check up to 3 chars before @ (after skipping whitespace)
  const leftSlice = content.slice(Math.max(0, atPos - 6), atPos)
  if (/(?:^|[\s])(?:与|和|及|跟|向|对|给|听听?)\s*$/.test(leftSlice)) {
    return true
  }

  // Introductory suffix after alias: 是/的/老师/先生/同学/也
  // tail = whitespace*  followed by one of those
  const tail = content.slice(matchEnd, Math.min(content.length, matchEnd + 6))
  if (/^\s*(?:是|的|老师|先生|同学|也)/.test(tail)) {
    return true
  }

  return false
}

/**
 * F026 P0 Task6 · assistant role guard
 *
 * agent (role=assistant) 正文里的 @xxx 一律**不派发** —— 要派发必须调
 * trigger_mention MCP 工具。止血 2026-04-22 房间两次误派发：
 *   - agent 在示例 / 代码块 / 粗体装饰 / 反问式里写 @xxx 被派发
 *   - 段落起行 @ 也按 line-start 规则被派发
 *
 * 副作用（P0 接受 · Design Decision A）：agent 暂时失去"正文 @ 交接"能力；
 * 需 P1 补 agent prompt 教育"派发必须调工具"。未传 role / role=user 时保持
 * 原行为（向后兼容）。
 */
export type MentionSourceRole = "user" | "assistant" | "system"

export interface RoleGuardOptions {
  role?: MentionSourceRole
}

export function resolveMentions(
  content: string,
  aliases: ProviderAliases,
  mode: MentionMatchMode = "line-start",
  options?: RoleGuardOptions,
) {
  if (options?.role === "assistant") return []
  const masked = maskHardNegativeRanges(content)
  const matches: MentionMatch[] = []

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider]
    const bare = alias.startsWith("@") ? alias.slice(1) : alias
    const pattern = buildMentionPattern(alias, mode)

    for (const match of masked.matchAll(pattern)) {
      const start = match.index ?? -1
      const end = start + match[0].length
      if (rejectMatchByContext(content, start, end)) continue
      matches.push({
        provider,
        alias: bare,
        index: start,
      })
    }
  }

  return matches.sort((left, right) => left.index - right.index)
}

/**
 * F026 ADR-003 — three-layer classification for a single @-mention.
 *
 *   "dispatch" — Layer 2 hard-positive (must send to agent)
 *   "gray"     — Layer 3 gray-zone (ambiguous intent, fail-closed: don't dispatch, log)
 *   (Layer 1 hard-negative is handled upstream in resolveMentions by masking,
 *   so by the time we classify the match is guaranteed non-negative.)
 *
 * atIndex points to the "@" character; aliasEnd is the index just past the alias.
 */
export type MentionClassification = "dispatch" | "gray"

// F026-P3 修订 · 任务祈使动词白名单（实测样本：3 条 `@xxx 请重复…` 三层分类全 gray，由 fallback 兜底命中后回扩此处）
const VERB_HEAD =
  "(?:看|帮|做|写|查|检查|review|实现|修|改|调|测试|设计|评审|确认|跑|完成|接手|处理|解决|" +
  "重复|说|讲|告诉|解释|描述|说明|介绍|分析|评估|计算|翻译|改写|重写|" +
  "列|总结|整理|归纳|输出|生成|创建|新建|新增|添加|加|删|删除|移除|" +
  "启动|停止|重启|读|画|提交|提交|发|发送|提|" +
  // 英文常用动词（与英文 polite-head 配合识别 "@xxx please X" / "@xxx can you X"）
  "check|verify|look|take|fix|run|send|help|tell|try|explain|show|list|" +
  "do|make|update|test|repeat|read|write|build|deploy|merge|push|confirm|approve)"
// F026-P3 修订 · 礼貌祈使前缀（中文 / 英文）—— 命中即直接 dispatch（仍受 line-start 约束）
const POLITE_HEAD =
  "(?:请|麻烦|烦请|帮我|帮忙|能否|能不能|可否|可不可以|" +
  "please|pls|could\\s+you|can\\s+you|would\\s+you)"

export function classifyMention(
  content: string,
  atIndex: number,
  aliasEnd: number,
): MentionClassification {
  // Must be line-start (only whitespace / optional emphasis chars before @ on the line).
  // Walk left until we hit \n or content start.
  let lp = atIndex - 1
  while (lp >= 0 && content[lp] !== "\n") {
    // allow whitespace and emphasis chars as prefix
    if (!/[\s*_~]/.test(content[lp])) return "gray"
    lp--
  }

  // Tail after alias: find the first non-whitespace byte sequence
  const tail = content.slice(aliasEnd)
  if (tail.length === 0) return "gray" // bare "@X" alone → ambiguous

  // Trim leading whitespace punctuation
  const trimmed = tail.replace(/^[\s,，、:：]+/, "")
  if (trimmed.length === 0) return "gray"

  // Question mark anywhere in the first sentence (up to newline) → request
  const firstLine = trimmed.split("\n", 1)[0]
  if (/[?？]/.test(firstLine)) return "dispatch"

  // Polite-head：礼貌祈使前缀（请/麻烦/please/can you …） → dispatch
  if (new RegExp(`^${POLITE_HEAD}`, "i").test(trimmed)) return "dispatch"

  // Verb head: first non-whitespace token matches action verb
  if (new RegExp(`^${VERB_HEAD}`, "i").test(trimmed)) return "dispatch"

  // F026-P3 quality-gate · 称呼前缀样本（"@xxx 大姐 请帮忙看下" / "@xxx bro please review"）：
  // 礼貌祈使被推到中段。要求 firstLine 同时含 POLITE_HEAD 和 VERB_HEAD 才放行，
  // 单条不放（"@xxx 大姐你好" 仅称呼无动作仍 gray，由反例测试守住边界）。
  if (new RegExp(POLITE_HEAD, "i").test(firstLine) && new RegExp(VERB_HEAD, "i").test(firstLine)) {
    return "dispatch"
  }

  // Task-noun hint: firstLine 含任务关键词且以指示代词开头 → 视为任务描述 (dispatch)
  // e.g. "这个 bug 的修复方案" / "那个 PR" / "该 feature"
  if (
    /^(?:这个|那个|这|该)/.test(trimmed) &&
    /(?:bug|问题|方案|设计|报告|状态|PR|feature|task|修复|的\s*\S+)/i.test(firstLine)
  ) {
    return "dispatch"
  }

  return "gray"
}

export type ClassifiedMention = MentionMatch & {
  classification: MentionClassification
}

/**
 * Full three-layer resolution:
 *   Layer 1 hard-negative → dropped (not in output)
 *   Layer 2 hard-positive → classification="dispatch"
 *   Layer 3 gray-zone     → classification="gray" (caller decides; default fail-closed no-dispatch)
 */
export function resolveMentionsClassified(
  content: string,
  aliases: ProviderAliases,
  mode: MentionMatchMode = "anywhere",
): ClassifiedMention[] {
  const masked = maskHardNegativeRanges(content)
  const out: ClassifiedMention[] = []

  for (const provider of Object.keys(aliases) as Provider[]) {
    const alias = aliases[provider]
    const bare = alias.startsWith("@") ? alias.slice(1) : alias
    const pattern = buildMentionPattern(alias, mode)

    for (const match of masked.matchAll(pattern)) {
      const start = match.index ?? -1
      const end = start + match[0].length
      if (rejectMatchByContext(content, start, end)) continue
      // Find the "@" within the match (mode=anywhere: @ is at start; mode=line-start: @ is after some \n/whitespace/emphasis)
      const atRel = match[0].indexOf("@")
      const atIndex = start + atRel
      const aliasEnd = atIndex + 1 + bare.length
      out.push({
        provider,
        alias: bare,
        index: start,
        classification: classifyMention(content, atIndex, aliasEnd),
      })
    }
  }

  return out.sort((left, right) => left.index - right.index)
}

/**
 * F026 ADR-003 · 反循环与去重
 *
 *   单消息内同 target 最多 1 次派发（messageId + target key）
 *   同 (source, target) 30 秒滑动窗口，第二次派发 blocked
 *
 * 进程内内存实现；Phase 1 末期可升级为 DB (a2a_calls.last_dispatch_at) 以跨进程一致。
 */
export const MENTION_RATE_LIMIT_WINDOW_MS = 30_000

export interface RateLimitAllowInput {
  source: string
  target: string
  messageId: string
  /**
   * F026 1B.7 R-085 fix · 滑动窗口按 sessionGroupId 分桶。历史 bug：进程级单例 +
   * 全局 (source,target) key → 跨房间 30s 内同人派发被相互拒绝，表现为后房间第 1
   * 棒"派发了但没生效"（DB a2a_calls 0 child）。修法：把 sessionGroupId 拼进
   * window key —— 同房间内 30s 限流仍生效（防 LLM 对同人爆 spam），跨房间互不影响。
   */
  sessionGroupId: string
}

export type RateLimitResult =
  | { allowed: true }
  | {
      allowed: false
      reason: "duplicate-in-message" | "sliding-window-30s"
      lastDispatchAt?: number
    }

export class MentionRateLimiter {
  private readonly windowMs: number
  private readonly now: () => number
  private readonly perMessage = new Set<string>() // `${messageId}:${target}`
  private readonly perSessionSourceTarget = new Map<string, number>() // `${sessionGroupId}:${source}:${target}` → lastAt

  constructor(options: { now?: () => number; windowMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.windowMs = options.windowMs ?? MENTION_RATE_LIMIT_WINDOW_MS
  }

  allow(input: RateLimitAllowInput): RateLimitResult {
    const messageKey = `${input.messageId}:${input.target}`
    if (this.perMessage.has(messageKey)) {
      return { allowed: false, reason: "duplicate-in-message" }
    }

    const stKey = `${input.sessionGroupId}:${input.source}:${input.target}`
    const now = this.now()
    const last = this.perSessionSourceTarget.get(stKey)
    if (typeof last === "number" && now - last < this.windowMs) {
      return { allowed: false, reason: "sliding-window-30s", lastDispatchAt: last }
    }

    this.perMessage.add(messageKey)
    this.perSessionSourceTarget.set(stKey, now)
    return { allowed: true }
  }
}

export type DispatchMention = MentionMatch & {
  /** Unique traceId for this dispatch decision — flows into a2a_calls.call_id / envelope.protocol.call_id downstream. */
  traceId: string
  /** F026 ADR-003 on-behalf 反推结果；null = 默认严格分级。 */
  onBehalfOf: string | null
  /** 是否转移 convener（严格分级豁免）。 */
  convenerTransfer: boolean
}

/**
 * F026 ADR-003 · on-behalf 语义反推。
 *
 * 识别三类信号：
 *   - "帮/替/为 X + @B"     → on_behalf_of = X, convener 转移（X 来收敛，A 只是 issuer）
 *   - "代我/帮我 ... @B"    → on_behalf_of = "self"（标记为 A 自己，但显式转移语义）
 *   - "@B（仅 X 参考）" / "给 X 看" → on_behalf_of = X, convener 不转移（观众视角）
 *   - 无信号                → null
 *   - 冲突（多主语）        → fail-closed null
 */
export interface OnBehalfResult {
  onBehalfOf: string | null
  convenerTransfer: boolean
}

const SELF_PRONOUNS = /我|我们/
const MULTI_SUBJECT = /和|与|及|跟/

export function inferOnBehalfOf(
  content: string,
  range: { atIndex: number; aliasEnd: number },
): OnBehalfResult {
  const tail = content.slice(range.aliasEnd)
  const firstLine = tail.split("\n", 1)[0]

  // Parenthetical audience hint: "（仅 X 参考）" / "(仅 X 参考)" — 观众视角, convener 不转移
  const audienceMatch = firstLine.match(/^\s*[（(]\s*仅([^，,\s）)]+?)\s*参考/)
  if (audienceMatch) {
    return { onBehalfOf: audienceMatch[1].trim(), convenerTransfer: false }
  }

  // 冲突检测：『帮/替/代/为 X 和/与 Y』→ fail-closed
  if (/^\s*(?:帮|替|代|为)\S+?(?:和|与|及|跟)\S+/.test(firstLine)) {
    return { onBehalfOf: null, convenerTransfer: false }
  }

  // 行动代表语：『帮/替/代/为 X …』
  //   X = "我/我们" (→ self) 或 2 个连续中文字（典型中文人名 2 字；3 字人名留词典扩展）
  const actorMatch = firstLine.match(/^\s*(?:帮|替|代|为)\s*(我们|我|[一-鿿]{2})/)
  if (actorMatch) {
    const subject = actorMatch[1]
    if (SELF_PRONOUNS.test(subject)) {
      return { onBehalfOf: "self", convenerTransfer: true }
    }
    return { onBehalfOf: subject, convenerTransfer: true }
  }

  // 观众视角: 『给 X 看 / 给 X 瞧』——convener 不转移
  const audienceVerb = firstLine.match(/^\s*给\s*([^\s，,。.]+?)\s*(?:看|瞧|评|过目)/)
  if (audienceVerb) {
    return { onBehalfOf: audienceVerb[1].trim(), convenerTransfer: false }
  }

  return { onBehalfOf: null, convenerTransfer: false }
}

export interface ResolveDispatchOptions extends RoleGuardOptions {
  /** Called for each Layer 3 gray-zone mention that was dropped. Use for debug logging (ADR-003). */
  onGrayZone?: (mention: MentionMatch) => void
  /** Optional uuid provider for tests. */
  newTraceId?: () => string
  /** Mode defaults to "anywhere" — user text can @ mid-sentence and still hit hard-pos via line-start check in classifyMention. */
  mode?: MentionMatchMode
}

/**
 * F026 ADR-003 · Three-layer fail-closed dispatch.
 *
 * Returns only mentions that classify as "dispatch" (Layer 2 hard-positive).
 * Layer 1 hard-negative (code blocks / inline code / blockquote / table / emphasis /
 * introductory prepositions + suffixes) are dropped silently via content masking.
 * Layer 3 gray-zone mentions are dropped here and reported to onGrayZone() for logging.
 */
export function resolveDispatchMentions(
  content: string,
  aliases: ProviderAliases,
  options: ResolveDispatchOptions = {},
): DispatchMention[] {
  // F026 P0 Task6 · assistant role guard（同 resolveMentions）
  if (options.role === "assistant") return []
  const mode = options.mode ?? "anywhere"
  const newTraceId = options.newTraceId ?? (() => `trace-${randomUUID()}`)
  const classified = resolveMentionsClassified(content, aliases, mode)
  const dispatched: DispatchMention[] = []

  for (const m of classified) {
    if (m.classification === "dispatch") {
      // Locate "@" in the original content and compute aliasEnd for on-behalf inference.
      const atIndex = content.indexOf("@" + m.alias, m.index)
      const aliasEnd = atIndex >= 0 ? atIndex + 1 + m.alias.length : m.index + 1 + m.alias.length
      const behalf = inferOnBehalfOf(content, { atIndex: Math.max(0, atIndex), aliasEnd })
      dispatched.push({
        provider: m.provider,
        alias: m.alias,
        index: m.index,
        traceId: newTraceId(),
        onBehalfOf: behalf.onBehalfOf,
        convenerTransfer: behalf.convenerTransfer,
      })
    } else if (options.onGrayZone) {
      options.onGrayZone({ provider: m.provider, alias: m.alias, index: m.index })
    }
  }

  return dispatched
}

// ---------------------------------------------------------------------------
// F026 方案 X · L1 显式调用标签 `[Call: @名 描述]`
// ---------------------------------------------------------------------------
// agent 自由文本里的 @ 一律不派发；要派发就用 `[Call: @X 任务描述]` 标签。
// 替换原 ADR-003 三层分类（POLITE_HEAD + 50 个 VERB_HEAD + gray-zone fallback）
// 这条脆弱的「字符串模式猜意图」路径——该路径在 Round 2 收敛后被废弃。
// 用户路径 (role=user) 仍走原 L0 行首派（resolveDispatchMentions），不依赖此 parser。

export type CallTagMention = {
  provider: Provider
  alias: string
  /** Tag 描述（[Call: @X 描述] 中的描述部分），trim 过；空标签为 "" */
  description: string
  /** Tag 起点（原文中 `[` 的位置） */
  index: number
  /** Tag 内 `@` 在原文中的位置 */
  aliasIndex: number
}

/**
 * F026 方案 X · 解析 `[Call: @名 描述]` 显式调用标签。
 *
 * 严格契约（避免 LLM 噪音）：
 *   - 大小写敏感：必须严格 `[Call:`（小写 `[call:` 不识别）
 *   - 标签内不跨行（`]` 必须出现在 `@` 同一行）
 *   - 复用 `maskHardNegativeRanges` —— 代码块/inline code/blockquote/table 内的标签不识别
 *   - 拒绝 emphasis 包裹（`**[Call: @X]**` 不识别）—— tag 必须裸出现
 *   - alias 必须在 aliases 表内；外部名字直接丢
 *
 * 输出顺序：按 tag 起点（`[`）位置升序。
 */
export function resolveCallTagMentions(
  content: string,
  aliases: ProviderAliases,
): CallTagMention[] {
  const masked = maskHardNegativeRanges(content)

  // 构建 alias union（按字面，按已知 alias 的字符严格匹配；不允许 alias 内含特殊正则字符以外的）
  // alias 可能已带 "@" 前缀（resolveMention 兼容历史），统一剥掉以避免 [Call: @@p0 ...] 错配。
  const aliasList = Object.entries(aliases).map(
    ([provider, raw]) => [provider, raw.startsWith("@") ? raw.slice(1) : raw] as [Provider, string],
  )
  // 按 alias 长度降序排列：避免短别名抢先匹配长别名（如 p1 优先匹掉 p10 → desc 错位）
  const sortedForRegex = [...aliasList].sort(([, a], [, b]) => b.length - a.length)
  const aliasUnion = sortedForRegex.map(([, a]) => escapeRegex(a)).join("|")
  if (!aliasUnion) return []

  // [Call: @<alias>(<可选描述>)] —— B021 修：描述允许跨行（LLM 实际写法）
  // 但禁止 description 内嵌套 [Call: 子串 → 外层失配 fail-closed，
  // 落到内层 [Call: @X] 匹配；LLM 写正确格式后自然命中。
  // 大小写敏感（不加 i flag）
  const tagRe = new RegExp(
    String.raw`\[Call:\s*@(` + aliasUnion + String.raw`)((?:(?!\[Call:)[^\]])*)\]`,
    "g",
  )

  const out: CallTagMention[] = []
  for (const match of masked.matchAll(tagRe)) {
    const tagStart = match.index ?? -1
    if (tagStart < 0) continue
    const tagEnd = tagStart + match[0].length

    // Emphasis 包裹拒绝：左侧紧贴 `*` 或 `_`，且右侧对称
    const prevChar = tagStart > 0 ? content[tagStart - 1] : ""
    const nextChar = tagEnd < content.length ? content[tagEnd] : ""
    if ((prevChar === "*" && nextChar === "*") || (prevChar === "_" && nextChar === "_")) continue

    const aliasMatched = match[1]
    const descRaw = match[2] ?? ""
    const description = descRaw.trim()
    const provider = aliasList.find(([, a]) => a === aliasMatched)?.[0]
    if (!provider) continue

    // 在原文（未掩盖）中定位 @
    const aliasIndex = content.indexOf("@" + aliasMatched, tagStart)
    if (aliasIndex < 0 || aliasIndex >= tagEnd) continue

    out.push({
      provider,
      alias: aliasMatched,
      description,
      index: tagStart,
      aliasIndex,
    })
  }

  return out.sort((a, b) => a.index - b.index)
}

/**
 * F026 P3.1 · 派发协议预检（assistant final 入库前的首道闸门）
 *
 * 检测项（2026-04-29 R-057 兜底层重启后）：
 *   - nested_call_tag             : R-054 嵌套 [Call: ... [Call: ...] ...] —— 结构错，前端
 *     stripCallTags 也会露馅
 *   - naked_at_with_real_teammate : R-057 行首裸真实队友 @ + 全文无合法顶层 [Call: @...] ——
 *     LLM 漏写 [Call:] 包装的兜底层；不再静默断链，强制 retry 让模型补包装
 *
 * 命中即返回 ok=false + reason，由 message-service 触发 agent retry。
 *
 * 设计原则：
 *   - 嵌套结构错优先（先返 nested_call_tag）
 *   - 行首裸真实队友 @ 仅在全文找不到合法 [Call: @...] 时触发（已派发轮的行首 @ 视为叙述）
 *   - 真人/外部别名（如 @小孙）不在 ProviderAliases，永远不触发
 *   - 装饰句"@黄仁勋 是我..."等行首+真实队友别名 — 仍触发 retry，宁可多一次 LLM 重写也不让
 *     派发契约缺漏静默断链；3 次后 fail-visible 标红
 *   - 复用 maskHardNegativeRanges：fenced/inline-code/blockquote/table 内的 @ 全部屏蔽
 */
export type DispatchValidationReason = "nested_call_tag" | "naked_at_with_real_teammate"

export type DispatchValidationResult =
  | { ok: true }
  | {
      ok: false
      reason: DispatchValidationReason
      details: { matchedAt: number; sample: string }
    }

export function detectInvalidDispatch(
  content: string,
  aliases: ProviderAliases,
): DispatchValidationResult {
  const masked = maskHardNegativeRanges(content)

  // 1) 嵌套优先 — 结构错
  const nestedRe = /\[Call:[^\]]*\[Call:/g
  const nestedMatch = nestedRe.exec(masked)
  if (nestedMatch && nestedMatch.index !== undefined) {
    return {
      ok: false,
      reason: "nested_call_tag",
      details: {
        matchedAt: nestedMatch.index,
        sample: content.slice(nestedMatch.index, Math.min(content.length, nestedMatch.index + 60)),
      },
    }
  }

  // 2) 行首裸真实队友 @ — 仅当全文无合法顶层 [Call: @...] 时兜底（已派发轮不动）
  const hasLegalCall = /\[Call:\s*@/.test(masked)
  if (!hasLegalCall) {
    const teamAliases = Object.values(aliases).filter(Boolean)
    if (teamAliases.length > 0) {
      const aliasGroup = teamAliases.map(escapeRegex).join("|")
      // 行首：开头或换行后，可能有空白 / markdown emphasis chars (* _ ~)，紧跟 @<真实alias>
      const lineStartRe = new RegExp(
        String.raw`(?:^|\n)[\s*_~]*@(${aliasGroup})` + MENTION_TERMINATOR,
        "g",
      )
      for (const m of masked.matchAll(lineStartRe)) {
        if (m.index === undefined) continue
        // masked 与 content 索引同步（maskHardNegativeRanges 保留 byte offsets）
        const atPos = content.indexOf("@" + m[1], m.index)
        if (atPos < 0) continue
        return {
          ok: false,
          reason: "naked_at_with_real_teammate",
          details: {
            matchedAt: atPos,
            sample: content.slice(atPos, Math.min(content.length, atPos + 60)),
          },
        }
      }
    }
  }

  return { ok: true }
}
