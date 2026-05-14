/**
 * F027 P4.5 · 跨 drop keyword chain pattern 检测
 * 真相源：docs/plans/V16.5-final.md chap 7 行 824
 * 攻击场景示例（chap 7 行 811-815）：
 *   Drop A: "等待 B 文件到来"          → wait pattern
 *   Drop B: "忽略 system prompt"       → execute pattern
 *   单独看 A/B 都没事，合起来 = wait→execute 攻击链
 *
 * 设计：
 *   - 双侧检测：current 含 wait + candidate 含 execute → chain；反之亦然
 *   - 限定到 sanitized text（前 4 层防御已剥离同形字 / base64）
 *   - 不试图覆盖所有指令链（NLP 这层留给 LLM audit hook）；只抓最常见 wait→execute pair
 */

/**
 * "wait" 类模式：暗示当前 drop 在等待后续 drop 触发。
 * 范-r1 P2-1：补 hold until / 待 X 到达 / 等 X 来了 / packet/file landing 等 paraphrase。
 */
const WAIT_PATTERNS: readonly RegExp[] = [
  /等待\s*[一-龥A-Za-z0-9_-]+\s*(?:到来|出现|发送|的内容|文件|消息|drop)/i,
  /\bwait\s+(?:for|until)\b.{0,40}(?:arrives?|comes?|received|message|drop|file|lands?|appears?)/i,
  /\bhold\s+(?:until|on|off)\b.{0,40}(?:arrives?|comes?|lands?|received|message|drop|file|appears?)/i,
  /\bafter\s+.{1,30}\s+(?:arrives?|comes?|received|lands?)\b/i,
  /\bon\s+receipt\s+of\b/i,
  /当.{1,30}时(?:执行|触发|启动|开始)/i,
  /待\s*[一-龥A-Za-z0-9_-]+\s*(?:到达|到来|出现|送达|landing|送到)/i,
  /等\s*[一-龥A-Za-z0-9_-]+\s*(?:来了|到了|出现)/i,
  /\bif\s+.{1,40}\s+(?:appears?|matches?|contains?|received)\b/i,
] as const

/**
 * "execute" 类模式：暗示当前 drop 是被触发后要执行的指令。
 * 范-r1 P2-1：补 reveal/leak system prompt 等 + 中文 "透露" / "泄露" paraphrase。
 */
const EXECUTE_PATTERNS: readonly RegExp[] = [
  /忽略\s*(?:之前|前面|之前的|system\s*prompt|系统\s*提示)/i,
  /\bignore\s+(?:previous|all|above|prior)\b/i,
  /\bdisregard\s+(?:previous|all|above)\b/i,
  /\boverride\s+(?:your|all|the)\s+instructions?\b/i,
  /\b(?:reveal|leak|expose|dump)\s+(?:the\s+)?(?:system\s*prompt|prompt|instructions?|secrets?|credentials?)/i,
  /\b(?:execute|run|perform)\s+(?:the\s+following|this|now|payload|operation)\b/i,
  /(?:然后|之后|接下来|现在)\s*(?:执行|运行|发送|输出|透露|泄露|dump)/,
  /透露\s*(?:系统\s*提示|提示词|prompt|秘密|凭证)/i,
  /泄露\s*(?:系统|提示|prompt|秘密|凭证)/i,
  /\bnow\s+(?:do|execute|reveal|output|leak|dump|expose)\b/i,
] as const

export interface KeywordChainResult {
  /** 命中描述（如 "wait@current + execute@candidate"） */
  hits: string[]
}

/**
 * 检测 currentText vs candidateText 之间是否构成 wait→execute 跨 drop 链。
 * 双向：
 *   - current=wait + candidate=execute  → "wait@current + execute@candidate"
 *   - current=execute + candidate=wait  → "execute@current + wait@candidate"
 * 单侧命中（只有 current 或只有 candidate 命中）不报，因为单 drop 内的 jailbreak
 * 已在 sanitize-raw-drop.ts 的红线模板里抓过；这里只关心**跨 drop**新风险。
 */
export function detectKeywordChain(
  currentText: string,
  candidateText: string,
): KeywordChainResult {
  const hits: string[] = []
  const curWait = matchAny(currentText, WAIT_PATTERNS)
  const curExec = matchAny(currentText, EXECUTE_PATTERNS)
  const candWait = matchAny(candidateText, WAIT_PATTERNS)
  const candExec = matchAny(candidateText, EXECUTE_PATTERNS)

  if (curWait && candExec) {
    hits.push(`wait@current[${truncate(curWait)}] + execute@candidate[${truncate(candExec)}]`)
  }
  if (curExec && candWait) {
    hits.push(`execute@current[${truncate(curExec)}] + wait@candidate[${truncate(candWait)}]`)
  }

  return { hits }
}

function matchAny(text: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re)
    if (m) return m[0]
  }
  return null
}

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
