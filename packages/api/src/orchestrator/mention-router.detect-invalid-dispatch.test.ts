import assert from "node:assert/strict"
import test from "node:test"
import { detectInvalidDispatch, resolveCallTagMentions } from "./mention-router"
import type { ProviderAliases } from "./mention-router"

/**
 * F026 P3.1 · `detectInvalidDispatch` 派发协议预检
 *
 * 在 assistant final 入库前调用——命中即拒收 + 触发 agent retry。
 *
 * 检测项（2026-04-29 R-057 兜底层重启后）：
 *   - nested_call_tag             : R-054 嵌套 [Call: ... [Call: ...] ...]
 *   - naked_at_with_real_teammate : R-057 行首裸真实队友 @ + 全文未发现合法 [Call:]
 *
 * 设计原则：
 *   - 嵌套结构优先（先返）
 *   - 行首裸真实队友 @ 仅在全文找不到合法 [Call: @...] 时触发 — 已派发的轮次里
 *     行首 @ 视为叙述（避免对正常多人接力误伤）
 *   - 真人/外部别名（@小孙）不在 ProviderAliases，永远不触发 retry
 *   - 装饰句"@黄仁勋 是我..."等行首+真实队友别名+无派发动词 — 仍触发 retry（小孙拍板：
 *     宁可多一次 LLM 重写，也不让契约缺漏静默断链；retry 上限 3 次后 fail-visible）
 */

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

test("AC-1 嵌套 [Call:]：R-054 三轮接力写法 → reason=nested_call_tag", () => {
  const text = "[Call: @范德彪 重复春江潮水连海平 [Call: @桂芬 重复德彪刚说的话]]"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, "nested_call_tag")
})

test("AC-2 R-057 行首裸真实队友 @ + 全文无 [Call:] → reason=naked_at_with_real_teammate", () => {
  for (const text of [
    "@范德彪 review 这个 PR",
    "@桂芬 帮我看下 F012 这个 bug 还能不能复现",
    "前面一段铺垫。\n\n@范德彪 接力实现下一步",
    "@黄仁勋 是我，我先起个头。", // 装饰句也算（小孙拍板可接受代价）
  ]) {
    const r = detectInvalidDispatch(text, aliases)
    assert.equal(r.ok, false, `text="${text}" should be rejected (naked-at retry)`)
    if (!r.ok) assert.equal(r.reason, "naked_at_with_real_teammate")
  }
})

test("AC-3 合法格式 [Call: @范德彪 review PR] → ok=true", () => {
  const text = "好的，下一步：\n[Call: @范德彪 review 这个 PR]"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, true)
})

test("AC-3b 合法格式 + 多个 [Call:] 并列 → ok=true", () => {
  const text = "[Call: @范德彪 任务A]\n中间一句话\n[Call: @桂芬 任务B]"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, true)
})

test("AC-3c 合法 [Call:] 同篇出现 + 行首裸真实队友 @（叙述）→ ok=true（已派发轮，裸 @ 视作叙述）", () => {
  const text = "[Call: @范德彪 review F026]\n\n顺带一提，@桂芬 之前也帮过我类似的事。"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, true)
})

test("AC-4 装饰性 @：句中非行首「我和 @桂芬 聊过」 → ok=true", () => {
  const text = "我和 @桂芬 聊过这个方案，她也认可。"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, true)
})

test("AC-4b 行首 @ 但 alias 不是真实队友（@小孙）→ ok=true（外部/真人不触发 retry）", () => {
  const text = "@小孙 这个版本我已经测过了，请你拍板。"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, true)
})

test("AC-5 inline-code `[Call:]`：嵌套样例藏在反引号里 → ok=true（hard-negative 屏蔽）", () => {
  const text = "比如可以写 `[Call: @A 描述 [Call: @B] 接力]` 这种格式（不该派）。"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, true)
})

test("AC-5b fenced code block 内嵌套 [Call:] + 段首裸真实队友 → ok=true（hard-negative 屏蔽 fenced 行首）", () => {
  // fenced 内的行首 @ 已被掩盖，外层无真实派发意图
  const text = "示例代码：\n```\n@范德彪 写函数 foo\n```\n以上仅供参考。"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, true)
})

test("AC-6 round-trip: 合法 [Call:] → detect ok 且 resolveCallTagMentions 命中（双绿）", () => {
  const text = "[Call: @范德彪 review F026]"
  const detect = detectInvalidDispatch(text, aliases)
  const resolve = resolveCallTagMentions(text, aliases)
  assert.equal(detect.ok, true)
  assert.equal(resolve.length, 1)
  assert.equal(resolve[0].alias, "范德彪")
})

test("AC-6b 嵌套 [Call:] → detect 拒绝（reason=nested 优先于 naked_at）", () => {
  // 同时含嵌套 + 行首裸真实队友 @：嵌套结构错优先返
  const text = "[Call: @范德彪 重复 [Call: @桂芬 hi]]\n@黄仁勋 总结一下"
  const detect = detectInvalidDispatch(text, aliases)
  assert.equal(detect.ok, false)
  if (!detect.ok) assert.equal(detect.reason, "nested_call_tag")
})

test("AC-7 emphasis 包裹 **@范德彪**（行首）→ 仍触发 retry（emphasis 不豁免行首裸 @）", () => {
  const text = "**@范德彪** 来接一下 R-057"
  const r = detectInvalidDispatch(text, aliases)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, "naked_at_with_real_teammate")
})

test("AC-8 行首引导词「与/和/给 @X」 → ok=true（介绍句，不触发 retry）", () => {
  // 行首前缀虽含 @真实队友，但「和/与」开头明显是叙述
  for (const text of ["和 @范德彪 一起把这个事干了", "给 @桂芬 看了下方案"]) {
    const r = detectInvalidDispatch(text, aliases)
    assert.equal(r.ok, true, `text="${text}" should be ok (introductory connector)`)
  }
})

test("AC-9 各类裸 @ 真实队友派发动词 → 全部 reason=naked_at_with_real_teammate（R-057 回归保护）", () => {
  const verbs = ["实现", "检查", "处理", "接力", "写", "重复", "帮", "看下", "确认", "评价"]
  for (const verb of verbs) {
    const text = `@桂芬 ${verb}一下这个`
    const r = detectInvalidDispatch(text, aliases)
    assert.equal(r.ok, false, `verb='${verb}' should be rejected`)
    if (!r.ok) assert.equal(r.reason, "naked_at_with_real_teammate")
  }
})
