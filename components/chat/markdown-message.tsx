"use client"

import { Fragment, type ReactNode } from "react"

type MarkdownMessageProps = {
  content: string
  inverted?: boolean
  className?: string
}

type ListKind = "ol" | "ul"

type ListItem = {
  content: string
  checked: boolean | null
  children: ListGroup[]
}

type ListGroup = {
  kind: ListKind
  items: ListItem[]
}

function normalizeIndent(value: string) {
  return value.replace(/\t/g, "  ").length
}

function nextOccurrenceKey(seen: Map<string, number>, seed: string) {
  const count = seen.get(seed) ?? 0
  seen.set(seed, count + 1)
  return `${seed}-${count}`
}

function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern =
    /(\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)]+\)|https?:\/\/[^\s<]+|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|(?<![\w/])@[A-Za-z0-9._-]+)/g
  let lastIndex = 0
  let key = 0

  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    const index = match.index ?? 0

    if (index > lastIndex) {
      nodes.push(text.slice(lastIndex, index))
    }

    if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)]+)\)$/)
      if (linkMatch) {
        nodes.push(
          <a
            className="font-medium text-orange-600 underline decoration-orange-300/50 underline-offset-[3px] transition hover:decoration-orange-500"
            href={linkMatch[2]}
            key={`inline-${key}`}
            rel="noreferrer"
            target="_blank"
          >
            {linkMatch[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    } else if (token.startsWith("http://") || token.startsWith("https://")) {
      nodes.push(
        <a
          className="font-medium text-orange-600 underline decoration-orange-300/50 underline-offset-[3px] transition hover:decoration-orange-500"
          href={token}
          key={`inline-${key}`}
          rel="noreferrer"
          target="_blank"
        >
          {token}
        </a>,
      )
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[0.88em] text-slate-700"
          key={`inline-${key}`}
        >
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={`inline-${key}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={`inline-${key}`}>{token.slice(2, -2)}</del>)
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={`inline-${key}`}>{token.slice(1, -1)}</em>)
    } else if (token.startsWith("@")) {
      nodes.push(
        <span
          className="inline-flex rounded-full border border-emerald-200/80 bg-emerald-50 px-2 py-0.5 font-mono text-[0.82em] font-medium text-emerald-700"
          key={`inline-${key}`}
        >
          {token}
        </span>,
      )
    } else {
      nodes.push(token)
    }

    lastIndex = index + token.length
    key += 1
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function renderParagraph(lines: string[], key: string) {
  const seen = new Map<string, number>()

  return (
    <p key={key}>
      {lines.map((line) => {
        const lineKey = nextOccurrenceKey(seen, line)

        return (
          <Fragment key={`${key}-${lineKey}`}>
            {lineKey !== `${line}-0` ? <br /> : null}
            {parseInline(line)}
          </Fragment>
        )
      })}
    </p>
  )
}

function renderBlockquote(lines: string[], key: string) {
  const seen = new Map<string, number>()

  return (
    <blockquote className="border-l-[3px] border-emerald-400/60 pl-4 text-slate-500" key={key}>
      {lines.map((line) => {
        const normalized = line.replace(/^>\s?/, "")
        const lineKey = nextOccurrenceKey(seen, normalized)

        return (
          <Fragment key={`${key}-${lineKey}`}>
            {lineKey !== `${normalized}-0` ? <br /> : null}
            {parseInline(normalized)}
          </Fragment>
        )
      })}
    </blockquote>
  )
}

function renderCodeBlock(language: string | null, lines: string[], key: string) {
  const code = lines.join("\n")

  return (
    <div
      className="overflow-hidden rounded-xl border border-slate-200/80 bg-slate-900 text-white"
      key={key}
    >
      {language ? (
        <div className="border-b border-white/10 px-4 py-1.5 text-[11px] font-medium uppercase tracking-[0.15em] text-white/50">
          {language}
        </div>
      ) : null}
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderHeading(line: string, key: string) {
  const match = line.match(/^(#{1,6})\s+(.*)$/)
  if (!match) {
    return renderParagraph([line], key)
  }

  const level = Math.min(match[1].length, 6)
  const text = match[2]
  const className =
    level === 1
      ? "text-lg font-bold text-slate-800"
      : level === 2
        ? "text-base font-bold text-slate-800"
        : "text-[15px] font-semibold text-slate-700"

  if (level === 1) {
    return (
      <h1 className={className} key={key}>
        {parseInline(text)}
      </h1>
    )
  }

  if (level === 2) {
    return (
      <h2 className={className} key={key}>
        {parseInline(text)}
      </h2>
    )
  }

  if (level === 3) {
    return (
      <h3 className={className} key={key}>
        {parseInline(text)}
      </h3>
    )
  }

  if (level === 4) {
    return (
      <h4 className={className} key={key}>
        {parseInline(text)}
      </h4>
    )
  }

  if (level === 5) {
    return (
      <h5 className={className} key={key}>
        {parseInline(text)}
      </h5>
    )
  }

  return (
    <h6 className={className} key={key}>
      {parseInline(text)}
    </h6>
  )
}

function isHorizontalRule(line: string) {
  return /^(\s*)(-{3,}|\*{3,}|_{3,})(\s*)$/.test(line)
}

function parseTableRow(line: string) {
  if (!line.includes("|")) {
    return null
  }

  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  const cells = trimmed.split("|").map((cell) => cell.trim())
  return cells.length > 1 ? cells : null
}

function isTableDivider(line: string) {
  const cells = parseTableRow(line)
  return Boolean(cells?.every((cell) => /^:?-{3,}:?$/.test(cell)))
}

function renderTable(lines: string[], key: string) {
  const header = parseTableRow(lines[0]) ?? []
  const body = lines.slice(2).map((line) => parseTableRow(line) ?? [])
  const headerSeen = new Map<string, number>()
  const rowSeen = new Map<string, number>()

  return (
    <div className="overflow-x-auto" key={key}>
      <table className="min-w-full border-collapse overflow-hidden rounded-xl border border-slate-200/80 text-left text-[13px]">
        <thead className="bg-slate-50">
          <tr>
            {header.map((cell) => {
              const cellKey = nextOccurrenceKey(headerSeen, cell)

              return (
                <th
                  className="border-b border-slate-200/80 px-3 py-2 font-semibold text-slate-600"
                  key={`${key}-head-${cellKey}`}
                >
                  {parseInline(cell)}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {body.map((row) => {
            const rowKey = nextOccurrenceKey(rowSeen, row.join("|"))
            const cellSeen = new Map<string, number>()
            const normalizedRow = header.map((_, index) => row[index] ?? "")

            return (
              <tr className="border-t border-slate-100" key={`${key}-row-${rowKey}`}>
                {normalizedRow.map((cell) => {
                  const cellKey = nextOccurrenceKey(cellSeen, cell)

                  return (
                    <td
                      className="px-3 py-2 align-top text-slate-600"
                      key={`${key}-cell-${rowKey}-${cellKey}`}
                    >
                      {parseInline(cell)}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function parseListLine(line: string) {
  const match = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/)
  if (!match) {
    return null
  }

  const indent = normalizeIndent(match[1])
  const kind: ListKind = /^\d+\.$/.test(match[2]) ? "ol" : "ul"
  const taskMatch = match[3].match(/^\[( |x|X)\]\s+(.*)$/)

  return {
    indent,
    kind,
    content: taskMatch ? taskMatch[2] : match[3],
    checked: taskMatch ? taskMatch[1].toLowerCase() === "x" : null,
  }
}

function buildListGroup(lines: string[], startIndex: number, indent: number) {
  const first = parseListLine(lines[startIndex])
  if (!first) {
    return null
  }

  const group: ListGroup = {
    kind: first.kind,
    items: [],
  }

  let index = startIndex

  while (index < lines.length) {
    const parsed = parseListLine(lines[index])
    if (!parsed) {
      break
    }

    if (parsed.indent < indent) {
      break
    }

    if (parsed.indent > indent) {
      const nested = buildListGroup(lines, index, parsed.indent)
      if (!nested || group.items.length === 0) {
        break
      }

      group.items[group.items.length - 1].children.push(nested.group)
      index = nested.nextIndex
      continue
    }

    if (parsed.kind !== group.kind) {
      break
    }

    group.items.push({
      content: parsed.content,
      checked: parsed.checked,
      children: [],
    })
    index += 1
  }

  return { group, nextIndex: index }
}

function renderListGroup(group: ListGroup, key: string): ReactNode {
  const ListTag = group.kind
  const itemSeen = new Map<string, number>()

  return (
    <ListTag className="space-y-1.5 pl-5 marker:text-slate-400" key={key}>
      {group.items.map((item) => {
        const itemKey = nextOccurrenceKey(itemSeen, `${item.checked}-${item.content}`)
        const childSeen = new Map<string, number>()

        return (
          <li className="pl-0.5" key={`${key}-${itemKey}`}>
            <div className="flex items-start gap-2">
              {item.checked !== null ? (
                <input
                  checked={item.checked}
                  className="mt-[0.34rem] h-4 w-4 rounded border-slate-300 accent-emerald-500"
                  disabled
                  readOnly
                  type="checkbox"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div>{parseInline(item.content)}</div>
                {item.children.length ? (
                  <div className="mt-1.5 space-y-1.5">
                    {item.children.map((child) => {
                      const childKey = nextOccurrenceKey(
                        childSeen,
                        `${child.kind}:${child.items.map((nestedItem) => nestedItem.content).join("|")}`,
                      )

                      return renderListGroup(child, `${key}-${itemKey}-${childKey}`)
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </li>
        )
      })}
    </ListTag>
  )
}

function renderListBlock(lines: string[], key: string) {
  const groups: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const parsed = parseListLine(lines[index])
    if (!parsed) {
      break
    }

    const built = buildListGroup(lines, index, parsed.indent)
    if (!built) {
      break
    }

    groups.push(renderListGroup(built.group, `${key}-${groups.length}`))
    index = built.nextIndex
  }

  return (
    <div className="space-y-1.5" key={key}>
      {groups}
    </div>
  )
}

function renderMarkdownBlocks(content: string) {
  const normalized = content.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    if (line.startsWith("```")) {
      const languageMatch = line.match(/^```([\w-]+)?/)
      const language = languageMatch?.[1] ?? null
      const codeLines: string[] = []
      index += 1

      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index])
        index += 1
      }

      if (index < lines.length && lines[index].startsWith("```")) {
        index += 1
      }

      blocks.push(renderCodeBlock(language, codeLines, `code-${blocks.length}`))
      continue
    }

    if (isHorizontalRule(line)) {
      blocks.push(<hr className="border-slate-200/60" key={`hr-${blocks.length}`} />)
      index += 1
      continue
    }

    if (/^#{1,6}\s+/.test(line)) {
      blocks.push(renderHeading(line, `heading-${blocks.length}`))
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index])
        index += 1
      }

      blocks.push(renderBlockquote(quoteLines, `quote-${blocks.length}`))
      continue
    }

    if (parseTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const tableLines = [line, lines[index + 1]]
      index += 2

      while (index < lines.length && parseTableRow(lines[index])) {
        tableLines.push(lines[index])
        index += 1
      }

      blocks.push(renderTable(tableLines, `table-${blocks.length}`))
      continue
    }

    if (parseListLine(line)) {
      const listLines: string[] = []

      while (index < lines.length && parseListLine(lines[index])) {
        listLines.push(lines[index])
        index += 1
      }

      blocks.push(renderListBlock(listLines, `list-${blocks.length}`))
      continue
    }

    const paragraphLines: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !isHorizontalRule(lines[index]) &&
      !/^#{1,6}\s+/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !(
        parseTableRow(lines[index]) &&
        index + 1 < lines.length &&
        isTableDivider(lines[index + 1])
      ) &&
      !parseListLine(lines[index])
    ) {
      paragraphLines.push(lines[index])
      index += 1
    }

    blocks.push(renderParagraph(paragraphLines, `p-${blocks.length}`))
  }

  return blocks
}

export function MarkdownMessage({
  content,
  inverted = false,
  className = "",
}: MarkdownMessageProps) {
  return (
    <div
      className={[
        "grid gap-2.5 break-words text-[14px] leading-[1.75]",
        "[&_a]:break-all",
        "[&_blockquote]:italic",
        "[&_code]:font-mono",
        "[&_del]:opacity-70",
        "[&_input]:accent-emerald-500",
        "[&_ol]:list-decimal",
        "[&_table]:text-[13px]",
        "[&_ul]:list-disc",
        inverted
          ? "text-white [&_code]:bg-white/15 [&_hr]:border-white/15 [&_thead]:bg-white/10"
          : "text-slate-700 [&_hr]:border-slate-200/60 [&_thead]:bg-slate-50",
        className,
      ].join(" ")}
    >
      {renderMarkdownBlocks(content)}
    </div>
  )
}
