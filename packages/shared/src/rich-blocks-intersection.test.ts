import assert from "node:assert/strict"
import test from "node:test"
import { stripRichFencesForPreview } from "./rich-blocks"

// F030 r8-P2（德彪 codex review 抓到）· 交叉围栏：preview-only 外层围栏 × main cc_rich 区间。
//
// 根因：main 行首锚定、不剥容器前缀；preview 为折叠容器卡片要 deprefix → preview 能开 main 认不出的
// **外层围栏**（`> ~~~` / 反向 marker / list 外层 / 缩进 / 不可见前缀）。该外层围栏的 strict-close 可能落在
// main 的某个 cc_rich 区间**内部** → preview 折叠边界与 main 卡片/隐藏区"交叉但非包含" → main 卡片化/隐藏的
// JSON 被 preview 当区间外正文漏出。"开栏 deprefix 超集"只覆盖开栏、不保证折叠区盖住 main rich 区。
//
// 修复（mainCcRichRegions 权威保护）：先按 main 精确语义算出 main 所有 cc_rich 区间（闭合/未闭合），
// preview 落入即按 main 处置（闭合→[卡片]跳过、未闭合→隐藏到 EOF），区间外才 deprefix-fold。
// 下列用例 main 都把 LEAK 卡片化或隐藏（不显原文）；preview 不得漏 LEAK。
const F = "```"
const T = "~~~"
const LEAK = '{"kind":"card","id":"x","title":"LEAK"}'

const cases: Array<{ desc: string; md: string }> = [
  // 德彪 r8-P2 原始反例：tilde 外层 + main 未闭合 backtick rich + 尾卡（main 隐藏[1,EOF]）
  { desc: "bq-tilde外层 + main未闭合 + 尾卡", md: `> ${T}\n${F}cc_rich\n{"a":1}\n${T}\n${LEAK}` },
  // 闭合卡片变体：tilde 外层在 main 闭合卡片区间内提前闭栏（main 卡片化[1,...]）
  { desc: "bq-tilde外层 在闭合卡区内提前闭栏", md: `> ${T}\n${F}cc_rich\n${T}\n${LEAK}\n${F}` },
  // 反向 marker：backtick 外层 + main 未闭合 tilde rich + 尾卡
  {
    desc: "反向 backtick外层 + main tilde未闭 + 尾卡",
    md: `> ${F}\n${T}cc_rich\n{"a":1}\n${F}\n${LEAK}`,
  },
  // list 外层
  { desc: "list-tilde外层 + main未闭合 + 尾卡", md: `- ${T}\n${F}cc_rich\n{"a":1}\n${T}\n${LEAK}` },
  // 嵌套 bq 外层
  { desc: "嵌套bq-tilde外层 + 闭合卡区内闭栏", md: `> > ${T}\n${F}cc_rich\n${LEAK}\n${T}\n${F}` },
  // 4 空格缩进外层（main MAIN_FENCE_OPEN 只容 ≤3 空格 → main 不认；preview deprefix 认）
  {
    desc: "4空格缩进外层 + main未闭合 + 尾卡",
    md: `    ${T}\n${F}cc_rich\n{"a":1}\n    ${T}\n${LEAK}`,
  },
  // 外层夹在两 main 卡片之间，close 落第二卡区内
  {
    desc: "外层夹两卡 + close落第二卡区",
    md: `${F}cc_rich\n{"kind":"card","id":"one","title":"ONE"}\n${F}\n> ${T}\n${F}cc_rich\n${LEAK}\n${T}\n${F}`,
  },
  // 外层未闭合折到 EOF，跨 main 闭合卡 + 区后 trailing
  {
    desc: "外层未闭合跨闭合卡 + 区后trailing",
    md: `> ${T}\n${F}cc_rich\n${LEAK}\n${F}\n后续 LEAK 文本`,
  },
]

for (const c of cases) {
  test(`交叉围栏回归 [${c.desc}]：preview 不漏 main 卡片化/隐藏的 JSON`, () => {
    const out = stripRichFencesForPreview(c.md)
    assert.ok(!out.includes("cc_rich"), `残留 cc_rich → ${JSON.stringify(out)}`)
    assert.ok(!out.includes('"kind"'), `残留 JSON → ${JSON.stringify(out)}`)
    assert.ok(!out.includes("LEAK"), `漏 main rich JSON → ${JSON.stringify(out)}`)
  })
}

// 负例：正常卡片仍折 [卡片]、容器卡片仍折叠（mainCcRichRegions 不破坏既有行为）
test("交叉围栏回归 [负例] 顶层正常卡片 → [卡片]", () => {
  assert.equal(stripRichFencesForPreview(`${F}cc_rich\n${LEAK}\n${F}`), "[卡片]")
})
test("交叉围栏回归 [负例] 容器卡片仍折叠不漏", () => {
  const out = stripRichFencesForPreview(`> ${F}cc_rich\n> ${LEAK}\n> ${F}`)
  assert.ok(!out.includes('"kind"') && !out.includes("LEAK"), `→ ${JSON.stringify(out)}`)
})

// 德彪 r9-P2 性能守卫：regionAt 单调游标使整体 O(lines+regions)。旧 regions.find 逐次从头扫 →
// R 个连续闭合卡 O(R²)，2 万卡 ~2 亿次比较（数秒，冻 UI/阻塞 API）。现 O(n) ~十几 ms。
// 阈值 1000ms 与 O(n²)(数秒) 干净分离、与实测 O(n)(~15ms) 留 60×+ 余量，不 flake。
test("交叉围栏回归 [perf] 2万连续闭合卡片 O(n) 不退化", () => {
  const one = `${F}cc_rich\n{"kind":"card","id":"x","title":"t"}\n${F}`
  const big = Array.from({ length: 20000 }, () => one).join("\n")
  const t0 = process.hrtime.bigint()
  const out = stripRichFencesForPreview(big)
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert.ok(!out.includes('"kind"'), "不漏 JSON")
  assert.equal(out, Array.from({ length: 20000 }, () => "[卡片]").join("\n"), "全 [卡片]")
  assert.ok(ms < 1000, `O(n²) 退化：20000 卡耗时 ${ms.toFixed(1)}ms（应 < 1000ms）`)
})
