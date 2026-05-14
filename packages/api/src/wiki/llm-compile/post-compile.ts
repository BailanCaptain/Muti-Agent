/**
 * F027 P4.6 · Phase 3 Post-compile validation
 * 真相源：docs/plans/V16.5-final.md chap 26 行 2829-2916
 *
 * 步骤：
 *   1. cross_refs 死链检测（不阻塞，记 deadRefs，由 caller 落 wiki/warnings/）
 *   2. derive draftPath = wiki/concepts/draft/<date>-<slug>.md
 *   3. fill 完整 frontmatter（19 字段三段：agent 3 + LLM 13 + post derive 3）
 *   4. dedup 边角字段（merge_into / supersedes case）
 *   5. canonical_owner_suggestion = wiki/rules/ → requires_user_review=true
 *   6. 写 wiki_events action='ingest' + content_hash
 */

import { createHash } from "node:crypto"
import type {
  AgentDraftFrontmatter,
  CompiledFrontmatter,
  DeadCrossRef,
  DraftResult,
  EntityExistenceChecker,
  LLMCompileOutput,
  RawMetadata,
  WikiEventsWriter,
} from "./types"

export interface PostCompileOptions {
  /** draft 目录前缀（默认 wiki/concepts/draft/） */
  draftDirPrefix?: string
}

export async function postCompile(
  llmOutput: LLMCompileOutput,
  rawMetadata: RawMetadata,
  agentDraft: AgentDraftFrontmatter,
  deps: {
    entityChecker: EntityExistenceChecker
    wikiEvents: WikiEventsWriter
  },
  options?: PostCompileOptions,
): Promise<DraftResult> {
  const draftDirPrefix = options?.draftDirPrefix ?? "wiki/concepts/draft/"

  // Step 1：cross_refs 死链检测（并发）
  const deadRefs: DeadCrossRef[] = []
  const liveRefs = []
  const checks = await Promise.all(
    llmOutput.cross_refs.map(async (ref) => ({
      ref,
      exists: await deps.entityChecker.exists(ref.target),
    })),
  )
  for (const { ref, exists } of checks) {
    if (exists) {
      liveRefs.push(ref)
    } else {
      deadRefs.push({ ref, reason: `entity "${ref.target}" not found in wiki/{concepts,rules,methods,people}/` })
    }
  }

  // Step 2：derive draftPath
  const slug = slugifyTitle(llmOutput.title)
  const draftPath = `${draftDirPrefix}${rawMetadata.date}-${slug}.md`

  // Step 3：fill 完整 frontmatter（V16.5 chap 26 行 2851-2873）
  const frontmatter: CompiledFrontmatter = {
    // —— A. agent 写（3 字段）——
    title: agentDraft.title,
    type: llmOutput.type,
    sources: agentDraft.sources,

    // —— B. compile-LLM 输出（V16.5 chap 26 行 2858-2863）——
    summary: llmOutput.summary,
    facts: llmOutput.facts,
    cross_refs: liveRefs, // 死链已过滤
    dedup_decision: llmOutput.dedup_decision,
    draft_quality: llmOutput.draft_quality,
    canonical_owner_suggestion: llmOutput.canonical_owner_suggestion,

    // —— C. post 阶段 derive（V16.5 chap 26 行 2865-2873）——
    canonical_owner_path: draftPath,
    proposed_promote_to: derivePromoteTarget(llmOutput.canonical_owner_suggestion, slug),
    tainted_source: rawMetadata.fromUserDrop,
    ingest_metadata: {
      ingest_event_id: rawMetadata.ingestMessageId,
      ...(rawMetadata.userReason !== undefined && { user_reason: rawMetadata.userReason }),
      series_id: rawMetadata.seriesId ?? null,
    },
  }

  // Step 4：dedup 边角字段（仅 merge_into / supersedes case）
  switch (llmOutput.dedup_decision.verdict) {
    case "merge_into":
      if (llmOutput.dedup_decision.target_entity) {
        frontmatter.merge_target = llmOutput.dedup_decision.target_entity
      }
      break
    case "supersedes":
      if (llmOutput.dedup_decision.target_entity) {
        frontmatter.supersedes = [llmOutput.dedup_decision.target_entity]
      }
      break
    // case "new_entity": 无额外字段
  }

  // Step 5：canonical_owner_suggestion = wiki/rules/ → 强制小孙审
  if (llmOutput.canonical_owner_suggestion === "wiki/rules/") {
    frontmatter.requires_user_review = true
    frontmatter.suggested_promote_to = "wiki/rules/"
  }

  // Step 6：写 wiki_events action='ingest' + content_hash
  const contentHash = computeContentHash(llmOutput)
  const { eventId } = await deps.wikiEvents.append({
    action: "ingest",
    path: draftPath,
    contentHash,
    sourceMessageIds: [rawMetadata.ingestMessageId],
    ...(rawMetadata.userReason !== undefined && { reason: rawMetadata.userReason }),
  })

  return {
    draftPath,
    eventId,
    deadRefs,
    frontmatter,
    dedupDecision: llmOutput.dedup_decision,
  }
}

/**
 * V16.5 chap 26 derivePromoteTarget。
 * canonical_owner_suggestion 决定 entity 最终落哪个目录（promote 后路径）。
 * 命名约定：title slug 化后 + 目录前缀 + .md。
 */
export function derivePromoteTarget(
  suggestion: LLMCompileOutput["canonical_owner_suggestion"],
  slug: string,
): string {
  return `${suggestion}${slug}.md`
}

/**
 * title → slug：
 *   - 小写 + ASCII 字母数字 + 中文保留
 *   - 空白 / 标点 / 特殊符号 → '-'
 *   - 连续 '-' 合并 + 首尾 trim
 *   - 限长 60 char（防 path 过长）
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKC")
    // 把所有非字母数字（含中文 一-鿿）替换为 -
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return slug.length > 60 ? slug.slice(0, 60) : slug || "untitled"
}

/**
 * content_hash for wiki_events.content_hash —— stable JSON stringify 后 SHA256。
 * 用 sorted keys 防 LLM 输出 key 顺序不稳影响 hash。
 */
export function computeContentHash(llmOutput: LLMCompileOutput): string {
  const stable = stableStringify(llmOutput)
  return createHash("sha256").update(stable).digest("hex").slice(0, 16) // 16 hex char prefix 够了
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`
}
