import assert from "node:assert/strict"
import test from "node:test"
import { buildPhase2Turn } from "./phase2-header"

const aliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
} as const

test("buildPhase2Turn includes round info and agent alias", () => {
  const prompt = buildPhase2Turn({
    agentAlias: "黄仁勋",
    round: 1,
    totalRounds: 2,
    phase1Aggregate: "## 汇总\n内容",
    priorReplies: [],
    aliases,
  })
  assert.match(prompt, /Phase 2 · 第 1\/2 轮/)
  assert.match(prompt, /你是 黄仁勋/)
})

test("buildPhase2Turn embeds phase1 aggregate", () => {
  const prompt = buildPhase2Turn({
    agentAlias: "黄仁勋",
    round: 1,
    totalRounds: 2,
    phase1Aggregate: "## 并行思考结果汇总\n\n### 范德彪\n建议 A",
    priorReplies: [],
    aliases,
  })
  assert.match(prompt, /## 并行思考结果汇总/)
  assert.match(prompt, /建议 A/)
})

test("buildPhase2Turn has no phase2 section when priorReplies empty", () => {
  const prompt = buildPhase2Turn({
    agentAlias: "黄仁勋",
    round: 1,
    totalRounds: 2,
    phase1Aggregate: "agg",
    priorReplies: [],
    aliases,
  })
  assert.doesNotMatch(prompt, /Phase 2 讨论记录/)
})

test("buildPhase2Turn lists priorReplies with round + alias", () => {
  const prompt = buildPhase2Turn({
    agentAlias: "桂芬",
    round: 2,
    totalRounds: 2,
    phase1Aggregate: "agg",
    priorReplies: [
      { round: 1, provider: "claude", messageId: "m1", content: "同意 A" },
      { round: 1, provider: "codex", messageId: "m2", content: "反对 A" },
      { round: 1, provider: "gemini", messageId: "m3", content: "保留意见" },
      { round: 2, provider: "claude", messageId: "m4", content: "更新立场" },
    ],
    aliases,
  })
  assert.match(prompt, /Phase 2 讨论记录/)
  assert.match(prompt, /\[第 1 轮 · 黄仁勋\]: 同意 A/)
  assert.match(prompt, /\[第 1 轮 · 范德彪\]: 反对 A/)
  assert.match(prompt, /\[第 2 轮 · 黄仁勋\]: 更新立场/)
})

test("buildPhase2Turn ends with the current agent's turn marker", () => {
  const prompt = buildPhase2Turn({
    agentAlias: "桂芬",
    round: 2,
    totalRounds: 2,
    phase1Aggregate: "agg",
    priorReplies: [],
    aliases,
  })
  assert.match(prompt, /轮到你（桂芬）发言/)
})
