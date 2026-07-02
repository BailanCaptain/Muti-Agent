import { RICH_FENCE_TAG, RichBlockSchema } from "@multi-agent/shared"
import type {
  CardBlock,
  ChecklistBlock,
  MarkdownBlock,
  ProgressBlock,
  TableBlock,
} from "./blocks"

/**
 * F030 AC3/AC4 · cc_rich 内联围栏解析器。
 *
 * 通道单轨：agent 在消息正文写 ```cc_rich 围栏 JSON，本函数在渲染层把
 * content 切成 markdown / card / checklist 交错段。块内嵌于消息体 →
 * 与消息的绑定是结构性的，不存在"迟到块挂错气泡"路径（clowder F096 B4
 * 的反面教材是异步推送通道）。
 *
 * fail-closed：JSON 非法 / schema 不过 / 超出每消息上限 → 整段围栏原文
 * 保留为 markdown（用户看到的是代码块，不崩渲染）。同 id 重复块只保留
 * 第一个。未闭合围栏（流式中途）不产块。
 */

const MAX_RICH_BLOCKS_PER_MESSAGE = 8

export type RichSegment =
  | MarkdownBlock
  | CardBlock
  | ChecklistBlock
  | TableBlock
  | ProgressBlock

// CommonMark：围栏 = 行首 ≤3 空格 + ≥3 个 ` 或 ~，info string 跟在后面。
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/

type Scanner = {
  segments: RichSegment[]
  markdownBuffer: string[]
  seenIds: Set<string>
  emitted: number
}

function flushMarkdown(s: Scanner) {
  // 原文逐字保留（r1 P2-1）：trim 只用于"整段是否空白"判断，绝不改写内容——
  // 否则首行 4 空格缩进代码会被吃掉缩进，违反无围栏消息不回归。
  const text = s.markdownBuffer.join("\n")
  s.markdownBuffer = []
  if (!text.trim()) return
  const last = s.segments[s.segments.length - 1]
  if (last && last.kind === "markdown") {
    last.content = `${last.content}\n${text}`
  } else {
    s.segments.push({ kind: "markdown", content: text })
  }
}

function tryEmitRichBlock(s: Scanner, rawLines: string[], jsonLines: string[]): void {
  const degrade = () => s.markdownBuffer.push(...rawLines)
  if (s.emitted >= MAX_RICH_BLOCKS_PER_MESSAGE) {
    degrade()
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonLines.join("\n"))
  } catch {
    degrade()
    return
  }
  const result = RichBlockSchema.safeParse(parsed)
  if (!result.success) {
    degrade()
    return
  }
  if (s.seenIds.has(result.data.id)) {
    // 同消息内重复 id：保留第一个，后续静默丢弃（AC4 去重）
    return
  }
  s.seenIds.add(result.data.id)
  s.emitted += 1
  flushMarkdown(s)
  s.segments.push(result.data as CardBlock | ChecklistBlock | TableBlock | ProgressBlock)
}

export function parseRichSegments(content: string): RichSegment[] {
  const lines = content.split("\n")
  const s: Scanner = { segments: [], markdownBuffer: [], seenIds: new Set(), emitted: 0 }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const open = line.match(FENCE_OPEN)
    if (!open) {
      s.markdownBuffer.push(line)
      i += 1
      continue
    }

    const marker = open[1]
    const info = open[2].trim()
    const fenceChar = marker[0]
    // r1 P2-2：``` 与 ~~~ 两种 CommonMark 围栏 marker 都接受 cc_rich
    const isRich = info === RICH_FENCE_TAG
    // 闭栏：同字符、长度 ≥ 开栏、无 info string（CommonMark）
    const closeRe = new RegExp(`^ {0,3}\\${fenceChar}{${marker.length},}\\s*$`)

    let j = i + 1
    while (j < lines.length && !closeRe.test(lines[j])) j += 1

    if (j >= lines.length) {
      // 未闭合围栏：
      //   - cc_rich → 整段不渲染（围栏原文不进 markdown）。判断只看"闭没闭合"，不依赖流式
      //     状态：流式中该段留空、闭合后直接出卡片；final 漏闭合则半截 JSON 对用户无价值，
      //     也不显示黑框源码。小孙 AC6 硬要求"任何时候不想看见黑框"。
      //   - 普通代码围栏未闭合 → 原文进 markdown（fail-closed，正常代码块本就该显示）
      if (isRich) {
        flushMarkdown(s)
      } else {
        s.markdownBuffer.push(...lines.slice(i))
      }
      i = lines.length
      break
    }

    if (isRich) {
      tryEmitRichBlock(s, lines.slice(i, j + 1), lines.slice(i + 1, j))
    } else {
      // 其他代码围栏：整段（含内部任何 cc_rich 行）原样保留
      s.markdownBuffer.push(...lines.slice(i, j + 1))
    }
    i = j + 1
  }

  flushMarkdown(s)
  return s.segments
}
