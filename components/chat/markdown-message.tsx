"use client"

import { Children, type ReactNode, useCallback, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

type MarkdownMessageProps = {
  content: string
  inverted?: boolean
  className?: string
}

/* ------------------------------------------------------------------ */
/*  @mention highlighting                                              */
/* ------------------------------------------------------------------ */

const mentionColorMap: Record<string, string> = {
  // 黄仁勋 / Claude — 紫色
  '黄仁勋': 'border-violet-200/80 bg-violet-50 text-violet-700',
  'claude': 'border-violet-200/80 bg-violet-50 text-violet-700',
  // 范德彪 / Codex — 金色
  '范德彪': 'border-amber-200/80 bg-amber-50 text-amber-700',
  'codex': 'border-amber-200/80 bg-amber-50 text-amber-700',
  // 桂芬 / Gemini — 蓝色
  '桂芬': 'border-sky-200/80 bg-sky-50 text-sky-700',
  'gemini': 'border-sky-200/80 bg-sky-50 text-sky-700',
  // 小孙 — 橙色（用户）
  '小孙': 'border-orange-200/80 bg-orange-50 text-orange-700',
  // 所有人
  '所有人': 'border-slate-200/80 bg-slate-100 text-slate-700',
}

function getMentionColor(mention: string): string {
  const name = mention.replace(/^@/, '')
  return mentionColorMap[name] ?? 'border-emerald-200/80 bg-emerald-50 text-emerald-700'
}

function highlightMentions(text: string): ReactNode[] {
  const re = /(@[\p{L}\p{N}._-]+)/gu
  const parts: ReactNode[] = []
  let lastIdx = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > lastIdx) parts.push(text.slice(lastIdx, idx))
    parts.push(
      <span
        key={`m${idx}`}
        className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[0.82em] font-medium ${getMentionColor(m[0])}`}
      >
        {m[0]}
      </span>,
    )
    lastIdx = idx + m[0].length
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}

function withMentions(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === "string" ? highlightMentions(child) : child,
  )
}

/* ------------------------------------------------------------------ */
/*  CodeBlock (AC5 — language label + copy button)                     */
/* ------------------------------------------------------------------ */

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Extract language from the code element's className (language-xxx)
  let language: string | null = null
  Children.forEach(children, (child) => {
    if (child && typeof child === "object" && "props" in child) {
      const cls = (child as { props: { className?: string } }).props.className as
        | string
        | undefined
      if (cls) {
        const match = cls.match(/language-(\w+)/)
        if (match) language = match[1]
      }
    }
  })

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? ""
    void navigator.clipboard.writeText(text)
    setCopied(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1500)
  }, [])

  return (
    <div className="group/code relative overflow-hidden rounded-xl border border-slate-200/80 bg-slate-900">
      {language && (
        <div className="flex items-center justify-between border-b border-white/10 bg-slate-800 px-4 py-1.5">
          <span className="text-caption font-medium uppercase tracking-[0.15em] text-white/50">
            {language}
          </span>
        </div>
      )}
      <button
        onClick={handleCopy}
        type="button"
        className="absolute right-2 top-2 z-10 rounded-md bg-slate-700 px-2 py-1 text-micro font-medium text-slate-300 opacity-0 transition-opacity hover:bg-slate-600 group-hover/code:opacity-100"
      >
        {copied ? "已复制 ✓" : "复制"}
      </button>
      <pre
        ref={preRef}
        className="overflow-x-auto px-4 py-3 font-mono text-compact leading-6 text-white [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit"
      >
        {children}
      </pre>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Inline image lightbox for markdown-rendered images                 */
/* ------------------------------------------------------------------ */

function ZoomableImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false)
  if (!src) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="my-2 block cursor-zoom-in">
        <img
          src={src}
          alt={alt ?? ""}
          className="max-h-64 rounded-lg border border-zinc-200 object-contain transition hover:border-zinc-400 hover:shadow-md"
        />
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            role="button"
            tabIndex={0}
          >
            <img
              src={src}
              alt={alt ?? ""}
              className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>,
          document.body,
        )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  react-markdown component overrides                                 */
/* ------------------------------------------------------------------ */

const mdComponents: Components = {
  p: ({ children }) => (
    <p className="mb-1 last:mb-0 leading-relaxed">{withMentions(children)}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{withMentions(children)}</strong>
  ),
  em: ({ children }) => <em>{withMentions(children)}</em>,
  del: ({ children }) => <del className="opacity-70">{withMentions(children)}</del>,

  h1: ({ children }) => (
    <h1 className="text-lg font-bold text-slate-800">{withMentions(children)}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-bold text-slate-800">{withMentions(children)}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold text-slate-700">{withMentions(children)}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-semibold text-slate-700">{withMentions(children)}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
      {withMentions(children)}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-xs font-medium text-slate-500">{withMentions(children)}</h6>
  ),

  ul: ({ children }) => (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-slate-400">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1.5 pl-5 marker:text-slate-400">{children}</ol>
  ),
  li: ({ children, className }) => (
    <li
      className={
        className === "task-list-item"
          ? "list-none -ml-5 flex items-start gap-2"
          : "pl-0.5"
      }
    >
      {withMentions(children)}
    </li>
  ),
  input: ({ type, checked }) =>
    type === "checkbox" ? (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        disabled
        className="mt-[0.34rem] h-4 w-4 rounded border-slate-300 accent-emerald-500"
      />
    ) : (
      <input type={type} />
    ),

  blockquote: ({ children }) => (
    <blockquote className="border-l-[3px] border-emerald-400/60 pl-4 italic text-slate-500">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="break-all font-medium text-orange-600 underline decoration-orange-300/50 underline-offset-[3px] transition hover:decoration-orange-500"
    >
      {withMentions(children)}
    </a>
  ),
  img: ({ src, alt }) => <ZoomableImage src={typeof src === "string" ? src : undefined} alt={typeof alt === "string" ? alt : undefined} />,
  hr: () => <hr className="border-slate-200/60" />,

  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => {
    // Inside a <pre> (fenced code block) — className is typically "language-xxx"
    if (className) {
      return <code className={className}>{children}</code>
    }
    // Inline code
    return (
      <code className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[0.88em] text-slate-700">
        {children}
      </code>
    )
  },

  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse overflow-hidden rounded-xl border border-slate-200/80 text-left text-compact">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-slate-200/80 px-3 py-2 font-semibold text-slate-600">
      {withMentions(children)}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-slate-100 px-3 py-2 align-top text-slate-600">
      {withMentions(children)}
    </td>
  ),
}

/* ------------------------------------------------------------------ */
/*  Output Sanitizer (AC6)                                             */
/* ------------------------------------------------------------------ */

export function sanitizeMarkdown(raw: string): string {
  // Protect fenced code blocks (``` and ~~~) from sanitization
  const fenceRe = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm
  const blocks: string[] = []
  let text = raw.replace(fenceRe, (match) => {
    blocks.push(match)
    return `\x00CODEBLOCK_${blocks.length - 1}\x00`
  })

  // F026 方案 X · 静默渲染 [Call: @X 描述] → @X 描述
  // [Call:] 是底层派发协议；前端把它脱掉，留下普通 @X 让 highlightMentions 渲染成 pill。
  // 代码块已在上面 stash；inline code 也需保护（与后端 maskHardNegativeRanges 契约对齐）。
  const inlineSpans: string[] = []
  text = text.replace(/`[^`\n]+`/g, (match) => {
    inlineSpans.push(match)
    return `\x00INLINECODE_${inlineSpans.length - 1}\x00`
  })
  text = stripCallTags(text)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional null-byte placeholders
  text = text.replace(/\x00INLINECODE_(\d+)\x00/g, (_, i) => inlineSpans[Number(i)])

  text = text.replace(/\r\n/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/([^\n])\n([-*+] )/g, '$1\n\n$2')
  text = text.replace(/([^\n])\n(\d+\. )/g, '$1\n\n$2')

  const backtickCount = (text.match(/`/g) || []).length
  if (backtickCount % 2 !== 0) {
    text += '`'
  }

  text = text.replace(/[ \t]{3,}$/gm, '  ')

  // Restore code blocks
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional null-byte placeholders
  text = text.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_, i) => blocks[Number(i)])

  return text
}

