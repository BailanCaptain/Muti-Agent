/**
 * F027 P2 · WikiCompiler 输入/输出契约
 * 真相源：docs/plans/V16.5-final.md chap 5 + chap 19
 *
 * 设计选择：compiler 是纯函数，不查 DB —— 调用方（NightlyJobScheduler /
 * 5s debounce 触发器 / smoke script）负责拉数据 + 决定 version 号。这样
 * compiler 可以独立单测（fixture 直接喂 events/memories）。
 *
 * 派生文件结构（chap 19 + 简化）：
 *   wiki/
 *     index.md                        ← 一级摘要（按 type 分类计数 + 最近 5 hot）
 *     sources.md                      ← 全 canonical memory 来源 (provenance)
 *     log.md                          ← wiki_events 审计 (committed 行)
 *     index/
 *       manifest.json                 ← P21 atomic write
 *       v-<version>/
 *         project.md                  ← 各 type canonical memory 列表
 *         room.md
 *         user.md
 *         feedback.md
 *         work.md
 *
 * 不做（留 P3+ / P4.6 / RoomCompiler / NightlyJobScheduler）：
 *   - 旧版本目录归档（P3.5 NightlyJobScheduler）
 *   - LLM 编译 cross_refs / dedup_decision（P4.6）
 *   - viewfinder.md / decisions.md（RoomCompiler，Phase 1 P12）
 *   - rooms-active vs rooms-archive 30 天分流（需要 message 时间戳，Phase 1 后期）
 *   - chap 19 的 rules/concepts/episodes 子分类（需要按 canonical_owner_path 子目录路由，P3+）
 */

import type { WikiEvent } from "../db/repositories/wiki-events-types"
import type { WikiMemory, WikiMemoryType } from "../db/repositories/wiki-memories-types"
import type { IndexManifest } from "./index-manifest"

export interface CompileInput {
  /**
   * wiki/ 目录绝对路径（或相对 cwd）。compiler 在此根下写：
   *   {wikiRoot}/index.md / sources.md / log.md
   *   {wikiRoot}/index/manifest.json
   *   {wikiRoot}/index/v-<version>/{type}.md
   */
  wikiRoot: string
  /**
   * 版本号字符串（如 "2026050601"，YYYYMMDDNN）。caller 决定（chap 19 协议）。
   * compiler 用此创建 v-<version>/ 子目录。
   */
  version: string
  /**
   * 已 fetched 的全部 wiki_events（含 committed/aborted/pending）。
   * compiler 只重放 state='committed' 行写 log.md，但保留全部以便 sourceEventSeq 取 max(id)。
   */
  events: WikiEvent[]
  /**
   * 已 fetched 的全部 wiki_memories（含全 state）。
   * compiler 只渲染 state='canonical' 行进 type/{type}.md / index.md / sources.md。
   * draft 不进派生视图（待 promote 后才 canonical），deprecated 也不进（已被 supersedes 替换）。
   */
  memories: WikiMemory[]
  /** 默认 new Date().toISOString() — 单测注入固定时间防 flaky。 */
  generatedAt?: string
}

export interface CompileResult {
  version: string
  manifest: IndexManifest
  /** 写入的相对路径（相对 wikiRoot），按写入顺序。 */
  filesWritten: string[]
  /** 派生统计：每个 type 的 canonical 行数 + 总 events. */
  stats: {
    canonicalByType: Record<WikiMemoryType, number>
    totalEvents: number
    committedEvents: number
  }
}
