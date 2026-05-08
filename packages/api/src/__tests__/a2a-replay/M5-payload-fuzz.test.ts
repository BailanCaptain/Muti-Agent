/**
 * F026-P3 Task8 · M5 payload fuzz harness.
 *
 * Matrix: cap (4k/16k/32k tokens) × @-mention 段首 (有/无) × sentence boundary (有/无) ×
 * 中段 finding 关键词 (含/不含)。断言 16k 档**所有 case** 中段 finding 不被砍。
 */

import assert from "node:assert/strict"
import test from "node:test"
import { buildReturnPathPayload } from "../../orchestrator/return-path-payload"

const FINDING_MARKER = "MID_FINDING_KEY_2026_M5_REGRESSION_GUARD"

type Case = {
  label: string
  content: string
  maxTokens: number
  expectFinding: boolean // 16k+ 档 + 所有合理 input → 中段 finding 必须保留
}

function buildContent(opts: {
  totalChars: number
  hasAtMentionAtStart: boolean
  hasSentenceBoundary: boolean
  hasMidFinding: boolean
}): string {
  const head = opts.hasAtMentionAtStart ? "@黄仁勋 帮忙看下\n" : "正常段落开头\n"
  const sep = opts.hasSentenceBoundary ? "。" : " "
  const filler = "x".repeat(Math.max(0, Math.floor(opts.totalChars / 2) - 200))
  const mid = opts.hasMidFinding ? `${sep}${FINDING_MARKER}${sep}` : `${sep}NO_FINDING${sep}`
  const tail = "y".repeat(Math.max(0, Math.floor(opts.totalChars / 2) - 200))
  return head + filler + mid + tail
}

const CAPS = [
  { tokens: 4096, name: "4k" }, // chars cap = 16k
  { tokens: 16384, name: "16k" }, // chars cap = 64k
  { tokens: 32768, name: "32k" }, // chars cap = 128k
]

const cases: Case[] = []
for (const cap of CAPS) {
  for (const atStart of [true, false]) {
    for (const sentence of [true, false]) {
      for (const midFinding of [true, false]) {
        // 输入大小：cap chars × 0.8（确保 16k+ 档不触发截断）
        const totalChars = Math.floor(cap.tokens * 4 * 0.8)
        cases.push({
          label: `cap=${cap.name} atStart=${atStart} sentence=${sentence} midFinding=${midFinding}`,
          content: buildContent({
            totalChars,
            hasAtMentionAtStart: atStart,
            hasSentenceBoundary: sentence,
            hasMidFinding: midFinding,
          }),
          maxTokens: cap.tokens,
          // 输入 = 0.8×cap，<cap → 不该截，midFinding 必保留
          expectFinding: midFinding,
        })
      }
    }
  }
}

for (const c of cases) {
  test(`F026-P3 M5 fuzz · ${c.label} · 中段 finding 保留`, () => {
    const r = buildReturnPathPayload(c.content, { maxTokens: c.maxTokens })
    if (c.expectFinding) {
      assert.ok(r.text.includes(FINDING_MARKER), `${c.label} → finding 应保留`)
    } else {
      assert.ok(
        !r.text.includes(FINDING_MARKER),
        `${c.label} → 不应包含 finding（输入本无 finding）`,
      )
    }
  })
}

// 16k 档边界：输入 = cap × 0.99 (刚好不超 cap) 必须不截
test("F026-P3 M5 fuzz · 16k cap × 0.99 输入 → 不截、finding 完整", () => {
  const cap = 16384
  const totalChars = Math.floor(cap * 4 * 0.99)
  const content = buildContent({
    totalChars,
    hasAtMentionAtStart: false,
    hasSentenceBoundary: true,
    hasMidFinding: true,
  })
  const r = buildReturnPathPayload(content, { maxTokens: cap })
  assert.equal(r.truncated, false, "0.99×cap 应不截")
  assert.ok(r.text.includes(FINDING_MARKER))
})

// 16k 档超 cap 场景：finding 在 head 60% 区或 tail 30% 区时仍保留；finding 落在中间省略段则丢失（已知行为）
test("F026-P3 M5 fuzz · 16k cap 超量输入：finding 在 head 区保留", () => {
  const cap = 16384
  const headPad = "x".repeat(1000) // 1000 chars head padding
  const overflowFiller = "z".repeat(cap * 4 * 2) // 远超 cap
  const content = headPad + FINDING_MARKER + overflowFiller
  const r = buildReturnPathPayload(content, { maxTokens: cap })
  assert.equal(r.truncated, true)
  assert.ok(r.text.includes(FINDING_MARKER), "finding 在 head 60% 区应保留")
})

test("F026-P3 M5 fuzz · 16k cap 超量输入：finding 在 tail 区保留", () => {
  const cap = 16384
  const overflowFiller = "z".repeat(cap * 4 * 2)
  const tailPad = "x".repeat(1000)
  const content = overflowFiller + FINDING_MARKER + tailPad
  const r = buildReturnPathPayload(content, { maxTokens: cap })
  assert.equal(r.truncated, true)
  assert.ok(r.text.includes(FINDING_MARKER), "finding 在 tail 30% 区应保留")
})
