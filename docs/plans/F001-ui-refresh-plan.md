# F001 UI 焕新 Implementation Plan

**Feature:** F001 — `docs/features/F001-ui-refresh.md`
**Goal:** 消除配置双入口冲突 + 消息渲染质量升级（react-markdown + block adapter + CardBlock/DiffBlock + per-provider 视觉差异化）
**Acceptance Criteria:**
- [ ] AC1: Composer 无配置控件，AgentConfigBar 已删除
- [ ] AC2: StatusPanel 支持当前会话配置（常显）+ 全局默认配置（折叠）
- [ ] AC3: 统一走 `PUT /api/runtime-config` API
- [ ] AC4: react-markdown + remark-gfm 渲染，禁用 rehype-raw
- [ ] AC5: 代码块语法高亮 + 复制按钮
- [ ] AC6: `normalizeMessageToBlocks()` 统一渲染路径
- [ ] AC7: Per-provider 气泡视觉差异化
- [ ] AC8: CardBlock 渲染组件
- [ ] AC9: DiffBlock 渲染组件
- [ ] AC10: 向后兼容（无 blocks 时降级为 markdown block）

**Architecture:** 前端适配层模式——不改 `TimelineMessage` 协议，在前端用 `normalizeMessageToBlocks()` 将 content/thinking/inlineConfirmations 映射为统一 Block 数组，用 `BlockRenderer` 统一渲染。Markdown block 由 `react-markdown` 驱动。
**Tech Stack:** react-markdown, remark-gfm, remark-breaks, Tailwind CSS

---

## Terminal Schema

### Block 类型定义（前端 only，`lib/blocks.ts`）

```typescript
import type { Provider, InlineConfirmation } from "@multi-agent/shared"

export type MarkdownBlock = {
  kind: "markdown"
  content: string
}

export type ThinkingBlock = {
  kind: "thinking"
  content: string
  provider: Provider
}

export type DecisionBlock = {
  kind: "decision"
  confirmations: InlineConfirmation[]
}

export type CardBlock = {
  kind: "card"
  id: string
  title: string
  bodyMarkdown?: string
  tone?: "info" | "success" | "warning" | "danger"
  fields?: Array<{ label: string; value: string }>
}

export type DiffBlock = {
  kind: "diff"
  id: string
  filePath: string
  diff: string
}

export type Block = MarkdownBlock | ThinkingBlock | DecisionBlock | CardBlock | DiffBlock
```

### normalizeMessageToBlocks（`lib/blocks.ts`）

```typescript
export function normalizeMessageToBlocks(message: TimelineMessage): Block[] {
  const blocks: Block[] = []
  if (message.thinking) {
    blocks.push({ kind: "thinking", content: message.thinking, provider: message.provider })
  }
  if (message.content) {
    blocks.push({ kind: "markdown", content: message.content })
  }
  if (message.inlineConfirmations?.length) {
    blocks.push({ kind: "decision", confirmations: message.inlineConfirmations })
  }
  return blocks
}
```

### StatusPanel 配置终态

智能体卡片里：
- **当前会话模型**（常显）：和现在类似的 `<input list>` + 保存按钮，但改为调 `PUT /api/runtime-config`
- **全局默认配置**（折叠）：点击 "默认配置 ▸" 展开，显示 model + effort，数据源 = `runtime-config-store`

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install react-markdown + remark plugins**

```bash
cd C:/Users/-/Desktop/Multi-Agent && pnpm add react-markdown remark-gfm remark-breaks
```

**Step 2: Verify install**

Run: `pnpm typecheck`
Expected: PASS (no type errors from new deps)

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: add react-markdown + remark-gfm + remark-breaks for F001 [黄仁勋]"
```

---

## Task 2: Remove AgentConfigBar from Composer (AC1)

**Files:**
- Modify: `components/chat/composer.tsx:3,207` — remove import + JSX usage
- Delete: `components/chat/agent-config-bar.tsx` — entire file

**Step 1: Edit composer.tsx**

Remove line 3 (`import { AgentConfigBar }`).
Remove line 207 (`<AgentConfigBar />`).

**Step 2: Delete agent-config-bar.tsx**

```bash
git rm components/chat/agent-config-bar.tsx
```

**Step 3: Verify**

Run: `pnpm typecheck`
Expected: PASS (no dangling imports)

**Step 4: Commit**

```bash
git add components/chat/composer.tsx
git commit -m "feat(F001): remove AgentConfigBar from Composer — pure chat input [黄仁勋]"
```

---

## Task 3: Upgrade StatusPanel config (AC2, AC3)

**Files:**
- Modify: `components/chat/status-panel.tsx:218-308` — rewrite 智能体配置 section
- Modify: `components/stores/runtime-config-store.ts` — no changes needed, already has the API

**Step 1: Import runtime-config-store in StatusPanel**

Add to status-panel.tsx:
```typescript
import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
```

**Step 2: Rewrite the 智能体配置 section**

Replace the current model input (lines 258-304) which uses `updateModel` from thread-store.
New structure per provider card:

```tsx
// Inside the provider card, after status dot section:

