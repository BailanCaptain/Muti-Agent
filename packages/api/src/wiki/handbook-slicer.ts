/**
 * F027 P3.6 · Agent Wiki Handbook 4 H2 切片注入合约
 * 真相源：docs/plans/V16.5-final.md chap 27.4
 *
 * 职责：
 *   - 按 H2 标题切 handbook markdown 成 4 片（compileRules / sanitizeRules /
 *     agentActions / devHuman）
 *   - 注入合约：compile-LLM 拿 compileRules / sanitize-LLM 拿 sanitizeRules /
 *     agent runtime 仅 first-wakeup 时拿一次 agentActions / devHuman 不注入任何 LLM
 *
 * 不做：
 *   - 语义判断（哪条规则对哪条 raw 起作用） —— 那是 LLM 的活
 *   - 缓存 / cache invalidation —— LLM 启动时即时切片，handbook 改了下次启动生效
 *
 * **核心哲学（V16.5 chap 27）**：
 *   程序按 H2 切片是**纯索引动作**（不做语义判断）。
 *   语义判断（"这条 raw 应归 concept 还是 method"）由 LLM 拿到切片后判断 ——
 *   LLM 做语义，程序做索引。
 */

import { readFile } from "node:fs/promises"
import path from "node:path"

export interface HandbookSlices {
  compileRules: string
  sanitizeRules: string
  agentActions: string
  devHuman: string
}

/**
 * H2 标题 → slice key 映射。
 * 加新切片时必须同步：
 *   1. handbook frontmatter slice_metadata
 *   2. handbook 增 H2 段
 *   3. 这里加映射
 *   4. HandbookSlices interface 加字段
 */
export const H2_TO_KEY: Record<string, keyof HandbookSlices> = {
  编译规则: "compileRules",
  "Sanitize 规则": "sanitizeRules",
  "Agent 动作手册": "agentActions",
  "Dev / human 部分": "devHuman",
}

const REQUIRED_SLICE_KEYS: readonly (keyof HandbookSlices)[] = [
  "compileRules",
  "sanitizeRules",
  "agentActions",
  "devHuman",
] as const

/** handbook 默认 canonical 路径（相对 wikiRoot）。 */
export const HANDBOOK_RELATIVE_PATH = "wiki/rules/agent-wiki-handbook.md"

/**
 * 纯函数：按 H2 切 markdown。
 *
 * 协议：
 *   - 只看 `^## ` 开头的 H2 标题（H3+ 归属当前 H2 切片）
 *   - 标题文本 trim 后查 H2_TO_KEY；未识别的 H2 → 内容跳过（不归任何切片）
 *   - frontmatter / 文件头介绍段（H2 之前的内容）→ 不归任何切片
 *   - 切片内容包含该 H2 标题行本身（方便 LLM 看见自己的标题）
 *
 * 防错：
 *   - 4 个切片任意一个为空 → throw（handbook 损坏 / 误编辑保护）
 *   - 同一 H2 出现两次（典型误编辑）→ 后段 append 到前段（不丢内容，给 lint 抓）
 */
export function sliceHandbookByH2(content: string): HandbookSlices {
  const slices: HandbookSlices = {
    compileRules: "",
    sanitizeRules: "",
    agentActions: "",
    devHuman: "",
  }
  const lines = content.split(/\r?\n/)
  let currentKey: keyof HandbookSlices | null = null
  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+?)\s*$/)
    if (h2Match) {
      const heading = h2Match[1].trim()
      currentKey = H2_TO_KEY[heading] ?? null
      if (currentKey) slices[currentKey] += `${line}\n`
      continue
    }
    if (currentKey) slices[currentKey] += `${line}\n`
  }
  for (const key of REQUIRED_SLICE_KEYS) {
    if (!slices[key].trim()) {
      throw new HandbookSliceMissingError(key)
    }
  }
  return slices
}

export class HandbookSliceMissingError extends Error {
  readonly missingKey: keyof HandbookSlices
  constructor(key: keyof HandbookSlices) {
    super(`Handbook slice missing: ${key} (H2 not found or empty)`)
    this.name = "HandbookSliceMissingError"
    this.missingKey = key
  }
}

/**
 * [范-r1 P3] runtime ENOENT 友好错误：抛 HandbookFileMissingError 而不是裸 ENOENT。
 * 让 caller（Phase 2 RoomCompiler / sanitize 调度）能直接日志报"哪个 wikiRoot 没 handbook"。
 */
export class HandbookFileMissingError extends Error {
  readonly wikiRoot: string
  readonly relativePath: string
  readonly absolutePath: string
  constructor(wikiRoot: string, relativePath: string, absolutePath: string, cause?: unknown) {
    super(
      `Agent Wiki Handbook file not found: ${absolutePath}\n` +
        `  wikiRoot=${wikiRoot}\n` +
        `  relativePath=${relativePath}\n` +
        "  → Phase 1 部署期：把 wiki/rules/agent-wiki-handbook.md seed 进对应 wikiRoot；" +
        "Phase 2 之后由 P3.6 setup 脚本兜底。",
    )
    this.name = "HandbookFileMissingError"
    this.wikiRoot = wikiRoot
    this.relativePath = relativePath
    this.absolutePath = absolutePath
    if (cause !== undefined) {
      ;(this as unknown as { cause: unknown }).cause = cause
    }
  }
}

/**
 * IO 包装：从 wikiRoot 加载 handbook 文件并切片。
 * @throws HandbookFileMissingError 文件不存在 / 不可读
 * @throws HandbookSliceMissingError handbook 内容缺 H2
 */
export async function loadHandbookSlices(wikiRoot: string): Promise<HandbookSlices> {
  const handbookPath = path.resolve(wikiRoot, HANDBOOK_RELATIVE_PATH)
  let content: string
  try {
    content = await readFile(handbookPath, "utf-8")
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") {
      throw new HandbookFileMissingError(wikiRoot, HANDBOOK_RELATIVE_PATH, handbookPath, e)
    }
    throw e
  }
  return sliceHandbookByH2(content)
}

/**
 * compile-LLM system prompt builder。
 * caller 传 base prompt（model identity / output schema），slicer 拼上「编译规则」H2。
 */
export function buildCompileLLMPrompt(slices: HandbookSlices, basePrompt: string): string {
  return `${basePrompt}\n\n# 编译规则（来自 handbook）\n\n${slices.compileRules.trim()}\n`
}

/**
 * sanitize-LLM system prompt builder。
 */
export function buildSanitizeLLMPrompt(slices: HandbookSlices, basePrompt: string): string {
  return `${basePrompt}\n\n# Sanitize 规则（来自 handbook）\n\n${slices.sanitizeRules.trim()}\n`
}

/**
 * Agent runtime 注入 helper（**可选**）。
 * 默认不注入；仅 first wake-up（session_state.handbook_seen=false）时注入一次。
 * caller 注入后应 mark handbook_seen=true。
 */
export function maybeInjectAgentHandbookSlice(
  slices: HandbookSlices,
  sessionState: { handbookSeen: boolean },
): string | null {
  if (sessionState.handbookSeen) return null
  return slices.agentActions
}
