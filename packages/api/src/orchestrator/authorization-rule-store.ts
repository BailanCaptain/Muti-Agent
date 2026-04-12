import type {
  AuthorizationRuleRepository,
  AuthorizationRuleRow,
} from "../db/repositories/authorization-rule-repository"

function matchAction(pattern: string, action: string): boolean {
  if (pattern === "*") return true
  if (pattern === action) return true
  if (pattern.includes("*")) {
    const prefix = pattern.slice(0, pattern.indexOf("*"))
    return action.startsWith(prefix)
  }
  return false
}

export class AuthorizationRuleStore {
  constructor(private readonly ruleRepo: AuthorizationRuleRepository) {}

  addRule(input: {
    provider: string
    action: string
    scope: "thread" | "global"
    decision: "allow" | "deny"
    threadId?: string
    sessionGroupId?: string
    reason?: string
  }): AuthorizationRuleRow {
    return this.ruleRepo.add({ ...input, createdBy: "user" })
  }

  removeRule(ruleId: string): boolean {
    return this.ruleRepo.remove(ruleId)
  }

  match(
    provider: string,
    action: string,
    threadId: string,
  ): AuthorizationRuleRow | null {
    const rules = this.ruleRepo.listAll()
    let bestThread: AuthorizationRuleRow | null = null
    let bestGlobal: AuthorizationRuleRow | null = null

    for (const rule of rules) {
      const providerMatch = rule.provider === "*" || rule.provider === provider
      if (!providerMatch) continue
      if (!matchAction(rule.action, action)) continue

      if (rule.scope === "thread" && rule.thread_id === threadId) {
        if (!bestThread) bestThread = rule
      } else if (rule.scope === "global") {
        if (!bestGlobal) bestGlobal = rule
      }
    }
    return bestThread ?? bestGlobal ?? null
  }

  listRules(filter?: { provider?: string; threadId?: string }): AuthorizationRuleRow[] {
    return this.ruleRepo.list(filter)
  }
}
