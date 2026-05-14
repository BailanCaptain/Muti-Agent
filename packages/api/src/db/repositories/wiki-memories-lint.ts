/**
 * F027 P10 · 防漂桶 lint validator — wiki_memories 全表漂移检测。
 * 真相源：docs/plans/V16.5-final.md chap 14（5 防漂桶规则 + type-routed 规则）
 *
 * P10 实施 4 条 DB-only 规则；P2 WikiCompiler 落地后补 1 条文件系统规则：
 *   ✅ R1   同 canonical_owner_path 多 canonical 行 → red
 *   ⏳ R2   promote 后 source_path 还存在内容 → red（P2 文件 IO 落地后实施）
 *   ✅ R3   supersedes 链含 DB 中不存在的 path → red
 *   ✅ R4   ttl_days 过期 + state ≠ deprecated → yellow
 *   ❌ R5   canonical_owner field missing → DB NOT NULL 已强约束（无需 lint）
 *   ✅ R-T  canonical_owner_path prefix 与 type 不匹配 → red（type-routed 漂桶）
 *
 * lint 是诊断工具，不修复。修复由 cron NightlyHealthCheck（V16.5 chap 17）触发。
 */

import { type WikiMemory, bucketPrefix } from "./wiki-memories-types"

export type LintSeverity = "red" | "yellow"

export type LintRuleId = "R1-duplicate-canonical" | "R3-dead-supersedes" | "R4-ttl-expired" | "R-type-routed-prefix"

export interface LintFinding {
  rule: LintRuleId
  severity: LintSeverity
  memoryId: number
  canonicalOwnerPath: string
  message: string
}

export interface LintOptions {
  /** 评估 TTL 时基准时间。默认 new Date() — 单测注入固定时间防 flaky。 */
  now?: Date
}

export function lintWikiMemories(memories: WikiMemory[], opts: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = []
  const now = opts.now ?? new Date()
  const knownPaths = new Set(memories.map((m) => m.canonicalOwnerPath))

  // R1 · 同 canonical_owner_path 多 state='canonical' → red
  // 同一 path 应只有一条 canonical（旧版本应已 deprecated）。
  const canonicalByPath = new Map<string, WikiMemory[]>()
  for (const m of memories) {
    if (m.state !== "canonical") continue
    const arr = canonicalByPath.get(m.canonicalOwnerPath) ?? []
    arr.push(m)
    canonicalByPath.set(m.canonicalOwnerPath, arr)
  }
  for (const [path, group] of canonicalByPath) {
    if (group.length <= 1) continue
    for (const m of group) {
      findings.push({
        rule: "R1-duplicate-canonical",
        severity: "red",
        memoryId: m.id,
        canonicalOwnerPath: path,
        message: `R1: ${group.length} canonical rows for path "${path}" (ids: ${group.map((g) => g.id).join(", ")})`,
      })
    }
  }

  // R3 · supersedes 链含 DB 中不存在的 path → red
  // supersedes 是被本行覆盖的旧 path 列表；旧 path 必须在 wiki_memories 表里存在
  // （即使已 deprecated 也要在）。死链 = 引用了从未写入或被物理删除的 path。
  for (const m of memories) {
    if (!m.supersedes || m.supersedes.length === 0) continue
    const dead = m.supersedes.filter((p) => !knownPaths.has(p))
    if (dead.length === 0) continue
    findings.push({
      rule: "R3-dead-supersedes",
      severity: "red",
      memoryId: m.id,
      canonicalOwnerPath: m.canonicalOwnerPath,
      message: `R3: supersedes 包含 DB 中不存在的 path: ${dead.join(", ")}`,
    })
  }

  // R4 · ttl_days 过期 + state ≠ deprecated → yellow（提醒归档，不阻断）
  for (const m of memories) {
    if (m.ttlDays == null) continue
    if (m.state === "deprecated") continue
    const created = new Date(m.createdAt)
    if (Number.isNaN(created.getTime())) continue
    const expireAt = created.getTime() + m.ttlDays * 24 * 60 * 60 * 1000
    if (expireAt > now.getTime()) continue
    findings.push({
      rule: "R4-ttl-expired",
      severity: "yellow",
      memoryId: m.id,
      canonicalOwnerPath: m.canonicalOwnerPath,
      message: `R4: ttl_days=${m.ttlDays} 过期但 state=${m.state}（created_at=${m.createdAt}）`,
    })
  }

  // R-T · canonical_owner_path 前缀必须 = wiki/<type>/
  // 写时校验已在 repo 拦了，这里 lint 兜底（手工 INSERT / migration 漏拦时找出来）。
  for (const m of memories) {
    const expected = bucketPrefix(m.type)
    if (m.canonicalOwnerPath.startsWith(expected)) continue
    findings.push({
      rule: "R-type-routed-prefix",
      severity: "red",
      memoryId: m.id,
      canonicalOwnerPath: m.canonicalOwnerPath,
      message: `R-T: type=${m.type} 应以 "${expected}" 开头，实际 "${m.canonicalOwnerPath}"`,
    })
  }

  return findings
}

/** 按 severity 分桶（前端 / cron 报警按 red/yellow 分别处理）。 */
export function groupBySeverity(findings: LintFinding[]): Record<LintSeverity, LintFinding[]> {
  return {
    red: findings.filter((f) => f.severity === "red"),
    yellow: findings.filter((f) => f.severity === "yellow"),
  }
}
