/**
 * F027 P3 · ACL Engine 单测
 * 真相源：docs/plans/V16.5-final.md chap 6（ACL 优先级规范 + 6 条匹配规则）
 *
 * 覆盖：
 *   - loadACLConfig：合法 yaml + 缺字段 / 错 action / 非 array
 *   - decide：no_match（白名单 deny）
 *   - decide：most-specific 优先（draft/** 优先于 concepts/**）
 *   - decide：alias 不允许 / action 不允许 各自路径
 *   - decide：<self> 模板正确 + 不匹配
 *   - decide：<other> 不允许 self
 *   - decide：<any-agent> 排除 system-auto-*
 *   - decide：服务身份 system-auto-X exact match
 *   - decide：tied + inconsistent → ambiguous deny
 *   - decide：写禁区（allowed_aliases=[]）任何 caller 都 deny
 *   - lintACL：universe 枚举抓 ambiguity
 *   - lintACL：清理 config 无 conflicts
 */

import assert from "node:assert/strict"
import test from "node:test"
import { compileACL, decide, lintACL, loadACLConfig } from "./acl-engine"
import { ACLConfigInvalidError, type ACLContext, type WikiAction } from "./acl-types"

const SAMPLE_YAML = `
acl:
  - path_pattern: 'wiki/rules/**'
    allowed_aliases: ['小孙']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/people/<self>.md'
    allowed_aliases: ['<self>']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/people/<other>.md'
    allowed_aliases: ['小孙']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/concepts/draft/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write, patch, demote]

  - path_pattern: 'wiki/concepts/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write, patch]

  - path_pattern: 'wiki/rooms/<roomId>/decisions.md'
    allowed_aliases: ['system-auto-room-compiler']
    allowed_actions: [append]

  - path_pattern: 'wiki/index.md'
    allowed_aliases: []
    notes: '派生视图，由 WikiCompiler 生成'

  - path_pattern: 'wiki/sources.md'
    allowed_aliases: []
`

function ctx(alias: string, isService = false): ACLContext {
  return { alias, isServiceIdentity: isService }
}

function build() {
  return compileACL(loadACLConfig(SAMPLE_YAML))
}

test("F027 P3 loadACLConfig 解析合法 yaml", () => {
  const cfg = loadACLConfig(SAMPLE_YAML)
  assert.equal(cfg.acl.length, 8)
  assert.equal(cfg.acl[0].pathPattern, "wiki/rules/**")
  assert.deepEqual(cfg.acl[0].allowedAliases, ["小孙"])
})

test("F027 P3 loadACLConfig 缺 path_pattern → invalid", () => {
  const bad = `acl:\n  - allowed_aliases: ['x']\n    allowed_actions: [write]\n`
  assert.throws(() => loadACLConfig(bad), ACLConfigInvalidError)
})

test("F027 P3 loadACLConfig 未知 action → invalid", () => {
  const bad = `acl:\n  - path_pattern: 'wiki/x'\n    allowed_aliases: ['x']\n    allowed_actions: [explode]\n`
  assert.throws(() => loadACLConfig(bad), ACLConfigInvalidError)
})

test("F027 P3 loadACLConfig 顶层非 array → invalid", () => {
  assert.throws(() => loadACLConfig("acl: not-an-array"), ACLConfigInvalidError)
})

test("F027 P3 decide：no_match 时白名单 deny", () => {
  const c = build()
  const d = decide(c, ctx("小孙"), "wiki/raw/never-defined.md", "write")
  assert.equal(d.allowed, false)
  assert.equal(d.reason, "no_match")
})

test("F027 P3 decide：rules/** 仅小孙可 write，范德彪 deny", () => {
  const c = build()
  assert.equal(decide(c, ctx("小孙"), "wiki/rules/iron-laws.md", "write").allowed, true)
  const d = decide(c, ctx("范德彪"), "wiki/rules/iron-laws.md", "write")
  assert.equal(d.allowed, false)
  assert.equal(d.reason, "alias_not_allowed")
})

test("F027 P3 decide：rules/** 小孙也不能 demote（action 白名单外）", () => {
  const c = build()
  const d = decide(c, ctx("小孙"), "wiki/rules/iron-laws.md", "demote")
  assert.equal(d.allowed, false)
  assert.equal(d.reason, "action_not_allowed")
})

test("F027 P3 decide：concepts/draft/** 比 concepts/** 更 specific", () => {
  const c = build()
  // draft 路径下任意 agent 可 demote（draft/** 规则允许）
  const draftDemote = decide(c, ctx("范德彪"), "wiki/concepts/draft/foo.md", "demote")
  assert.equal(draftDemote.allowed, true)
  assert.equal(draftDemote.matchedPattern, "wiki/concepts/draft/**")
  // 非 draft 路径 demote 应被拒（concepts/** 规则不含 demote）
  const nonDraftDemote = decide(c, ctx("范德彪"), "wiki/concepts/foo.md", "demote")
  assert.equal(nonDraftDemote.allowed, false)
  assert.equal(nonDraftDemote.reason, "action_not_allowed")
  assert.equal(nonDraftDemote.matchedPattern, "wiki/concepts/**")
})

