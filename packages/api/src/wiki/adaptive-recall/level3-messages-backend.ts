/**
 * F027 P13.3 · Level 3 query_messages backend adapter
 *
 * 把 P14.b MessagesFtsRepository (返 MessagesFtsHit) 适配到 P13 Level3Backend interface
 * (返 RecallHit)。
 *
 * 转换：
 *   - path: 用 "messages/<roomId>/<messageId>" 形式标识（不是 wiki 实体路径，
 *           Level3 hits 进 L4 严格 specific_path 校验时会通过 "本级 hits 中已存在 path" 路径）
 *   - score: 直接复用 MessagesFtsHit.score (corpus min-max 归一化 [0, 1])
 *   - excerpt: 截前 200 字 content
 */

import type { Level3Backend } from "./types"
import type { RecallHit } from "../memory-preflight/types"
import type { MessagesFtsRepository } from "../wiki-search/messages-fts-repository"

const EXCERPT_TRUNCATE = 200

export class MessagesFtsLevel3Backend implements Level3Backend {
  constructor(private readonly repo: MessagesFtsRepository) {}

  async queryMessages(
    query: string,
    opts: { roomId: string; topK: number },
  ): Promise<RecallHit[]> {
    // 注：MessagesFtsRepository.query 是同步函数；Level3Backend 签名 async 是
    // future-proof（其他后端可能异步），这里 await 一个同步返回即可。
    const hits = this.repo.query(query, {
      roomId: opts.roomId,
      topK: opts.topK,
    })
    return hits.map((h) => ({
      path: `messages/${opts.roomId}/${h.messageId}`,
      score: h.score,
      excerpt: h.content.slice(0, EXCERPT_TRUNCATE),
    }))
  }
}
