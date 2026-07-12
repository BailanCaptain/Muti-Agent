/**
 * F042 AC6 · 召回查询编译器（ADR-005 / LL-036）
 *
 * 背景：wiki_entity_fts / messages_fts 都是 trigram tokenizer。旧 sanitizeFtsQuery 把
 * CJK 连续段整体 phrase 化 + 隐式 AND —— trigram 下长 phrase = 要求文档 verbatim 包含
 * 用户消息片段 → 中文自然语句恒零命中（F042 观察窗 6 行审计全空的检索侧根因）。
 *
 * 职责分层（德彪收敛）：
 *   - sanitizeFtsQuery 保持原样 = 手动 search_wiki / query_messages 的安全层（语义不变）
 *   - 本编译器 = 召回链专用检索策略层，产出 CompiledFtsQuery.matchExpr 直接喂 MATCH
 *
 * 策略：
 *   1. raw 上先提显式实体信号（F/B 编号、R-/LL- 编号、wiki path、「」/引号术语）→ MUST
 *   2. 剩余文本 normalize 后切段：CJK ≥3 字段 → 去重三字滑窗（与表 tokenizer 对齐）；
 *      非 CJK token ≥3 字符整词 —— 均进 OR 组
 *   3. 1-2 字碎片是 trigram 物理死 token（LL-036 德彪 SQLite 3.53 实测），显式丢弃
 *      记入 droppedShortFragments，绝不塞进 AND 杀死整条 query
 *   4. matchExpr = must AND-joined [AND (or OR-joined)]；每 term 经 quoteFtsTerm 包
 *      phrase（注入安全）；clause 去重、must 优先封顶 MAX_CLAUSES
 *
 * OR 只负责扩大候选召回；相关性判定交给 evidence gate（LL-037：不用 minmax score）。
 */

import type { RecallHitEvidence } from "../memory-preflight/types"

export interface CompiledFtsQuery {
  /**
   * 直接喂 FTS5 MATCH 的表达式；unsupported 或纯 path 查询时为 ""。
   * 德彪 AC6-r1 P1-2 · optional-boost 形态：must 与 or 并存时
   * `((must) AND (or…)) OR (must)` —— OR 命中参与 BM25 排序（真目标升前），
   * 同时保留 must-only fallback 召回面；纯 must-only 表达式会让实体噪声
   * 占满 topK（对抗复现），纯 `must AND (or)` 会杀实体+语气词 query。
   */
  matchExpr: string
  /** 文本型实体信号（编号/引号术语；AND 语义）——exactEntityMatch 依据 */
  mustClauses: string[]
  /** 内容词/滑窗（OR 语义）——BM25 boost + evidence 评分 */
  orClauses: string[]
  /**
   * 德彪 AC6-r1 P2-3 · wiki path 实体：FTS 表 path 列 UNINDEXED（MATCH 恒零命中），
   * 必须走 SQL 结构化过滤（i.path 等值/带 wiki/ 前缀变体），不进 MATCH 表达式。
   */
  pathMusts: string[]
  /** must / or / pathMusts 全空 —— caller 应直接走正常 miss */
  unsupported: boolean
  /** 被丢弃的 1-2 字碎片（trigram 物理不可检索，审计/调试用） */
  droppedShortFragments: string[]
}

const MAX_CLAUSES = 32
const CJK_WINDOW = 3

/** FTS5 phrase 字面量包引号（内部 `"` 双倍转义）。 */
export function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/** 文本型实体信号 pattern：项目编号 / 「」引号术语。normalize 前在 raw 上提取。 */
const ENTITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:F|B)\d{3}\b/g, // F042 / B026
  /\b(?:R|LL)-\d+\b/g, // R-205 / LL-036
]
/** wiki path 实体（P2-3：不进 MATCH——path 列 UNINDEXED，走 SQL 过滤） */
const PATH_PATTERN = /[\w-]+(?:\/[\w.-]+)+\.md\b/g
const QUOTED_TERM_PATTERNS: ReadonlyArray<RegExp> = [
  /「([^」\n]{3,64})」/g,
  /"([^"\n]{3,64})"/g,
]

const HAS_HAN = /\p{Script=Han}/u

