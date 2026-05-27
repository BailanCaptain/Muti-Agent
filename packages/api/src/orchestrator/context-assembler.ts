import type { Provider } from "@multi-agent/shared"
import { ACCEPTANCE_GUARDIAN_PROMPT, AGENT_SYSTEM_PROMPTS } from "../runtime/agent-prompts"
import type { MemoryService } from "../services/memory-service"
import type { ThreadMemory } from "../services/thread-memory"
import type { ExtractiveDigestV1 } from "../services/transcript-writer"
import type { ContextPolicy } from "./context-policy"
import { POLICY_FULL } from "./context-policy"
import type { ContextMessage } from "./context-snapshot"
import { sanitizeHandoffBody } from "./sanitize-handoff"
import { buildSessionBootstrap } from "./session-bootstrap"
import type { SOPBookmark } from "./sop-bookmark"
import { formatBookmarkForInjection } from "./sop-bookmark"

export type AssemblePromptInput = {
  provider: Provider
  threadId: string
  sessionGroupId: string
  /** If set, CLI can --resume and self-history is redundant */
  nativeSessionId: string | null
  policy: ContextPolicy
  /** The task/user message content */
  task: string
  /** Optional preamble (requirements doc, etc.) for DOCUMENT_ONLY policy */
  preamble?: string
  /** Context snapshot from the room (all threads' messages merged) */
  roomSnapshot: readonly ContextMessage[]
  /** Who initiated: "user" or agent alias */
  sourceAlias: string
  /** Target agent's alias (e.g. "黄仁勋") */
  targetAlias: string
  /** SOP bookmark for cross-seal skill state restoration */
  sopBookmark?: SOPBookmark | null
  /** Last fill ratio for dynamic budget computation */
  lastFillRatio?: number
  /** When true, replace system prompt with ACCEPTANCE_GUARDIAN_PROMPT (zero-context mode) */
  guardianMode?: boolean
  /** F018 AC3.5: Thread memory rolling summary for SessionBootstrap (new session only) */
  threadMemory?: ThreadMemory | null
  /** F018 AC3.5: Session chain index — Nth session under this thread */
  sessionChainIndex?: number
  /** F018 AC3.5: Available recall tools injected into Bootstrap tools section */
  recallTools?: string[]
  /** F018 AC3.5: Previous session's extractive digest (from TranscriptWriter) */
  previousDigest?: ExtractiveDigestV1 | null
  /**
   * F026-P3 Task6 · cold-target burst 注入位（场景3 ·下游冷启时给 burst+tombstone）。
   * 触发判定由 callsite 决定（nativeSessionId === null AND threadMemory == null AND
   * previousDigest == null）；本入参在的 = caller 已经判定要注入。
   * 注入位置：SessionBootstrap section 之后、[A2A 协作请求]/[用户请求] header 之前。
   * Source 不限（user → cold 与 agent → cold 同等覆盖）。
   */
  coldTargetBurst?: { burstSection: string; tombstoneSection: string | null }

  // ─── F027 P5 · V16.4 新增 7 字段 (V16.5 chap 4 行 393-401) ─────────────
  /** F027 chap 8 RoomCompiler 联动（F022 R-XXX）。Phase 1 仅作 metadata，未驱动逻辑。 */
  roomId?: string | null
  /** 显式区分 wake-up / handoff / session_bootstrap 场景，决定哪些区段注入 */
  scenario?: "session_bootstrap" | "wake_up" | "a2a_handoff"
  /**
   * F027 chap 11 viewfinder reference 视图（room 防漂移）。
   * Phase 1 caller 传已 stringify 的 markdown body；P11 实施完整 ViewfinderRef 后再细化。
   */
  viewfinder?: { body: string } | null
  /**
   * F027 chap 13 capability_digest_for_self（P9 capability registry 输出）。
   * caller 调 getSelfCapabilityDigest(targetAlias, registry) 拿到。
   * 进 systemPrompt（agent 身份层），不进 content（V16.5 chap 4 行 417-419）。
   */
  capabilityDigest?: string | null
  /**
   * F027 chap 27 handbook H2 切片 — agent actions 部分（仅 first wake-up 注入）。
   * caller 调 loadHandbookSlices(wikiRoot).agentActions 拿到。
   */
  handbookSlices?: { agentActions: string } | null
  /**
   * F027 chap 10 memory_preflight 高置信召回（≥ 0.75）。
   * Phase 1 简化 shape：caller 传已过滤的 hits；P11 实施 TaskMemoryPack 后再细化。
   */
  memoryPreflight?: {
    hits: Array<{ score: number; summary: string; path?: string }>
  } | null
  /**
   * F027 chap 13 handoff 中性改写（不暴露 sender risks）。
   * F026 EnvelopeBuilder 在派发时填充（V16.5 chap 4 行 422-431）。
   * Phase 1 简化 shape：receiverAlias + taskSummary 两个派生字段。
   */
  handoffContext?: { receiverAlias: string; taskSummary: string } | null
}

