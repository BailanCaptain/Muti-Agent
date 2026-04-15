import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createDrizzleDb } from "../db/drizzle-instance"
import { AuthorizationRuleRepository } from "../db/repositories"
import { AuthorizationRuleStore } from "./authorization-rule-store"

describe("AuthorizationRuleStore", () => {
  let store: AuthorizationRuleStore

  beforeEach(() => {
    const { db } = createDrizzleDb(":memory:")
    const repo = new AuthorizationRuleRepository(db)
    store = new AuthorizationRuleStore(repo)
  })

  it("exact match: 'npm test' matches 'npm test'", () => {
    store.addRule({ provider: "codex", action: "npm test", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "allow")
  })

  it("glob match: 'npm *' matches 'npm test' and 'npm install'", () => {
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "allow")
    assert.equal(store.match("codex", "npm install", "t1")?.decision, "allow")
  })

  it("wildcard '*' matches everything", () => {
    store.addRule({ provider: "*", action: "*", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "anything", "t1")?.decision, "allow")
    assert.equal(store.match("claude", "edit_file", "t2")?.decision, "allow")
  })

  it("thread-scoped rule takes precedence over global", () => {
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    store.addRule({
      provider: "codex", action: "npm *", scope: "thread", decision: "deny", threadId: "t1",
    })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "deny")
    assert.equal(store.match("codex", "npm test", "t2")?.decision, "allow")
  })

  it("no match returns null", () => {
    assert.equal(store.match("codex", "unknown", "t1"), null)
  })

  it("later rule wins within same scope", () => {
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "deny" })
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "allow")
  })

  it("provider '*' matches any provider", () => {
    store.addRule({ provider: "*", action: "run_command", scope: "global", decision: "deny" })
    assert.equal(store.match("codex", "run_command", "t1")?.decision, "deny")
    assert.equal(store.match("gemini", "run_command", "t1")?.decision, "deny")
  })

  it("removeRule deletes a rule", () => {
    const rule = store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    assert.equal(store.match("codex", "npm test", "t1")?.decision, "allow")
    store.removeRule(rule.id)
    assert.equal(store.match("codex", "npm test", "t1"), null)
  })

  it("listRules returns all rules", () => {
    store.addRule({ provider: "codex", action: "npm *", scope: "global", decision: "allow" })
    store.addRule({ provider: "claude", action: "edit_file", scope: "thread", decision: "deny", threadId: "t1" })
    const rules = store.listRules()
    assert.equal(rules.length, 2)
  })
})
