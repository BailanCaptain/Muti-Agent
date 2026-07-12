/**
 * F042 AC4 · 编译候选检索：生产 hybridWikiSearch（BM25+cosine over wiki_entity_index）
 * 适配成 pre-compile 的 SimilarEntity。
 *
 * 替代 message_embeddings 误用（审计断点 #4）：embedding-service.searchByVector 搜的是
 * 聊天消息表，wiki ingest 场景 threadIds 恒空（ingest-preview 不传 options.pre）→
 * pre-compile 相似候选恒空 → 58/64 篇 cross_refs/dedup 盲编。本适配器直接查 wiki 实体域，
 * 不依赖 threadIds。
 *
 * 查询文本 = title + 正文头 500 字（FTS 查询过长无增益，hybrid 内部自带 sanitize）。
 * 候选过滤 draft/归档（召回面同闸门）；候选自身 sources[0].path 从 index body 的
 * frontmatter 提取（同源 dedup 的确定性信号，见 compile-prompt 渲染）。
 */

import { parseFrontmatter } from "../../routes/phase3/frontmatter"
import { isArchivedRelativePath, isDraftRelativePath } from "../promote-audit/promote-wiki-service"
import { sources0Path } from "../promote-audit/same-source-detector"
import type { SimilarEntity } from "./types"

export interface WikiCandidateSearch {
  findSimilar(title: string, rawContent: string, topK: number): Promise<SimilarEntity[]>
}

export interface WikiCandidateSearchDeps {
  /** 生产 hybridWikiSearch（server.ts :360 已构造）；测试注 stub。 */
  hybrid: {
    search(
      query: string,
      opts: { topK: number },
    ): Promise<Array<{ path: string; score: number; excerpt: string }>>
  }
  /** wiki_entity_index 按 path 取 name/body（title + frontmatter 来源提取用）。 */
  lookupIndexRow(path: string): { name: string; body: string } | null
}

export function createWikiCandidateSearch(deps: WikiCandidateSearchDeps): WikiCandidateSearch {
  return {
    async findSimilar(title, rawContent, topK) {
      const query = `${title} ${rawContent.slice(0, 500)}`.trim()
      if (query.length === 0) return []
      const hits = await deps.hybrid.search(query, { topK })
      const out: SimilarEntity[] = []
      for (const h of hits) {
        if (isDraftRelativePath(h.path) || isArchivedRelativePath(h.path)) continue
        const row = deps.lookupIndexRow(h.path)
        let sourcePath: string | undefined
        if (row) {
          try {
            sourcePath = sources0Path(parseFrontmatter(row.body).frontmatter) ?? undefined
          } catch {
            sourcePath = undefined // 坏 frontmatter 不炸候选（来源标注缺省即可）
          }
        }
        out.push({
          path: h.path,
          title: row?.name ?? h.path,
          summary: h.excerpt.slice(0, 200),
          score: h.score,
          ...(sourcePath !== undefined && { sourcePath }),
        })
        if (out.length >= topK) break
      }
      return out
    },
  }
}
