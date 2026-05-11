/**
 * F027 P3.6 · cross-file dedupe lint
 * 真相源：docs/plans/V16.5-final.md chap 27.0（职责边界 + lint 协议）
 * AC: AC-P1-6 第 2/3 项 —— 红样例 lint 红灯 / 绿样例 lint 绿灯
 *
 * 协议：
 *   - shared-rules.md（项目家规）vs agent-wiki-handbook.md（wiki 操作手册）字段不允许重叠
 *   - 检测两个 markdown 文件之间的 H2/H3 标题级 + 首段语义级显式重叠
 *   - 重叠且**有 cross-ref（[basename`）→ green（合规：用 cross-ref 不复制）
 *   - 重叠但**无 cross-ref** → red（违规：直接复制内容到另一个真相源文件）
 *
 * 协议范围（chap 27.0）：
 *   - 只抓**显式字符串重叠**（同 keyword / 同 H2/H3 标题文本）
 *   - 抓不住语义重叠（同概念用不同表达）—— 这部分留人工 review + 季度 audit
 *   - lint 是显式重叠的最后防线，不是完美职责边界保证
 */

import path from "node:path"

export interface FileInput {
  /** 文件路径，用于 finding 报告 + cross-ref basename 匹配 */
  path: string
  /** 文件 markdown 内容 */
  content: string
}

interface MarkdownSection {
  level: number
  heading: string
  startLine: number
  body: string
}

export interface CrossFileLintFinding {
  fileA: string
  sectionA: string
  fileB: string
  sectionB: string
  severity: "red" | "green"
  similarityScore: number
  reason: string
}

export interface CrossFileLintOptions {
  /**
   * 标题 token Jaccard 相似度阈值。≥ threshold 视为标题重叠。默认 0.5。
   * 太低 → 假阳性多；太高 → 漏抓。CJK 标题 token 数少（一般 1-3），用 0.5 比 0.6 健壮。
   */
  jaccardThreshold?: number
  /**
   * cross-ref 合规判定的 body 长度上限（字符）。≤ 此长度且含 `[<otherBasename>`
   * 模式 → 视为 reference-only 而非内容复制 → green。默认 400。
   */
  referenceBodyMaxChars?: number
  /** 只 lint H2/H3（默认 true）。H4+ 一般是 detail 不构成"职责重叠"。 */
  ignoreDeeperThanH3?: boolean
  /**
   * body N-gram 子串重叠最小字符数。A section body 内任意 ≥ N 字符（去除空白后）
   * 的连续片段在 B 文件全文出现 → 触发 body-overlap 信号。默认 60。
   * 配 jaccard 双信号，CJK 长 verbatim 复制就抓得到。
   */
  bodyNgramMinChars?: number
  /** 跳过空 body section（H2 只挂 H3 不写正文）—— 避免父级 H2 假阳性。默认 true。 */
  skipEmptyBodySections?: boolean
}

/**
 * 在两个 markdown 文件之间检测 cross-file dedupe 违规。
 *
 * 算法：
 *   1. 抽取 fileA / fileB 的所有 H2/H3 section（含标题 + body）
 *   2. 双层循环：每对 (sectionA, sectionB) 比 heading token Jaccard
 *   3. ≥ threshold → 视为重叠候选；判定 sectionA 的 body 是否含 cross-ref [fileBbasename
 *      → 含且 body 短 → green
 *      → 不含 → red
 *   4. 对称：同样反向（A 是 fileB 抄 fileA → 看 fileB 的 body 有没有 cross-ref 到 A）
 */
