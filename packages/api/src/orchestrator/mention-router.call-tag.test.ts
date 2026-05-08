import assert from "node:assert/strict"
import test from "node:test"
import { resolveCallTagMentions } from "./mention-router"
import type { ProviderAliases } from "./mention-router"

/**
 * F026 方案 X · L1 显式调用标签 `[Call: @名 描述]`
 *
 * 替换原 ADR-003 的 50 个动词白名单 / 礼貌前缀 / 子句猜测路径。
 * agent (role=assistant) 自由文本里的 @xxx 一律不派发；要派发必须用 [Call: @X 任务] 标签。
 * 用户路径 (role=user) 不依赖此 parser，走 L0 行首派。
 *
 * 解析输出：alias / description / index (整段标签起点) / aliasIndex (@ 在原文位置)
 */

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

test("L1 call-tag: 基本形 [Call: @桂芬 帮我看下这个] → 1 match", () => {
  const text = "我准备让她过一眼。[Call: @桂芬 帮我看下这个]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].provider, "gemini")
  assert.equal(matches[0].alias, "桂芬")
  assert.equal(matches[0].description, "帮我看下这个")
})

test("L1 call-tag: 空描述 [Call: @桂芬] → 1 match (description 空串)", () => {
  const text = "[Call: @桂芬]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].alias, "桂芬")
  assert.equal(matches[0].description, "")
})

test("L1 call-tag: 多个标签 → 多个 match 按出现顺序", () => {
  const text = "[Call: @桂芬 任务A]\n中间一句话\n[Call: @范德彪 任务B]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 2)
  assert.equal(matches[0].alias, "桂芬")
  assert.equal(matches[0].description, "任务A")
  assert.equal(matches[1].alias, "范德彪")
  assert.equal(matches[1].description, "任务B")
})

test("L1 call-tag: 代码块 ``` 内的 [Call:] 不识别（hard-negative 复用）", () => {
  const text = "示例：\n```\n[Call: @桂芬 不该派]\n```\n"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 0)
})

test("L1 call-tag: inline code `[Call: @桂芬]` 不识别", () => {
  const text = "可以写 `[Call: @桂芬 hi]` 这样的语法。"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 0)
})

test("L1 call-tag: blockquote > [Call:] 不识别", () => {
  const text = "> [Call: @桂芬 引用别人的话不该派]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 0)
})

test("L1 call-tag: 严格大小写 [call:] 小写不识别（避免 LLM 噪音）", () => {
  const text = "[call: @桂芬 小写不算]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 0)
})

test("L1 call-tag: 别名不在 aliases 表 → 不识别", () => {
  const text = "[Call: @张三 谁啊]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 0)
})

test("L1 call-tag: 同一目标多次调用 → 多个 match (rate-limiter 上层去重)", () => {
  const text = "[Call: @桂芬 任务A]\n[Call: @桂芬 任务B]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 2)
})

test("L1 call-tag: 描述含中文标点保留（直到 ]）", () => {
  const text = "[Call: @桂芬 帮我看下这个 UI 有没有问题，特别是边距]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].description, "帮我看下这个 UI 有没有问题，特别是边距")
})

test("L1 call-tag: 自然文本里的 @桂芬 不通过此 parser 识别（仅识别标签）", () => {
  const text = "我刚和 @桂芬 聊过这事，她也同意。"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 0)
})

test("L1 call-tag: 标签内允许换行（B021 修：LLM 实际多行写描述）", () => {
  const text = "[Call: @桂芬 帮我看下这个 UI\n- 边距\n- 配色\n是否有问题]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].alias, "桂芬")
  assert.match(matches[0].description, /边距/)
  assert.match(matches[0].description, /配色/)
})

test("L1 call-tag: 嵌套 [Call:] 外层失配，内层匹配（fail-closed · B021 R-045 fixture）", () => {
  // R-045 实测：仁勋 LLM 误把 [Call: @桂芬] 嵌进给 @范德彪 的描述里。
  // 跨行允许后若不防嵌套，外层会贪到 ]，错把 description 截短；
  // 我们采用 fail-closed：外层 description 含 [Call: 子串 → 外层失配，
  // 内层 [Call: @桂芬] 单独匹配。LLM 重写正确格式后即可派对。
  const text = "[Call: @范德彪 传话游戏！请重复\n然后 [Call: @桂芬] 让她接力\n收尾]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].alias, "桂芬")
})

test("L1 call-tag: 描述内含普通 markdown 链接 [github] 不影响匹配", () => {
  const text = "[Call: @桂芬 看 [github](https://x) 上的设计]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].alias, "桂芬")
})

test("L1 call-tag: index 字段指向 [ 起点；aliasIndex 指向 @ 位置", () => {
  const text = "前缀 [Call: @桂芬 任务]"
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].index, text.indexOf("["))
  assert.equal(matches[0].aliasIndex, text.indexOf("@"))
})

test("L1 call-tag: emphasis 包裹 **[Call: @X]** 也不识别（emphasis 只用于装饰 @ 不用于装饰 tag）", () => {
  const text = "**[Call: @桂芬 hi]**"
  // 我们不打算支持 emphasis 包裹标签——LLM 学到这层 noise 不值得；保持严格契约
  // 实际上 maskHardNegativeRanges 不会掩盖 emphasis（只掩 code/blockquote/table），所以这里会识别
  // 但描述/规则上：tag 必须裸出现。改为：当左侧紧贴 `*` 或 `_` 时拒绝。
  const matches = resolveCallTagMentions(text, aliases)
  assert.equal(matches.length, 0)
})
