import assert from "node:assert/strict"
import test from "node:test"
import { extractDecisionItems, extractWithdrawals } from "./aggregate-result"

// ── extractDecisionItems ────────────────────────────────────────────

test("extractDecisionItems: structured format with options", () => {
  const content = [
    "一些分析内容…",
    "",
    "[拍板] 默认折叠还是展开？",
    "  [A] 默认收起，节省空间",
    "  [B] 默认展开，避免遗漏",
    "",
    "后续讨论…",
  ].join("\n")

  const items = extractDecisionItems(content)
  assert.equal(items.length, 1)
  assert.equal(items[0].question, "默认折叠还是展开？")
  assert.deepEqual(items[0].options, ["默认收起，节省空间", "默认展开，避免遗漏"])
})

test("extractDecisionItems: simple format without options (backward compat)", () => {
  const content = "分析…\n[拍板] 需要确认是否删除旧接口\n后续…"
  const items = extractDecisionItems(content)
  assert.equal(items.length, 1)
  assert.equal(items[0].question, "需要确认是否删除旧接口")
  assert.deepEqual(items[0].options, [])
})

test("extractDecisionItems: multiple items each with options", () => {
  const content = [
    "[拍板] 问题一",
    "  [A] 选项 A1",
    "  [B] 选项 B1",
    "",
    "中间内容",
    "",
    "[拍板] 问题二",
    "  [A] 选项 A2",
    "  [B] 选项 B2",
    "  [C] 选项 C2",
  ].join("\n")

  const items = extractDecisionItems(content)
  assert.equal(items.length, 2)
  assert.equal(items[0].question, "问题一")
  assert.equal(items[0].options.length, 2)
  assert.equal(items[1].question, "问题二")
  assert.equal(items[1].options.length, 3)
})

test("extractDecisionItems: returns empty for content without markers", () => {
  const items = extractDecisionItems("普通内容，没有拍板标记")
  assert.equal(items.length, 0)
})

// ── extractWithdrawals ──────────────────────────────────────────────

test("extractWithdrawals parses single withdrawal marker", () => {
  const content = "我们讨论后发现\n[撤销拍板] 数据库选型\n这个问题已经有答案了"
  const result = extractWithdrawals(content)
  assert.deepEqual(result, ["数据库选型"])
})

test("extractWithdrawals returns multiple withdrawals in order", () => {
  const content = "[撤销拍板] 问题A\n中间文字\n[撤销拍板] 问题B"
  assert.deepEqual(extractWithdrawals(content), ["问题A", "问题B"])
})

test("extractWithdrawals ignores malformed markers", () => {
  const content = "[撤销拍板]\n空白行没有问题文本"
  assert.deepEqual(extractWithdrawals(content), [])
})
