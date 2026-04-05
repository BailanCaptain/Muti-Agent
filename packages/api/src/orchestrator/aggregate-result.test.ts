import assert from "node:assert/strict"
import test from "node:test"
import type { Provider } from "@multi-agent/shared"
import { generateAggregatedResult, generatePhase2Result } from "./aggregate-result"

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
