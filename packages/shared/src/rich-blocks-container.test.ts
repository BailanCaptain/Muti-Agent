import assert from "node:assert/strict"
import test from "node:test"
import { stripRichFencesForPreview } from "./rich-blocks"

// F030 r6→r7（§17 二次 override）：容器/编码围栏泄漏矩阵。
// 根因：FENCE_OPEN_RE 行首绝对锚定 + 只容 ≤3 空格 → CommonMark 容器前缀（blockquote >、
// list 标记/缩进）、CRLF \r、NBSP、Tab、大小写/变体 info string 都让围栏失认 → 透传漏 cc_rich JSON。
// 来源：workflow f030-fence-leak-enumerate 穷尽枚举（blockquote/list/marker/pathological 4 路 + 实测）。
// 安全语义：preview 单向——over-fold（折成 [卡片]/[代码块]）安全，leak（漏原始 JSON）不安全。

// 泄漏用例：修复后两种模式（default 给 slice 面 / placeholder 给折叠面）都不得残留 cc_rich 或 JSON 签名。
const LEAK_CASES: Array<{ desc: string; md: string }> = [
  // —— blockquote ——
  { desc: "bq 单层", md: '> ```cc_rich\n> {"kind":"card","id":"x"}\n> ```' },
  { desc: "bq 嵌套两层", md: '> > ```cc_rich\n> > {"kind":"card","id":"n"}\n> > ```' },
  { desc: "bq 嵌套三层", md: '> > > ```cc_rich\n> > > {"kind":"card","id":"d3"}\n> > > ```' },
  { desc: "bq 无空格 >```", md: '>```cc_rich\n>{"kind":"card","id":"ns"}\n>```' },
  { desc: "bq lazy：body 裸奔", md: '> ```cc_rich\n{"kind":"card","id":"lazy"}\n```' },
  { desc: "bq lazy：close 裸奔", md: '> ```cc_rich\n> {"kind":"card","id":"cb"}\n```' },
  {
    desc: "bq 四反引号包三反引号",
    md: '> ````\n> ```cc_rich\n> {"kind":"card","id":"4t"}\n> ```\n> ````',
  },
  { desc: "bq 未闭合", md: '> 看：\n> ```cc_rich\n> {"kind":"card","id":"u"}' },
  { desc: "bq tilde 围栏", md: '> ~~~cc_rich\n> {"kind":"card","id":"tld"}\n> ~~~' },
  { desc: "bq 前导 ≤3 空格缩进", md: '   > ```cc_rich\n   > {"kind":"card","id":"i"}\n   > ```' },
  { desc: "bq Tab 分隔", md: '>\t```cc_rich\n>\t{"kind":"card","id":"tab"}\n>\t```' },
  { desc: "bq 混合空格", md: '> ```cc_rich\n>{"kind":"card","id":"mix"}\n>```' },
  { desc: "bq 前导文字 + 卡片", md: '> 引用开头\n> ```cc_rich\n> {"kind":"card"}\n> ```' },
  // —— list ——
  {
    desc: "list 无序 4 空格缩进",
    md: '- 评审：\n\n    ```cc_rich\n    {"kind":"card","id":"li4"}\n    ```',
  },
  {
    desc: "list 有序两位数 10.",
    md: '10. 第十项\n\n    ```cc_rich\n    {"kind":"card","id":"o10"}\n    ```',
  },
  { desc: "list 同行起围栏 -", md: '- ```cc_rich\n  {"kind":"card","id":"same"}\n  ```' },
  { desc: "list 同行起围栏 1.", md: '1. ```cc_rich\n   {"kind":"card","id":"osame"}\n   ```' },
  {
    desc: "list 三级嵌套 8 空格",
    md: '- L1\n  - L2\n    - L3\n\n        ```cc_rich\n        {"kind":"card","id":"deep3"}\n        ```',
  },
  {
    desc: "list * 标记 4 空格",
    md: '* 状态\n\n    ```cc_rich\n    {"kind":"card","id":"star"}\n    ```',
  },
  // —— marker / 编码 ——
  { desc: "NBSP 前缀", md: ' ```cc_rich\n{"kind":"card","id":"nbsp"}\n```' },
  { desc: "大写 CC_RICH", md: '```CC_RICH\n{"kind":"card","id":"up"}\n```' },
  { desc: "info 带尾随词 cc_rich extra", md: '```cc_rich extra\n{"kind":"card","id":"ex"}\n```' },
  { desc: "驼峰 Cc_Rich", md: '```Cc_Rich\n{"kind":"card","id":"cap"}\n```' },
  { desc: "纯 4 空格缩进", md: '正文\n    ```cc_rich\n    {"kind":"card","id":"ind4"}\n    ```' },
  { desc: "Tab 缩进前缀", md: '正文\n\t```cc_rich\n\t{"kind":"card","id":"tabind"}\n\t```' },
  // —— pathological 组合 ——
  {
    desc: "bq + list 混合前缀",
    md: '> - 见下：\n>   ```cc_rich\n>   {"kind":"card","id":"deep"}\n>   ```',
  },
  {
    desc: "bq 内 4 空格再缩进",
    md: '> 见：\n>     ```cc_rich\n>     {"kind":"card","id":"dbl"}\n>     ```',
  },
  {
    desc: "嵌套围栏 + bq",
    md: '> ````md\n> ```cc_rich\n> {"kind":"card","id":"nf"}\n> ```\n> ````',
  },
]

