"use client"

import { useEffect, useRef } from "react"

/**
 * F027 Phase 3 Week 4 Day 19c (AC-P3-6 入口 C) · composer 内 `/命令面板` 下拉
 *
 * 真相源：
 *   - V16.5 chap 25 line 2539-2545 入口 C: composer 打 `/` → 弹下拉 5 命令
 *   - V16.5 chap 25 line 2626 注 "新, 可选" (Phase 3 接 /ingest, /promote 等 Phase 4)
 *   - feature.md AC-P3-6 line 182: "三入口" 字面，slash 是入口 C 完整必做
 *   - feature.md AC-P4-3 line 192: Phase 4 `/promote` `/demote` `/series` `/rollback` 接 modal
 *
 * Day 19c 范围:
 *   - 独立 SlashCommandMenu 组件 (Phase 3 只接 /ingest 启用，其他 4 命令 disabled)
 *   - 暴露 props: open / highlight / onSelect / onHighlightChange / onClose
 *   - composer.tsx 集成 (parse / context + 选中后触发 file picker → IngestModal)
 *     由 Day 19c-i 接 (composer 集成) 完成
 *
 * 设计:
 *   - 命令枚举: ingest (Phase 3) | promote (P4) | demote (P4) | series (P4) | rollback (P4)
 *   - 5 命令固定顺序 (与 V16.5 chap 25 line 2541-2545 一致)
 *   - disabled 命令在 UI 灰显 + 禁选中
 *   - 键盘导航: ArrowUp/Down 在 enabled 集内, Enter 选中, Escape onClose
 */

export type SlashCommandKey = "ingest" | "promote" | "demote" | "series" | "rollback"

export interface SlashCommand {
  key: SlashCommandKey
  label: string
  description: string
  enabled: boolean
}

/**
 * Phase 3 范围: /ingest enabled; 其他 4 命令 Phase 4 才接 modal (feature.md AC-P4-3)
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    key: "ingest",
    label: "/ingest",
    description: "上传资料编译进 wiki (V16.5 chap 25 入口 C)",
    enabled: true,
  },
  {
    key: "promote",
    label: "/promote",
    description: "审批 draft 升正式 (Phase 4)",
    enabled: false,
  },
  {
    key: "demote",
    label: "/demote",
    description: "拒绝 draft (Phase 4)",
    enabled: false,
  },
  {
    key: "series",
    label: "/series",
    description: "建系列防 chained 误检 (Phase 4)",
    enabled: false,
  },
  {
    key: "rollback",
    label: "/rollback",
    description: "回滚某次 wiki 写操作 (Phase 4)",
    enabled: false,
  },
]

/**
 * 过滤命令: query 前缀匹配 (case-insensitive)
 *   - query='' → 全部 5 命令
 *   - query='in' → /ingest only
 *   - query='xyz' → 空
 */
export function filterSlashCommands(query: string): SlashCommand[] {
  if (!query) return SLASH_COMMANDS
  const lower = query.toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.key.toLowerCase().startsWith(lower))
}

/**
 * 找 cursor 前的 / context (类似 composer.tsx findMentionContext 但 / 起头):
 *   - cursor 之前必须是 / 起头一段 (line start 或 space 后)
 *   - / 后面到 cursor 之间不能含空格
 *   - 返回 { start: /位置, query: /后字符 } 或 null
 */
export interface SlashContext {
  start: number
  query: string
}

export function findSlashContext(value: string, cursor: number): SlashContext | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i]
    if (ch === "/") {
      // / 前必须是 line start 或 space (防 path/url 误识别)
      const prev = i > 0 ? value[i - 1] : ""
      if (prev && !/\s/.test(prev)) return null
      const query = value.slice(i + 1, cursor)
      // query 不能含空格 / 不能含特殊字符 (只限字母数字 + - _)
      if (/[\s/@]/.test(query)) return null
      return { start: i, query }
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

export interface SlashCommandMenuProps {
  open: boolean
  commands: SlashCommand[]
  highlight: number
  onSelect: (cmd: SlashCommand) => void
  onHighlightChange: (i: number) => void
  /** Escape 或 click outside 触发. */
  onClose: () => void
}

export function SlashCommandMenu({
  open,
  commands,
  highlight,
  onSelect,
  onHighlightChange,
  onClose,
}: SlashCommandMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // 点 outside 关闭
  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", onClickOutside)
    return () => document.removeEventListener("mousedown", onClickOutside)
  }, [open, onClose])

  if (!open || commands.length === 0) return null

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-surface-canvas shadow-lg"
      data-testid="composer-slash-menu"
      role="listbox"
      tabIndex={-1}
      aria-label="Slash commands"
    >
      {commands.map((cmd, i) => {
        const active = i === highlight
        const disabled = !cmd.enabled
        return (
          <button
            key={cmd.key}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled) return
              onSelect(cmd)
            }}
            onMouseEnter={() => onHighlightChange(i)}
            onMouseDown={(e) => e.preventDefault()}
            data-testid={`slash-command-${cmd.key}`}
            data-active={active ? "true" : "false"}
            data-disabled={disabled ? "true" : "false"}
            role="option"
            aria-selected={active}
            aria-disabled={disabled}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
              active && !disabled
                ? "bg-violet-100"
                : disabled
                  ? "cursor-not-allowed bg-transparent text-slate-400"
                  : "bg-transparent hover:bg-slate-50"
            }`}
          >
            <span
              className={`shrink-0 rounded-md border px-2 py-0.5 font-mono text-micro ${
                disabled
                  ? "border-slate-200 text-slate-400"
                  : "border-violet-300 bg-violet-50 text-violet-700"
              }`}
            >
              {cmd.label}
            </span>
            <span className="flex-1 text-caption text-slate-600">{cmd.description}</span>
            {disabled && <span className="text-micro text-slate-400">Phase 4</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * 键盘导航 helper: 给定当前 highlight 和 keyboard event, 返回下一个 highlight
 * (跳过 disabled 命令)。caller (composer.tsx) 在 textarea onKeyDown 调用。
 *
 * 返回 null 表示不消费此 key (caller 走默认行为)。
 */
export function nextHighlightOnKey(
  key: string,
  commands: SlashCommand[],
  current: number,
): number | null {
  if (commands.length === 0) return null
  const enabledIndices: number[] = []
  for (let i = 0; i < commands.length; i++) {
    if (commands[i].enabled) enabledIndices.push(i)
  }
  if (enabledIndices.length === 0) return null

  const curEnabledPos = enabledIndices.indexOf(current)
  if (key === "ArrowDown") {
    if (curEnabledPos === -1) return enabledIndices[0]
    return enabledIndices[(curEnabledPos + 1) % enabledIndices.length]
  }
  if (key === "ArrowUp") {
    if (curEnabledPos === -1) return enabledIndices[enabledIndices.length - 1]
    return enabledIndices[(curEnabledPos - 1 + enabledIndices.length) % enabledIndices.length]
  }
  return null
}