export function lintCrossFileDedupe(
  fileA: FileInput,
  fileB: FileInput,
  options?: CrossFileLintOptions,
): CrossFileLintFinding[] {
  const threshold = options?.jaccardThreshold ?? 0.5
  const refBodyMax = options?.referenceBodyMaxChars ?? 400
  const ignoreDeeper = options?.ignoreDeeperThanH3 ?? true
  const ngramMin = options?.bodyNgramMinChars ?? 60
  const skipEmpty = options?.skipEmptyBodySections ?? true

  const sectionsA = extractSections(fileA.content, ignoreDeeper)
  const sectionsB = extractSections(fileB.content, ignoreDeeper)
  const baseA = path.basename(fileA.path)
  const baseB = path.basename(fileB.path)
  const refToA = makeCrossRefRegex(baseA)
  const refToB = makeCrossRefRegex(baseB)
  const fileBStripped = stripWhitespace(fileB.content).toLowerCase()
  const fileAStripped = stripWhitespace(fileA.content).toLowerCase()

  const findings: CrossFileLintFinding[] = []
  for (const sa of sectionsA) {
    if (skipEmpty && sa.body.trim().length === 0) continue
    for (const sb of sectionsB) {
      if (skipEmpty && sb.body.trim().length === 0) continue
      const sim = tokenJaccard(sa.heading, sb.heading)
      const headingMatch = sim >= threshold
      // body N-gram：A section body 是否含 ≥ ngramMin 字符片段也出现在 B section body
      const bodyMatch = bodyNgramOverlap(sa.body, sb.body, ngramMin)
      if (!headingMatch && !bodyMatch.matched) continue

      const reason = headingMatch
        ? `heading overlap (jaccard=${sim.toFixed(2)})`
        : `body verbatim overlap (≥${ngramMin} chars: "${truncate(bodyMatch.snippet, 40)}")`
      const aHasRefToB = refToB.test(sa.body) && sa.body.length <= refBodyMax
      const bHasRefToA = refToA.test(sb.body) && sb.body.length <= refBodyMax
      const isReference = aHasRefToB || bHasRefToA
      findings.push({
        fileA: fileA.path,
        sectionA: sa.heading,
        fileB: fileB.path,
        sectionB: sb.heading,
        severity: isReference ? "green" : "red",
        similarityScore: Number(Math.max(sim, bodyMatch.matched ? 1 : 0).toFixed(3)),
        reason: isReference
          ? `${reason} + cross-ref to ${aHasRefToB ? baseB : baseA}`
          : `${reason} without cross-ref —— 必须用 [${baseB}#section] 形式 cross-ref，不要复制内容`,
      })
    }
    // 第二信号：sectionA 的 body 是否含跨文件 verbatim chunk（不限于 sectionB body）
    // —— 抓"换标题但内容照抄"的攻击。
    if (sectionsB.length > 0) continue // 已经在内层循环中覆盖
    // unreachable 保留作语义占位
  }

  // 第三轮：sectionA body 与 fileB 全文 N-gram 重叠（不挂任何 sectionB）—— 抓"换标题或没标题但 body 照抄"
  for (const sa of sectionsA) {
    if (skipEmpty && sa.body.trim().length === 0) continue
    // 已在双层循环里覆盖了 sectionB 内的命中；这里只补"sa body 出现在 fileB 但不在任何 sectionB body"
    const cleanA = stripWhitespace(sa.body).toLowerCase()
    if (cleanA.length < ngramMin) continue
    let foundChunk: string | null = null
    for (let i = 0; i + ngramMin <= cleanA.length; i++) {
      const chunk = cleanA.slice(i, i + ngramMin)
      if (fileBStripped.includes(chunk)) {
        // 已在 sectionB body 命中过 → 跳过（去重）
        if (
          findings.some(
            (f) => f.fileA === fileA.path && f.sectionA === sa.heading && /body/.test(f.reason),
          )
        ) {
          foundChunk = null
          break
        }
        foundChunk = chunk
        break
      }
    }
    if (!foundChunk) continue
    const aHasRefToB = refToB.test(sa.body) && sa.body.length <= refBodyMax
    findings.push({
      fileA: fileA.path,
      sectionA: sa.heading,
      fileB: fileB.path,
      sectionB: "(file-wide)",
      severity: aHasRefToB ? "green" : "red",
      similarityScore: 1,
      reason: aHasRefToB
        ? `body verbatim overlap with ${baseB} (≥${ngramMin} chars: "${truncate(foundChunk, 40)}") + cross-ref present`
        : `body verbatim overlap with ${baseB} (≥${ngramMin} chars: "${truncate(foundChunk, 40)}") without cross-ref —— 必须用 [${baseB}#section] 形式 cross-ref，不要复制内容`,
    })
  }

  // 抑制重复 findings（同一对 sectionA × sectionB 组合多信号触发的合并已在内层处理；
  // 这里的 file-wide 第三轮可能与内层重复，已通过 some() 去重，不再二次过滤。）
  // 防止 (file-wide) finding 与 (具体 sectionB) finding 同时出现：移除 file-wide 当存在具体 sectionB 命中
  const filtered = findings.filter((f) => {
    if (f.sectionB !== "(file-wide)") return true
    return !findings.some(
      (g) =>
        g !== f &&
        g.fileA === f.fileA &&
        g.sectionA === f.sectionA &&
        g.sectionB !== "(file-wide)",
    )
  })

  // 用 fileAStripped 做形式占位（未来对称扩展用），ESLint 不抱怨
  void fileAStripped
  return filtered
}