export function compileRecallFtsQuery(raw: string): CompiledFtsQuery {
  const mustSet = new Set<string>()
  const pathSet = new Set<string>()
  let remainder = raw

  // path 先于文本实体提取（path 内可能含 F042 之类子串，先摘走防重复计入）
  remainder = remainder.replace(PATH_PATTERN, (m) => {
    pathSet.add(m)
    return " "
  })
  for (const pat of ENTITY_PATTERNS) {
    remainder = remainder.replace(pat, (m) => {
      mustSet.add(m)
      return " "
    })
  }
  for (const pat of QUOTED_TERM_PATTERNS) {
    remainder = remainder.replace(pat, (_m, inner: string) => {
      const t = inner.trim()
      if (t.length >= 3) {
        mustSet.add(t)
        return " "
      }
      return ` ${inner} ` // 短引号内容回流普通切词
    })
  }

  // normalize：非 字母/数字/下划线 → 空格（含控制字符/标点；与旧 sanitize 同口径）
  const normalized = remainder.replace(/[^\p{L}\p{N}_]/gu, " ")

  const orSet = new Set<string>()
  const dropped: string[] = []

  for (const token of normalized.split(/\s+/)) {
    if (token.length === 0) continue
    // token 内按 CJK / 非 CJK 边界再切段（处理 "api召回链" 类连写）
    for (const seg of splitByCjkBoundary(token)) {
      if (HAS_HAN.test(seg)) {
        if (seg.length >= CJK_WINDOW) {
          for (let i = 0; i + CJK_WINDOW <= seg.length; i++) {
            orSet.add(seg.slice(i, i + CJK_WINDOW))
          }
        } else {
          dropped.push(seg)
        }
      } else if (seg.length >= 3) {
        orSet.add(seg)
      } else {
        dropped.push(seg)
      }
    }
  }

  // must 已是显式信号，不重复出现在 or 组
  for (const m of mustSet) orSet.delete(m)

  // 封顶：must 优先，or 截断补齐
  const mustClauses = [...mustSet].slice(0, MAX_CLAUSES)
  const pathMusts = [...pathSet].slice(0, 4)
  const orClauses = [...orSet].slice(0, Math.max(0, MAX_CLAUSES - mustClauses.length))

  if (mustClauses.length === 0 && orClauses.length === 0 && pathMusts.length === 0) {
    return {
      matchExpr: "",
      mustClauses: [],
      orClauses: [],
      pathMusts: [],
      unsupported: true,
      droppedShortFragments: dropped,
    }
  }

  // matchExpr（德彪 AC6-r1 P1-2 optional-boost）：
  //   must+or → `((must) AND (or…)) OR (must)` —— OR 命中参与 BM25（真目标排前），
  //   must-only fallback 保留召回面（「F042 怎么修」滑窗不在目标文档时仍召回）。
  //   历史教训链：`must AND (or)` 杀正确命中（Task15 实证）→ 纯 must-only 让实体
  //   噪声占满 topK（德彪对抗复现）→ optional-boost 两个都解。
  //   排序/gate 责任：provider 按 matchedOrClauseCount 重排；gate 在存在
  //   OR-evidenced 候选时过滤零 OR 候选（direct-recall-pipeline evidenceGate）。
  const mustExpr = mustClauses.map(quoteFtsTerm).join(" AND ")
  const orExpr = orClauses.map(quoteFtsTerm).join(" OR ")
  let matchExpr: string
  if (mustExpr !== "" && orExpr !== "") matchExpr = `((${mustExpr}) AND (${orExpr})) OR (${mustExpr})`
  else if (mustExpr !== "") matchExpr = mustExpr
  else matchExpr = orExpr

  return {
    matchExpr,
    mustClauses,
    orClauses,
    pathMusts,
    unsupported: false,
    droppedShortFragments: dropped,
  }
}

/**
 * F042 AC6 · 命中证据计算（LL-037：gate 不用 minmax score，用可数 clause 证据）。
 * trigram tokenizer = substring 语义，应用层 includes() 等价且零 SQL 复杂度。
 * wiki 侧 haystack = name+body、entityPath = hit.path；messages 侧 = content、无 path。
 *
 * exactEntityMatch（P2-3 修订）：全部文本 must 命中 haystack，且候选 path 命中
 * 任一点名 pathMust（等值或 wiki/ 前缀变体）；两类实体都不存在 → false。
 */
export function analyzeClauseMatches(
  haystack: string,
  compiled: CompiledFtsQuery,
  entityPath?: string,
): { evidence: RecallHitEvidence; matchedClauses: string[] } {
  const lower = haystack.toLowerCase()
  const clauses = [...compiled.mustClauses, ...compiled.orClauses]
  const matchedClauses = clauses.filter((c) => lower.includes(c.toLowerCase()))
  const matchedOrClauseCount = compiled.orClauses.filter((c) =>
    lower.includes(c.toLowerCase()),
  ).length
  const textMustsOk =
    compiled.mustClauses.length === 0 ||
    compiled.mustClauses.every((c) => lower.includes(c.toLowerCase()))
  const exactPathMatch =
    compiled.pathMusts.length > 0 &&
    entityPath !== undefined &&
    compiled.pathMusts.some((p) => pathMatches(entityPath, p))
  const pathMustsOk = compiled.pathMusts.length === 0 || exactPathMatch
  const hasAnyEntity = compiled.mustClauses.length > 0 || compiled.pathMusts.length > 0
  return {
    evidence: {
      matchedClauseCount: matchedClauses.length,
      totalClauseCount: clauses.length,
      clauseCoverage: clauses.length > 0 ? matchedClauses.length / clauses.length : 0,
      matchedOrClauseCount,
      exactEntityMatch: hasAnyEntity && textMustsOk && pathMustsOk,
      exactPathMatch,
    },
    matchedClauses,
  }
}

/** path 实体判定：等值 / wiki/ 前缀变体 /「/」边界尾缀。 */
export function pathMatches(entityPath: string, wanted: string): boolean {
  return (
    entityPath === wanted || entityPath === `wiki/${wanted}` || entityPath.endsWith(`/${wanted}`)
  )
}

/** 把 token 按 CJK/非 CJK 连续段切开："api召回链" → ["api", "召回链"] */
function splitByCjkBoundary(token: string): string[] {
  const segs: string[] = []
  let cur = ""
  let curIsHan: boolean | null = null
  for (const ch of token) {
    const isHan = HAS_HAN.test(ch)
    if (curIsHan === null || isHan === curIsHan) {
      cur += ch
      curIsHan = isHan
    } else {
      segs.push(cur)
      cur = ch
      curIsHan = isHan
    }
  }
  if (cur) segs.push(cur)
  return segs
}
