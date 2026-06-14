import assert from "node:assert/strict"
import test from "node:test"
import { stripRichFencesForPreview } from "./rich-blocks"

// F030 r3 P2：预览/摘要清理。主渲染（parseRichSegments）修了黑框，但折叠态、侧栏、
// session-group 摘要等"展示摘要"面直接 slice 原始 content，未闭合 cc_rich 的 ```cc_rich
// + JSON 会原样泄漏。stripRichFencesForPreview 是这些面复用的单一清理函数。

test("stripRichFencesForPreview: 闭合 cc_rich → [卡片] 占位，无 JSON 泄漏", () => {
  const out = stripRichFencesForPreview('结论\n```cc_rich\n{"kind":"card","id":"x","title":"T"}\n```\n下文')
  assert.equal(out, "结论\n[卡片]\n下文")
  assert.ok(!out.includes("cc_rich"))
  assert.ok(!out.includes("{"))
})

test("stripRichFencesForPreview: 未闭合 cc_rich → 整段移除，前导文字保留", () => {
  const out = stripRichFencesForPreview('前导XYZ\n```cc_rich\n{"kind":"card","id":"x"')
  assert.equal(out, "前导XYZ")
  assert.ok(!out.includes("cc_rich"))
  assert.ok(!out.includes("{"))
})

test("stripRichFencesForPreview: 整条消息只有未闭合 cc_rich → 空串", () => {
  const out = stripRichFencesForPreview('```cc_rich\n{"kind":"card"')
  assert.equal(out, "")
})

// r7 always-fold：普通代码围栏一律折叠成 [代码块]（不再原样保留——保留会让"四反引号包
// 三反引号 cc_rich"的内层 JSON 从侧栏漏出）。
test("stripRichFencesForPreview: 普通代码围栏折叠成 [代码块]", () => {
  assert.equal(stripRichFencesForPreview("```js\nconst a = 1\n```"), "[代码块]")
})

// r4 P2-2 / r7：普通外层围栏内的 cc_rich 是代码示例，整块当普通围栏折叠 [代码块]，绝不漏内部 JSON。
test("stripRichFencesForPreview: 四反引号包三反引号 cc_rich → 整块 [代码块]，不漏内部", () => {
  const out = stripRichFencesForPreview('````\n```cc_rich\n{"kind":"card"}\n```\n````')
  assert.equal(out, "[代码块]")
  assert.ok(!out.includes("cc_rich") && !out.includes('"kind"'))
})

test("stripRichFencesForPreview: 普通围栏 [代码块] + 其后真 cc_rich [卡片]", () => {
  const src = '```js\ncode\n```\n```cc_rich\n{"kind":"card","id":"x"}\n```'
  assert.equal(stripRichFencesForPreview(src), "[代码块]\n[卡片]")
})

test("stripRichFencesForPreview: ~~~ tilde 围栏的 cc_rich 也清理", () => {
  const out = stripRichFencesForPreview('~~~cc_rich\n{"kind":"card","id":"x"}\n~~~')
  assert.equal(out, "[卡片]")
})

test("stripRichFencesForPreview: 多个 cc_rich 块各自替换/移除", () => {
  const out = stripRichFencesForPreview(
    '```cc_rich\n{"a":1}\n```\n中间\n```cc_rich\n{"b":2}\n```',
  )
  assert.equal(out, "[卡片]\n中间\n[卡片]")
})

// r7：info 首词忽略大小写 === cc_rich（容 CC_RICH / cc_rich extra / 驼峰），over-fold 防
// agent 写错大小写/带尾随词时 mis-tag 的卡片 JSON 从侧栏漏出。
test("stripRichFencesForPreview: 大写/带尾随词的 cc_rich 也折叠成 [卡片]", () => {
  assert.equal(stripRichFencesForPreview('```CC_RICH\n{"kind":"card"}\n```'), "[卡片]")
  assert.equal(stripRichFencesForPreview('```cc_rich extra\n{"kind":"card"}\n```'), "[卡片]")
})

test("stripRichFencesForPreview: 无围栏内容原样返回", () => {
  assert.equal(stripRichFencesForPreview("普通一句话"), "普通一句话")
})

test("stripRichFencesForPreview: 空串返回空串", () => {
  assert.equal(stripRichFencesForPreview(""), "")
})
