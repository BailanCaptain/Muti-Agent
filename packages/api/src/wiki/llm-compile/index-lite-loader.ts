/**
 * F027 v3 G11 · Phase 1 Pre-compile · 生产 IndexLiteLoader
 *
 * 真相源：types.ts:218 IndexLiteLoader interface + pre-compile.ts:58 load(["concepts","rules"])
 *
 * 职责：扫 `<wikiRoot>/<scope>/` 顶层 .md 文件，parse frontmatter，产 IndexLiteEntry[]：
 *   - name = 文件 basename（去 .md）—— 必须是 entity 规范名（kebab），这样 LLM 据此目录
 *     产出的 cross_refs.target 才能被 EntityExistenceChecker.exists(`<name>.md`) 命中。
 *   - summary = frontmatter.summary（缺 → body 首非空行 → ""）
 *
 * 边界：
 *   - 仅扫顶层 .md，**排除 draft/ 等子目录**（draft 不是已发布 entity，不进编译参考目录）。
 *   - 目录不存在 / 读失败 → fail-soft 返 []（pre-compile.ts:59 已 try/catch，双保险）。
 *   - 不缓存（编译非超高频；目录数十文件扫描 <10ms。需缓存时 follow-up 加 TTL）。
 */

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { parseFrontmatter } from "../../routes/phase3/frontmatter"
import type { IndexLiteEntry, IndexLiteLoader } from "./types"

type IndexScope = "concepts" | "rules" | "methods"

export interface ProductionIndexLiteLoaderDeps {
  /** markdown 实际根（= server.ts roomCompileWikiRoot = `.runtime/wiki/wiki`）。 */
  wikiRoot: string
  /** 可选 log（fail-soft 时记一笔；默认 noop）。 */
  logger?: (msg: string) => void
}

export function createProductionIndexLiteLoader(
  deps: ProductionIndexLiteLoaderDeps,
): IndexLiteLoader {
  const log = deps.logger ?? (() => {})

  async function loadScope(scope: IndexScope): Promise<IndexLiteEntry[]> {
    const dir = path.join(deps.wikiRoot, scope)
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      // 目录不存在 → 该 scope 无 entity
      return []
    }
    const entries: IndexLiteEntry[] = []
    for (const file of names) {
      if (!file.endsWith(".md")) continue // 跳过非 md + 子目录（readdir 名无扩展名即跳）
      const full = path.join(dir, file)
      try {
        const stat = await fs.stat(full)
        if (!stat.isFile()) continue // 排除 draft/ 等子目录
        const content = await fs.readFile(full, "utf-8")
        const { frontmatter, body } = parseFrontmatter(content)
        const name = file.slice(0, -3) // 去 .md → entity 规范名（kebab）
        const summary = coerceSummary(frontmatter?.summary) || firstNonEmptyLine(body)
        entries.push({ name, summary })
      } catch (err) {
        log(`IndexLiteLoader skip ${full}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return entries
  }

  return {
    async load(scopes) {
      const out: { concepts: IndexLiteEntry[]; rules: IndexLiteEntry[]; methods?: IndexLiteEntry[] } =
        { concepts: [], rules: [] }
      for (const scope of scopes) {
        const entries = await loadScope(scope)
        if (scope === "concepts") out.concepts = entries
        else if (scope === "rules") out.rules = entries
        else if (scope === "methods") out.methods = entries
      }
      return out
    },
  }
}

function coerceSummary(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function firstNonEmptyLine(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (t && !t.startsWith("#")) return t.slice(0, 200)
  }
  return ""
}
