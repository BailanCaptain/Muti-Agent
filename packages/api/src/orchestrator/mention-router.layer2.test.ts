import assert from "node:assert/strict"
import test from "node:test"
import { classifyMention, resolveMentionsClassified } from "./mention-router"
import type { ProviderAliases } from "./mention-router"

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

// F026 ADR-003 Layer 2 — hard-positive
// 要求: (1) 行首 @X  (2) 指令/请求语义（动词 or 问句 or 任务描述）

test("L2 hard-pos: 行首 @X + 动词『看』→ classify=dispatch", () => {
  const text = "@范德彪 看一下这个 PR"
  const mentions = resolveMentionsClassified(text, aliases)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].classification, "dispatch")
  assert.equal(mentions[0].provider, "codex")
})

test("L2 hard-pos: 行首 @X + 动词『帮』→ classify=dispatch", () => {
  const text = "@桂芬 帮我设计一下 UI"
  const mentions = resolveMentionsClassified(text, aliases)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].classification, "dispatch")
})

test("L2 hard-pos: 行首 @X + 动词『做/写/review/检查/实现』→ classify=dispatch", () => {
  for (const verb of ["做", "写", "review", "检查", "实现"]) {
    const text = `@范德彪 ${verb} 一个登录页面`
    const mentions = resolveMentionsClassified(text, aliases)
    assert.equal(mentions.length, 1, `verb=${verb}`)
    assert.equal(mentions[0].classification, "dispatch", `verb=${verb}`)
  }
})

test("L2 hard-pos: 行首 @X + 问号 → classify=dispatch", () => {
  const text = "@范德彪 你觉得这个方案 ok 吗？"
  const mentions = resolveMentionsClassified(text, aliases)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].classification, "dispatch")
})

test("L2 hard-pos: 行首 @X 英文问号 → classify=dispatch", () => {
  const text = "@桂芬 what do you think?"
  const mentions = resolveMentionsClassified(text, aliases)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].classification, "dispatch")
})

test("L2 hard-pos: 行首 @X + 任务名词片段 → classify=dispatch", () => {
  const text = "@范德彪 这个 bug 的修复方案"
  const mentions = resolveMentionsClassified(text, aliases)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].classification, "dispatch")
})

// --- Non-positive cases: should be gray-zone (Layer 3) not dispatch ---

test("L2 boundary: 非行首 @X → 不是 hard-positive（落入 Layer 3 gray）", () => {
  const text = "我刚才问 @范德彪 的意思是……"
  const mentions = resolveMentionsClassified(text, aliases)
  // 非行首 → 既非 Layer 1 hard-neg 也非 Layer 2 hard-pos → gray-zone 默认不派发
  assert.ok(mentions.every((m) => m.classification !== "dispatch"))
})

test("L2 boundary: 行首 @X 但无动作语义 → classification 为 gray", () => {
  const text = "@范德彪" // 孤零零一个 @X
  const mentions = resolveMentionsClassified(text, aliases)
  assert.equal(mentions.length, 1)
  assert.equal(mentions[0].classification, "gray")
})

// --- classifyMention direct unit tests ---

test("L2 classifyMention: hard-positive 行首 @X 动词", () => {
  assert.equal(classifyMention("@范德彪 帮我检查", 0, 4), "dispatch")
})

test("L2 classifyMention: gray-zone 行首 @X 无动作", () => {
  assert.equal(classifyMention("@范德彪", 0, 4), "gray")
})

test("L2 classifyMention: gray-zone 非行首 @X", () => {
  assert.equal(classifyMention("然后 @范德彪 帮忙检查", 3, 7), "gray")
})
