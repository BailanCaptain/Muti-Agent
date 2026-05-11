/**
 * F027 P10 · 防漂桶 lint 单测（pure-function tests，不需 DB）。
 * 真相源：docs/plans/V16.5-final.md chap 14（5 防漂桶规则）
 *
 * 覆盖：
 *   - R1 同 canonical_owner_path 多 canonical → red
 *   - R3 supersedes 链含 DB 中不存在的 path → red
 *   - R4 ttl 过期 + state ≠ deprecated → yellow（注 now 防 flaky）
 *   - R-T canonical_owner_path 与 type 不匹配 → red
 *   - 全绿 fixture：lint 0 finding
 *   - groupBySeverity 分桶
 */

import assert from "node:assert/strict"
import test from "node:test"

import { groupBySeverity, lintWikiMemories } from "./wiki-memories-lint"
import type { WikiMemory, WikiMemoryState, WikiMemoryType } from "./wiki-memories-types"

let nextId = 1
function mem(over: Partial<WikiMemory> = {}): WikiMemory {
  const id = nextId++
  const type: WikiMemoryType = over.type ?? "project"
  return {
    id,
    type,
    name: over.name ?? `n-${id}`,
    canonicalOwnerPath: over.canonicalOwnerPath ?? `wiki/${type}/p-${id}.md`,
    promotionTarget: over.promotionTarget ?? null,
    ttlDays: over.ttlDays ?? null,
    supersedes: over.supersedes ?? null,
    replacesInBuckets: over.replacesInBuckets ?? null,
    sourceMessageIds: over.sourceMessageIds ?? null,
    contributedBy: over.contributedBy ?? ["黄仁勋"],
    crossRefs: over.crossRefs ?? null,
    dedupDecision: over.dedupDecision ?? null,
    body: over.body ?? "body",
    state: (over.state ?? "canonical") as WikiMemoryState,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00Z",
  }
}

test("F027 P10 lint: 全绿 fixture（5 type 各 1 row, state=canonical, 路由对, 无 ttl）→ 0 finding", () => {
  const memories = (["room", "project", "user", "feedback", "work"] as const).map((t) =>
    mem({ type: t, canonicalOwnerPath: `wiki/${t}/x.md`, state: "canonical" }),
  )
  const findings = lintWikiMemories(memories)
  assert.equal(findings.length, 0)
})

test("F027 P10 lint R1: 同 canonical_owner_path 2 个 canonical → 2 red findings", () => {
  const memories = [
    mem({ canonicalOwnerPath: "wiki/project/dup.md", state: "canonical" }),
    mem({ canonicalOwnerPath: "wiki/project/dup.md", state: "canonical" }),
  ]
  const findings = lintWikiMemories(memories)
  assert.equal(findings.length, 2)
  for (const f of findings) {
    assert.equal(f.rule, "R1-duplicate-canonical")
    assert.equal(f.severity, "red")
    assert.equal(f.canonicalOwnerPath, "wiki/project/dup.md")
  }
})

test("F027 P10 lint R1: deprecated/draft 不计入重复（只 canonical 互冲突）", () => {
  const memories = [
    mem({ canonicalOwnerPath: "wiki/project/x.md", state: "deprecated" }),
    mem({ canonicalOwnerPath: "wiki/project/x.md", state: "draft" }),
    mem({ canonicalOwnerPath: "wiki/project/x.md", state: "canonical" }),
  ]
  const findings = lintWikiMemories(memories)
  assert.equal(findings.filter((f) => f.rule === "R1-duplicate-canonical").length, 0)
})

test("F027 P10 lint R3: supersedes 含 DB 不存在的 path → red", () => {
  const memories = [
    mem({
      canonicalOwnerPath: "wiki/project/new.md",
      supersedes: ["wiki/project/old.md", "wiki/project/missing.md"],
    }),
    mem({ canonicalOwnerPath: "wiki/project/old.md" }), // missing.md 没入库
  ]
  const findings = lintWikiMemories(memories)
  const r3 = findings.filter((f) => f.rule === "R3-dead-supersedes")
  assert.equal(r3.length, 1)
  assert.equal(r3[0].severity, "red")
  assert.match(r3[0].message, /missing\.md/)
  assert.doesNotMatch(r3[0].message, /old\.md/)
})

