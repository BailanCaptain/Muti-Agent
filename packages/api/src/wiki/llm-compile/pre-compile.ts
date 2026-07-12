/**
 * F027 P4.6 · Phase 1 Pre-compile
 * 真相源：docs/plans/V16.5-final.md chap 26 行 2729-2754
 *
 * 目的：让 LLM 编译时知道 wiki 已有什么，避免重复 + 找出 cross-ref 候选。
 *
 * 步骤：
 *   1. 对 raw 做 embedding（复用 F018 EmbeddingService.generateEmbedding）
 *   2. 与 wiki 已有 entity embedding 比对，取 top-5 ≥ score_floor (0.4)
 *   3. 加载 wiki/index/concepts.md + rules.md（轻量目录）
 *   4. 输出 PreCompileContext 给 Phase 2 拼 SYSTEM prompt
 *
 * 失败降级：embedding service 不可用 → similarEntities = []，indexLite 仍 load。
 *   理由：similar entities 是优化（提供 dedup 信号），不是 correctness 必需；
 *   LLM 仍可基于 indexLite 做 cross_refs 识别。F018 EmbeddingService 已固有
 *   静默降级行为（B019 修复后），此处不再二次 try/catch。
 */

import type { EmbeddingService, RecallHit } from "../../services/embedding-service"
import type {
  IndexLiteLoader,
  PreCompileContext,
  RawMetadata,
  SimilarEntity,
} from "./types"
import type { WikiCandidateSearch } from "./wiki-candidate-search"

/** Phase 1 默认参数（V16.5 chap 26 行 2740-2742） */
const DEFAULT_TOP_K = 5
const DEFAULT_SCORE_FLOOR = 0.4
const DEFAULT_TOTAL_CONTEXT_TOKENS = 1500

export interface PreCompileOptions {
  topK?: number
  scoreFloor?: number
  totalContextTokens?: number
  /** 限定 vector search 范围（默认 wiki/concepts/, wiki/rules/, wiki/methods/） */
  scopes?: Array<"concepts" | "rules" | "methods">
  /**
   * threadIds 用于 EmbeddingService.searchByVector 的 thread 范围参数。
   * P4.6 在 ingest 上下文调用，threadIds 可传入"系统级 wiki 池"标识或留空数组
   * 时降级 similarEntities=[]（caller 责任决定 wiki entity embedding 怎么存）。
   * 默认 []（Phase 1 阶段 wiki entity 索引尚未由 P2 WikiCompiler 写入）。
   */
  threadIds?: string[]
  /** entity_path → 元数据查询 callback（把 RecallHit.messageId 映射回 entity title/summary） */
  entityMetadataLookup?: (entityKey: string) => Promise<{
    path: string
    title: string
    summary: string
  } | null>
  /**
   * F042 AC4 · 候选检索查询文本的 title 部分（agentDraft.title，pipeline 透传）。
   * 仅 wikiCandidateSearch 路径消费；缺省用空串（纯正文头查询）。
   */
  title?: string
}

export async function preCompile(
  rawContent: string,
  rawMetadata: RawMetadata,
  deps: {
    embedding: Pick<EmbeddingService, "generateEmbedding" | "searchByVector">
    indexLoader: IndexLiteLoader
    /**
     * F042 AC4 · wiki_entity_index 候选检索（生产 hybridWikiSearch 适配）。注入时优先于
     * 旧 message_embeddings 路径（那条在 ingest 场景 threadIds 恒空从未产出）；不注入
     * 保持现状（存量测试/旧 caller 零回归）。
     */
    wikiCandidateSearch?: WikiCandidateSearch
  },
  options?: PreCompileOptions,
): Promise<PreCompileContext> {
  const opts = {
    topK: options?.topK ?? DEFAULT_TOP_K,
    scoreFloor: options?.scoreFloor ?? DEFAULT_SCORE_FLOOR,
    totalContextTokens: options?.totalContextTokens ?? DEFAULT_TOTAL_CONTEXT_TOKENS,
    scopes: options?.scopes ?? (["concepts", "rules", "methods"] as const),
    threadIds: options?.threadIds ?? [],
    entityMetadataLookup: options?.entityMetadataLookup,
  }

  // Step 1+2：相似候选。F042 AC4 双路：
  //   - wikiCandidateSearch 注入（生产装配）→ 直查 wiki_entity_index（不依赖 threadIds/
  //     embedding；hybrid 内部自带 BM25+cosine）。score_floor 不套用——hybrid 分数是
  //     corpus 内相对置信度（min-max 归一），与 cosine 绝对阈值不同域。
  //   - 未注入 → 原 message_embeddings 路径原样保留（rawEmbedding 缺失或 threadIds 空 → []）。
  let similarEntities: SimilarEntity[] = []
  if (deps.wikiCandidateSearch) {
    similarEntities = await deps.wikiCandidateSearch.findSimilar(
      options?.title ?? "",
      rawContent,
      opts.topK,
    )
  } else {
    const rawEmbedding = await deps.embedding.generateEmbedding(rawContent)
    if (rawEmbedding && opts.threadIds.length > 0) {
      const hits = deps.embedding.searchByVector({
        queryVector: rawEmbedding,
        threadIds: opts.threadIds,
        topK: opts.topK * 2, // 多取一些再按 score_floor 过滤
        excludeMessageIds: new Set(),
        now: Date.now(),
      })
      similarEntities = await mapHitsToEntities(hits, opts)
      similarEntities = similarEntities
        .filter((e) => e.score >= opts.scoreFloor)
        .slice(0, opts.topK)
    }
  }

  // Step 3：indexLite 加载（不依赖 embedding；总是跑）
  const indexLite = await deps.indexLoader.load([...opts.scopes])

  void rawMetadata // 留作 future tracing；目前只 log 用

  return {
    similarEntities,
    indexLite,
    totalContextTokens: opts.totalContextTokens,
  }
}

async function mapHitsToEntities(
  hits: RecallHit[],
  opts: { entityMetadataLookup?: PreCompileOptions["entityMetadataLookup"] },
): Promise<SimilarEntity[]> {
  const out: SimilarEntity[] = []
  for (const hit of hits) {
    if (opts.entityMetadataLookup) {
      const meta = await opts.entityMetadataLookup(hit.messageId)
      if (meta) {
        out.push({
          path: meta.path,
          title: meta.title,
          summary: meta.summary,
          score: roundScore(hit.score),
        })
        continue
      }
    }
    // fallback：lookup 缺失 / null → 用 messageId 作 path，chunk 前 80 char 作 summary
    out.push({
      path: hit.messageId,
      title: hit.messageId,
      summary: hit.chunkText.slice(0, 80),
      score: roundScore(hit.score),
    })
  }
  return out
}

function roundScore(s: number): number {
  return Math.round(s * 1000) / 1000
}
