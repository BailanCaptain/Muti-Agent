"use client"

import { Children, type ReactNode, useCallback, useRef, useState } from "react"
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
        className="inline-flex rounded-full border border-emerald-200/80 bg-emerald-50 px-2 py-0.5 font-mono text-[0.82em] font-medium text-emerald-700"
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
          <span className="text-[11px] font-medium uppercase tracking-[0.15em] text-white/50">
            {language}
          </span>
        </div>
      )}
      <button
        onClick={handleCopy}
        type="button"
        className="absolute right-2 top-2 z-10 rounded-md bg-slate-700 px-2 py-1 text-[10px] font-medium text-slate-300 opacity-0 transition-opacity hover:bg-slate-600 group-hover/code:opacity-100"
      >
        {copied ? "已复制 ✓" : "复制"}
      </button>
      <pre
        ref={preRef}
        className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-6 text-white [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit"
      >
        {children}
      </pre>
    </div>
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
    <h3 className="text-[15px] font-semibold text-slate-700">{withMentions(children)}</h3>
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
      <table className="min-w-full border-collapse overflow-hidden rounded-xl border border-slate-200/80 text-left text-[13px]">
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
/*  MarkdownMessage                                                    */
/* ------------------------------------------------------------------ */

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
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
