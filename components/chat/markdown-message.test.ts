/**
 * F026 P3 方案 X · 前端 [Call:] 静默渲染单测
 *
 * 验证 stripCallTags 把底层派发协议 [Call: @X 描述] 脱掉，
 * 留下普通 @X 让 highlightMentions 渲染成 pill —— 用户看不到 [Call:] 字样。
 */

import { describe, expect, it } from "vitest"
import { stripCallTags, sanitizeMarkdown } from "./markdown-message"

describe("F026-P3 方案X · stripCallTags", () => {
  it("基本形：[Call: @桂芬 看下] → @桂芬 看下", () => {
    expect(stripCallTags("[Call: @桂芬 看下]")).toBe("@桂芬 看下")
  })

  it("空描述：[Call: @桂芬] → @桂芬（无尾随空格）", () => {
    expect(stripCallTags("[Call: @桂芬]")).toBe("@桂芬")
  })

  it("句中：前缀和后缀正文保留", () => {
    expect(stripCallTags("我准备让她过一眼。[Call: @桂芬 看视觉] 收尾。"))
      .toBe("我准备让她过一眼。@桂芬 看视觉 收尾。")
  })

  it("多个 tag：各自展开", () => {
    expect(stripCallTags("[Call: @桂芬 任务A]\n[Call: @范德彪 任务B]"))
      .toBe("@桂芬 任务A\n@范德彪 任务B")
  })

  it("大小写敏感：[call:] 小写保持不变（与解析端契约一致）", () => {
    expect(stripCallTags("[call: @桂芬 hi]")).toBe("[call: @桂芬 hi]")
  })

  it("跨行（B021 修）：[Call: @X\\n描述\\n] 也 strip 成 @X 描述", () => {
    expect(stripCallTags("[Call: @桂芬 帮我看下 UI\n- 边距\n- 配色\n是否有问题]"))
      .toBe("@桂芬 帮我看下 UI\n- 边距\n- 配色\n是否有问题")
  })

  it("F026 P3.1 loose 版本 · 嵌套 [Call:] 多 pass 全脱（用户视觉零字面量）", () => {
    // R-045/R-054 实测：仁勋 LLM 误把 [Call: @桂芬] 嵌进给 @范德彪 的描述里。
    // P3.1 解耦后：前端宽松 strip 多 pass 把内外层都脱干净；
    // 后端 mention-router 仍 fail-closed（外层不派发，避免错派）。
    // 派发结果通过 retry badge / @ pill 状态徽章传达，而非靠用户看 [Call:] 字符串。
    const text = "[Call: @范德彪 传话游戏\n然后 [Call: @桂芬] 让她接力\n收尾]"
    const out = stripCallTags(text)
    expect(out).not.toContain("[Call:")
    expect(out).toContain("@范德彪")
    expect(out).toContain("@桂芬")
  })

  it("F026 P3.1 loose 版本 · 三轮接力深嵌套也全脱", () => {
    const text = "[Call: @A 描述 [Call: @B 描述 [Call: @C 描述]]]"
    const out = stripCallTags(text)
    expect(out).not.toContain("[Call:")
    expect(out).toContain("@A")
    expect(out).toContain("@B")
    expect(out).toContain("@C")
  })

  it("自然 @ 不动：自由文本里的 @桂芬 不受影响", () => {
    expect(stripCallTags("我和 @桂芬 聊过这事")).toBe("我和 @桂芬 聊过这事")
  })

  it("描述含中文标点：保留（直到 ]）", () => {
    expect(stripCallTags("[Call: @桂芬 看下 UI 边距，重点是按钮区]"))
      .toBe("@桂芬 看下 UI 边距，重点是按钮区")
  })

  it("多空白：描述前缀空白被吃掉，alias 与描述间留单空格", () => {
    expect(stripCallTags("[Call: @桂芬   多余空白]"))
      .toBe("@桂芬 多余空白")
  })

  it("不影响其它字符串", () => {
    expect(stripCallTags("Hello world")).toBe("Hello world")
    expect(stripCallTags("")).toBe("")
  })
})

describe("F026-P3 review fix · sanitizeMarkdown inline code 保护", () => {
  it("inline code 内的 [Call:] 保持原样（与后端 maskHardNegativeRanges 契约对齐）", () => {
    const input = "正文 `[Call: @桂芬 示例]` 后续"
    const out = sanitizeMarkdown(input)
    expect(out).toContain("`[Call: @桂芬 示例]`")
  })

  it("fenced code block 内的 [Call:] 保持原样", () => {
    const input = "正文\n```\n[Call: @范德彪 代码样例]\n```\n后续"
    const out = sanitizeMarkdown(input)
    expect(out).toContain("[Call: @范德彪 代码样例]")
  })

  it("正文中的 [Call:] 仍被 strip", () => {
    const input = "[Call: @桂芬 看视觉]"
    const out = sanitizeMarkdown(input)
    expect(out).not.toContain("[Call:")
    expect(out).toContain("@桂芬")
  })
})