/**
 * F027 P4 hotfix · Prompt Inspector parts metadata.
 *
 * V16.5-final.md §18 line 2030-2079："让你亲眼验证 V14 的'唯一注入合约'真的工作了"
 * — Prompt Inspector tab 每条 part 必须展示 name + tokens。
 *
 * `tokens` 用 char/4 估算（V16.5 §18 line 2515 同口径，token 精确度量留 Phase 5）。
 * `surface` 标识落到 systemPrompt 还是 content，前端按颜色分组。
 */
export type PromptPart = {
  name: string
  tokens: number
  surface: "systemPrompt" | "content"
}

/**
 * F027 v3 G1 · V16.5 chap 20 line 2273-2275 token 预算硬顶（runtime 单次 wake-up）。
 *
 * 6700 = wake-up runtime cap（CLI harness ~3500 是不可控的，runtime 这一段 = 6700）。
 * 合并 cap ~10200 由 caller 自己加 harness 预算，本入口只管 runtime 段。
 *
 * 改值时记得同步：V16.5 chap 20 line 2273 表格 / docs/features/F027/F027-v3-PATCH.md G1 章节。
 */
export const WAKEUP_TOKEN_CAP = 6700

/**
 * F027 v3 G1 · Drop order（最先被砍的在前，硬顶溢出时按此序丢弃）。
 *
 * 设计原则（对齐 F018 session-bootstrap.ts:17 drop order 推到全 prompt 层）：
 *   - base-identity / guardian-prompt / sop-bookmark / capability-digest / session-bootstrap
 *     / task / handoff-context 永不丢（agent 身份 + 当前任务 + 协作合约不可缺）
 *   - viewfinder 是 room 防漂移核心（V16.5 chap 11），最后才丢
 *   - cold-target-burst 是冷启动救命包，倒数第二丢
 *   - rolling-summary / handbook 是 reference 性辅助，可早丢
 *   - recall-pack 是 memory_preflight 召回，最先丢（找不到信息时 agent 还能调 recall_similar_context 工具补救）
 */
const DROP_ORDER: ReadonlyArray<PromptPart["name"]> = [
  "recall-pack",
  "handbook-agent-actions",
  "rolling-summary",
  "cold-target-tombstone",
  "cold-target-burst",
  "collaboration-contract",
  "viewfinder",
]

/**
 * F027 v3 G1 · prompt_audit.not_injected_json 行项 schema。
 *
 * 写真值（cap 溢出后被 reducer 砍的 part）后，Inspector NotInjectedSection 渲染:
 *   "❌ recall-pack (1200 tok) — over_cap_drop_order"
 */
export type NotInjectedPart = {
  name: string
  tokens: number
  reason: "over_cap_drop_order"
}

