/**
 * F027 v3 G11 · Phase 3 Post-compile · 生产 EntityExistenceChecker
 *
 * 真相源：types.ts:230 EntityExistenceChecker interface + post-compile.ts:64
 *   `await deps.entityChecker.exists(ref.target)` —— cross_refs 死链检测。
 *
 * 职责：判断 entity 名（kebab，不带 [[]]/目录/.md）是否在已发布 wiki 中存在：
 *   查 `<wikiRoot>/{concepts,rules,methods,people}/<name>.md` 任一存在即 true。
 *
 * 边界：
 *   - 防路径穿越：name 含 `/` `\` `..` 或非法字符 → 直接返 false（不拼进 path）。
 *   - 容错前缀：若 caller 传了 `[[name]]` 或 `concepts/name` → 剥离后再查（零信任，contract
 *     说不带但防御）。
 *   - 仅查已发布根目录，**不查 draft/**（cross_ref 指向已发布 entity；draft 未定稿不算）。
 *   - fs 错误（权限/IO）→ 当作不存在（false）；post-compile 不 try/catch 单个 exists，
 *     这里吞错保证死链检测不炸编译。
 */

import { promises as fs } from "node:fs"
import * as path from "node:path"
import type { EntityExistenceChecker } from "./types"

const ENTITY_DIRS = ["concepts", "rules", "methods", "people"] as const

/** 合法 entity 名：字母数字 + `-` `_` `.`（但不含 `..`）。 */
const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface ProductionEntityExistenceCheckerDeps {
  /** markdown 实际根（= server.ts roomCompileWikiRoot = `.runtime/wiki/wiki`）。 */
  wikiRoot: string
}

export function createProductionEntityExistenceChecker(
  deps: ProductionEntityExistenceCheckerDeps,
): EntityExistenceChecker {
  return {
    async exists(entityName) {
      const name = normalizeEntityName(entityName)
      if (!name) return false

      for (const dir of ENTITY_DIRS) {
        const full = path.join(deps.wikiRoot, dir, `${name}.md`)
        try {
          const stat = await fs.stat(full)
          if (stat.isFile()) return true
        } catch {
          // 不存在 / IO 错 → 试下一个目录
        }
      }
      return false
    },
  }
}

/** 剥 [[]] / 目录前缀 / .md 后缀，校验防穿越；非法返 "". */
function normalizeEntityName(raw: string): string {
  let n = raw.trim()
  // 剥 [[wikilink]]
  const wl = n.match(/^\[\[(.+)\]\]$/)
  if (wl) n = wl[1].trim()
  // 剥目录前缀（取最后一段）
  n = n.split(/[/\\]/).pop() ?? ""
  // 剥 .md 后缀
  if (n.endsWith(".md")) n = n.slice(0, -3)
  // 防穿越 + 合法名校验
  if (n.includes("..") || !VALID_NAME.test(n)) return ""
  return n
}
