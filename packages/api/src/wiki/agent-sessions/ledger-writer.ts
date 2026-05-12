/**
 * F027 P8 · S-NNNN.md ledger writer + current.md derive
 * 真相源：docs/plans/V16.5-final.md chap 9 行 1005-1086
 *
 * Path 约定（caller 传 wikiRoot）：
 *   <wikiRoot>/wiki/rooms/<roomId>/agent-sessions/<alias>/S-<padded4>.md
 *   <wikiRoot>/wiki/rooms/<roomId>/agent-sessions/<alias>/current.md
 *
 * Atomic：复用 writeFileAtomic（tmp + rename + fsync），与 RoomCompiler 同协议。
 * Hot path（chap 9 行 1083）：current.md 200-400 tok，wake-up 注入；不扫 S 文件。
 */

import path from "node:path"
import { writeFileAtomic } from "../atomic-write"
import type { RoomAgentSession, SessionLedgerFrontmatter } from "./types"

export interface AgentSessionFileLayout {
  /** S-XXXX.md 绝对路径 */
  ledgerPath: string
  /** current.md 绝对路径 */
  currentPath: string
  /** S-XXXX.md 在 wiki/ 下的相对路径（canonical_owner_path 字段值） */
  canonicalOwnerRelPath: string
  /** agent-sessions/<alias>/ 目录绝对路径 */
  agentDir: string
}

export function computeAgentSessionLayout(opts: {
  wikiRoot: string
  roomId: string
  alias: string
  sessionSeq: number
}): AgentSessionFileLayout {
  const seqPadded = String(opts.sessionSeq).padStart(4, "0")
  const agentDir = path.join(
    opts.wikiRoot,
    "wiki",
    "rooms",
    opts.roomId,
    "agent-sessions",
    opts.alias,
  )
  const ledgerPath = path.join(agentDir, `S-${seqPadded}.md`)
  const currentPath = path.join(agentDir, "current.md")
  const canonicalOwnerRelPath = `wiki/rooms/${opts.roomId}/agent-sessions/${opts.alias}/S-${seqPadded}.md`
  return { ledgerPath, currentPath, canonicalOwnerRelPath, agentDir }
}

/**
 * 写 S-NNNN.md ledger 文件 + 同步更新 current.md。
 * caller 已 endSession（row 含 ended_at + digest）；本函数纯文件 IO。
 *
 * V16.5 chap 9 行 1027-1031：canonical_owner_path 永远是 S-<seq>.md 自身路径，
 * frontmatter sources 至少含 room-messages。
 */
export function writeAgentSessionLedger(opts: {
  wikiRoot: string
  session: RoomAgentSession
  /** room-messages source range（option，由 RoomCompiler 计算） */
  messageIdRange?: [string, string]
  /** body markdown（chap 9 没硬约束，caller 决定）；不传则只写 frontmatter + 空白 */
  body?: string
}): AgentSessionFileLayout {
  const layout = computeAgentSessionLayout({
    wikiRoot: opts.wikiRoot,
    roomId: opts.session.roomId,
    alias: opts.session.alias,
    sessionSeq: opts.session.sessionSeq,
  })

  const fm: SessionLedgerFrontmatter = {
    session_id: opts.session.sessionId,
    room_id: opts.session.roomId,
    alias: opts.session.alias,
    session_seq: opts.session.sessionSeq,
    started_at: opts.session.startedAt,
    ended_at: opts.session.endedAt,
    entry_reason: opts.session.entryReason,
    exit_reason: opts.session.exitReason,
    last_seen_commit_seq: opts.session.lastSeenCommitSeq,
    open_threads: opts.session.openThreads,
    closed_threads: opts.session.closedThreads,
    canonical_owner_path: layout.canonicalOwnerRelPath,
    sources: opts.messageIdRange
      ? [{ type: "room-messages", message_id_range: opts.messageIdRange }]
      : [{ type: "room-messages" }],
  }

  const content = buildLedgerMarkdown(fm, opts.body, opts.session.sessionDigest)
  writeFileAtomic(layout.ledgerPath, content)
  // current.md 派生：用同一份内容（hot path = 最新 session digest）
  const currentContent = buildCurrentMarkdown(fm, opts.session.sessionDigest)
  writeFileAtomic(layout.currentPath, currentContent)
  return layout
}

/**
 * 单独写 current.md（不写 S 文件） —— 用于 active session 还没 end 但要更新热路径。
 * V16.5 chap 9 行 1074："assembler 注入只读 current.md (200-400 tok)" 实时刷新场景。
 */
export function writeCurrentOnly(opts: {
  wikiRoot: string
  session: RoomAgentSession
  digest?: string
}): string {
  const layout = computeAgentSessionLayout({
    wikiRoot: opts.wikiRoot,
    roomId: opts.session.roomId,
    alias: opts.session.alias,
    sessionSeq: opts.session.sessionSeq,
  })
  const fm: SessionLedgerFrontmatter = {
    session_id: opts.session.sessionId,
    room_id: opts.session.roomId,
    alias: opts.session.alias,
    session_seq: opts.session.sessionSeq,
    started_at: opts.session.startedAt,
    ended_at: opts.session.endedAt,
    entry_reason: opts.session.entryReason,
    exit_reason: opts.session.exitReason,
    last_seen_commit_seq: opts.session.lastSeenCommitSeq,
    open_threads: opts.session.openThreads,
    closed_threads: opts.session.closedThreads,
    canonical_owner_path: layout.canonicalOwnerRelPath,
    sources: [{ type: "room-messages" }],
  }
  const content = buildCurrentMarkdown(fm, opts.digest ?? opts.session.sessionDigest)
  writeFileAtomic(layout.currentPath, content)
  return layout.currentPath
}

