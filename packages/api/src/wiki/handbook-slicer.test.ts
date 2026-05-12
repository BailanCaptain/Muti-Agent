/**
 * F027 P3.6 · handbook-slicer 单测
 * 真相源：docs/plans/V16.5-final.md chap 27
 * AC: AC-P1-6 第 1 项 —— sliceHandbookByH2() 返回 4 个独立切片
 *
 * 覆盖：
 *   - sliceHandbookByH2：4 切片各得其所 + 不串内容 + frontmatter 不归切片
 *   - sliceHandbookByH2：缺 H2 → throw HandbookSliceMissingError
 *   - sliceHandbookByH2：未识别 H2 段被跳过
 *   - sliceHandbookByH2：CRLF 兼容
 *   - loadHandbookSlices：repo wiki/rules/agent-wiki-handbook.md 4 切片全在
 *   - buildCompileLLMPrompt / buildSanitizeLLMPrompt：base + 切片拼接顺序
 *   - maybeInjectAgentHandbookSlice：first wakeup 注入 / 已注入 null
 */

import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {
  H2_TO_KEY,
  HANDBOOK_RELATIVE_PATH,
  HandbookFileMissingError,
  HandbookSliceMissingError,
  buildCompileLLMPrompt,
  buildSanitizeLLMPrompt,
  loadHandbookSlices,
  maybeInjectAgentHandbookSlice,
  sliceHandbookByH2,
} from "./handbook-slicer"

// 编译产物 dist/wiki/handbook-slicer.test.js → repoRoot 上 4 层
const REPO_ROOT = path.resolve(__dirname, "../../../..")

const MINIMAL_HANDBOOK = `---
title: stub
---

# Agent Wiki Handbook

intro

## 编译规则

### 分类标准

A
B

## Sanitize 规则

### 5 层流程

C

## Agent 动作手册

### 你与 wiki 的关系

D

## Dev / human 部分

### 设计决策历史

E
`

