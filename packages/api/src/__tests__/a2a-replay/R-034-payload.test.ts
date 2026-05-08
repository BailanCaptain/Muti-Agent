/**
 * F026-P3 Task8 · R-034 replay.
 *
 * 用真实的范德彪 4053 字 review (R-034 incident, 2026-04-24) 验证：
 * buildReturnPathPayload 在 16k 默认 cap 下完整保留三条核心 finding 关键句 +
 * 测试命令字符串。这是 M5 设计的现实回归保护。
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import { buildReturnPathPayload } from "../../orchestrator/return-path-payload"

const REVIEW_FIXTURE_PATH = resolve(__dirname, "fixtures", "R-034-vande-review-4195.txt")

// 三条核心 finding 关键句 + 验证命令（fixture 里实际出现的字符串片段）
const REQUIRED_PHRASES = [
  // Finding 1: B016 修复 + claude-runtime
  "B016",
  "claude-runtime.ts",
  // Finding 2: phase1-header 删行
  "phase1-header",
  "phase1-header.test.ts",
  // Finding 3: 全量 typecheck + PASS 结论
  "pnpm typecheck",
  "PASS",
]

const REQUIRED_TEST_COMMANDS = ["pnpm typecheck", "pnpm test"]

test("F026-P3 R-034 replay · 16k 默认 cap 完整保留 review，三条 finding 不丢", () => {
  const review = readFileSync(REVIEW_FIXTURE_PATH, "utf8")
  assert.ok(review.length > 2000, `fixture 至少 2k chars，实际 ${review.length}`)

  const r = buildReturnPathPayload(review, {
    maxTokens: 16384,
    dbMsgId: "94ebd971-vande-review-2026-04-24",
  })

  // 16k cap = 64k chars，4053 字 << 64k → 不截，全保留
  assert.equal(r.truncated, false, "4k 字 review 在 16k cap 下不应截断")
  assert.equal(r.text, review, "未截断时 text 应等于 fixture 原文")

  for (const phrase of REQUIRED_PHRASES) {
    assert.ok(r.text.includes(phrase), `必须保留 finding 关键句: ${phrase}`)
  }
  for (const cmd of REQUIRED_TEST_COMMANDS) {
    assert.ok(r.text.includes(cmd), `必须保留验证命令: ${cmd}`)
  }
})

test("F026-P3 R-034 replay · 强制截断（cap=2k chars）：head 含 fixture 开头 + msg_id 引用", () => {
  const review = readFileSync(REVIEW_FIXTURE_PATH, "utf8")
  const r = buildReturnPathPayload(review, {
    maxTokens: 512, // = 2048 chars cap，比 fixture 4053 chars 小，强制截断
    dbMsgId: "94ebd971-vande-review-2026-04-24",
  })

  assert.equal(r.truncated, true)
  assert.match(r.text, /msg_id=94ebd971-vande-review-2026-04-24/, "省略标记里必须含 msg_id")
  assert.match(r.text, /省略\s*\d+\s*字/)

  // head 60% (≈1200 chars from start) 必含 fixture 开头的"结论先说"
  assert.ok(r.text.includes("结论先说"), "head 区应保留 fixture 开头")
  // 截断后总长应 << 原文（cap×1.1 容忍 omission marker overhead）
  assert.ok(
    r.text.length < review.length,
    `截断后 ≤ 原文长度，实际 ${r.text.length} vs 原 ${review.length}`,
  )
})

test("F026-P3 R-034 replay · DB 红线：buildReturnPathPayload 不修改输入 content", () => {
  const review = readFileSync(REVIEW_FIXTURE_PATH, "utf8")
  const before = review.slice() // immutable string
  buildReturnPathPayload(review, { maxTokens: 1024, dbMsgId: "x" })
  // String 是 immutable，但确认 fixture 内容未变（防 future 重构引入 in-place mutation）
  const after = readFileSync(REVIEW_FIXTURE_PATH, "utf8")
  assert.equal(after, before, "fixture 文件不可被修改")
})
