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

  // [范-r1 P1 修正] 双信号 lint：
  //   - heading 信号 → cross-ref 可赦免（chap 27.0 行 3022 "cross-ref 互引"）
  //   - body verbatim 信号 → **任何情况下都 red**（"不复制" —— cross-ref 不能赦免复制）
  const findings: CrossFileLintFinding[] = []
  const seen = new Set<string>()

  for (const sa of sectionsA) {
    if (skipEmpty && sa.body.trim().length === 0) continue
    for (const sb of sectionsB) {
      if (skipEmpty && sb.body.trim().length === 0) continue
      const sim = tokenJaccard(sa.heading, sb.heading)
      const headingMatch = sim >= threshold
      const bodyMatch = bodyNgramOverlap(sa.body, sb.body, ngramMin)
      if (!headingMatch && !bodyMatch.matched) continue

      const finding = buildFinding({
        fileA,
        fileB,
        sa,
        sb,
        baseA,
        baseB,
        refToA,
        refToB,
        refBodyMax,
        sim,
        bodyMatch,
        ngramMin,
      })
      const key = `${finding.sectionA}::${finding.sectionB}::${finding.severity}::${finding.reason}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push(finding)
    }
  }

  // 第三轮：sectionA body 跨 fileB 全文 N-gram —— 抓"换标题但内容照抄"
  for (const sa of sectionsA) {
    if (skipEmpty && sa.body.trim().length === 0) continue
    const cleanA = stripWhitespace(sa.body).toLowerCase()
    if (cleanA.length < ngramMin) continue
    let foundChunk: string | null = null
    for (let i = 0; i + ngramMin <= cleanA.length; i++) {
      const chunk = cleanA.slice(i, i + ngramMin)
      if (fileBStripped.includes(chunk)) {
        foundChunk = chunk
        break
      }
    }
    if (!foundChunk) continue
    // [范-r1 P1] body verbatim copy → 永远 red（不被 cross-ref 赦免）
    findings.push({
      fileA: fileA.path,
      sectionA: sa.heading,
      fileB: fileB.path,
      sectionB: "(file-wide)",
      severity: "red",
      similarityScore: 1,
      reason: `body verbatim overlap with ${baseB} (≥${ngramMin} chars: "${truncate(foundChunk, 40)}") —— 复制即违规，cross-ref 也不能赦免（V16.5 chap 27.0 "互引不复制"）`,
    })
  }

  // 去重 (file-wide) 与具体 sectionB 之间的重复
  const filtered = findings.filter((f) => {
    if (f.sectionB !== "(file-wide)") return true
    return !findings.some(
      (g) =>
        g !== f &&
        g.fileA === f.fileA &&
        g.sectionA === f.sectionA &&
        g.sectionB !== "(file-wide)" &&
        /verbatim/.test(g.reason),
    )
  })

  void fileAStripped
  return filtered
}

interface BuildFindingArgs {
  fileA: FileInput
  fileB: FileInput
  sa: MarkdownSection
  sb: MarkdownSection
  baseA: string
  baseB: string
  refToA: RegExp
  refToB: RegExp
  refBodyMax: number
  sim: number
  bodyMatch: BodyOverlapResult
  ngramMin: number
}

function buildFinding(args: BuildFindingArgs): CrossFileLintFinding {
  const {
    fileA,
    fileB,
    sa,
    sb,
    baseA,
    baseB,
    refToA,
    refToB,
    refBodyMax,
    sim,
    bodyMatch,
    ngramMin,
  } = args
  const aHasRefToB = refToB.test(sa.body) && sa.body.length <= refBodyMax
  const bHasRefToA = refToA.test(sb.body) && sb.body.length <= refBodyMax
  const hasCrossRef = aHasRefToB || bHasRefToA

  if (bodyMatch.matched) {
    // body verbatim 信号：永远 red，cross-ref 不能赦免
    return {
      fileA: fileA.path,
      sectionA: sa.heading,
      fileB: fileB.path,
      sectionB: sb.heading,
      severity: "red",
      similarityScore: Number(Math.max(sim, 1).toFixed(3)),
      reason: `body verbatim overlap (≥${ngramMin} chars: "${truncate(bodyMatch.snippet, 40)}") —— 复制即违规，cross-ref 不能赦免（V16.5 chap 27.0 "互引不复制"）`,
    }
  }
  // 仅 heading 信号 + cross-ref → green
  if (hasCrossRef) {
    return {
      fileA: fileA.path,
      sectionA: sa.heading,
      fileB: fileB.path,
      sectionB: sb.heading,
      severity: "green",
      similarityScore: Number(sim.toFixed(3)),
      reason: `heading overlap (jaccard=${sim.toFixed(2)}) + cross-ref to ${aHasRefToB ? baseB : baseA}`,
    }
  }
  return {
    fileA: fileA.path,
    sectionA: sa.heading,
    fileB: fileB.path,
    sectionB: sb.heading,
    severity: "red",
    similarityScore: Number(sim.toFixed(3)),
    reason: `heading overlap (jaccard=${sim.toFixed(2)}) without cross-ref —— 必须用 [${baseB}#section] 形式 cross-ref，不要复制内容`,
  }
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
  // [范-r1 P2 修正] cross-ref 必须是 markdown 链接 `[label](url)`，且 url 含 basename。
  // 之前 `\[basename[\s#§]` 太宽 —— 普通文本 `[shared-rules.md 也许应该看` 就触发 green。
  // 新规则：匹配 `](...basename...)` —— 即 markdown link 的 URL 段含 basename。
  // 这覆盖：
  //   - `[label](./foo/basename)`
  //   - `[label](../foo/basename#anchor)`
  //   - `[basename § X](./basename#anchor)` 全部命中
  // 排除：
  //   - 纯文本 `[basename ...]` 而无 `(url)` 段
  //   - 纯文本 `basename` 不在 markdown 链接里
  return new RegExp(`\\]\\([^)\\n]*${escapeRegex(basename)}[^)\\n]*\\)`)
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