// ─── frontmatter / markdown 拼装 ───────────────────────────────────

function buildLedgerMarkdown(
  fm: SessionLedgerFrontmatter,
  body: string | undefined,
  digest: string | null,
): string {
  const sections = [renderFrontmatter(fm)]
  if (digest && digest.trim().length > 0) {
    sections.push("", "## Session Digest", digest.trim())
  }
  if (body && body.trim().length > 0) {
    sections.push("", "## Body", body.trim())
  }
  // 至少留一个换行（atomic-write 不依赖结尾换行；这是 markdown 习惯）
  return `${sections.join("\n")}\n`
}

function buildCurrentMarkdown(fm: SessionLedgerFrontmatter, digest: string | null): string {
  // current.md：精简 frontmatter（只保留注入必需的） + digest
  const parts = ["---"]
  parts.push(`session_id: ${fm.session_id}`)
  parts.push(`session_seq: ${fm.session_seq}`)
  parts.push(`alias: ${escapeYamlString(fm.alias)}`)
  parts.push(`room_id: ${escapeYamlString(fm.room_id)}`)
  parts.push(`started_at: ${escapeYamlString(fm.started_at)}`)
  if (fm.ended_at) parts.push(`ended_at: ${escapeYamlString(fm.ended_at)}`)
  parts.push(`entry_reason: ${escapeYamlString(fm.entry_reason)}`)
  if (fm.exit_reason) parts.push(`exit_reason: ${escapeYamlString(fm.exit_reason)}`)
  if (fm.last_seen_commit_seq !== null) {
    parts.push(`last_seen_commit_seq: ${fm.last_seen_commit_seq}`)
  }
  parts.push(`canonical_owner_path: ${escapeYamlString(fm.canonical_owner_path)}`)
  if (fm.open_threads.length > 0) {
    parts.push("open_threads:")
    for (const ot of fm.open_threads) {
      if (typeof ot === "string") {
        parts.push(`  - ${escapeYamlString(ot)}`)
      } else {
        parts.push(`  - text: ${escapeYamlString(ot.text)}`)
        if (ot.a2a_call_id) parts.push(`    a2a_call_id: ${escapeYamlString(ot.a2a_call_id)}`)
      }
    }
  }
  parts.push("---")
  if (digest && digest.trim().length > 0) {
    parts.push("", "## Current Digest", digest.trim())
  }
  return `${parts.join("\n")}\n`
}

function renderFrontmatter(fm: SessionLedgerFrontmatter): string {
  const lines = ["---"]
  lines.push(`session_id: ${fm.session_id}`)
  lines.push(`room_id: ${escapeYamlString(fm.room_id)}`)
  lines.push(`alias: ${escapeYamlString(fm.alias)}`)
  lines.push(`session_seq: ${fm.session_seq}`)
  lines.push(`started_at: ${escapeYamlString(fm.started_at)}`)
  if (fm.ended_at) {
    lines.push(`ended_at: ${escapeYamlString(fm.ended_at)}`)
  } else {
    lines.push("ended_at: null")
  }
  lines.push(`entry_reason: ${escapeYamlString(fm.entry_reason)}`)
  if (fm.exit_reason) {
    lines.push(`exit_reason: ${escapeYamlString(fm.exit_reason)}`)
  } else {
    lines.push("exit_reason: null")
  }
  if (fm.last_seen_commit_seq !== null) {
    lines.push(`last_seen_commit_seq: ${fm.last_seen_commit_seq}`)
  } else {
    lines.push("last_seen_commit_seq: null")
  }
  if (fm.open_threads.length > 0) {
    lines.push("open_threads:")
    for (const ot of fm.open_threads) {
      if (typeof ot === "string") {
        lines.push(`  - ${escapeYamlString(ot)}`)
      } else {
        lines.push(`  - text: ${escapeYamlString(ot.text)}`)
        if (ot.a2a_call_id) lines.push(`    a2a_call_id: ${escapeYamlString(ot.a2a_call_id)}`)
      }
    }
  } else {
    lines.push("open_threads: []")
  }
  if (fm.closed_threads.length > 0) {
    lines.push("closed_threads:")
    for (const ct of fm.closed_threads) {
      lines.push(`  - ${escapeYamlString(ct)}`)
    }
  } else {
    lines.push("closed_threads: []")
  }
  lines.push(`canonical_owner_path: ${escapeYamlString(fm.canonical_owner_path)}`)
  lines.push("sources:")
  for (const s of fm.sources) {
    lines.push(`  - type: ${escapeYamlString(s.type)}`)
    if (s.message_id_range) {
      lines.push(
        `    message_id_range: [${escapeYamlString(s.message_id_range[0])}, ${escapeYamlString(s.message_id_range[1])}]`,
      )
    }
  }
  lines.push("---")
  return lines.join("\n")
}

/**
 * Minimal YAML string escape：
 *   - 含 ":" / "#" / 前导 / 尾随空白 / 多行 → 引号包；
 *   - 引号包后内部双引号 escape
 *   - 其它纯文本直接返回（YAML 接受）
 */
function escapeYamlString(s: string): string {
  if (s.length === 0) return '""'
  const needsQuote =
    /[:#"'\n\r\t\\]/.test(s) ||
    /^[\s]/.test(s) ||
    /[\s]$/.test(s) ||
    /^[-?!&*|>%@`]/.test(s) ||
    s === "null" ||
    s === "true" ||
    s === "false" ||
    /^[0-9]/.test(s)
  if (!needsQuote) return s
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
