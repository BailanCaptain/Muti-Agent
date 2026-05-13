/**
 * F027 P12 · MonthlySnapshot drift（jaccard）
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1202-1206 + AC-P1-10 行 133-137
 *
 * 算法：
 *   - jaccard(A, B) = |A ∩ B| / |A ∪ B|  ∈ [0, 1]
 *   - drift = 1 - jaccard  ∈ [0, 1]
 *   - shouldReplace = drift > replaceThreshold（默认 0.3 = 30%，AC-P1-10 字面要求）
 *
 * Phase 1 P12 范围：
 *   - 纯函数 computeDrift（输入两个 token set，输出 DriftResult）
 *   - 不接调度（NightlyJobScheduler cron 接入挂 P19/Phase 2）
 *   - 不发审计通知（接入挂 P19）
 *
 * 触发流程（P19 完成后）：
 *   1. 每月 1 号 03:00 NightlyJobScheduler 跑 runMonthlySnapshot(roomId)
 *   2. 全量重编 viewfinder（renderViewfinder + 全量 raw transcript window）
 *   3. computeDrift(old.tokens, new.tokens) → drift score
 *   4. drift > 30% → 自动 replace 旧 viewfinder.md + 推审计通知到房间
 *   5. drift ≤ 30% → 不替换，写一条 audit log
 */

import type { DriftResult, MonthlySnapshotInput } from "./types"

const DEFAULT_REPLACE_THRESHOLD = 0.3

export function computeDrift(input: MonthlySnapshotInput): DriftResult {
  const threshold = input.replaceThreshold ?? DEFAULT_REPLACE_THRESHOLD
  const old = input.oldDecisionsSummaryTokens
  const next = input.newDecisionsSummaryTokens

  const oldCount = old.size
  const nextCount = next.size

  if (oldCount === 0 && nextCount === 0) {
    // 两边都空 → 视作完全一致（jaccard=1, drift=0），不触发 replace
    return {
      jaccard: 1,
      drift: 0,
      shouldReplace: false,
      details: { oldTokenCount: 0, newTokenCount: 0, intersectionSize: 0, unionSize: 0 },
    }
  }

  let intersectionSize = 0
  for (const t of old) {
    if (next.has(t)) intersectionSize++
  }
  const unionSize = oldCount + nextCount - intersectionSize

  // unionSize 必 > 0（上面已 cover 全空 case）
  const jaccard = intersectionSize / unionSize
  const drift = 1 - jaccard

  return {
    jaccard,
    drift,
    shouldReplace: drift > threshold,
    details: {
      oldTokenCount: oldCount,
      newTokenCount: nextCount,
      intersectionSize,
      unionSize,
    },
  }
}

/**
 * Tokenize helper（与 renderViewfinder 内同款，给 fixture / runMonthlySnapshot 复用）。
 * 简单按非中英数字字符切，去空，小写。
 */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/)
      .filter((t) => t.length > 0),
  )
}

/**
 * 模拟 LLM telephone game 漂移：每轮在原文上做小修改（替换 / 增删词）。
 * 用于 100-iter fixture 的可重现生成（Phase 1 fixture 真相源）。
 */
export interface TelephoneGameOptions {
  /** 每轮替换的概率（0-1，默认 0.05 = 5% 词被替换） */
  replaceProbability?: number
  /** 每轮删除的概率（默认 0.02） */
  deleteProbability?: number
  /** 每轮新增的概率（默认 0.02） */
  insertProbability?: number
  /** 替换/新增时的词库（候选） */
  vocab?: string[]
  /** 随机种子（确定性 fixture，默认 42） */
  seed?: number
}

const DEFAULT_VOCAB = [
  "lorry",
  "accident",
  "bus",
  "explosion",
  "F027",
  "F026",
  "viewfinder",
  "rule",
  "based",
  "extractor",
  "haiku",
  "decision",
  "ledger",
  "merger",
  "gate",
  "approve",
  "reject",
  "tombstone",
  "drift",
  "coverage",
]

/**
 * 简单确定性 PRNG（mulberry32）—— Math.random 不能给定 seed，fixture 必须可重现。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function simulateTelephoneGame(
  initialText: string,
  iterations: number,
  opts: TelephoneGameOptions = {},
): { finalText: string; finalTokens: Set<string>; history: string[] } {
  const replaceP = opts.replaceProbability ?? 0.05
  const deleteP = opts.deleteProbability ?? 0.02
  const insertP = opts.insertProbability ?? 0.02
  const vocab = opts.vocab ?? DEFAULT_VOCAB
  const rand = mulberry32(opts.seed ?? 42)

  let tokens = initialText.toLowerCase().split(/\s+/).filter(Boolean)
  const history: string[] = [tokens.join(" ")]

  for (let iter = 0; iter < iterations; iter++) {
    const next: string[] = []
    for (let i = 0; i < tokens.length; i++) {
      const r = rand()
      if (r < deleteP) {
        // 删除（不 push）
        continue
      }
      if (r < deleteP + replaceP) {
        // 替换
        next.push(vocab[Math.floor(rand() * vocab.length)])
        continue
      }
      next.push(tokens[i])
      if (rand() < insertP) {
        // 紧跟插入新词
        next.push(vocab[Math.floor(rand() * vocab.length)])
      }
    }
    tokens = next
    if (tokens.length === 0) tokens = [vocab[Math.floor(rand() * vocab.length)]]
    history.push(tokens.join(" "))
  }

  return {
    finalText: tokens.join(" "),
    finalTokens: tokenize(tokens.join(" ")),
    history,
  }
}
