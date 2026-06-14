import assert from "node:assert/strict"
import test from "node:test"
import { stripRichFencesForPreview } from "./rich-blocks"

// F030 r8（§17 二次 override 续 · dual-oracle 抓自己的假绿）。
//
// 背景：preview(stripRichFencesForPreview) 与 main(parseRichSegments) 是两个独立围栏扫描器。
// main 用 content.split("\n") 切行、isRich 精确 info==="cc_rich"。c1b9a3f 曾把 preview 的 split
// 扩成多分隔符（U+2028/U+2029/U+0085），本意兜"非常规分隔符整段塌行"。但 dual-oracle（preview vs
// 真 parseRichSegments 回喂）实测这制造了**反向**不对称泄漏：
//   ① U+2028/U+2029/U+0085 在合法 JSON 字符串里是合法字符（JSON.parse 不当换行、main 也只 split \n）。
//      卡片 JSON 体内出现 "A<sep>```<sep>LEAK" 时，main 单 \n 行 parse 成干净卡片；旧 preview 在 sep 处
//      多切一行、把体内 ``` 当**早闭栏** → 折 [卡片] 后漏 JSON 尾。
//   ② r8 预检 workflow（220 对抗语料）又抓到 \r 诱饵闭栏（G18）：顶层开栏 + body 一行 `{"a":1}\r```\`
//      对 main 是单 \n 行（非闭栏）→ main 扫到 EOF 未闭合**隐藏**；preview 若 split \r 就把它切出早闭栏
//      → 折后漏尾随真卡 JSON。
//
// **定论：preview 只要比 main 多切任何分隔符，就会在 main 视作单行的内容里多认一个闭栏 → 提前闭合后
// 把 main 隐藏/卡片化的 JSON 漏成正文。故 split 严格 == main 的 content.split("\n")。** 同模型下开栏
// deprefix 是 main 超集、闭栏与 main 同款 strict → preview 折叠区 ⊇ main 卡片/隐藏区 → 结构上不可能
// 漏 main 隐藏/卡片化的 JSON。分隔符全部用 fromCharCode 运行时构造，避免源码不可见字符歧义。
const LS = String.fromCharCode(0x2028) // U+2028 line separator
const PS = String.fromCharCode(0x2029) // U+2029 paragraph separator
const NEL = String.fromCharCode(0x0085) // U+0085 NEL
const CR = String.fromCharCode(0x000d) // lone CR
const F = "```"

const embedSepCases: Array<{ desc: string; sep: string }> = [
  { desc: "U+2028", sep: LS },
  { desc: "U+2029", sep: PS },
  { desc: "U+0085 NEL", sep: NEL },
]

for (const c of embedSepCases) {
  // 卡片 title 内含 A<sep>```<sep>LEAK：对 main 是单 \n 行的合法 JSON，出干净卡片；
  // preview 必须整段折成 [卡片]，不得把内嵌 ``` 当早闭栏漏出 LEAK"}。
  test(`卡片体内嵌分隔符回归 [${c.desc}+围栏+${c.desc}]：preview 不漏 JSON`, () => {
    const md = `${F}cc_rich\n{"kind":"card","id":"x","title":"A${c.sep}${F}${c.sep}LEAK"}\n${F}`
    const out = stripRichFencesForPreview(md)
    assert.ok(!out.includes("cc_rich"), `残留 cc_rich → ${JSON.stringify(out)}`)
    assert.ok(!out.includes('"kind"'), `残留 JSON → ${JSON.stringify(out)}`)
    assert.ok(!out.includes("LEAK"), `漏 JSON 尾 → ${JSON.stringify(out)}`)
    assert.equal(out, "[卡片]", `应整段折叠 → ${JSON.stringify(out)}`)
  })

  // fields.value 内嵌分隔符夹围栏：同理 preview 不得提前闭栏。
  test(`卡片体内嵌分隔符回归 [${c.desc} 夹围栏行]：preview 不漏 JSON`, () => {
    const md = `${F}cc_rich\n{"kind":"card","id":"x","title":"T","fields":[{"label":"a${c.sep}${F}${c.sep}b","value":"LEAK"}]}\n${F}`
    const out = stripRichFencesForPreview(md)
    assert.ok(!out.includes("cc_rich"), `残留 cc_rich → ${JSON.stringify(out)}`)
    assert.ok(!out.includes('"kind"'), `残留 JSON → ${JSON.stringify(out)}`)
    assert.ok(!out.includes("LEAK"), `漏 JSON 尾 → ${JSON.stringify(out)}`)
  })
}

// r8 预检 workflow G18：\r 诱饵闭栏。顶层 cc_rich + body 一行含 \r + 三反引号（对 main 是单 \n 行、
// 非闭栏 → 未闭合隐藏到 EOF）；preview 不得 split \r 把它当早闭栏后漏尾随真卡 JSON。两层都应隐藏。
test("CR 诱饵闭栏回归 [body 含 \\r+围栏，尾随真卡]：preview 不漏 JSON（随 main 隐藏）", () => {
  const md = `${F}cc_rich\n{"a":1}${CR}${F}\n{"kind":"card","id":"g18","title":"LEAKG18"}${CR}${F}`
  const out = stripRichFencesForPreview(md)
  assert.ok(!out.includes("cc_rich"), `残留 cc_rich → ${JSON.stringify(out)}`)
  assert.ok(!out.includes('"kind"'), `残留 JSON → ${JSON.stringify(out)}`)
  assert.ok(!out.includes("LEAKG18"), `漏 JSON 尾 → ${JSON.stringify(out)}`)
})

// 对称性说明（非泄漏，out-of-scope）：把 U+2028/U+2029/CRLF/lone-CR 当**整段行分隔符**（fence 与
// body 之间不用 \n 而用这些分隔符）的输入，main 视作单 \n 行 → info 不等于 "cc_rich"（或开栏带尾随
// \r 失认）→ 当普通围栏/纯文本显原文，preview 同样透传 → **两层对称、main 也漏**。preview 的职责是
// "不比 main 多漏"，对称情形不在范围内。故不再断言 preview 必须折叠这类塌行输入（c1b9a3f 多分隔符
// split 的过严断言已随 split 回退 \n-only 移除——正是那些多切制造了上面的不对称泄漏）。
test("对称 out-of-scope：塌行输入 preview 透传 == main 透传（不构成不对称泄漏）", () => {
  for (const sep of [LS, PS, CR]) {
    const md = `${F}cc_rich${sep}{"kind":"card","id":"x","title":"t"}${sep}${F}`
    // 只确认不抛异常、行为确定（与 main 对称由 .runtime dual-oracle 守，非本单测可 import main）。
    assert.equal(typeof stripRichFencesForPreview(md), "string")
  }
})
