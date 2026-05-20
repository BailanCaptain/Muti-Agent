/**
 * F027 Phase 3 P20 · 共享 frontmatter parser（Day 3）
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1 Day 3
 *
 * 解析 `---\n...yaml...\n---\nbody` 格式：
 *   - 返回 { frontmatter, body }
 *   - 无 frontmatter → { frontmatter: null, body: 原文 }
 *   - YAML 解析失败 → 抛 FrontmatterParseError
 *
 * 不引入 gray-matter 等第三方库 — 用项目已有的 yaml@1.x。
 */

import yaml from "yaml"

export class FrontmatterParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message)
    this.name = "FrontmatterParseError"
  }
}

export interface ParseFrontmatterResult<T = Record<string, unknown>> {
  /** Parsed frontmatter object；无 frontmatter 时 null。 */
  frontmatter: T | null
  /** 去除 frontmatter 后的 body（首行 newline 已 trim）。 */
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export function parseFrontmatter<T = Record<string, unknown>>(
  raw: string,
): ParseFrontmatterResult<T> {
  if (typeof raw !== "string") {
    return { frontmatter: null, body: "" }
  }
  const match = raw.match(FRONTMATTER_RE)
  if (!match) {
    return { frontmatter: null, body: raw }
  }
  const [, yamlBlock, body] = match
  let parsed: unknown
  try {
    parsed = yaml.parse(yamlBlock)
  } catch (err) {
    throw new FrontmatterParseError(
      `YAML parse failed: ${(err as Error).message}`,
      err as Error,
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { frontmatter: null, body }
  }
  return { frontmatter: parsed as T, body }
}
