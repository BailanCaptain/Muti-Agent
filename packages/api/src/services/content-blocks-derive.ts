/**
 * F026 P11 · LLM 文本流回填 content_blocks 派生函数
 *
 * 病灶（spec line 141）：assistant final 入库时 `messages.content_blocks` 硬编码 `'[]'`，
 * 导致 95% 的 assistant 行结构化 block 缺失，前端 / replay 拿不到 thinking + text 分离的
 * Anthropic-style 块结构。
 *
 * 修复策略：在 final flush（message-service.ts L1842）+ iteration flush（L1368）+ 间隔
 * flush（L1194）派生「单 thinking 块（如有）+ 单 text 块（如有）」并随 overwriteMessage
 * 一并写库。
 *
 * 选型：派生而非端到端 stream 改造
 *   - 当前 LLM stream `parseAssistantDelta` / `parseActivityLine` 已经把 content_blocks 拆成
 *     `text_delta` / `thinking_delta` 字符串，**结构化 block 信息在解析层就丢了**
 *   - 真正的端到端块直传需要重构 ClaudeRuntime / cli-orchestrator 接口，~3-5d
 *   - 派生方案 ~0.5d 落地，且对前端 / replay 而言「单 thinking 块 + 单 text 块」与原始
 *     stream block 序列在语义上等价（message-level 维度），不损失关键信息
 *
 * 兼容：image block / connector source 走独立的 `appendContentBlock` 路径，本派生只
 * 处理「LLM 文本流」场景，**不会覆盖**已有 image blocks（调用方自行守护，见
 * mergeWithExistingBlocks）。
 */

export type DerivedContentBlock =
  | { type: "thinking"; thinking: string }
  | { type: "text"; text: string }
  | { type: "image"; source?: unknown }
  | { type: string; [k: string]: unknown }

export interface DeriveOptions {
  content: string
  thinking?: string
}

/**
 * 从 accumulated text + thinking 派生 Anthropic-style content_blocks。
 * 空字符串 / 仅空白会被 skip — 返回 [] 与硬编码 `'[]'` 对齐（不引入误回填）。
 */
export function deriveContentBlocks(opts: DeriveOptions): DerivedContentBlock[] {
  const blocks: DerivedContentBlock[] = []
  const trimmedThinking = (opts.thinking ?? "").trim()
  if (trimmedThinking.length > 0) {
    blocks.push({ type: "thinking", thinking: opts.thinking ?? "" })
  }
  const trimmedContent = opts.content.trim()
  if (trimmedContent.length > 0) {
    blocks.push({ type: "text", text: opts.content })
  }
  return blocks
}

/**
 * 与已存在的 contentBlocks JSON merge：保留所有非「derived text/thinking」的块
 * （如 image），用最新 derive 出来的 thinking + text 替换旧的同类块。
 *
 * Why：image block 经 `appendContentBlock` 独立写入；本派生在 streaming flush 反复
 * 触发，不能把 image 一起冲掉。
 */
export function mergeDerivedWithExistingBlocks(
  existingJson: string | null | undefined,
  derived: DerivedContentBlock[],
): DerivedContentBlock[] {
  let existing: DerivedContentBlock[] = []
  try {
    existing = JSON.parse(existingJson || "[]") as DerivedContentBlock[]
    if (!Array.isArray(existing)) existing = []
  } catch {
    existing = []
  }
  const preserved = existing.filter((b) => b.type !== "thinking" && b.type !== "text")
  return [...preserved, ...derived]
}
