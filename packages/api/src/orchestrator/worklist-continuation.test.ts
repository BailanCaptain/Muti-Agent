import assert from "node:assert/strict"
import test from "node:test"
import { buildWorklistContinuationPrompt } from "./worklist-continuation"

test("F026 1B.6 Fix-2: single alias — pointer-only prompt 含 [Call: @X] 与单人语句", () => {
  const prompt = buildWorklistContinuationPrompt({ childAliases: ["桂芬"] })
  assert.match(
    prompt,
    /\[桂芬 已完成你之前 \[Call: @桂芬\] 派发的任务，他的回复在你刚才的对话历史里。/,
  )
  assert.match(prompt, /请基于此整合最终给用户的回复。\]$/)
})

test("F026 1B.6 Fix-2: multi alias — 多人版 prompt 含每人 [Call:@] + 多人语句", () => {
  const prompt = buildWorklistContinuationPrompt({ childAliases: ["桂芬", "范德彪"] })
  assert.match(prompt, /\[桂芬、范德彪 已完成你之前/)
  assert.ok(prompt.includes("[Call: @桂芬]"), "single tag for 桂芬")
  assert.ok(prompt.includes("[Call: @范德彪]"), "single tag for 范德彪")
  assert.match(prompt, /他们的回复在你刚才的对话历史里。/)
  assert.match(prompt, /请基于此整合最终给用户的回复。\]$/)
})

test("F026 1B.6 Fix-2: child reply content NOT inlined — pointer-only 契约（不双倍冗余 envelope history）", () => {
  // 关键 Y 契约：prompt 长度与 child reply 文本无关。
  const childContent = "我审完了视觉，建议把按钮换成绿色，且字号增加到 14pt 以提升老年用户可读性。"
  const prompt = buildWorklistContinuationPrompt({ childAliases: ["桂芬"] })
  assert.ok(!prompt.includes(childContent), "child content must NOT be inlined")
  assert.ok(
    !prompt.includes("回复内容如下"),
    "no '回复内容如下' inline 标签（Y 选项废弃）",
  )
})

test("F026 1B.6 Fix-2: empty alias array → defensive fallback prompt（不输出空 [Call: @]）", () => {
  const prompt = buildWorklistContinuationPrompt({ childAliases: [] })
  assert.ok(!prompt.includes("[Call: @]"), "must not emit empty [Call: @] literal")
  assert.ok(prompt.includes("请基于刚才的对话历史"), "fallback hint kicks in")
})

test("F026 1B.6 Fix-2: trims whitespace + drops empty alias entries", () => {
  // 防止 worklist items 偶发空 alias 污染 prompt（生产路径不该出，但 defensive）
  const prompt = buildWorklistContinuationPrompt({
    childAliases: ["  桂芬  ", "", "范德彪", "  "],
  })
  assert.match(prompt, /\[桂芬、范德彪 已完成你之前/)
  assert.ok(prompt.includes("[Call: @桂芬]"))
  assert.ok(prompt.includes("[Call: @范德彪]"))
})