for (const c of LEAK_CASES) {
  test(`容器泄漏矩阵 [${c.desc}]：不漏 cc_rich/JSON`, () => {
    const out = stripRichFencesForPreview(c.md)
    assert.ok(!out.includes("cc_rich"), `残留 cc_rich → "${out}"`)
    assert.ok(!out.includes('"kind"'), `残留 JSON → "${out}"`)
  })
}

// —— 对抗验证（workflow f030-fence-leak-adversarial）补充的 in-scope 绕过向量 ——
// Unicode 不可见/格式字符（JS \s 不含，deprefix 用 \p{Cf} 兜）+ 非常规行分隔符 + false-close。
const ADVERSARIAL_CASES: Array<{ desc: string; md: string }> = [
  { desc: "ZWSP(U+200B) 前缀", md: '​```cc_rich\n{"kind":"card","id":"x"}\n```' },
  { desc: "WJ(U+2060) 前缀", md: '⁠```cc_rich\n{"kind":"card","id":"x"}\n```' },
  { desc: "LRM(U+200E) 前缀", md: '‎```cc_rich\n{"kind":"card","id":"x"}\n```' },
  { desc: "RLM(U+200F) 前缀", md: '‏```cc_rich\n{"kind":"card","id":"x"}\n```' },
  { desc: "soft-hyphen(U+00AD) 前缀", md: '­```cc_rich\n{"kind":"card","id":"x"}\n```' },
  { desc: "U+180E 前缀", md: '᠎```cc_rich\n{"kind":"card","id":"x"}\n```' },
  { desc: "bq + ZWSP", md: '> ​```cc_rich\n> {"kind":"card","id":"x"}\n> ```' },
  { desc: "list + ZWSP", md: '- ​```cc_rich\n- {"kind":"card","id":"x"}\n- ```' },
  { desc: "ZWSP 开栏+闭栏", md: '​```cc_rich\n{"kind":"card","id":"x"}\n​```' },
  { desc: "NBSP+ZWSP 混合前缀", md: ' ​```cc_rich\n{"kind":"card","id":"x"}\n```' },
  { desc: "false-close bq 伪闭栏", md: '```cc_rich\n> ```\n{"kind":"card","id":"d5"}\n```' },
  { desc: "false-close list 伪闭栏", md: '```cc_rich\n- ```\n{"kind":"card","id":"d6"}\n```' },
  { desc: "false-close 4空格伪闭栏", md: '```cc_rich\n    ```\n{"kind":"card","id":"d7"}\n```' },
  // 德彪 r7-P2：顶层开栏 + body 伪闭栏 + 无最终 strict 闭栏 → 主判未闭合隐藏，预览不得 loose 回退漏后文
  {
    desc: "r7-P2 bq 伪闭栏无最终闭栏",
    md: '```cc_rich\n> ```\n{"kind":"card","id":"x","title":"LEAK"}',
  },
  {
    desc: "r7-P2 list 伪闭栏无最终闭栏",
    md: '```cc_rich\n- ```\n{"kind":"card","id":"x","title":"LEAK"}',
  },
  {
    desc: "r7-P2 4空格伪闭栏无最终闭栏",
    md: '```cc_rich\n    ```\n{"kind":"card","id":"x","title":"LEAK"}',
  },
]

for (const c of ADVERSARIAL_CASES) {
  test(`对抗向量 [${c.desc}]：不漏 cc_rich/JSON`, () => {
    const out = stripRichFencesForPreview(c.md)
    assert.ok(!out.includes("cc_rich"), `残留 cc_rich → "${out}"`)
    assert.ok(!out.includes('"kind"'), `残留 JSON → "${out}"`)
  })
}

// 顶层 cc_rich 开栏 + 带容器前缀的"闭栏"（CommonMark 下不构成顶层闭栏）→ 未闭合。
// 德彪 r7-P2 定论：未闭合两层都隐藏（main 也隐藏到 EOF）——预览不得用 loose 回退把 `> ``` `
// 当闭栏、再漏其后 JSON/正文。安全语义优先于"保留后文"：宁可隐藏，绝不漏 JSON。
test("容器泄漏矩阵 [闭栏带 bq 前缀·无最终 strict 闭栏]：未闭合 → 隐藏，不漏 JSON", () => {
  const md = '```cc_rich\n{"kind":"card","id":"uc"}\n> ```\n小孙请看结论。'
  const out = stripRichFencesForPreview(md)
  assert.ok(!out.includes('"kind"'), `残留 JSON → "${out}"`)
  assert.ok(!out.includes("cc_rich"), `残留 cc_rich → "${out}"`)
})

// —— 负例：合法内容不能被过度折叠/破坏 ——
test("负例：blockquote 纯引用文字不被折叠", () => {
  const out = stripRichFencesForPreview("> 这是一句引用，没有卡片。")
  assert.ok(out.includes("这是一句引用"), `引用正文不应丢 → "${out}"`)
})

test("负例：list 纯文本项保留", () => {
  const out = stripRichFencesForPreview("- 第一项\n- 第二项")
  assert.ok(out.includes("第一项") && out.includes("第二项"), `list 文本不应丢 → "${out}"`)
})

test("顶层普通 ```js 折叠成 [代码块]（always-fold）", () => {
  assert.equal(stripRichFencesForPreview("```js\nconst a = 1\n```"), "[代码块]")
})

test("负例：行首以 > 开头但非围栏的正文，剥前缀不致误删内容", () => {
  const out = stripRichFencesForPreview("> 引用第一行\n> 引用第二行带 > 符号")
  assert.ok(out.includes("引用第一行") && out.includes("引用第二行"), `→ "${out}"`)
})