export type AssemblePromptResult = {
  systemPrompt: string
  content: string
  /** F027 P4 hotfix · 每注入一段就 push 一条；caller 传给 promptAuditWriter.partsJson。 */
  parts: PromptPart[]
  /**
   * F027 v3 G1 · drop reducer 砍掉的 part 列表（V16.5 chap 20 cap 溢出时）。
   * 空数组 = 全部注入成功；caller 传给 promptAuditWriter.notInjectedJson。
   */
  notInjected: NotInjectedPart[]
  /** F027 v3 G1 · 本次拼装使用的总 cap（V16.5 chap 20 wake-up runtime = WAKEUP_TOKEN_CAP）。 */
  cap: number
}

/** F027 P4 hotfix · char/4 token 估算（V16.5 §18 line 2515 同口径）。 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * F027 v3 G1 · 内部 AssemblyPart — 每段带 block (注入到 prompt 的实际文本)。
 *
 * 每个 block 自带前导分隔（"\n\n"），可单独删除而不影响相邻 block 排版。
 * 第一个 block (base-identity/guardian-prompt) 无前导分隔，永不被删。
 */
type AssemblyPart = {
  name: PromptPart["name"]
  surface: "systemPrompt" | "content"
  block: string
  tokens: number
}

/**
 * F027 v3 G1 · Token 预算 reducer — sum > cap 时按 DROP_ORDER 砍 part。
 *
 * tokens 字段只统计 body 内容（不含前导分隔），与原 push parts 时 estimateTokens 同口径，
 * 避免分隔字符让 budget 算高。永不被 drop：不在 DROP_ORDER 里的 part（包括 task / base-identity 等）。
 */
function applyTokenBudget(
  partsInOrder: ReadonlyArray<AssemblyPart>,
  cap: number,
): { kept: AssemblyPart[]; notInjected: NotInjectedPart[] } {
  const notInjected: NotInjectedPart[] = []
  if (cap <= 0) return { kept: [...partsInOrder], notInjected }
  let total = partsInOrder.reduce((s, p) => s + p.tokens, 0)
  if (total <= cap) return { kept: [...partsInOrder], notInjected }
  const dropped = new Set<PromptPart["name"]>()
  for (const name of DROP_ORDER) {
    if (total <= cap) break
    const idx = partsInOrder.findIndex((p) => p.name === name && !dropped.has(p.name))
    if (idx < 0) continue
    const part = partsInOrder[idx]
    dropped.add(part.name)
    notInjected.push({ name: part.name, tokens: part.tokens, reason: "over_cap_drop_order" })
    total -= part.tokens
  }
  const kept = partsInOrder.filter((p) => !dropped.has(p.name))
  return { kept, notInjected }
}

/**
 * Single entry point for building the complete prompt for any agent invocation.
 * Replaces: getSystemPromptForTurn, buildSystemPrompt, buildA2APrompt, captureSnapshot, truncateForA2A.
 *
 * System prompt = base identity + rolling summary (if policy allows)
 * Content = task + context layers determined by policy
 */
