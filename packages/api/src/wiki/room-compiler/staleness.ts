/**
 * F027 P7 · Max-staleness SLA
 * 真相源：docs/plans/V16.5-final.md chap 8 行 934-943
 *
 * SessionBootstrap 读 viewfinder 之前调本函数：
 *   - 默认 max_staleness_ms = 5 分钟
 *   - 超过：strategy 决定 warn / sync / fallback
 *   - committed_at IS NULL（未提交）按 stale + 当前 strategy 处理
 */

import type { RoomCheckpointRow, StalenessCheckResult, StalenessStrategy } from "./types"

export const DEFAULT_MAX_STALENESS_MS = 5 * 60 * 1000

export interface StalenessInput {
  checkpoint: RoomCheckpointRow | null
  now: number
  config?: {
    maxStalenessMs?: number
    strategy?: StalenessStrategy
  }
}

export function checkStaleness(input: StalenessInput): StalenessCheckResult {
  const maxMs = input.config?.maxStalenessMs ?? DEFAULT_MAX_STALENESS_MS
  const strategy = input.config?.strategy ?? "warn"

  // 无 checkpoint = 从未 compile = 等价 stale ∞
  if (!input.checkpoint) {
    return materialize(strategy, Number.POSITIVE_INFINITY, maxMs, "no_checkpoint")
  }

  // committed_at NULL = 二阶段提交未完成（reconciler 还没处理或 prepare 后崩了）
  // SessionBootstrap 不能信这条 viewfinder
  if (!input.checkpoint.committedAt) {
    return materialize(strategy, Number.POSITIVE_INFINITY, maxMs, "uncommitted_checkpoint")
  }

  const ageMs = input.now - Date.parse(input.checkpoint.committedAt)
  return materialize(strategy, ageMs, maxMs, "age_check")
}

function materialize(
  strategy: StalenessStrategy,
  ageMs: number,
  maxMs: number,
  reasonTag: string,
): StalenessCheckResult {
  const stale = ageMs > maxMs
  if (!stale) {
    return { stale: false, ageMs, strategy, decision: "use_viewfinder" }
  }
  switch (strategy) {
    case "warn":
      return {
        stale: true,
        ageMs,
        strategy,
        decision: "use_viewfinder",
        warning: stalenessWarning(ageMs, maxMs, reasonTag),
      }
    case "sync":
      return {
        stale: true,
        ageMs,
        strategy,
        decision: "trigger_sync",
        warning: stalenessWarning(ageMs, maxMs, reasonTag),
      }
    case "fallback":
      return {
        stale: true,
        ageMs,
        strategy,
        decision: "fallback_messages",
        warning: stalenessWarning(ageMs, maxMs, reasonTag),
      }
  }
}

function stalenessWarning(ageMs: number, maxMs: number, reasonTag: string): string {
  const ageDisplay = ageMs === Number.POSITIVE_INFINITY ? "∞" : `${Math.round(ageMs / 1000)}s`
  return `viewfinder stale: age=${ageDisplay} > max=${Math.round(maxMs / 1000)}s (${reasonTag})`
}