test("sliceHandbookByH2 · 4 个 H2 切片各拿到自己的内容", () => {
  const s = sliceHandbookByH2(MINIMAL_HANDBOOK)
  assert.match(s.compileRules, /## 编译规则/)
  assert.match(s.compileRules, /分类标准/)
  assert.match(s.compileRules, /A\nB/)
  assert.match(s.sanitizeRules, /## Sanitize 规则/)
  assert.match(s.sanitizeRules, /5 层流程/)
  assert.match(s.sanitizeRules, /C/)
  assert.match(s.agentActions, /## Agent 动作手册/)
  assert.match(s.agentActions, /你与 wiki 的关系/)
  assert.match(s.agentActions, /D/)
  assert.match(s.devHuman, /## Dev \/ human 部分/)
  assert.match(s.devHuman, /设计决策历史/)
  assert.match(s.devHuman, /E/)
})

test("sliceHandbookByH2 · 切片之间不串内容", () => {
  const s = sliceHandbookByH2(MINIMAL_HANDBOOK)
  assert.ok(!s.compileRules.includes("5 层流程"))
  assert.ok(!s.compileRules.includes("Agent 动作手册"))
  assert.ok(!s.sanitizeRules.includes("分类标准"))
  assert.ok(!s.agentActions.includes("分类标准"))
  assert.ok(!s.devHuman.includes("分类标准"))
})

test("sliceHandbookByH2 · frontmatter / 文件头介绍段不归任何切片", () => {
  const s = sliceHandbookByH2(MINIMAL_HANDBOOK)
  for (const slice of [s.compileRules, s.sanitizeRules, s.agentActions, s.devHuman]) {
    assert.ok(!slice.includes("title: stub"))
    assert.ok(!slice.includes("intro"))
    assert.ok(!slice.includes("# Agent Wiki Handbook"))
  }
})

test("sliceHandbookByH2 · 缺 H2 → throw HandbookSliceMissingError", () => {
  const broken = MINIMAL_HANDBOOK.replace("## 编译规则", "## 编译规则-typo")
  assert.throws(() => sliceHandbookByH2(broken), HandbookSliceMissingError)
  try {
    sliceHandbookByH2(broken)
    assert.fail("expected throw")
  } catch (e) {
    assert.ok(e instanceof HandbookSliceMissingError)
    assert.equal(e.missingKey, "compileRules")
  }
})

test("sliceHandbookByH2 · 未识别的 H2 段被跳过，不污染识别切片", () => {
  const withExtra = MINIMAL_HANDBOOK.replace(
    "## Dev / human 部分",
    "## 未来章节\n\nFUTURE\n\n## Dev / human 部分",
  )
  const s = sliceHandbookByH2(withExtra)
  assert.ok(!s.devHuman.includes("FUTURE"))
  assert.ok(!s.compileRules.includes("FUTURE"))
})

test("sliceHandbookByH2 · CRLF 行结尾兼容", () => {
  const crlf = MINIMAL_HANDBOOK.replace(/\n/g, "\r\n")
  const s = sliceHandbookByH2(crlf)
  assert.match(s.compileRules, /分类标准/)
  assert.match(s.sanitizeRules, /5 层流程/)
})

test("HANDBOOK_RELATIVE_PATH 指向 wiki/rules/agent-wiki-handbook.md", () => {
  assert.equal(HANDBOOK_RELATIVE_PATH, "wiki/rules/agent-wiki-handbook.md")
})

test("loadHandbookSlices · repo 真实 handbook 文件 4 切片全在", async () => {
  const slices = await loadHandbookSlices(REPO_ROOT)
  for (const key of Object.values(H2_TO_KEY)) {
    assert.ok(
      slices[key].length > 50,
      `slice ${key} too short: ${slices[key].length} chars`,
    )
  }
})

test("loadHandbookSlices · compileRules 切片含分类标准 / cross_refs / Dedup 阈值，不含 sanitize 内容", async () => {
  const slices = await loadHandbookSlices(REPO_ROOT)
  assert.match(slices.compileRules, /分类标准/)
  assert.match(slices.compileRules, /cross_refs/)
  assert.match(slices.compileRules, /Dedup 阈值/)
  assert.ok(!slices.compileRules.includes("5 层流程"))
})

test("loadHandbookSlices · sanitizeRules 切片含 5 层流程 / 红线触发条件", async () => {
  const slices = await loadHandbookSlices(REPO_ROOT)
  assert.match(slices.sanitizeRules, /5 层流程/)
  assert.match(slices.sanitizeRules, /红线触发条件/)
  assert.ok(!slices.sanitizeRules.includes("分类标准"))
})

test("loadHandbookSlices · agentActions 切片含「你与 wiki 的关系」+「不能做的」", async () => {
  const slices = await loadHandbookSlices(REPO_ROOT)
  assert.match(slices.agentActions, /你与 wiki 的关系/)
  assert.match(slices.agentActions, /你不能做的/)
})

test("loadHandbookSlices · devHuman 切片含设计决策历史 / Contributor Onboarding", async () => {
  const slices = await loadHandbookSlices(REPO_ROOT)
  assert.match(slices.devHuman, /设计决策历史/)
  assert.match(slices.devHuman, /Contributor Onboarding/)
})

test("buildCompileLLMPrompt · 拼 base + 编译规则切片，顺序固定", () => {
  const slices = sliceHandbookByH2(MINIMAL_HANDBOOK)
  const out = buildCompileLLMPrompt(slices, "BASE_COMPILE_SYS")
  assert.ok(out.startsWith("BASE_COMPILE_SYS\n\n# 编译规则（来自 handbook）\n\n## 编译规则"))
  assert.match(out, /分类标准/)
  assert.ok(!out.includes("5 层流程"))
})

test("buildSanitizeLLMPrompt · 拼 base + Sanitize 切片，顺序固定", () => {
  const slices = sliceHandbookByH2(MINIMAL_HANDBOOK)
  const out = buildSanitizeLLMPrompt(slices, "BASE_SANITIZE_SYS")
  assert.ok(
    out.startsWith("BASE_SANITIZE_SYS\n\n# Sanitize 规则（来自 handbook）\n\n## Sanitize 规则"),
  )
  assert.match(out, /5 层流程/)
  assert.ok(!out.includes("分类标准"))
})

test("maybeInjectAgentHandbookSlice · first wake-up → 返回 agentActions", () => {
  const slices = sliceHandbookByH2(MINIMAL_HANDBOOK)
  const out = maybeInjectAgentHandbookSlice(slices, { handbookSeen: false })
  assert.notEqual(out, null)
  assert.match(out!, /Agent 动作手册/)
})

test("maybeInjectAgentHandbookSlice · 已注入过 → null", () => {
  const slices = sliceHandbookByH2(MINIMAL_HANDBOOK)
  const out = maybeInjectAgentHandbookSlice(slices, { handbookSeen: true })
  assert.equal(out, null)
})

// ───── 范-r1 P3 防回归：runtime ENOENT 应抛友好错误，不是裸 ENOENT ─────
test("范-r1 P3 · loadHandbookSlices 文件不存在 → HandbookFileMissingError 含 wikiRoot + relPath", async () => {
  const fakeRoot = path.join(REPO_ROOT, ".no-such-wiki-root-for-test-xxxx")
  let caught: unknown = null
  try {
    await loadHandbookSlices(fakeRoot)
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof HandbookFileMissingError, `expected HandbookFileMissingError, got: ${(caught as Error)?.message}`)
  assert.match((caught as HandbookFileMissingError).message, /agent-wiki-handbook\.md/)
  assert.match((caught as HandbookFileMissingError).message, /no-such-wiki-root-for-test-xxxx/)
  assert.equal((caught as HandbookFileMissingError).wikiRoot, fakeRoot)
  assert.equal((caught as HandbookFileMissingError).relativePath, HANDBOOK_RELATIVE_PATH)
})
