import { z } from "zod"

// ── F030 Rich Blocks 协议 schema（单一真相源）────────────────────────
//
// agent → 小孙的只读卡片协议。通道：消息正文内联 ```cc_rich 围栏 JSON
// （单轨，MCP 推送轨推迟 F033 — final assistant 消息自动持久化 +
// post_message post-final lockout，MCP 轨够不着 review 结论场景）。
// 前端 normalize 层解析；本 schema 放 shared 供 F033 后端复用。
//
// 字段上限是 fail-closed 闸门的一部分：超限 = 整段围栏降级纯文本，
// 防 agent 把整篇 review 塞进卡片把 UI 撑爆。

export const RICH_FENCE_TAG = "cc_rich"

export const RichCardBlockSchema = z.object({
  kind: z.literal("card"),
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  bodyMarkdown: z.string().max(4000).optional(),
  tone: z.enum(["info", "success", "warning", "danger"]).optional(),
  fields: z
    .array(z.object({ label: z.string().min(1).max(40), value: z.string().max(200) }))
    .max(12)
    .optional(),
})

export const RichChecklistBlockSchema = z.object({
  kind: z.literal("checklist"),
  id: z.string().min(1).max(64),
  title: z.string().max(200).optional(),
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        text: z.string().min(1).max(200),
        checked: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(50)
    // item.id 直接做 React key（checklist-block.tsx），重复 id 会渲染不稳定 → 整块拒收
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
      message: "checklist item ids must be unique",
    }),
})

export const RichBlockSchema = z.discriminatedUnion("kind", [
  RichCardBlockSchema,
  RichChecklistBlockSchema,
])

export type RichCardBlock = z.infer<typeof RichCardBlockSchema>
export type RichChecklistBlock = z.infer<typeof RichChecklistBlockSchema>
export type RichBlock = z.infer<typeof RichBlockSchema>

