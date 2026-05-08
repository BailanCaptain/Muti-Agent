import assert from "node:assert/strict"
import test from "node:test"
import { resolveDispatchMentions } from "./mention-router"
import type { ProviderAliases } from "./mention-router"

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

// F026 ADR-003 Layer 3 — gray-zone default fail-closed:
//   resolveDispatchMentions returns ONLY those whose classification === "dispatch".
//   gray-zone mentions are silently dropped + (optionally) reported via callback.

test("L3 fail-closed: 只返回 dispatch 类 mention", () => {
  const text = "@范德彪 帮我 review PR。另外 @桂芬" // second 孤零零 @桂芬 → gray
  const hits = resolveDispatchMentions(text, aliases)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].provider, "codex")
})

test("L3 fail-closed: 行首 @X 但无动作语义 → 被剔除（不派发）", () => {
  const text = "@桂芬" // bare
  assert.deepEqual(resolveDispatchMentions(text, aliases), [])
})

test("L3 fail-closed: 非行首 @X 全部 gray → 0 dispatch", () => {
  const text = "我之前跟 @桂芬 碰了一下，又问 @范德彪 确认了"
  assert.deepEqual(resolveDispatchMentions(text, aliases), [])
})

test("L3 onGrayZone callback: 被 drop 的 gray mention 全部冒泡", () => {
  const text = "然后 @桂芬。另外 @范德彪"
  const dropped: Array<{ provider: string; alias: string; index: number }> = []
  resolveDispatchMentions(text, aliases, {
    onGrayZone: (m) => dropped.push({ provider: m.provider, alias: m.alias, index: m.index }),
  })
  assert.equal(dropped.length, 2)
  const providers = dropped.map((d) => d.provider).sort()
  assert.deepEqual(providers, ["codex", "gemini"])
})

test("L3 traceId: 每个 dispatch mention 都带有 traceId", () => {
  const text = "@范德彪 帮我 review\n@桂芬 帮我设计"
  const hits = resolveDispatchMentions(text, aliases)
  assert.equal(hits.length, 2)
  for (const h of hits) {
    assert.ok(
      typeof h.traceId === "string" && h.traceId.length > 0,
      `expected traceId, got ${h.traceId}`,
    )
  }
  assert.notEqual(hits[0].traceId, hits[1].traceId, "traceId must be unique")
})

test("L3 fail-closed: Layer 1 hard-neg + Layer 3 gray 都不冒泡为 dispatch", () => {
  const text = `\`\`\`
@范德彪 示例 派发
\`\`\`
@桂芬 帮我 review`
  const hits = resolveDispatchMentions(text, aliases)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].provider, "gemini")
})

// F026-P3 修订 · 祈使句白名单（实测样本：3 条 `@xxx 请重复…` 全部被判 gray，gray-zone fallback 兜底命中）
test("L3 polite-head: 礼貌祈使前缀（请/麻烦/烦请）→ dispatch", () => {
  const cases = [
    "@范德彪 请重复这句话：「测试」",
    "@范德彪 麻烦看一下这个 PR",
    "@桂芬 烦请确认一下方案",
    "@范德彪 能否帮我跑一下用例",
    "@范德彪 帮忙审一下这段",
  ]
  for (const text of cases) {
    const hits = resolveDispatchMentions(text, aliases)
    assert.equal(hits.length, 1, `expected dispatch for: ${text}`)
  }
})

test("L3 verb-head 扩展: 重复/说/告诉/解释/列/输出 等任务祈使动词 → dispatch", () => {
  const cases = [
    "@范德彪 重复一遍：山一样稳",
    "@范德彪 说一句话",
    "@桂芬 告诉我当前状态",
    "@范德彪 解释一下这个错误",
    "@桂芬 列一下所有未完成项",
    "@范德彪 输出 P3 的 commit",
    "@范德彪 总结一下今天进度",
    "@桂芬 生成一份摘要",
  ]
  for (const text of cases) {
    const hits = resolveDispatchMentions(text, aliases)
    assert.equal(hits.length, 1, `expected dispatch for: ${text}`)
  }
})

test("L3 polite-head 英文: please / can you / could you → dispatch", () => {
  const cases = [
    "@范德彪 please review this PR",
    "@桂芬 can you check the spec",
    "@范德彪 could you explain this",
    "@范德彪 pls confirm",
  ]
  for (const text of cases) {
    const hits = resolveDispatchMentions(text, aliases)
    assert.equal(hits.length, 1, `expected dispatch for: ${text}`)
  }
})

// F026-P3 quality-gate · 当前 layer 2 用 ^${POLITE_HEAD} 严格匹配 trimmed 起始，
// 但样本里 @ 后常有称呼前缀（"大姐"/"老兄"/"大哥"等），礼貌词被推到中段 → 落 gray。
// 修法：firstLine 任意位置含 POLITE_HEAD + 含动作动词 → dispatch（仍受 line-start 约束）。
test("L3 称呼前缀 + 礼貌祈使: '@桂芬 大姐 请帮忙看下' → dispatch", () => {
  const cases = [
    "@桂芬 大姐 请帮忙看下这个方案",
    "@范德彪 老兄 麻烦确认一下",
    "@桂芬 妹子 烦请评估下视觉",
    "@范德彪 老哥 能否解释一下这段",
  ]
  for (const text of cases) {
    const hits = resolveDispatchMentions(text, aliases)
    assert.equal(hits.length, 1, `expected dispatch for: ${text}`)
  }
})

test("L3 称呼前缀 + 英文礼貌: '@xxx bro please review' → dispatch", () => {
  const cases = ["@范德彪 bro please review this", "@桂芬 sis can you check"]
  for (const text of cases) {
    const hits = resolveDispatchMentions(text, aliases)
    assert.equal(hits.length, 1, `expected dispatch for: ${text}`)
  }
})

// 反例：仅有称呼无动作动词 仍应 gray（不夸大白名单）
test("L3 仅称呼无动作: '@桂芬 大姐你好' → gray（不派）", () => {
  const text = "@桂芬 大姐你好"
  assert.deepEqual(resolveDispatchMentions(text, aliases), [])
})
