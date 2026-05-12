/**
 * F027 P14.a · FTS5 query 字符串 sanitize
 * 真相源：https://www.sqlite.org/fts5.html#full_text_query_syntax
 *
 * 问题：SQLite FTS5 MATCH 接受的 query 是 mini-DSL，含特殊字符 `"` / `*` / `(`
 * / `)` / `OR` / `AND` / `NEAR` / `^` / `-` 等。
 *   - caller 拿用户输入的 taskSummary 直接当 query 时，含 `"` 或保留字会让
 *     SQLite 抛 "fts5: syntax error" 中断查询
 *   - prompt-injection: 用户可注入 `body MATCH * OR ...` 改语义
 *
 * 策略（Phase 1 简化 baseline）：
 *   1. 去除控制字符
 *   2. 引用每个空格分隔的 token，让 FTS5 把它当 phrase 字面量
 *   3. token 内部的 `"` 转义为 `""`（FTS5 phrase 内 quote 双倍）
 *   4. 跳过空 token
 *   5. 整体若 sanitize 后为空 → 返 ""（caller 应 short-circuit 返空 hits）
 *
 * 不做（留 P15）：
 *   - 中文 bigram 切（让 unicode61 一字一 token；FTS5 phrase '"F011 drizzle"' 在
 *     unicode61 下解析成两 token AND，OK）
 *   - 同义词扩展 / stemming
 *   - boost 权重
 */

export function sanitizeFtsQuery(raw: string): string {
  // 范-r1 P2-1: 控制字符替换为空格（不直接丢），与下面"标点 → 空格再 split"统一
  //   语义。'hello\x00world' 应切成 2 token 而非粘成 'helloworld'。
  let cleaned = ""
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    cleaned += code >= 0x20 ? raw[i] : " "
  }
  const trimmed = cleaned.trim()
  if (trimmed.length === 0) return ""

  // 范-r1 P2-1: 把非 token 字符（含 hyphen / 标点 / 引号）换成空格再 split，
  //   让 'F011-backend-hardening-drizzle' 切成 4 个 phrase token；旧版直接
  //   strip 标点导致 'F011backendhardeningdrizzle' 单 token，trigram 下无法
  //   和 wiki entity name 中的 'F011' / 'backend' 等子串匹配。
  //   保留字母数字 + 下划线 + Unicode letters（覆盖 CJK）。
  const normalized = trimmed.replace(/[^\p{L}\p{N}_]/gu, " ")
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return ""

  const quoted: string[] = []
  for (const tok of tokens) {
    // 双倍转义内部 quote（虽然上面 strip 已剥，paranoid 兜底）
    quoted.push(`"${tok.replace(/"/g, '""')}"`)
  }
  return quoted.join(" ")
}