test("F027 P10 lint R3: 全部 supersedes 都在 DB → 不报", () => {
  const memories = [
    mem({ canonicalOwnerPath: "wiki/project/new.md", supersedes: ["wiki/project/old.md"] }),
    mem({ canonicalOwnerPath: "wiki/project/old.md" }),
  ]
  const r3 = lintWikiMemories(memories).filter((f) => f.rule === "R3-dead-supersedes")
  assert.equal(r3.length, 0)
})

test("F027 P10 lint R4: ttl 过期 + state≠deprecated → yellow", () => {
  // created_at = 2026-01-01, ttl=30, now=2026-03-01 → 过期
  const expired = mem({
    canonicalOwnerPath: "wiki/feedback/expired.md",
    type: "feedback",
    ttlDays: 30,
    state: "canonical",
    createdAt: "2026-01-01T00:00:00Z",
  })
  // 同样过期但 state=deprecated → 不报（已归档）
  const archived = mem({
    canonicalOwnerPath: "wiki/feedback/done.md",
    type: "feedback",
    ttlDays: 30,
    state: "deprecated",
    createdAt: "2026-01-01T00:00:00Z",
  })
  // 没 ttl → 永久 → 不报
  const eternal = mem({
    canonicalOwnerPath: "wiki/project/eternal.md",
    state: "canonical",
    createdAt: "2026-01-01T00:00:00Z",
    ttlDays: null,
  })

  const findings = lintWikiMemories([expired, archived, eternal], {
    now: new Date("2026-03-01T00:00:00Z"),
  })
  const r4 = findings.filter((f) => f.rule === "R4-ttl-expired")
  assert.equal(r4.length, 1)
  assert.equal(r4[0].severity, "yellow")
  assert.equal(r4[0].memoryId, expired.id)
})

test("F027 P10 lint R4: ttl 未过期 → 不报", () => {
  const fresh = mem({
    canonicalOwnerPath: "wiki/feedback/fresh.md",
    type: "feedback",
    ttlDays: 30,
    state: "canonical",
    createdAt: "2026-01-01T00:00:00Z",
  })
  const findings = lintWikiMemories([fresh], { now: new Date("2026-01-15T00:00:00Z") })
  assert.equal(findings.filter((f) => f.rule === "R4-ttl-expired").length, 0)
})

test("F027 P10 lint R-T: canonical_owner_path 前缀与 type 不匹配 → red", () => {
  // 通过 mem helper 强制路由错（绕过 repo 写时校验，模拟手工 INSERT 漏拦）
  const drift = mem({
    type: "project",
    canonicalOwnerPath: "wiki/user/drifted.md", // type=project 但 path 在 user/ 下
    state: "canonical",
  })
  const findings = lintWikiMemories([drift])
  const rt = findings.filter((f) => f.rule === "R-type-routed-prefix")
  assert.equal(rt.length, 1)
  assert.equal(rt[0].severity, "red")
  assert.match(rt[0].message, /wiki\/project\//)
})

test("F027 P10 lint: groupBySeverity 分 red / yellow", () => {
  const memories = [
    mem({ canonicalOwnerPath: "wiki/project/dup.md", state: "canonical" }),
    mem({ canonicalOwnerPath: "wiki/project/dup.md", state: "canonical" }), // R1 red x2
    mem({
      type: "feedback",
      canonicalOwnerPath: "wiki/feedback/old.md",
      ttlDays: 30,
      state: "canonical",
      createdAt: "2026-01-01T00:00:00Z",
    }), // R4 yellow
  ]
  const findings = lintWikiMemories(memories, { now: new Date("2026-03-01T00:00:00Z") })
  const grouped = groupBySeverity(findings)
  assert.equal(grouped.red.length, 2)
  assert.equal(grouped.yellow.length, 1)
})
