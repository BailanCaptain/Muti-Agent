/**
 * F027 P3.6 · cross-file dedupe lint 单测
 * 真相源：docs/plans/V16.5-final.md chap 27.0
 * AC: AC-P1-6 第 2/3 项 —— 红样例 lint 红灯 / 绿样例 lint 绿灯
 *
 * 覆盖：
 *   - 标题级显式重叠 → red
 *   - 用 cross-ref 取代 → green
 *   - 无重叠 → 无 finding
 *   - 真实 fixture：red-handbook-adds-at-rule.md / green-cross-ref-only.md vs shared-rules.md
 *   - 真实 fixture：当前 handbook vs 当前 shared-rules.md = 0 red（基线门禁）
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import test from "node:test"
import {
  type CrossFileLintFinding,
  getRedFindings,
  lintCrossFileDedupe,
} from "./cross-file-dedupe-lint"

const REPO_ROOT = path.resolve(__dirname, "../../../..")
const SHARED_RULES_PATH = path.join(REPO_ROOT, "multi-agent-skills/refs/shared-rules.md")
const HANDBOOK_PATH = path.join(REPO_ROOT, "wiki/rules/agent-wiki-handbook.md")
const FIXTURE_RED = path.join(REPO_ROOT, "tests/fixtures/lint/red-handbook-adds-at-rule.md")
const FIXTURE_GREEN = path.join(REPO_ROOT, "tests/fixtures/lint/green-cross-ref-only.md")

function readFile(p: string): { path: string; content: string } {
  return { path: p, content: readFileSync(p, "utf-8") }
}

function findingsBetween(
  findings: CrossFileLintFinding[],
  sectionA: RegExp,
  sectionB: RegExp,
): CrossFileLintFinding[] {
  return findings.filter((f) => sectionA.test(f.sectionA) && sectionB.test(f.sectionB))
}

// ───────────── 内联单测：min reproducible cases ─────────────

test("lint · 同名 H3 标题 + 长 body 复制 → red", () => {
  const a = {
    path: "fileA.md",
    content: "# A\n\n## 协作\n\n### @ 规则\n\n派发用 [Call: @人名] 标签。@ 用真实人名。\n\n详细一点的内容。\n",
  }
  const b = {
    path: "fileB.md",
    content: "# B\n\n## 协作\n\n### @ 规则\n\n派发用 [Call: @人名] 标签。@ 用真实人名。\n\n详细一点的内容。\n",
  }
  const findings = lintCrossFileDedupe(a, b)
  const reds = findings.filter((f) => f.severity === "red")
  assert.ok(reds.length >= 1, `expected red, got: ${JSON.stringify(findings)}`)
  // 标题完全相同 → jaccard = 1
  assert.ok(reds.some((f) => f.sectionA === "@ 规则" && f.sectionB === "@ 规则"))
})

test("lint · 同名 H3 + body 用 cross-ref [otherFile.md → green", () => {
  const a = {
    path: "fileA.md",
    content: "# A\n\n## 协作\n\n### @ 规则\n\n详见 [fileB.md § @ 规则](#anchor)，本文件不重复。\n",
  }
  const b = {
    path: "fileB.md",
    content: "# B\n\n## 协作\n\n### @ 规则\n\n派发用 [Call: @人名] 标签。@ 用真实人名。详细内容。\n",
  }
  const findings = lintCrossFileDedupe(a, b)
  const reds = findings.filter((f) => f.severity === "red")
  assert.equal(reds.length, 0, `expected 0 red, got: ${JSON.stringify(findings)}`)
  const greens = findings.filter((f) => f.severity === "green")
  assert.ok(greens.length >= 1)
})

test("lint · 完全无重叠 → 无 finding", () => {
  const a = {
    path: "fileA.md",
    content: "# A\n\n## 编译规则\n\n### 分类标准\n\nfoo\n",
  }
  const b = {
    path: "fileB.md",
    content: "# B\n\n## 协作\n\n### @ 规则\n\nbar\n",
  }
  const findings = lintCrossFileDedupe(a, b)
  assert.equal(findings.length, 0)
})

test("lint · H4+ 默认不开新 section（不污染 H2/H3 级别 lint）", () => {
  const a = {
    path: "fileA.md",
    content: "# A\n\n## 编译规则\n\n#### 分类标准\n\nfoo\n",
  }
  const b = {
    path: "fileB.md",
    content: "# B\n\n## Sanitize\n\n#### 分类标准\n\nbar\n",
  }
  const findings = lintCrossFileDedupe(a, b)
  // H4 同名不应触发，H2 不同名也不触发
  assert.equal(findings.length, 0)
})

test("lint · jaccardThreshold 可调（threshold=0.9 时部分重叠不触发）", () => {
  const a = {
    path: "fileA.md",
    content: "## 编译规则 分类\n\nfoo\n",
  }
  const b = {
    path: "fileB.md",
    content: "## 编译规则 标准\n\nbar\n",
  }
  // token "编译规则" 重叠，1 token shared / 3 union → jaccard ≈ 0.33
  const lowThreshold = lintCrossFileDedupe(a, b, { jaccardThreshold: 0.3 })
  const highThreshold = lintCrossFileDedupe(a, b, { jaccardThreshold: 0.9 })
  assert.ok(lowThreshold.length >= 1)
  assert.equal(highThreshold.length, 0)
})

test("lint · frontmatter 不算 section（不出 finding）", () => {
  const a = {
    path: "fileA.md",
    content: "---\ntitle: foo\n---\n\n## 协作\n\nbody\n",
  }
  const b = {
    path: "fileB.md",
    content: "---\ntitle: bar\n---\n\n## 协作\n\nbody\n",
  }
  const findings = lintCrossFileDedupe(a, b)
  // 只应该报 ## 协作 重叠，不应该报 frontmatter
  assert.ok(findings.every((f) => f.sectionA !== "title" && f.sectionA !== "frontmatter"))
  assert.ok(findings.some((f) => f.sectionA === "协作"))
})

// ───────────── 真实 fixture 验收（AC-P1-6 第 2/3 项）─────────────

test("AC-P1-6 红样例 · red-handbook-adds-at-rule.md vs shared-rules.md → ≥1 red", () => {
  const handbook = readFile(FIXTURE_RED)
  const sharedRules = readFile(SHARED_RULES_PATH)
  const reds = getRedFindings(handbook, sharedRules)
  assert.ok(
    reds.length >= 1,
    `expected ≥1 red finding, got 0. all findings: ${JSON.stringify(
      lintCrossFileDedupe(handbook, sharedRules),
      null,
      2,
    )}`,
  )
  // 标题相关字眼应在 finding 里
  const offending = reds.find(
    (f) => /协作/.test(f.sectionA) || /@/.test(f.sectionA) || /协作/.test(f.sectionB),
  )
  assert.ok(
    offending,
    `expected finding to involve 协作/@ section, got: ${JSON.stringify(reds, null, 2)}`,
  )
})

test("AC-P1-6 绿样例 · green-cross-ref-only.md vs shared-rules.md → 0 red", () => {
  const handbook = readFile(FIXTURE_GREEN)
  const sharedRules = readFile(SHARED_RULES_PATH)
  const reds = getRedFindings(handbook, sharedRules)
  assert.equal(
    reds.length,
    0,
    `expected 0 red, got: ${JSON.stringify(reds, null, 2)}`,
  )
  // 至少一条 green finding（标题重叠 + 已用 cross-ref）
  const all = lintCrossFileDedupe(handbook, sharedRules)
  const greens = all.filter((f) => f.severity === "green")
  assert.ok(
    greens.length >= 1,
    `expected ≥1 green finding (heading overlap + cross-ref), got: ${JSON.stringify(all, null, 2)}`,
  )
})

test("基线门禁 · 当前 handbook vs 当前 shared-rules.md → 0 red", () => {
  const handbook = readFile(HANDBOOK_PATH)
  const sharedRules = readFile(SHARED_RULES_PATH)
  const reds = getRedFindings(handbook, sharedRules)
  assert.equal(
    reds.length,
    0,
    `当前 wiki/rules/agent-wiki-handbook.md 与 shared-rules.md 已发生 cross-file 重叠：\n${JSON.stringify(
      reds,
      null,
      2,
    )}`,
  )
})