// 围栏 marker（剥掉容器前缀后判定）：≥3 个 ` 或 ~，info string 跟其后。
const FENCE_DEPREFIXED_RE = /^(`{3,}|~{3,})(.*)$/
// 闭栏：同字符、长度 ≥ 开栏、其后只余空白（剥前缀后判定）。
const PREVIEW_CARD = "[卡片]"
const PREVIEW_CODE = "[代码块]"

/**
 * 剥离行首"容器前缀"——前导空白（含 NBSP/Tab/Unicode 空白）、blockquote `>`、list 标记，
 * 循环剥到行首不再是容器标记为止。**仅用于"这行是不是围栏开/闭"的检测，不改写输出内容。**
 *
 * 为什么要剥（F030 r6→r7 §17 二次 override）：旧 scanner 用绝对行首锚定的 FENCE_OPEN_RE，
 * 任何 CommonMark 容器（blockquote `> `、嵌套 `> > `、list `- `/`1. `/缩进）给每行加前缀，
 * 围栏就失认 → 透传 → 漏 cc_rich JSON 进摘要（workflow 穷尽枚举 56/63 实测泄漏）。
 * 安全语义：preview 单向——over-fold（折成 [卡片]/[代码块]）安全，leak（漏原始 JSON）不安全，
 * 故宁可多剥（连 4 空格缩进围栏也折叠）。逐行独立剥前缀 → blockquote lazy continuation
 * （开行带 `>`、body/close 裸奔）也能靠围栏开闭对整段折叠。
 */
function deprefixForFenceScan(line: string): string {
  let s = line
  for (;;) {
    const before = s
    // 前导空白 + Unicode 格式/不可见字符（\p{Cf}：ZWSP/WJ/LRM/RLM/软连字符/U+180E/BOM/bidi…）。
    // 对抗验证发现：JS \s 不含这批零宽字符，单 \s 会被它们当前缀绕过开栏检测漏 JSON。
    s = s.replace(/^[\s\p{Cf}]+/u, "")
    s = s.replace(/^>\s?/, "") // 一个 blockquote marker + 可选一个空白
    s = s.replace(/^(?:[-+*]|\d{1,9}[.)])\s+/, "") // 一个 list 标记 + 空白
    if (s === before) break
  }
  return s
}

// 复刻 main(parseRichSegments) 的精确围栏扫描，返回 main 的所有 **cc_rich 区间**（[start,end] 行内含；
// 闭合 → main 渲染成卡片不显 JSON 原文；未闭合 → main 隐藏 [start,EOF]）。普通围栏不入列（main 显原文）；
// 嵌在普通围栏里的 cc_rich 也不入列（main 当代码显原文）——与 parseRichSegments 一致。
//
// 为什么 preview 必须以此为准（德彪 r8-P2 交叉围栏）：main 行首锚定、不 deprefix；preview 为折叠容器
// 卡片要 deprefix → preview 能开 main 认不出的外层围栏（`> ~~~` / 反向 marker / list 外层）。该外层围栏
// 的 strict-close 可能落在 main 的某个 cc_rich 区间**内部**，把 preview 的折叠边界与 main 的卡片/隐藏
// 区间错位 → main 卡片化/隐藏的 JSON 被 preview 当区间外正文漏出（preview 折叠区与 main rich 区"交叉
// 但非包含"，"开栏 deprefix 超集"只覆盖开栏、不保证折叠区盖住 main rich 区）。故 preview 扫描时一旦
// 落入 main 的 cc_rich 区间：闭合 → 直接 [卡片]、跳到区间末；未闭合 → 隐藏到 EOF。区间外的行 main 必
// 显原文 → deprefix-fold 折它安全（over-fold，绝不比 main 多漏）。
const MAIN_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
type MainRichRegion = { start: number; end: number; unclosed: boolean }
function mainCcRichRegions(lines: string[]): MainRichRegion[] {
  const regions: MainRichRegion[] = []
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(MAIN_FENCE_OPEN)
    if (!m) {
      i += 1
      continue
    }
    const marker = m[1]
    const fenceChar = marker[0]
    const isRich = m[2].trim() === RICH_FENCE_TAG // main 精确匹配（大小写敏感、不容尾随词、不 deprefix）
    const closeRe = new RegExp(`^ {0,3}\\${fenceChar}{${marker.length},}\\s*$`)
    let j = i + 1
    while (j < lines.length && !closeRe.test(lines[j])) j += 1
    if (isRich) {
      if (j >= lines.length) {
        regions.push({ start: i, end: lines.length - 1, unclosed: true }) // main 隐藏 [i,EOF]
        break
      }
      regions.push({ start: i, end: j, unclosed: false }) // main 卡片化 [i,j]
      i = j + 1
    } else {
      // 普通围栏：main 显原文、其内 cc_rich 当代码——不入保护区；闭合跳过其区间，未闭合到 EOF
      i = j >= lines.length ? lines.length : j + 1
    }
  }
  return regions
}

/**
 * F030 · 展示摘要清理（折叠态预览 / 侧栏 last-message / session-group / bootstrap 摘要共用）。
 *
 * 主渲染（parseRichSegments）把 cc_rich 转卡片，但展示摘要面是直接 slice 原始 content 的，
 * 原始 ```cc_rich + JSON 会泄漏（小孙硬要求：摘要里任何时候不见 JSON）。本函数把**所有**围栏
 * 折叠成占位，绝不露围栏内文：
 *
 *   - cc_rich 围栏（info 首词忽略大小写 === cc_rich，容 `cc_rich extra` / `CC_RICH`）：
 *       闭合 → `[卡片]`；未闭合 → 整段隐藏（连同其后，前导保留，与主渲染"未闭合隐藏"一致）
 *   - 普通代码围栏（含其内部任何 cc_rich 示例行）→ 一律折叠成 `[代码块]`
 *       （r5 教训：保留普通围栏原文会让"四反引号包三反引号 cc_rich"的内层 JSON 漏出侧栏）
 *
 * 两道防线：
 *   1. **权威保护（r8/r9 · mainCcRichRegions）**：先按 main 精确语义算出 main 的所有 cc_rich 区间，preview
 *      落入即按 main 处置（闭合→[卡片] 跳过、未闭合→隐藏到 EOF）。这保证 preview 绝不漏 main 卡片化/隐藏
 *      的 JSON——deprefix 折叠的外层围栏与 main rich 区"交叉但非包含"时也不漏（德彪 r8-P2）。
 *   2. **容器感知 deprefix（r6→r7 保留）**：区间外的行 main 必显原文，再 deprefixForFenceScan 剥容器前缀
 *      （blockquote/嵌套/list/缩进/不可见前缀）折叠容器围栏成 [卡片]/[代码块]（over-fold，对称安全）。
 * 行模型：split("\n") 与 main 完全一致（不 split U+2028/U+2029/U+0085/lone-CR——见下）。
 * 历轮教训：[[多实现分裂]] —— 6 个摘要面全部复用本函数，一处修全。
 */
export function stripRichFencesForPreview(content: string): string {
  // 行模型必须与 main(parseRichSegments) **完全一致**：main 用 content.split("\n")。preview 只要比 main
  // 多切一行（任何额外分隔符——U+2028/U+2029/U+0085 或 lone-\r），就会在 main 视作单行的内容里多认一个
  // 闭栏 → 提前闭合后把 main 隐藏/卡片化的 JSON 漏成正文（dual-oracle 实测：U+2028 嵌 JSON 体、\r 诱饵
  // 闭栏两类"main 隐藏/卡片化、preview 泄漏"的反向不对称，与德彪 r7-P2 同源）。故严格只 split \n。
  const lines = content.split("\n")
  // 权威保护：先按 main 精确语义算出 main 的所有 cc_rich 区间（闭合卡片 / 未闭合隐藏）。preview 扫描
  // 一旦落入某区间，直接按 main 的处置（闭合→[卡片] 跳过、未闭合→隐藏到 EOF），**不让 deprefix 折叠的
  // 边界与 main rich 区错位漏 JSON**（德彪 r8-P2 交叉围栏：preview-only 外层围栏在 main 卡片/隐藏区内
  // 提前闭栏 → 漏区间外正文）。区间外的行 main 必显原文 → 走下方 deprefix-fold 折容器围栏（over-fold 安全）。
  const regions = mainCcRichRegions(lines)
  // 区间已按 start 升序、互不重叠；下方 while 循环里 i 单调不减 → 用**单调游标**查询，整体
  // O(lines + regions)。不用 regions.find 逐次从头扫（德彪 r9-P2：R 个连续闭合卡 → O(R²)，2 万围栏
  // ~2 亿次比较，本函数跑在客户端气泡 + 多条服务端 session 列表路径，会冻 UI / 阻塞 API）。
  // while 推进游标越过所有 end<idx 的区间后，regions[ri].end ≥ idx，故只需再判 idx ≥ start。
  let ri = 0
  const regionAt = (idx: number): MainRichRegion | undefined => {
    while (ri < regions.length && regions[ri].end < idx) ri += 1
    const r = regions[ri]
    return r && idx >= r.start ? r : undefined
  }
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const region = regionAt(i)
    if (region) {
      if (region.unclosed) break // main 隐藏 [start,EOF]：preview 同隐藏（前导已在 out）
      out.push(PREVIEW_CARD) // main 卡片化该区间：preview 出 [卡片]，整段跳过（含非法 JSON 也折，绝不漏）
      i = region.end + 1
      continue
    }
    const deprefixed = deprefixForFenceScan(lines[i])
    const open = deprefixed.match(FENCE_DEPREFIXED_RE)
    if (!open) {
      out.push(lines[i]) // 非围栏行：原样保留（含 `>`/`-` 前缀，交调用方后续清洗）
      i += 1
      continue
    }
    const marker = open[1]
    const fenceChar = marker[0]
    const firstToken = open[2].trim().split(/\s+/)[0] ?? ""
    const isRich = firstToken.toLowerCase() === RICH_FENCE_TAG
    // 闭栏 = main(parseRichSegments) 同款 strict：≤3 空格、不剥容器前缀，对所有开栏一致。
    // 配合"开栏 deprefix 超集"形成干净的包含关系——主能出卡片的（开栏+strict 闭栏齐）preview
    // 必折同一闭栏；主未闭合的 preview 也未闭合 → 隐藏。**不对闭栏候选做 deprefix**：否则 body 里
    // 一行 `> ``` `/`- ``` `/4 空格 ``` 被剥成裸围栏当 close 提前闭合，而主判未闭合隐藏 → 主隐藏
    // 预览漏后文（德彪 r7-P2）。容器/缩进卡片若闭栏带前缀，strict 认不出 → 按未闭合 fail-closed
    // （cc_rich 隐藏 / 普通围栏折到文末），over-fold 安全、绝不漏 JSON。
    const strictCloseRe = new RegExp(`^ {0,3}\\${fenceChar}{${marker.length},}\\s*$`)
    let j = i + 1
    while (j < lines.length && !strictCloseRe.test(lines[j])) j += 1
    const closed = j < lines.length

    if (isRich && !closed) break // 未闭合 cc_rich：隐藏围栏自身及其后，前导（已在 out）保留
    out.push(isRich ? PREVIEW_CARD : PREVIEW_CODE)
    i = (closed ? j : lines.length - 1) + 1
  }
  return out.join("\n")
}
