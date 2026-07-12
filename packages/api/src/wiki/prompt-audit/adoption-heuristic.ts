/**
 * F042 AC2 · 采纳判定启发式：回复文本是否引用了召回条目。
 *
 * 三路信号（任一命中即 adopted，每条目只记一次）：
 *   1. [[wiki-link]] 精确含路径（带/不带 .md 后缀都认）
 *   2. 条目 title 出现在回复里（CJK 直接子串；纯 ASCII 走词边界防 rapid→api 误报）
 *   3. path basename（去 .md）出现在回复里（规则同 2；title 缺省时的兜底信号）
 *
 * 返回 null = 召回为空，不可判——调用方不得把 null 计入标注数（D4：「标注」= recall_adopted
 * 非 NULL 行）。已知边界：启发式只测「提及」不测「因果」；shadow 期它是相关性代理信号
 * （回复独立提到召回条目 = 召回找得准），非严格采纳证明——rerank 立项时换人工标注升级。
 */

export interface AdoptionHit {
  path: string
  /** 条目标题（wiki_entity_index.name）；召回链只有 path 时可缺省，退化用 basename。 */
  title?: string
}

export interface AdoptionVerdict {
  adopted: boolean
  matches: Array<{ path: string; term: string }>
}

const CJK_RE = /[一-鿿]/

function termHits(reply: string, term: string): boolean {
  const t = term.trim()
  if (t.length < 2) return false
  if (CJK_RE.test(t)) return reply.includes(t)
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i").test(reply)
}

export function judgeAdoption(reply: string, hits: AdoptionHit[]): AdoptionVerdict | null {
  if (hits.length === 0) return null
  const matches: AdoptionVerdict["matches"] = []
  for (const h of hits) {
    const pathNoExt = h.path.replace(/\.md$/i, "")
    const base = pathNoExt.split("/").pop() ?? ""
    if (reply.includes(`[[${pathNoExt}]]`) || reply.includes(`[[${h.path}]]`)) {
      matches.push({ path: h.path, term: `[[${pathNoExt}]]` })
    } else if (h.title && termHits(reply, h.title)) {
      matches.push({ path: h.path, term: h.title })
    } else if (termHits(reply, base)) {
      matches.push({ path: h.path, term: base })
    }
  }
  return { adopted: matches.length > 0, matches }
}
