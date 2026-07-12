/**
 * F042 AC3 · 同源检测：promote 的 src draft 与正式区已有条目 sources[0].path 精确相同
 * → 双胞胎撞车（F031 场景：同一篇 docs 先后收录出两个 wiki 条目，新旧并存自相矛盾）。
 *
 * 数据源 = wiki_entity_index.body（含 frontmatter 全文快照），不走 fs walk——promote 人工
 * 触发频率低，全表 ~百行量级；index 新鲜度有 boot/commit-debounce/5min 周期三重保证
 * （≤5min 内连续两次同源 promote 的竞态窗口接受，事件账本可追溯）。
 *
 * 排除面：dest 自身（同路径替换走既有 dest_exists/CAS 通道）、draft 区（未转正不算撞）、
 * 归档区（已退出的旧版不算撞）。
 */

import fs from "node:fs"
import path from "node:path"
import { parseFrontmatter } from "../../routes/phase3/frontmatter"
import { isArchivedRelativePath, isDraftRelativePath } from "./promote-wiki-service"

export interface SameSourceConflict {
  path: string
  title: string
}

export interface SameSourceLookup {
  /** 正式区条目全集（path/name/body）；生产用 createFsSameSourceLookup（FS 权威零滞后）。 */
  listIndexedEntries(): Array<{ path: string; name: string; body: string }>
}

/** promote 合法目标面全集（与 promote-modal ALLOWED_DEST_PREFIXES 同口径六桶）。 */
const FORMAL_BUCKETS = ["concepts", "rules", "methods", "people", "feedback", "work"] as const

/**
 * 德彪 r1 P1-4 + r2 P1-2 · 文件系统权威 lookup：递归扫正式区六桶全部 .md。
 * 替代 wiki_entity_index 数据源——index 靠 5min 周期安全网收敛，连续两次同源 promote
 * 时第二篇撞不到第一篇（还没进索引）→ 绕过 409。FS 是 canonical 真相源，promote 落盘
 * 即可见。promote 人工触发低频 + 正式区条目百级，同步递归 readdir 成本可忽略。
 * r2 修：四桶顶层平扫漏 feedback/work 桶与桶内子目录（indexer 合同是递归全深度）
 * → 同源页在 wiki/concepts/team/ 等嵌套路径时 409 被绕过。递归 + draft/归档谓词排除。
 */
export function createFsSameSourceLookup(wikiRoot: string): SameSourceLookup {
  return {
    listIndexedEntries() {
      const out: Array<{ path: string; name: string; body: string }> = []
      const walk = (dirAbs: string, relPrefix: string): void => {
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dirAbs, { withFileTypes: true })
        } catch {
          return // 目录不存在/不可读 = 空
        }
        for (const e of entries) {
          const rel = `${relPrefix}/${String(e.name)}`
          if (e.isDirectory()) {
            walk(path.join(dirAbs, String(e.name)), rel)
            continue
          }
          if (!e.isFile() || !String(e.name).endsWith(".md")) continue
          // draft/归档子树排除（与 findSameSourceEntries 的谓词同口径，双保险）
          if (isDraftRelativePath(rel) || isArchivedRelativePath(rel)) continue
          try {
            out.push({
              path: rel,
              name: String(e.name).replace(/\.md$/, ""),
              body: fs.readFileSync(path.join(dirAbs, String(e.name)), "utf-8"),
            })
          } catch {
            // 单文件读失败不炸扫描（与 index 版单行坏 frontmatter 同姿态）
          }
        }
      }
      for (const bucket of FORMAL_BUCKETS) {
        walk(path.join(wikiRoot, "wiki", bucket), `wiki/${bucket}`)
      }
      return out
    },
  }
}

/** frontmatter.sources[0].path 取值（与 auto-draft-supersede sources0Path 同语义）。 */
export function sources0Path(fm: Record<string, unknown> | null | undefined): string | null {
  if (!fm) return null
  const sources = fm.sources
  if (!Array.isArray(sources) || sources.length === 0) return null
  const first = sources[0]
  if (!first || typeof first !== "object") return null
  const p = (first as Record<string, unknown>).path
  return typeof p === "string" && p.length > 0 ? p : null
}

/**
 * 装配点便捷入口：srcContent（draft 原文）→ 提取 sources[0].path → 扫同源。
 * promote-wiki-service 经 cfg.findSameSource 闭包消费本函数（type-only 依赖，防 import 环）。
 */
export function detectSameSourceConflicts(
  deps: SameSourceLookup,
  srcContent: string,
  destWikiPath: string,
): SameSourceConflict[] {
  let srcSourcePath: string | null = null
  try {
    srcSourcePath = sources0Path(parseFrontmatter(srcContent).frontmatter)
  } catch {
    return [] // src frontmatter 烂 → 无从同源比对，不挡 promote（V14 审计层管内容问题）
  }
  if (!srcSourcePath) return []
  return findSameSourceEntries(deps, srcSourcePath, destWikiPath)
}

export function findSameSourceEntries(
  deps: SameSourceLookup,
  srcSourcePath: string,
  destWikiPath: string,
): SameSourceConflict[] {
  if (!srcSourcePath) return []
  const out: SameSourceConflict[] = []
  for (const row of deps.listIndexedEntries()) {
    if (row.path === destWikiPath) continue
    if (isDraftRelativePath(row.path) || isArchivedRelativePath(row.path)) continue
    let fm: Record<string, unknown> | null = null
    try {
      fm = parseFrontmatter(row.body).frontmatter
    } catch {
      continue // 单行坏 frontmatter 不炸整个扫描
    }
    const p = sources0Path(fm)
    if (p && p === srcSourcePath) out.push({ path: row.path, title: row.name })
  }
  return out
}
