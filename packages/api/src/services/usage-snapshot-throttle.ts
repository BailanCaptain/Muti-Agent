/**
 * F043 AC8 · 轮中 usage 快照节流（per-thread leading-edge）。
 * onUsageSnapshot 在 claude 多调用轮里每次 message_start/delta 都触发（几秒一次），
 * 直接透传会打爆 WS；节流后前端面板仍能在长轮中看到至少一次实时变化，
 * 末值由 turn 收尾的权威 thread_snapshot_delta（落库真值）兜底，无需 trailing。
 */
export function createUsageSnapshotThrottle(intervalMs = 2_000, now: () => number = Date.now) {
  const lastEmitAt = new Map<string, number>()
  return {
    shouldEmit(threadId: string): boolean {
      const t = now()
      const prev = lastEmitAt.get(threadId)
      if (prev != null && t - prev < intervalMs) {
        return false
      }
      lastEmitAt.set(threadId, t)
      return true
    },
  }
}
