import { describe, expect, it } from "vitest"
import { buildFoldedPreview } from "./message-bubble"

// F030 r3 P2：折叠态预览直接对 content 做 markdown 清洗，但旧正则只认闭合围栏，
// 未闭合 cc_rich 的 ```cc_rich + JSON 会泄漏。buildFoldedPreview 须先过
// stripRichFencesForPreview 把 cc_rich 围栏剔除。
describe("buildFoldedPreview · cc_rich 不泄漏", () => {
  it("未闭合 cc_rich：折叠预览无 ```cc_rich / JSON，前导文字保留", () => {
    const out = buildFoldedPreview('结论先行\n```cc_rich\n{"kind":"card","id":"x","title":"T"')
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
    expect(out).toContain("结论先行")
  })

  it("闭合 cc_rich：折叠预览显示 [卡片] 占位而非代码块/JSON", () => {
    const out = buildFoldedPreview('```cc_rich\n{"kind":"card","id":"x","title":"标题"}\n```')
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("title")
    expect(out).toContain("卡片")
  })

  it("普通代码围栏仍折叠成 [代码块]（不被 cc_rich 清理误伤）", () => {
    const out = buildFoldedPreview("```js\nconst a = 1\n```")
    expect(out).toContain("代码块")
  })

  // r5 P2（§17 override 后修）：buildFoldedPreview 下游贪婪正则 /```...```/ 不认围栏长度，
  // 把四反引号代码块里的三反引号 cc_rich 错误配对 → 残留 JSON。e2e 全链断言（上两次假绿
  // 就是只测 sanitizer 单元没测 buildFoldedPreview 全链）。
  it("r5：四反引号代码块内的 cc_rich 示例不泄漏（下游正则 e2e）", () => {
    const content = '````\n```cc_rich\n{"kind":"card","id":"x","title":"T"}\n```\n````'
    const out = buildFoldedPreview(content)
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
    expect(out).not.toContain("kind")
  })

  it("~~~~ tilde 外层围栏内的 cc_rich 不泄漏", () => {
    const content = '~~~~\n```cc_rich\n{"kind":"card","id":"x"}\n```\n~~~~'
    const out = buildFoldedPreview(content)
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
  })

  it("未闭合普通外层围栏内的 cc_rich 不泄漏", () => {
    const content = '````\n```cc_rich\n{"kind":"card","id":"x"}'
    const out = buildFoldedPreview(content)
    expect(out).not.toContain("cc_rich")
    expect(out).not.toContain("{")
  })
})