export async function assemblePrompt(
  input: AssemblePromptInput,
  memoryService: MemoryService | null,
): Promise<AssemblePromptResult> {
  const { provider, policy, roomSnapshot, targetAlias } = input
  void roomSnapshot

  // ── System Prompt ──────────────────────────────────────────────────
  // Guardian mode: zero-context custom prompt, no identity/team/rules injection.
  if (input.guardianMode) {
    return {
      systemPrompt: ACCEPTANCE_GUARDIAN_PROMPT,
      content: input.task,
      parts: [
        {
          name: "guardian-prompt",
          tokens: estimateTokens(ACCEPTANCE_GUARDIAN_PROMPT),
          surface: "systemPrompt",
        },
      ],
      notInjected: [],
      cap: WAKEUP_TOKEN_CAP,
    }
  }

  // F027 v3 G1 · 用 AssemblyPart[] 替代原 systemParts/contentSections 字符串数组，
  // 让 cap reducer 能 drop 整段；每段 block 自带前导分隔（"\n\n"），删后排版仍干净。
  const assembly: AssemblyPart[] = []

  // ── 1. base-identity (systemPrompt, 永不 drop, 第一段无前导分隔) ──
  const baseIdentity = AGENT_SYSTEM_PROMPTS[provider]
  assembly.push({
    name: "base-identity",
    surface: "systemPrompt",
    block: baseIdentity,
    tokens: estimateTokens(baseIdentity),
  })

  // ── 2. rolling-summary (systemPrompt, droppable) ──
  if (policy.injectRollingSummary && memoryService) {
    const summary = await memoryService.getOrCreateSummary(input.sessionGroupId)
    if (summary) {
      // F018 AC5.6: LLM-generated rolling summary can contain directive-like
      // lines (SYSTEM:/IMPORTANT:) or forged closing tags; sanitize before
      // injecting into the system prompt.
      const sanitized = sanitizeHandoffBody(summary)
      // B-fix: rolling summary 注入 system prompt 前硬截断到 8K，防止 claude CLI
      // `--append-system-prompt` 撞 Windows CreateProcess 32767 字符上限（ENAMETOOLONG）。
      // 仅 claude-runtime 把 system prompt 走 argv，codex/gemini 走 stdin 不爆。
      const capped =
        sanitized.length > 8000
          ? sanitized.slice(0, 8000) +
            "\n…（摘要超长已截断，详细历史请用 recall_similar_context 按需查询）"
          : sanitized
      if (capped) {
        assembly.push({
          name: "rolling-summary",
          surface: "systemPrompt",
          block: `\n\n## 本房间摘要\n${capped}\n请参考上述背景信息继续协作。`,
          tokens: estimateTokens(capped),
        })
      }
    }
  }

  // ── 3. sop-bookmark (systemPrompt, 永不 drop) ──
  if (policy.injectRollingSummary && input.sopBookmark) {
    const bookmarkLine = formatBookmarkForInjection(input.sopBookmark)
    if (bookmarkLine) {
      assembly.push({
        name: "sop-bookmark",
        surface: "systemPrompt",
        block: `\n\n## 当前执行状态\n${bookmarkLine}`,
        tokens: estimateTokens(bookmarkLine),
      })
    }
  }

  // ── 4. capability-digest (systemPrompt, 永不 drop) ──
  // F027 P5 · V16.5 chap 4 行 405：capabilityDigest 进 systemPrompt（agent 身份层）。
  // 不进 content（V16.5 chap 4 行 417-419 严格区分：systemPrompt = agent 身份；
  // content = reference-only）。capability_digest_for_self 是 agent 自我介绍属性，
  // sanitize 是为防 wiki 修改后被 prompt-injection 污染（registry 来自 wiki/agents/）。
  if (input.capabilityDigest) {
    const sanitized = sanitizeHandoffBody(input.capabilityDigest)
    if (sanitized) {
      assembly.push({
        name: "capability-digest",
        surface: "systemPrompt",
        block: `\n\n## Capability Digest\n${sanitized}`,
        tokens: estimateTokens(sanitized),
      })
    }
  }

  // ── Content (user message) ─────────────────────────────────────────

  // ── 5. session-bootstrap (content, 永不 drop, 自带内部 drop order) ──
  // F018 AC3.5: New session gets SessionBootstrap reference-only prelude
  // (Thread Memory / Previous Session / Task Snapshot / Recall Tools / Do NOT guess).
  // Injected only when nativeSessionId is null AND caller supplied bootstrap metadata —
  // this preserves existing callers that haven't been wired yet (P4 wires message-service).
  if (
    input.nativeSessionId === null &&
    (input.sessionChainIndex !== undefined ||
      input.threadMemory !== undefined ||
      input.previousDigest !== undefined ||
      input.recallTools !== undefined)
  ) {
    const bootstrap = buildSessionBootstrap({
      threadId: input.threadId,
      sessionChainIndex: input.sessionChainIndex ?? 1,
      threadMemory: input.threadMemory ?? null,
      previousDigest: input.previousDigest ?? null,
      taskSnapshot: input.sopBookmark
        ? (formatBookmarkForInjection(input.sopBookmark) ?? null)
        : null,
      recallTools: input.recallTools ?? [],
    })
    assembly.push({
      name: "session-bootstrap",
      surface: "content",
      block: `${bootstrap.text}\n`,
      tokens: estimateTokens(bootstrap.text),
    })
  }

  // ── 6. cold-target-burst (+ tombstone) (content, droppable) ──
  // F026-P3 Task6 · cold-target burst 注入（SessionBootstrap 之后 / header 之前）
  // 触发判定由 callsite 决定（nativeSessionId == null AND threadMemory == null AND
  // previousDigest == null）；本段在的 = caller 已判定要注入。Source 不限。
  if (input.coldTargetBurst) {
    assembly.push({
      name: "cold-target-burst",
      surface: "content",
      block: `\n${input.coldTargetBurst.burstSection}`,
      tokens: estimateTokens(input.coldTargetBurst.burstSection),
    })
    if (input.coldTargetBurst.tombstoneSection) {
      assembly.push({
        name: "cold-target-tombstone",
        surface: "content",
        block: `\n${input.coldTargetBurst.tombstoneSection}`,
        tokens: estimateTokens(input.coldTargetBurst.tombstoneSection),
      })
    }
  }

  // ─── F027 P5 · 4 个新 reference-only 区段（V16.5 chap 4 行 362-367） ──────
  // 顺序固定（AC-P1-7）：Viewfinder → Recall Pack → Handbook → Collaboration Contract
  // 全部以 [Section — Reference Only] 包裹，body 入 wrapper 前过 sanitizeHandoffBody
  // 防 LLM 生成 / wiki 写入的内容含 directive-like 行 (SYSTEM:/IMPORTANT:) 或伪闭合标签。

  // ── 7. viewfinder (content, droppable last — room 防漂移核心) ──
  if (input.viewfinder?.body) {
    const sanitized = sanitizeHandoffBody(input.viewfinder.body)
    if (sanitized) {
      assembly.push({
        name: "viewfinder",
        surface: "content",
        block: `\n[Viewfinder — Reference Only]\n${sanitized}\n[/Viewfinder]\n`,
        tokens: estimateTokens(sanitized),
      })
    }
  }

  // ── 8. recall-pack (content, droppable first — memory_preflight 召回) ──
  // V16.5 chap 4 行 366："≥ 0.75 才注入；0.6-0.75 仅 Inspector 看"——caller 责任过滤
  if (input.memoryPreflight && input.memoryPreflight.hits.length > 0) {
    const lines: string[] = ["[Recall Pack — Reference Only]"]
    for (const hit of input.memoryPreflight.hits) {
      const sanitized = sanitizeHandoffBody(hit.summary)
      if (!sanitized) continue
      const pathPart = hit.path ? ` path=${hit.path}` : ""
      lines.push(`- (score=${hit.score.toFixed(2)}${pathPart}) ${sanitized}`)
    }
    if (lines.length > 1) {
      lines.push("[/Recall Pack]")
      const body = lines.join("\n")
      assembly.push({
        name: "recall-pack",
        surface: "content",
        block: `\n${body}\n`,
        tokens: estimateTokens(body),
      })
    }
  }

  // ── 9. handbook-agent-actions (content, droppable — first wake-up only) ──
  // V16.5 chap 4 行 365：capability_digest 已覆盖最小动作集时 skip
  // Phase 1 简化：scenario === 'wake_up' 且 caller 提供 handbookSlices.agentActions 即注入
  if (input.scenario === "wake_up" && input.handbookSlices?.agentActions) {
    const sanitized = sanitizeHandoffBody(input.handbookSlices.agentActions)
    if (sanitized) {
      assembly.push({
        name: "handbook-agent-actions",
        surface: "content",
        block: `\n[Handbook — Agent Actions — Reference Only]\n${sanitized}\n[/Handbook]\n`,
        tokens: estimateTokens(sanitized),
      })
    }
  }

  // ── 10. collaboration-contract (content, droppable second-last — a2a_handoff only) ──
  // V16.5 chap 4 行 422-431：handoffContext 由 F026 EnvelopeBuilder 派发时填充。
  // sender risks 不泄漏的保护：caller (message-service.buildA2AHandoffContext) 限定
  // 只透 receiverAlias + entry.taskSnippet，不读任何 sender capabilities/risks 字段；
  // 等价于 P9 rewriter 白名单输出 4 字段 envelope 的 2 字段子集 (V16.5 §4 line 429-431)。
  // P9 capability-registry/handoff-rewriter.ts 完整 4 字段 leak-detection 在 P9 fixture 跑，
  // 不在本 path 调用 (rewriter 是 fixture 校验用，runtime path 简化)。
  if (input.scenario === "a2a_handoff" && input.handoffContext) {
    const sanitizedReceiver = sanitizeHandoffBody(input.handoffContext.receiverAlias)
    const sanitizedTask = sanitizeHandoffBody(input.handoffContext.taskSummary)
    if (sanitizedReceiver || sanitizedTask) {
      const blockLines: string[] = [
        "[Collaboration Contract — Reference Only]",
        `receiver_alias: ${sanitizedReceiver}`,
      ]
      if (sanitizedTask) blockLines.push(`task_summary: ${sanitizedTask}`)
      blockLines.push("[/Collaboration Contract]")
      const body = blockLines.join("\n")
      assembly.push({
        name: "collaboration-contract",
        surface: "content",
        block: `\n${body}\n`,
        tokens: estimateTokens(body),
      })
    }
  }

  // ── 11. task (content, 永不 drop — 包含 header / 任务 / preamble / MCP hint / 落款) ──
  // F019 P4: skillHint keyword-injection layer removed — SOP direction now
  // comes from sopStageHint in the system prompt (see agent-prompts.ts
  // buildSystemPromptWithHints). CLI-native skill discovery handles the rest.
  //
  // F018 AC5.3/5.4: 废弃 `--- 你之前的发言 ---` + `--- 近期对话 ---` 原对话重灌。
  // 新架构：新 session 的历史通过 SessionBootstrap (ThreadMemory + Previous Session
  // Summary) 注入；继承 session (nativeSessionId !== null) 依赖 CLI --resume；按需
  // 细节由 agent 主动调 recall_similar_context 工具（Bootstrap tools 段已注入工具清单）。
  const isUserInitiated = input.sourceAlias === "user"
  const taskLines: string[] = [
    isUserInitiated ? "[用户请求]" : `[A2A 协作请求 from ${input.sourceAlias}]`,
    "",
    `任务: ${input.task}`,
    "",
  ]
  if (policy.injectPreamble && input.preamble) {
    taskLines.push("--- 需求文档 ---", input.preamble, "---", "")
  }
  taskLines.push(
    "如需更早的上下文，可调用 MCP get_room_context 工具获取。",
    "",
    `你是 ${targetAlias}。请完成上述任务。`,
  )
  const taskBlock = taskLines.join("\n")
  assembly.push({
    name: "task",
    surface: "content",
    block: `\n${taskBlock}`,
    tokens: estimateTokens(input.task),
  })

  // ── F027 v3 G1 · Token 预算 reducer ──────────────────────────────
  const { kept, notInjected } = applyTokenBudget(assembly, WAKEUP_TOKEN_CAP)

  const systemPrompt = kept
    .filter((p) => p.surface === "systemPrompt")
    .map((p) => p.block)
    .join("")
  const content = kept
    .filter((p) => p.surface === "content")
    .map((p) => p.block)
    .join("")

  const parts: PromptPart[] = kept.map((p) => ({
    name: p.name,
    tokens: p.tokens,
    surface: p.surface,
  }))

  return {
    systemPrompt,
    content,
    parts,
    notInjected,
    cap: WAKEUP_TOKEN_CAP,
  }
}

