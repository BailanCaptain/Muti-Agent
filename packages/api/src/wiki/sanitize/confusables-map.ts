/**
 * F027 P4 · TR39 confusables 简化映射
 * 真相源：docs/plans/V16.5-final.md chap 7 行 782（"confusables 映射 Unicode TR39"）
 * 范-r1 P1-1 修：NFKC 不归一化 Cyrillic / Greek 同形字 —— 攻击者可用 `іgnоre`（Cyrillic і о）
 * 绕过 jailbreak 模板检测。本表覆盖 jailbreak 绕过最常用的 ASCII Latin homoglyph 集合。
 *
 * 不在范围（接受漏抓 / 留 Phase 2 扩展）：
 *   - 完整 TR39 confusables.txt（10000+ 条），Phase 1 不引大数据表
 *   - Hebrew / Arabic / Devanagari 等 RTL 文字脚本（出现频率低）
 *   - 视觉相近但 jailbreak vector 不显著的字符（如 Hangul filler）
 *
 * 设计：
 *   - 单字符 → 单字符 ASCII 映射（不做 fuzzy match）
 *   - applyConfusables 一次扫一遍 input，替换所有命中字符 + 报告替换数
 *   - 替换是为了**让后续 jailbreak template 检测能命中**（Cyrillic іgnоre → Latin ignore）
 *   - 替换本身记 segment（让 LLM compile 知道有同形字攻击信号）
 */

/**
 * Cyrillic → Latin（最常见 jailbreak 绕过向量）。
 * 选取规则：仅包含 jailbreak template 单词里出现的字符（a-z + 大写常用集）。
 */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  // 小写
  "а": "a", // а CYRILLIC SMALL LETTER A
  "е": "e", // е CYRILLIC SMALL LETTER IE
  "о": "o", // о CYRILLIC SMALL LETTER O
  "р": "p", // р CYRILLIC SMALL LETTER ER
  "с": "c", // с CYRILLIC SMALL LETTER ES
  "у": "y", // у CYRILLIC SMALL LETTER U
  "х": "x", // х CYRILLIC SMALL LETTER HA
  "і": "i", // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  "ј": "j", // ј CYRILLIC SMALL LETTER JE
  "ѕ": "s", // ѕ CYRILLIC SMALL LETTER DZE
  // 大写
  "А": "A", // А CYRILLIC CAPITAL LETTER A
  "В": "B", // В CYRILLIC CAPITAL LETTER VE
  "Е": "E", // Е CYRILLIC CAPITAL LETTER IE
  "К": "K", // К CYRILLIC CAPITAL LETTER KA
  "М": "M", // М CYRILLIC CAPITAL LETTER EM
  "Н": "H", // Н CYRILLIC CAPITAL LETTER EN
  "О": "O", // О CYRILLIC CAPITAL LETTER O
  "Р": "P", // Р CYRILLIC CAPITAL LETTER ER
  "С": "C", // С CYRILLIC CAPITAL LETTER ES
  "Т": "T", // Т CYRILLIC CAPITAL LETTER TE
  "Х": "X", // Х CYRILLIC CAPITAL LETTER HA
  "І": "I", // І CYRILLIC CAPITAL LETTER BYELORUSSIAN-UKRAINIAN I
  "Ј": "J", // Ј CYRILLIC CAPITAL LETTER JE
  "Ѕ": "S", // Ѕ CYRILLIC CAPITAL LETTER DZE
}

/** Greek → Latin */
const GREEK_TO_LATIN: Record<string, string> = {
  // 小写
  "α": "a", // α GREEK SMALL LETTER ALPHA
  "ε": "e", // ε GREEK SMALL LETTER EPSILON
  "ι": "i", // ι GREEK SMALL LETTER IOTA
  "ο": "o", // ο GREEK SMALL LETTER OMICRON
  "ρ": "p", // ρ GREEK SMALL LETTER RHO
  "υ": "u", // υ GREEK SMALL LETTER UPSILON
  "ν": "v", // ν GREEK SMALL LETTER NU
  "κ": "k", // κ GREEK SMALL LETTER KAPPA
  // 大写
  "Α": "A", // Α GREEK CAPITAL LETTER ALPHA
  "Β": "B", // Β GREEK CAPITAL LETTER BETA
  "Ε": "E", // Ε GREEK CAPITAL LETTER EPSILON
  "Ζ": "Z", // Ζ GREEK CAPITAL LETTER ZETA
  "Η": "H", // Η GREEK CAPITAL LETTER ETA
  "Ι": "I", // Ι GREEK CAPITAL LETTER IOTA
  "Κ": "K", // Κ GREEK CAPITAL LETTER KAPPA
  "Μ": "M", // Μ GREEK CAPITAL LETTER MU
  "Ν": "N", // Ν GREEK CAPITAL LETTER NU
  "Ο": "O", // Ο GREEK CAPITAL LETTER OMICRON
  "Ρ": "P", // Ρ GREEK CAPITAL LETTER RHO
  "Τ": "T", // Τ GREEK CAPITAL LETTER TAU
  "Υ": "Y", // Υ GREEK CAPITAL LETTER UPSILON
  "Χ": "X", // Χ GREEK CAPITAL LETTER CHI
}

/** 合并 Cyrillic + Greek → Latin 映射 */
export const CONFUSABLES_TO_LATIN: ReadonlyMap<string, string> = new Map([
  ...Object.entries(CYRILLIC_TO_LATIN),
  ...Object.entries(GREEK_TO_LATIN),
])

/** 替换前所有命中字符的并集 regex（动态构造） */
const CONFUSABLES_RE = new RegExp(
  `[${[...CONFUSABLES_TO_LATIN.keys()].map((c) => `\\u${c.codePointAt(0)?.toString(16).padStart(4, "0")}`).join("")}]`,
  "g",
)

export interface ApplyConfusablesResult {
  text: string
  /** 命中的原始字符（可能重复），便于产 segment original 字段 */
  matched: string[]
}

/**
 * 替换 input 中所有 Cyrillic / Greek 同形字为对应 Latin 字符。
 * 不命中时直接返回原 input + 空 matched（无开销）。
 */
export function applyConfusables(input: string): ApplyConfusablesResult {
  const matched: string[] = []
  const text = input.replace(CONFUSABLES_RE, (ch) => {
    matched.push(ch)
    return CONFUSABLES_TO_LATIN.get(ch) ?? ch
  })
  return { text, matched }
}
