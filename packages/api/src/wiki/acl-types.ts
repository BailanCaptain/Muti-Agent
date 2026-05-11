/**
 * F027 P3 · wiki.config.yaml ACL 域类型 + 6 条匹配规则契约
 * 真相源：docs/plans/V16.5-final.md chap 6（ACL 优先级规范 + 匹配规则）
 *
 * 配置文件结构（YAML）：
 *   acl:
 *     - path_pattern: 'wiki/rules/**'
 *       allowed_aliases: [小孙]
 *       allowed_actions: [write, patch]
 *       notes?: '注释（可选）'
 *
 * Template 占位符（path_pattern 内 / allowed_aliases 内）：
 *   <self>      — caller 自己 alias
 *   <other>     — 非 self 的任意 agent（不含 service identity）
 *   <any-agent> — 任意 agent（不含 service identity，含 self）
 *
 * Action 枚举（与 wiki_events.action 同源）：
 *   write | append | patch | ingest | promote | demote | delete
 *
 * 匹配规则（chap 6.4）：
 *   1. Most-specific path 优先（按 segment 数 + 静态 segment 数）
 *   2. 同 path 内 deny 优先于 allow（白名单模式，未匹配 = deny）
 *   3. <self>/<other>/<any-agent> 解析时排除 system-auto-* 服务身份
 *   4. 同 priority 多 rule 不一致 → 启动 lint 失败
 *   5. service identity 必须显式声明（不参与 <any-agent>）
 */

export type WikiAction = "write" | "append" | "patch" | "ingest" | "promote" | "demote" | "delete"

export const WIKI_ACTIONS: readonly WikiAction[] = [
  "write",
  "append",
  "patch",
  "ingest",
  "promote",
  "demote",
  "delete",
]

export interface ACLRule {
  pathPattern: string
  allowedAliases: string[]
  allowedActions: WikiAction[]
  notes?: string
}

export interface ACLConfig {
  acl: ACLRule[]
}

export interface ACLDecision {
  allowed: boolean
  reason: string // "matched_<rule>" | "no_match" | "alias_not_allowed" | "action_not_allowed"
  matchedPattern?: string
}

/** caller 上下文，用于 template 解析 + service identity 区分。 */
export interface ACLContext {
  /** caller alias（runtime resolved，client 不能传） */
  alias: string
  /** alias 是否是 system-auto-* 服务身份 */
  isServiceIdentity: boolean
}

export class ACLConfigInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ACLConfigInvalidError"
  }
}

export function isServiceAlias(alias: string): boolean {
  return alias.startsWith("system-auto-")
}
