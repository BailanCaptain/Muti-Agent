import assert from "node:assert/strict"
import test from "node:test"
import { resolveMentions } from "./mention-router"
import type { ProviderAliases } from "./mention-router"

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

// F026 ADR-003 · Layer 1 hard-negative (Markdown-context aware)
// 所有以下场景一律不派发（无论 role），只保留前端视觉高亮

test("L1 hard-neg: fenced code block ``` 内 @ 不派发", () => {
  const text = "示例代码：\n```\n@范德彪 请接手 P0\n@桂芬 请看视觉稿\n```\n"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: fenced code block ``` 带语言标签 内 @ 不派发", () => {
  const text = "```markdown\n@黄仁勋 重要: 请评审\n```"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: fenced code block ~~~ 内 @ 不派发", () => {
  const text = "~~~ts\nconst hi = '@范德彪'\n~~~"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: inline code `@X` 不派发", () => {
  const text = "请用 `@范德彪` 这个 alias 调用"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: blockquote > @X 不派发", () => {
  const text = "他昨天说：\n> @黄仁勋 记得交接一下"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: table | @X | 不派发", () => {
  const text = "| 人员 | 任务 |\n|---|---|\n| @桂芬 | 前端 |\n| @范德彪 | 后端 |"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: **@X** 粗体装饰 不派发", () => {
  const text = "**@范德彪** 刚才接得挺快嘛"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: *@X* 斜体装饰 不派发", () => {
  const text = "*@桂芬* 的设计很棒"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: 介绍句式「@X 是 Y」不派发", () => {
  const text = "@范德彪 是安全大师"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: 介绍句式「@X 老师」不派发", () => {
  const text = "听听 @桂芬 老师的建议"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: 介绍句式「与 @X 讨论」不派发", () => {
  const text = "我刚才与 @范德彪 讨论过了"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 hard-neg: 介绍句式「和 @X」不派发", () => {
  const text = "和 @桂芬 一起 brainstorm 了一下"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

// --- 历史事故 red-case fixtures ---

test("L1 red-case 2026-04-22 15:30: assistant 回复里的 code block 示例不派发（I1' + LL-028）", () => {
  const text = `下面是示例：
\`\`\`
@范德彪 请接手 P0 Task 3
@桂芬 请看视觉稿
\`\`\`
请参考。`
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 red-case 2026-04-22 16:05: `**@X**` 粗体装饰不派发（LL-028）", () => {
  const text = "**@范德彪** 刚才的任务你接得挺快嘛，P14 的 MCP 桥修好后记得把错误码吐给我"
  assert.deepEqual(resolveMentions(text, aliases), [])
})

test("L1 red-case 2026-04-23 Round 2 级联事故: 黄仁勋简报内 code block 的 '@桂芬' 不派发（LL-028）", () => {
  const text = `Q12 简报汇报：

\`\`\`
对话里的 @桂芬 应该派发给桂芬吗？
这里仅作为示例引用。
\`\`\`

小孙你看看这个设计。`
  assert.deepEqual(resolveMentions(text, aliases), [])
})

// --- Green case: 正常派发场景仍然工作 ---

test("L1 green: 行首 @X + 动词 仍然派发（控制组）", () => {
  const text = "@范德彪 帮我 review 这个 PR"
  const r = resolveMentions(text, aliases)
  assert.equal(r.length, 1)
  assert.equal(r[0].provider, "codex")
})

test("L1 green: mixed paragraph, 行首 @X 派发 + 文中 @X 不派发", () => {
  const text = "@范德彪 看一下\n我之前也跟 @桂芬 说过" // 第一个派发；第二个"也跟"介绍句式 → hard-neg
  const r = resolveMentions(text, aliases)
  assert.equal(r.length, 1)
  assert.equal(r[0].provider, "codex")
})

// F026-P3 quality-gate: maskHardNegativeRanges 用 [...content] 切 codepoint 数组，
// 但下游循环按 UTF-16 length 累加 offset → 含 emoji 时 codepoint < UTF-16 偏移，
// mask 的 char 位置错位，可能：
//   (a) 漏掩 fence 内的 alias → 误派
//   (b) 错掩 fence 外真要派发的 alias → 漏派
// 测试构造 (b) 场景：emoji 让偏移 +3，把 fence 外的 "@范德彪" 错位 mask。
test("L1 emoji 偏移不漏掩/不错掩: 多个 emoji 后的 fence 仍正确屏蔽，fence 外行首 @ 仍派发", () => {
  // 3 个 🐾 = 6 UTF-16, 但只占 3 codepoint → 偏移 +3，错位最严重
  const text = `🐾🐾🐾 标题
\`\`\`
代码块内
\`\`\`
@范德彪 真派发`
  const hits = resolveMentions(text, aliases)
  // 期望：fence 内无 mention（本就没 alias），fence 外 "@范德彪 真派发" 派发
  assert.equal(hits.length, 1, `expected 1 hit, got ${hits.length}: ${JSON.stringify(hits)}`)
  assert.equal(hits[0].provider, "codex")
})

test("L1 emoji 偏移不让 fence 内 @ 漏掩成派发: '🐾🐾🐾' + fence 内 @桂芬 不派发", () => {
  // 偏移让 fence 起止符在 codepoint 域错位，可能漏掩 fence 内 alias
  const text = `🐾🐾🐾🐾 多 emoji 标题
\`\`\`
@桂芬 这是 fence 内示例
\`\`\`
正常段落`
  const hits = resolveMentions(text, aliases)
  assert.deepEqual(
    hits,
    [],
    `expected 0 hits (fence 内 @桂芬 应被 mask), got ${JSON.stringify(hits)}`,
  )
})

test("L1 emoji 在签名行（control · 当前已通过）: fence 之后内容里的 emoji 不让后续行首 @ 错位", () => {
  // 真实场景：commit message 风格回复（fence 不参与，只测 emoji 不破坏正常派发）
  const text = `[黄仁勋/Opus-46 🐾] 修完了

@范德彪 帮我 review`
  const hits = resolveMentions(text, aliases)
  assert.equal(hits.length, 1, `expected 1 hit, got ${hits.length}: ${JSON.stringify(hits)}`)
  assert.equal(hits[0].provider, "codex")
})