{/* 当前会话模型 — 常显 */}
<div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
  <span>当前会话</span>
  <span className="font-mono text-slate-500">{card.currentModel ?? "未设置"}</span>
</div>
<div className="flex items-center gap-2">
  <input list={...} onChange={...} placeholder="选择模型" value={sessionDraft} />
  {isDirty && <button onClick={saveSession}>保存</button>}
</div>

{/* 全局默认 — 折叠 */}
<button onClick={toggleDefaults} className="...">
  <ChevronRight /> 默认配置
</button>
{showDefaults && (
  <div>
    <input list={...} placeholder="默认模型" value={override.model} onChange={...} />
    <select value={override.effort} onChange={...}>...</select>
  </div>
)}
```

Session config: keep calling `updateModel()` from thread-store (sets currentModel for this session).
Global default: call `setAgentOverride()` from runtime-config-store (persists to file).

Both visible in the same card but clearly labeled and visually separated.

**Step 3: Verify**

Run: `pnpm typecheck && pnpm dev:web`
Visual check: StatusPanel shows "当前会话" (常显) + "默认配置" (折叠) per agent.

**Step 4: Commit**

```bash
git add components/chat/status-panel.tsx
git commit -m "feat(F001): unified config in StatusPanel — session (常显) + defaults (折叠) [黄仁勋]"
```

---

## Task 4: Rewrite MarkdownMessage with react-markdown (AC4, AC5)

**Files:**
- Rewrite: `components/chat/markdown-message.tsx` — replace hand-written parser with react-markdown

**Step 1: Rewrite markdown-message.tsx**

Key design decisions:
- Use `ReactMarkdown` with `remarkGfm` + `remarkBreaks` plugins
- NO `rehypeRaw` (XSS prevention)
- Custom `pre` component with copy button (reference: clowder's `CodeBlock`)
- Custom inline `code` with Tailwind styling
- @mention highlighting via custom text processing in `p`, `li`, `strong`, `em` components
- Per-provider mention colors using existing `PROVIDER_ALIASES` mapping

The component API stays identical: `<MarkdownMessage content={...} inverted={...} className={...} />`

```tsx
"use client"

import { PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { Children, type ReactNode, useCallback, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

// Per-provider @mention colors
const mentionColors: Record<string, string> = {
  [PROVIDER_ALIASES.codex.toLowerCase()]: "border-amber-200 bg-amber-50 text-amber-700",
  [PROVIDER_ALIASES.claude.toLowerCase()]: "border-violet-200 bg-violet-50 text-violet-700",
  [PROVIDER_ALIASES.gemini.toLowerCase()]: "border-sky-200 bg-sky-50 text-sky-700",
  codex: "border-amber-200 bg-amber-50 text-amber-700",
  claude: "border-violet-200 bg-violet-50 text-violet-700",
  gemini: "border-sky-200 bg-sky-50 text-sky-700",
}

function highlightMentions(text: string): ReactNode[] {
  const re = /(@[\p{L}\p{N}_]+)/gu
  const parts: ReactNode[] = []
  let lastIdx = 0
  for (const m of text.matchAll(re)) {
    if ((m.index ?? 0) > lastIdx) parts.push(text.slice(lastIdx, m.index))
    const alias = m[1].slice(1).toLowerCase()
    const cls = mentionColors[alias] ?? "border-emerald-200 bg-emerald-50 text-emerald-700"
    parts.push(
      <span key={`m${m.index}`} className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[0.82em] font-medium ${cls}`}>
        {m[0]}
      </span>
    )
    lastIdx = (m.index ?? 0) + m[0].length
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}

function withMentions(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === "string" ? highlightMentions(child) : child
  )
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? ""
    void navigator.clipboard.writeText(text)
    setCopied(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1500)
  }, [])

  return (
    <div className="group/code relative">
      <button onClick={handleCopy} className="absolute right-2 top-2 z-10 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 opacity-0 transition-opacity hover:bg-slate-600 group-hover/code:opacity-100">
        {copied ? "已复制" : "复制"}
      </button>
      <pre ref={preRef} className="overflow-x-auto rounded-xl border border-slate-200/80 bg-slate-900 px-4 py-3 font-mono text-[13px] leading-6 text-white [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
        {children}
      </pre>
    </div>
  )
}

// ... (full mdComponents object with table, blockquote, headings, lists etc.)
// ... (MarkdownMessage export with same props API)
```

**Step 2: Verify**

Run: `pnpm typecheck`
Run: `pnpm dev:web` — send messages with markdown (tables, code blocks, @mentions, lists)
Expected: Correct rendering, code blocks have copy button, @mentions have colors, no HTML injection

**Step 3: Commit**

```bash
git add components/chat/markdown-message.tsx
git commit -m "feat(F001): replace hand-written markdown parser with react-markdown [黄仁勋]"
```

---

## Task 5: Build normalizeMessageToBlocks + BlockRenderer (AC6, AC10)

**Files:**
- Create: `lib/blocks.ts` — Block type definitions + normalizeMessageToBlocks
- Create: `components/chat/block-renderer.tsx` — renders Block[] array
- Modify: `components/chat/message-bubble.tsx:192-249` — use BlockRenderer instead of inline rendering

**Step 1: Create lib/blocks.ts**

Block type union + normalizeMessageToBlocks function (see Terminal Schema above).

Backward compat (AC10): function always returns at least one block. If content is empty, returns empty array.

**Step 2: Create components/chat/block-renderer.tsx**

```tsx
"use client"

import type { Block } from "@/lib/blocks"
import type { Provider, DecisionRequest } from "@multi-agent/shared"
import { MarkdownMessage } from "./markdown-message"
// ... thinking panel, decision card imports

export function BlockRenderer({
  blocks, provider, thinkingTheme, inlineDecisions, onDecisionRespond
}: {
  blocks: Block[]
  provider: Provider
  // ... pass-through props
}) {
  return <>
    {blocks.map((block, i) => {
      switch (block.kind) {
        case "markdown": return <MarkdownMessage key={i} content={block.content} />
        case "thinking": return <ThinkingPanel key={i} ... />
        case "decision": return <DecisionSection key={i} ... />
        case "card": return <CardBlockComponent key={i} ... />
        case "diff": return <DiffBlockComponent key={i} ... />
      }
    })}
  </>
}
```

**Step 3: Modify message-bubble.tsx**

Replace the inline thinking/content/decision rendering (lines 199-247) with:

```tsx
import { normalizeMessageToBlocks } from "@/lib/blocks"
import { BlockRenderer } from "./block-renderer"

// Inside MessageBubble, replace the thinking + MarkdownMessage + decisions section:
const blocks = normalizeMessageToBlocks(message)
<BlockRenderer blocks={blocks} provider={message.provider} ... />
```

**Step 4: Verify**

Run: `pnpm typecheck`
Run: `pnpm dev:web` — verify existing messages render identically (thinking + content + decisions)
Expected: No visual regression

**Step 5: Commit**

```bash
git add lib/blocks.ts components/chat/block-renderer.tsx components/chat/message-bubble.tsx
git commit -m "feat(F001): normalizeMessageToBlocks adapter + BlockRenderer [黄仁勋]"
```

---

## Task 6: Per-provider bubble styling (AC7)

**Files:**
- Modify: `components/chat/message-bubble.tsx:193-197` — add provider-specific bubble border/background

**Step 1: Define bubble theme**

```typescript
const bubbleTheme: Record<Provider, string> = {
  codex: "border-amber-200/70 bg-amber-50/30",
  claude: "border-violet-200/70 bg-violet-50/30",
  gemini: "border-sky-200/70 bg-sky-50/30",
}
```

**Step 2: Apply to assistant bubble**

Change the assistant bubble className from:
```
"border-slate-200/80 bg-white/95 text-slate-700"
```
to:
```
`${bubbleTheme[message.provider]} text-slate-700`
```

**Step 3: Verify**

Run: `pnpm dev:web`
Expected: Each agent's bubble has a distinct tint (amber/violet/sky)

**Step 4: Commit**

```bash
git add components/chat/message-bubble.tsx
git commit -m "feat(F001): per-provider bubble colors for visual differentiation [黄仁勋]"
```

---

## Task 7: CardBlock component (AC8)

**Files:**
- Create: `components/chat/rich-blocks/card-block.tsx`
- Modify: `components/chat/block-renderer.tsx` — add CardBlock case

**Step 1: Create card-block.tsx**

Simplified from clowder's CardBlock. Supports: title, bodyMarkdown (rendered via MarkdownMessage), tone (info/success/warning/danger border color), fields (label:value grid).

```tsx
"use client"

import { MarkdownMessage } from "../markdown-message"
import type { CardBlock } from "@/lib/blocks"

const TONE_STYLES = {
  info: "border-l-blue-400 bg-blue-50/60",
  success: "border-l-emerald-400 bg-emerald-50/60",
  warning: "border-l-amber-400 bg-amber-50/60",
  danger: "border-l-rose-400 bg-rose-50/60",
}

export function CardBlockComponent({ block }: { block: CardBlock }) {
  const tone = TONE_STYLES[block.tone ?? "info"]
  return (
    <div className={`rounded-r-xl border-l-4 p-3 ${tone}`}>
      <div className="text-sm font-semibold text-slate-800">{block.title}</div>
      {block.bodyMarkdown && (
        <div className="mt-1">
          <MarkdownMessage content={block.bodyMarkdown} className="text-xs" />
        </div>
      )}
      {block.fields?.length && (
        <div className="mt-2 grid grid-cols-2 gap-1">
          {block.fields.map((f, i) => (
            <div key={i} className="text-xs">
              <span className="text-slate-400">{f.label}:</span>{" "}
              <span className="font-mono">{f.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

**Step 2: Wire into BlockRenderer**

Add `case "card"` in the switch.

**Step 3: Verify**

Run: `pnpm typecheck`
(Visual testing deferred — CardBlock will render when backend starts sending card blocks, but the component is ready.)

**Step 4: Commit**

```bash
git add components/chat/rich-blocks/card-block.tsx components/chat/block-renderer.tsx
git commit -m "feat(F001): CardBlock rich rendering component [黄仁勋]"
```

---

## Task 8: DiffBlock component (AC9)

**Files:**
- Create: `components/chat/rich-blocks/diff-block.tsx`
- Modify: `components/chat/block-renderer.tsx` — add DiffBlock case

**Step 1: Create diff-block.tsx**

Simple inline unified diff renderer. Parses unified diff lines (`+`, `-`, ` `) and renders with green/red/neutral backgrounds. No external diff library needed.

```tsx
"use client"

import type { DiffBlock } from "@/lib/blocks"

function classifyLine(line: string) {
  if (line.startsWith("+")) return "bg-emerald-50 text-emerald-800"
  if (line.startsWith("-")) return "bg-rose-50 text-rose-800"
  if (line.startsWith("@@")) return "bg-blue-50 text-blue-600 font-semibold"
  return "text-slate-600"
}

export function DiffBlockComponent({ block }: { block: DiffBlock }) {
  const lines = block.diff.split("\n")
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200/80">
      <div className="border-b border-slate-200/80 bg-slate-100 px-4 py-1.5 font-mono text-[11px] text-slate-500">
        {block.filePath}
      </div>
      <pre className="overflow-x-auto bg-white px-4 py-2 font-mono text-[12px] leading-5">
        {lines.map((line, i) => (
          <div key={i} className={`px-1 ${classifyLine(line)}`}>{line || " "}</div>
        ))}
      </pre>
    </div>
  )
}
```

**Step 2: Wire into BlockRenderer**

Add `case "diff"` in the switch.

**Step 3: Verify**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add components/chat/rich-blocks/diff-block.tsx components/chat/block-renderer.tsx
git commit -m "feat(F001): DiffBlock inline diff rendering component [黄仁勋]"
```

---

## Final Verification

**Step 1: Full typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

**Step 2: Visual smoke test**

```bash
pnpm dev:web
```

Verify:
- [ ] Composer has no config controls
- [ ] StatusPanel shows session config (常显) + global default (折叠)
- [ ] Messages render with react-markdown (tables, code blocks with copy, GFM)
- [ ] @mention tags have per-provider colors
- [ ] Agent bubbles have per-provider tint
- [ ] Thinking panels still work (expand/collapse)
- [ ] Decision cards still render inline

**Step 3: Final commit (if any fixups needed)**

---

## AC → Task Traceability

| AC | Task |
|----|------|
| AC1 | Task 2 |
| AC2 | Task 3 |
| AC3 | Task 3 |
| AC4 | Task 4 |
| AC5 | Task 4 |
| AC6 | Task 5 |
| AC7 | Task 6 |
| AC8 | Task 7 |
| AC9 | Task 8 |
| AC10 | Task 5 |
