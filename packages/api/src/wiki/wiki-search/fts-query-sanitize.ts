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
  // 控制字符（避免 biome noControlCharactersInRegex）
  let cleaned = ""
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code >= 0x20 || code === 0x09) cleaned += raw[i]
  }
  const trimmed = cleaned.trim()
  if (trimmed.length === 0) return ""

  // 按空白切 token；每个 token 引用成 phrase；内部 quote 双倍转义
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return ""

  const quoted: string[] = []
  for (const tok of tokens) {
    // 跳过纯标点 token (FTS5 unicode61 会忽略，但写进 query 仍占 AND 槽降召回)
    const stripped = tok.replace(/[^\p{L}\p{N}_一-鿿]/gu, "")
    if (stripped.length === 0) continue
    quoted.push(`"${stripped.replace(/"/g, '""')}"`)
  }
  if (quoted.length === 0) return ""
  return quoted.join(" ")
}