/** 仅返回 red findings（CI / lint 命令兜底用）。 */
export function getRedFindings(
  fileA: FileInput,
  fileB: FileInput,
  options?: CrossFileLintOptions,
): CrossFileLintFinding[] {
  return lintCrossFileDedupe(fileA, fileB, options).filter((f) => f.severity === "red")
}

// ───────────────── helpers ─────────────────

function extractSections(md: string, ignoreDeeperThanH3: boolean): MarkdownSection[] {
  const lines = md.split(/\r?\n/)
  const sections: MarkdownSection[] = []
  let current: MarkdownSection | null = null
  // 跳过 frontmatter（首行 --- 到下一个 ---）
  let inFrontmatter = false
  let frontmatterClosed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === 0 && line.trim() === "---") {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter && !frontmatterClosed) {
      if (line.trim() === "---") {
        frontmatterClosed = true
        inFrontmatter = false
      }
      continue
    }
    const headingMatch = line.match(/^(#{2,6})\s+(.+?)\s*$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      if (ignoreDeeperThanH3 && level > 3) {
        // H4+ 仍算入当前 section body，不开新 section
        if (current) current.body += `${line}\n`
        continue
      }
      if (current) sections.push(current)
      current = {
        level,
        heading: headingMatch[2].trim(),
        startLine: i + 1,
        body: "",
      }
      continue
    }
    if (current) current.body += `${line}\n`
  }
  if (current) sections.push(current)
  return sections
}

const TOKEN_SPLIT = /[\s\p{P}]+/u

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(TOKEN_SPLIT)
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  )
}

function tokenJaccard(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function makeCrossRefRegex(basename: string): RegExp {
  // 匹配 [basename / [basename# / [basename §  等 markdown 链接前缀
  return new RegExp(`\\[${escapeRegex(basename)}[\\s#§]`)
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "")
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

interface BodyOverlapResult {
  matched: boolean
  snippet: string
}

/**
 * 检查 bodyA 是否含 ≥ ngramMin 字符（去空白后）的连续片段，也出现在 bodyB 里。
 * CJK 友好（按字符滑窗，不依赖空格分词）。
 */
function bodyNgramOverlap(bodyA: string, bodyB: string, ngramMin: number): BodyOverlapResult {
  const cleanA = stripWhitespace(bodyA).toLowerCase()
  const cleanB = stripWhitespace(bodyB).toLowerCase()
  if (cleanA.length < ngramMin || cleanB.length < ngramMin) {
    return { matched: false, snippet: "" }
  }
  for (let i = 0; i + ngramMin <= cleanA.length; i++) {
    const chunk = cleanA.slice(i, i + ngramMin)
    if (cleanB.includes(chunk)) return { matched: true, snippet: chunk }
  }
  return { matched: false, snippet: "" }
}
