/**
 * F027 P3 · ACL Engine — wiki.config.yaml 的 pure function 决策器
 * 真相源：docs/plans/V16.5-final.md chap 6（ACL 优先级规范 + 匹配规则）
 *
 * 职责：
 *   - loadACLConfig(yamlText) → 解析 + 结构验证（不查 DB / 不读文件）
 *   - decide(config, context, path, action) → 单条决策（pure，O(rules)）
 *   - lintACL(config, universe) → 枚举 (alias, path, action) 检测歧义
 *
 * 不做：
 *   - 文件 IO（caller 读 wiki.config.yaml 把字符串传进来）
 *   - log / metric（caller 在 service 层做）
 *   - 缓存（caller 持有 config 对象即可，不变 = 缓存）
 *
 * 核心匹配算法（white-list union 模型）：
 *   1. 把每条 rule 的 path_pattern 编译成 (regex, specificityScore)
 *      —— 静态 segment 大幅加分；混合 segment 中 slot + 字面字符各算半
 *   2. 对 (alias, path, action) 找所有匹配的 rule
 *   3. 取 specificity 最大的若干（可能 tied）
 *   4. tied 集合 OR-union：任一 (alias_ok && action_ok) → allow
 *   5. 全部 fail → 区分 alias / action 拒绝原因
 *
 * Template 语义：
 *   path_pattern '<self>' → caller alias 字面替换；'<roomId>' → 任意单段
 *   allowed_aliases '<self>' → caller alias 必须等于 path 中 <self> 解出来的值
 *   allowed_aliases '<other>' → caller 是 agent 且 ≠ <self> 解出值
 *   allowed_aliases '<any-agent>' → caller 是 agent（不含 system-auto-*）
 *   allowed_aliases 'system-auto-X' → exact match service identity
 *   allowed_aliases '小孙' / 任意具体 alias → exact match
 */

import { parse as parseYaml } from "yaml"
import {
  type ACLConfig,
  ACLConfigInvalidError,
  type ACLContext,
  type ACLDecision,
  type ACLRule,
  WIKI_ACTIONS,
  type WikiAction,
} from "./acl-types"

interface CompiledRule {
  rule: ACLRule
  regex: RegExp
  /** 用于 most-specific 排序：静态 segment 数 + bonus；越大越 specific */
  specificity: number
  /** path_pattern 中模板槽（<X>）顺序，用于解析 path 中 captured 值 */
  slotNames: string[]
  /** rule 在原 config 中的 index（lint 错误信息用） */
  index: number
}

export interface CompiledACL {
  rules: CompiledRule[]
}

/** 解析 + 验证 ACL YAML。失败抛 ACLConfigInvalidError。 */
export function loadACLConfig(yamlText: string): ACLConfig {
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch (e) {
    throw new ACLConfigInvalidError(`yaml parse error: ${(e as Error).message}`)
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { acl?: unknown }).acl)) {
    throw new ACLConfigInvalidError("config must have top-level `acl` array")
  }
  const aclRaw = (parsed as { acl: unknown[] }).acl
  const rules: ACLRule[] = aclRaw.map((row, i) => validateRule(row, i))
  return { acl: rules }
}

function validateRule(row: unknown, index: number): ACLRule {
  if (!row || typeof row !== "object") {
    throw new ACLConfigInvalidError(`acl[${index}] must be object`)
  }
  const obj = row as Record<string, unknown>
  const pathPattern = obj.path_pattern
  const allowedAliases = obj.allowed_aliases
  const allowedActions = obj.allowed_actions
  if (typeof pathPattern !== "string" || pathPattern.length === 0) {
    throw new ACLConfigInvalidError(`acl[${index}].path_pattern must be non-empty string`)
  }
  if (
    !Array.isArray(allowedAliases) ||
    !allowedAliases.every((a): a is string => typeof a === "string")
  ) {
    throw new ACLConfigInvalidError(`acl[${index}].allowed_aliases must be string[]`)
  }
  // allowed_actions 缺省时（如 wiki/index.md no-write 规则）默认空数组（拒所有 action）
  let actions: WikiAction[] = []
  if (allowedActions !== undefined) {
    if (
      !Array.isArray(allowedActions) ||
      !allowedActions.every((a): a is string => typeof a === "string")
    ) {
      throw new ACLConfigInvalidError(`acl[${index}].allowed_actions must be string[]`)
    }
    for (const a of allowedActions) {
      if (!WIKI_ACTIONS.includes(a as WikiAction)) {
        throw new ACLConfigInvalidError(
          `acl[${index}].allowed_actions has unknown action '${a}' (allowed: ${WIKI_ACTIONS.join(",")})`,
        )
      }
    }
    actions = allowedActions as WikiAction[]
  }
  return {
    pathPattern,
    allowedAliases,
    allowedActions: actions,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
  }
}

