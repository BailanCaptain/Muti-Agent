/**
 * 限速遍历共用件（B 项防封号语义，07-05 自 x-provider 抽出）：
 * - 条目间 delay + jitter：按人速访问反爬面/cookie 面，收敛风控命中
 * - maxTotalMs 预算：到点停抓返回已得 —— partial 优于被 orchestrator 单源超时整包丢弃
 * - 上游 abort（orchestrator 单源超时兜底）→ 立即停抓不再白耗请求
 * 使用方：x-provider（cookie 小号）/ reddit-shreddit（反爬面）/ 未来长跑源；
 * F029 批量取证跑批同款纪律（复用地图 §8）。
 */

export interface PacingOptions {
  /** 条目间基础延时 ms */
  delayMs?: number
  /** 叠加随机抖动上限 ms（uniform [0, jitterMs)） */
  jitterMs?: number
  /** 整源时间预算 ms：超预算停抓返回已得 */
  maxTotalMs?: number
  /** 测试注入 */
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  clock?: () => number
}

export interface ResolvedPacing {
  delayMs: number
  jitterMs: number
  maxTotalMs: number
  sleep: (ms: number) => Promise<void>
  random: () => number
  clock: () => number
}

export function resolvePacing(
  p: PacingOptions | undefined,
  defaults: { delayMs: number; jitterMs: number; maxTotalMs: number },
): ResolvedPacing {
  return {
    delayMs: p?.delayMs ?? defaults.delayMs,
    jitterMs: p?.jitterMs ?? defaults.jitterMs,
    maxTotalMs: p?.maxTotalMs ?? defaults.maxTotalMs,
    sleep: p?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    random: p?.random ?? Math.random,
    clock: p?.clock ?? Date.now,
  }
}

/**
 * 限速遍历骨架：deadline/abort 检查在每个条目前；delay 只加在条目之间（末位不空等）。
 * 德彪 batchA-r1 P2：fetch 返回后预算已尽/已 abort 也不再空等一拍——sleep 前同款检查。
 */
export async function forEachPaced<T>(
  items: T[],
  pacing: ResolvedPacing,
  signal: AbortSignal | undefined,
  fetchOne: (item: T) => Promise<void>,
): Promise<void> {
  const deadline = pacing.clock() + pacing.maxTotalMs
  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted || pacing.clock() >= deadline) break
    await fetchOne(items[i])
    if (i < items.length - 1 && !signal?.aborted && pacing.clock() < deadline)
      await pacing.sleep(pacing.delayMs + pacing.random() * pacing.jitterMs)
  }
}