/**
 * F026 方案 X · 静默渲染 helper（P3.1 loose 版本）
 *
 *   [Call: @X 描述]   →  @X 描述
 *   [Call: @X]        →  @X
 *   嵌套：[Call: @A ... [Call: @B] ...]  →  @A ... @B ...
 *     （多 pass 迭代脱壳，先脱内层后脱外层；用户视觉零 [Call:] 字面量）
 *
 * 大小写敏感（仅识别字面 "[Call:"，避免误伤普通文本）。
 * B021 修：允许跨行 description（LLM 实际多行写法）。
 *
 * F026 P3.1 解耦设计（plan AC-18）：
 * 前端 strip 不再共享后端 mention-router resolveCallTagMentions regex。
 * 后端继续 fail-closed（嵌套外层不派发，避免错派）；
 * 前端宽松渲染（嵌套也尽量脱干净），用户永远看不到 [Call:] 字面量。
 * 派发结果通过 retry badge / @ pill 状态徽章传达，而非靠用户看 [Call:] 字符串自行判断。
 *
 * 出于演示需要保留 inline code（反引号 `…`） / fenced code block 内的 [Call:]，
 * 由 sanitizeMarkdown / ReactMarkdown 处理 — 此处只对正文做替换。
 */
export function stripCallTags(text: string): string {
  // 单 pass：匹配 [Call: 到对应 ] 的最短 enclose（[^\]]* 不跨过 ]），
  // 嵌套时第一遍脱掉的是内层（最内层最先闭合），下一遍再脱外层。
  const SINGLE_PASS_RE = /\[Call:\s*(@[\p{L}\p{N}._-]+)([^\]]*)\]/gu
  let out = text
  // 上限 8 层：远超 LLM 实际嵌套深度（即使脑子糊掉也不会写 9 层 [Call:]）
  for (let i = 0; i < 8; i++) {
    const next = out.replace(SINGLE_PASS_RE, (_match, alias, desc) => {
      const trimmedDesc = (desc as string).replace(/^\s+/, "")
      return trimmedDesc.length > 0 ? `${alias} ${trimmedDesc}` : (alias as string)
    })
    if (next === out) break
    out = next
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  MarkdownMessage                                                    */
/* ------------------------------------------------------------------ */

export function MarkdownMessage({
  content,
  inverted = false,
  className = "",
}: MarkdownMessageProps) {
  const sanitized = useMemo(() => sanitizeMarkdown(content), [content])

  return (
    <div
      className={[
        "grid gap-2.5 break-words text-sm leading-[1.75]",
        "[&_a]:break-all",
        "[&_blockquote]:italic",
        "[&_code]:font-mono",
        "[&_del]:opacity-70",
        "[&_input]:accent-emerald-500",
        "[&_ol]:list-decimal",
        "[&_table]:text-compact",
        "[&_ul]:list-disc",
        inverted
          ? "text-white [&_code]:bg-white/15 [&_hr]:border-white/15 [&_thead]:bg-white/10"
          : "text-slate-700 [&_hr]:border-slate-200/60 [&_thead]:bg-slate-50",
        className,
      ].join(" ")}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>
        {sanitized}
      </ReactMarkdown>
    </div>
  )
}