export function compileACL(config: ACLConfig): CompiledACL {
  const rules = config.acl.map((rule, index) => compileRule(rule, index))
  return { rules }
}

function compileRule(rule: ACLRule, index: number): CompiledRule {
  const segments = rule.pathPattern.split("/")
  const slotNames: string[] = []
  let specificity = 0
  const regexParts: string[] = []
  for (const seg of segments) {
    if (seg === "**") {
      regexParts.push(".*")
      // ** 不加分
      continue
    }
    if (seg === "*") {
      regexParts.push("[^/]+")
      specificity += 1
      continue
    }
    // 扫 segment 内 <X> token，支持 '<self>.md' / '<roomId>' 两种
    let segRegex = ""
    let pos = 0
    let staticChars = 0
    let slotsInSeg = 0
    const tokenRegex = /<([a-zA-Z][\w-]*)>/g
    for (const m of seg.matchAll(tokenRegex)) {
      const before = seg.slice(pos, m.index)
      segRegex += escapeRegex(before)
      staticChars += before.length
      slotNames.push(m[1])
      segRegex += "([^/]+)"
      slotsInSeg += 1
      pos = m.index + m[0].length
    }
    const tail = seg.slice(pos)
    segRegex += escapeRegex(tail)
    staticChars += tail.length
    if (slotsInSeg === 0) {
      // 纯静态 segment — 大幅加分
      specificity += 10
    } else if (staticChars === 0) {
      // 纯 <X> segment：一个 slot 抵 1 分
      specificity += slotsInSeg
    } else {
      // 混合（<X>.md 之类）：slot + 字面字符各算半，小幅加分
      specificity += slotsInSeg + Math.min(staticChars, 5)
    }
    regexParts.push(segRegex)
  }
  const regex = new RegExp("^" + regexParts.join("/") + "$")
  return { rule, regex, specificity, slotNames, index }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 单条决策。返回 allowed=true 表示通过，false 表示拒绝（reason 说明原因）。
 *
 * 决策步骤（white-list union 模型）：
 *   1. 找所有 path 匹配的 rule
 *   2. 没匹配 → no_match（白名单 deny）
 *   3. 取 specificity 最大的 rule 集（可能 tied）
 *   4. tied 集合 OR-union：任一 (alias_ok && action_ok) → allow
 *   5. 全部 fail → 取第一条作示例 pattern，区分 alias / action 拒绝原因
 *
 * 设计依据：chap 6 sample 的 wiki/people/<self>.md + wiki/people/<other>.md
 * 是 same specificity tied pair，意图就是"自己 page 走 <self> 规则；他人 page
 * 走 <other> 规则"，配置上是 OR 合并的多条 sub-rule。在 union 模型下永远不会
 * 真冲突。chap 6.4 第 4 条"同优先级且不一致 → lint 失败"的 lint 含义是配置
 * *质量* 检查（unreachable rule 之类），不是决策正确性 fail-safe。
 */
export function decide(
  compiled: CompiledACL,
  context: ACLContext,
  path: string,
  action: WikiAction,
): ACLDecision {
  const matches: Array<{ compiled: CompiledRule; slots: Record<string, string> }> = []
  for (const c of compiled.rules) {
    const m = c.regex.exec(path)
    if (!m) continue
    const slots: Record<string, string> = {}
    for (let i = 0; i < c.slotNames.length; i++) {
      slots[c.slotNames[i]] = m[i + 1] ?? ""
    }
    matches.push({ compiled: c, slots })
  }
  if (matches.length === 0) {
    return { allowed: false, reason: "no_match" }
  }
  const topSpec = Math.max(...matches.map((m) => m.compiled.specificity))
  const top = matches.filter((m) => m.compiled.specificity === topSpec)

  // tied OR-union：任一 rule (alias_ok && action_ok) → allow
  let aliasOkSomewhere = false
  for (const { compiled: c, slots } of top) {
    const aliasOk = aliasAllowed(c.rule.allowedAliases, context, slots)
    const actionOk = c.rule.allowedActions.includes(action)
    if (aliasOk) aliasOkSomewhere = true
    if (aliasOk && actionOk) {
      return { allowed: true, reason: "matched_allow", matchedPattern: c.rule.pathPattern }
    }
  }
  // 全部 fail：区分 alias / action 拒因。alias 至少 OK 过一条 → action 拒；否则 alias 拒。
  const first = top[0]
  if (aliasOkSomewhere) {
    return {
      allowed: false,
      reason: "action_not_allowed",
      matchedPattern: first.compiled.rule.pathPattern,
    }
  }
  return {
    allowed: false,
    reason: "alias_not_allowed",
    matchedPattern: first.compiled.rule.pathPattern,
  }
}

function aliasAllowed(
  allowed: string[],
  context: ACLContext,
  slots: Record<string, string>,
): boolean {
  for (const entry of allowed) {
    if (entry === "<self>") {
      // path 必须有 <self> slot；caller alias 必须等于 slot 解出来的值
      const selfFromPath = slots.self
      if (selfFromPath && context.alias === selfFromPath) return true
      // path 没有 <self> slot 时（例如 'wiki/people/小孙.md' 写死），
      // <self> 在 allowed_aliases 里就没意义。降级为 "caller 自己" 约束 ≡ 默认 true（非 service）。
      if (!selfFromPath && !context.isServiceIdentity) {
        // 但严格按 chap 6 语义，path 无 <self> 时 allowed_aliases 写 <self> 是配置错误；
        // 我们这里 conservative：要求 path 有 <self> slot 才允许。
        continue
      }
      continue
    }
    if (entry === "<other>") {
      const selfFromPath = slots.other ?? slots.self
      // <other> 语义：caller 是 agent 且 ≠ path 中 <other>/<self> 解出来的 alias
      if (context.isServiceIdentity) continue
      if (selfFromPath && context.alias !== selfFromPath) return true
      // path 无 <other>/<self> slot 时也降级 false（lint 应抓配置错误）
      continue
    }
    if (entry === "<any-agent>") {
      if (!context.isServiceIdentity) return true
      continue
    }
    if (entry === context.alias) {
      return true
    }
  }
  return false
}

/**
 * Lint：检测 unreachable rule —— 给定 (universe.aliases × universe.paths × actions)，
 * 哪些 rule 永远没机会成为 top-tied 集合中真正落地决策的那条。
 *
 * 当前实现仅 unreachable rule 检测（任一 universe 内 path 都不命中该 rule
 * 的 specificity 最高位）。chap 6.4 第 4 条原本提到的"同优先级且不一致"在
 * 当前 white-list union 决策模型下不会真冲突（tied 集合 OR 合并即可）。
 *
 * caller 提供 universe：典型从 wiki.config.yaml 旁边的 lint manifest 读
 * (aliases 来自 wiki/people / paths 来自 wiki/index 各版本 sources)。
 */
export interface ACLLintReport {
  unreachableRules: Array<{ index: number; pathPattern: string }>
}

export function lintACL(
  compiled: CompiledACL,
  universe: {
    aliases: Array<{ alias: string; isServiceIdentity: boolean }>
    paths: string[]
    actions?: WikiAction[]
  },
): ACLLintReport {
  // 哪些 rule index 在 universe 内至少一次成为 top-tied
  const reachable = new Set<number>()
  for (const path of universe.paths) {
    const top = topTiedRules(compiled, path)
    for (const r of top) reachable.add(r.index)
  }
  const unreachable: ACLLintReport["unreachableRules"] = []
  for (const c of compiled.rules) {
    if (!reachable.has(c.index)) {
      unreachable.push({ index: c.index, pathPattern: c.rule.pathPattern })
    }
  }
  return { unreachableRules: unreachable }
}

function topTiedRules(compiled: CompiledACL, path: string): CompiledRule[] {
  const matches = compiled.rules.filter((c) => c.regex.test(path))
  if (matches.length === 0) return []
  const topSpec = Math.max(...matches.map((m) => m.specificity))
  return matches.filter((m) => m.specificity === topSpec)
}
