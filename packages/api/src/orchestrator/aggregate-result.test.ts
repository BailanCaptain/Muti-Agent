import assert from "node:assert/strict"
import test from "node:test"
import type { Provider } from "@multi-agent/shared"
import {
  extractDecisionItems,
  extractWithdrawals,
  generateAggregatedResult,
  generatePhase2Result,
} from "./aggregate-result"

const ALIASES: Record<Provider, string> = {
  codex: "Coder",
  claude: "Reviewer",
  gemini: "Designer",
}

test("generateAggregatedResult renders all participants in provided order", () => {
  const markdown = generateAggregatedResult(
    {
      question: "要不要拆分 skill？",
      completedResults: new Map<Provider, { messageId: string; content: string }>([
        ["claude", { messageId: "m1", content: "支持拆分，因为职责分离" }],
        ["gemini", { messageId: "m2", content: "不必拆，加 trigger 即可" }],
      ]),
    },
    ALIASES,
  )

  assert.ok(markdown.includes("## 并行思考结果汇总"))
  assert.ok(markdown.includes("**问题**: 要不要拆分 skill？"))
  assert.ok(markdown.includes("### Reviewer"))
  assert.ok(markdown.includes("支持拆分，因为职责分离"))
  assert.ok(markdown.includes("### Designer"))
  assert.ok(markdown.includes("不必拆，加 trigger 即可"))
})

test("generateAggregatedResult omits question line when null", () => {
  const markdown = generateAggregatedResult(
    {
      question: null,
      completedResults: new Map<Provider, { messageId: string; content: string }>([
        ["claude", { messageId: "m1", content: "x" }],
      ]),
    },
    ALIASES,
  )
  assert.ok(markdown.includes("## 并行思考结果汇总"))
  assert.ok(!markdown.includes("**问题**"))
  assert.ok(markdown.includes("### Reviewer"))
  assert.ok(markdown.includes("x"))
})

test("generateAggregatedResult renders empty body for missing content", () => {
  const markdown = generateAggregatedResult(
    {
      question: "q",
      completedResults: new Map<Provider, { messageId: string; content: string }>([
        ["claude", { messageId: "m1", content: "" }],
      ]),
    },
    ALIASES,
  )
  assert.ok(markdown.includes("### Reviewer"))
  assert.ok(markdown.includes("(空回答)"))
})

test("generatePhase2Result groups replies by round with section headers", () => {
  const markdown = generatePhase2Result(
    [
      { round: 1, provider: "claude", messageId: "m1", content: "同意拆分" },
      { round: 1, provider: "gemini", messageId: "m2", content: "reconsidering" },
      { round: 2, provider: "claude", messageId: "m3", content: "保留意见" },
    ],
    ALIASES,
  )
  assert.ok(markdown.includes("## 串行讨论记录（Phase 2）"))
  assert.ok(markdown.includes("### 第 1 轮"))
  assert.ok(markdown.includes("### 第 2 轮"))
  assert.ok(markdown.includes("**Reviewer**"))
  assert.ok(markdown.includes("同意拆分"))
  assert.ok(markdown.includes("reconsidering"))
  assert.ok(markdown.includes("保留意见"))
})

test("generatePhase2Result handles empty replies gracefully", () => {
  const markdown = generatePhase2Result([], ALIASES)
  assert.ok(markdown.includes("(无讨论记录)"))
})

test("generateAggregatedResult preserves timeout placeholder content", () => {
  const markdown = generateAggregatedResult(
    {
      question: "q",
      completedResults: new Map<Provider, { messageId: string; content: string }>([
        ["claude", { messageId: "m1", content: "thoughtful reply" }],
        ["gemini", { messageId: "", content: "[timeout: gemini 未在 8 分钟内响应]" }],
      ]),
    },
    ALIASES,
  )
  assert.ok(markdown.includes("[timeout: gemini"))
  assert.ok(markdown.includes("thoughtful reply"))
})

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