test("F027 P3 decide：<self> 模板 — agent 写自己 page 通过", () => {
  const c = build()
  const d = decide(c, ctx("范德彪"), "wiki/people/范德彪.md", "write")
  assert.equal(d.allowed, true)
})

test("F027 P3 decide：<self> 模板 — agent 不能写他人 page", () => {
  const c = build()
  // 黄仁勋 写 范德彪.md：<self> 解出 '范德彪' ≠ caller '黄仁勋'
  // people/<other>.md 规则只允许小孙
  const d = decide(c, ctx("黄仁勋"), "wiki/people/范德彪.md", "write")
  assert.equal(d.allowed, false)
})

test("F027 P3 decide：<self> 模板 — 小孙作为 <other> 走 <other> 规则可写", () => {
  const c = build()
  // 小孙 写 范德彪.md：<self> 不匹配（caller=小孙 ≠ 范德彪），但 <other> 规则允许小孙
  const d = decide(c, ctx("小孙"), "wiki/people/范德彪.md", "write")
  assert.equal(d.allowed, true)
})

test("F027 P3 decide：<any-agent> 排除 service identity", () => {
  const c = build()
  // 普通 agent 通过
  assert.equal(decide(c, ctx("范德彪"), "wiki/concepts/foo.md", "write").allowed, true)
  // service identity 不算 agent，no_match 走到（concepts/** 规则只允许 <any-agent>）
  const d = decide(c, ctx("system-auto-room-compiler", true), "wiki/concepts/foo.md", "write")
  assert.equal(d.allowed, false)
})

test("F027 P3 decide：service identity exact match 通过", () => {
  const c = build()
  const d = decide(
    c,
    ctx("system-auto-room-compiler", true),
    "wiki/rooms/R-001/decisions.md",
    "append",
  )
  assert.equal(d.allowed, true)
})

test("F027 P3 decide：派生视图 wiki/index.md 任何人都不能写", () => {
  const c = build()
  for (const alias of ["小孙", "黄仁勋", "范德彪"]) {
    const d = decide(c, ctx(alias), "wiki/index.md", "write")
    assert.equal(d.allowed, false, `${alias} should be denied`)
  }
})

test("F027 P3 decide：tied 集合 OR-union（任一 rule 允许即通过）", () => {
  const tied = `
acl:
  - path_pattern: 'wiki/foo/<x>.md'
    allowed_aliases: ['小孙']
    allowed_actions: [write]
  - path_pattern: 'wiki/foo/<y>.md'
    allowed_aliases: ['范德彪']
    allowed_actions: [write]
`
  const c = compileACL(loadACLConfig(tied))
  // 同 specificity 两条 rule，分别允许不同 alias —— union 模型下两个 caller 都通过
  assert.equal(decide(c, ctx("小孙"), "wiki/foo/bar.md", "write").allowed, true)
  assert.equal(decide(c, ctx("范德彪"), "wiki/foo/bar.md", "write").allowed, true)
  assert.equal(decide(c, ctx("黄仁勋"), "wiki/foo/bar.md", "write").allowed, false)
})

test("F027 P3 lintACL：清理 config 全 rule 都 reachable", () => {
  const c = build()
  const report = lintACL(c, {
    aliases: [
      { alias: "小孙", isServiceIdentity: false },
      { alias: "黄仁勋", isServiceIdentity: false },
      { alias: "范德彪", isServiceIdentity: false },
      { alias: "system-auto-room-compiler", isServiceIdentity: true },
    ],
    paths: [
      "wiki/rules/iron-laws.md",
      "wiki/people/范德彪.md",
      "wiki/concepts/draft/foo.md",
      "wiki/concepts/foo.md",
      "wiki/rooms/R-001/decisions.md",
      "wiki/index.md",
      "wiki/sources.md",
    ],
  })
  assert.equal(
    report.unreachableRules.length,
    0,
    `expected 0 unreachable, got ${JSON.stringify(report.unreachableRules)}`,
  )
})

test("F027 P3 lintACL：抓 unreachable rule（universe 无 path 命中其 specificity）", () => {
  const partial = `
acl:
  - path_pattern: 'wiki/concepts/draft/**'
    allowed_aliases: ['<any-agent>']
    allowed_actions: [write]
  - path_pattern: 'wiki/dead-zone/**'
    allowed_aliases: ['小孙']
    allowed_actions: [write]
`
  const c = compileACL(loadACLConfig(partial))
  // universe 只覆盖 concepts/draft/，dead-zone 永远 unreachable
  const report = lintACL(c, {
    aliases: [{ alias: "小孙", isServiceIdentity: false }],
    paths: ["wiki/concepts/draft/foo.md"],
    actions: ["write"],
  })
  assert.equal(report.unreachableRules.length, 1)
  assert.equal(report.unreachableRules[0].pathPattern, "wiki/dead-zone/**")
})