/**
 * Direct user → single agent turn prompt assembly.
 *
 * F004: promoted from "systemPrompt only" to full {systemPrompt, content}
 * assembly so direct-turn history is injected by the API (authoritative),
 * not left to CLI --resume (unreliable). Internally delegates to
 * `assemblePrompt` with POLICY_FULL, sourceAlias="user", no phase1 header,
 * no preamble, non-guardian mode.
 */
export type AssembleDirectTurnInput = {
  provider: Provider
  threadId: string
  sessionGroupId: string
  /** Only used by downstream runtime for CLI --resume; no longer gates history injection. */
  nativeSessionId: string | null
  task: string
  sourceAlias: "user"
  targetAlias: string
  roomSnapshot: readonly ContextMessage[]
  sopBookmark?: SOPBookmark | null
  lastFillRatio?: number
  /** F018 AC3.5: SessionBootstrap metadata (forwarded to assemblePrompt) */
  threadMemory?: ThreadMemory | null
  sessionChainIndex?: number
  recallTools?: string[]
  previousDigest?: ExtractiveDigestV1 | null
  /** F026-P3 Task6 · cold-target burst（user-mention 路径同等覆盖） */
  coldTargetBurst?: { burstSection: string; tombstoneSection: string | null }

  // ─── F027 P4 hotfix · reader 侧 wire-up（V16.5 §4 line 396-400） ──────
  // direct turn 也应注入 viewfinder / capability digest / handbook / recall pack；
  // P5 commit 6d75a9e 扩了 assemblePrompt 接口但 assembleDirectTurnPrompt 没转发。
  /** F027 chap 11 防漂移 viewfinder 视图（user content 注入）。 */
  viewfinder?: { body: string } | null
  /** F027 chap 13 capability digest 自身 6 槽（systemPrompt 注入）。 */
  capabilityDigest?: string | null
  /** F027 chap 27 handbook agent actions H2 切片（first wake-up only）。 */
  handbookSlices?: { agentActions: string } | null
  /** F027 chap 10 memory_preflight 高置信召回（≥ 0.75）。 */
  memoryPreflight?: {
    hits: Array<{ score: number; summary: string; path?: string }>
  } | null
  /** 显式区分 wake_up / session_bootstrap（direct turn 默认 wake_up）。 */
  scenario?: "session_bootstrap" | "wake_up"
  /** room alias（R-###）— 给 caller 拿 viewfinder / inspector roomId 标识用。 */
  roomId?: string | null
}

export async function assembleDirectTurnPrompt(
  input: AssembleDirectTurnInput,
  memoryService: MemoryService | null,
): Promise<AssemblePromptResult> {
  return assemblePrompt(
    {
      provider: input.provider,
      threadId: input.threadId,
      sessionGroupId: input.sessionGroupId,
      nativeSessionId: input.nativeSessionId,
      policy: POLICY_FULL,
      task: input.task,
      preamble: undefined,
      roomSnapshot: input.roomSnapshot,
      sourceAlias: input.sourceAlias,
      targetAlias: input.targetAlias,
      sopBookmark: input.sopBookmark,
      lastFillRatio: input.lastFillRatio,
      guardianMode: false,
      threadMemory: input.threadMemory,
      sessionChainIndex: input.sessionChainIndex,
      recallTools: input.recallTools,
      previousDigest: input.previousDigest,
      coldTargetBurst: input.coldTargetBurst,
      // F027 P4 hotfix · 5 字段转发
      viewfinder: input.viewfinder,
      capabilityDigest: input.capabilityDigest,
      handbookSlices: input.handbookSlices,
      memoryPreflight: input.memoryPreflight,
      scenario: input.scenario ?? "wake_up",
      roomId: input.roomId,
    },
    memoryService,
  )
}
