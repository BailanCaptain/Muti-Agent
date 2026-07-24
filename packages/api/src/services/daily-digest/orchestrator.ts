import { SafeHttpError } from "../../net/safe-http-client"
import type {
  DigestSource,
  NormalizedItem,
  SafeHttpClient,
  SourceFetchResult,
  SourceHealthStore,
  TransientGetRetryPolicy,
} from "./types"

/**
 * AC8 单源失败隔离：每源独立超时 + try/catch，任一源挂不影响整报；
 * 跨源 dedupeKey 去重（保留 publishedAt 较新者）；健康结果交 SourceHealthStore 持久化。
 */

export interface OrchestratorDeps {
  http: SafeHttpClient
  /** 直连客户端（def.direct 源用） */
  httpDirect?: SafeHttpClient
  now?: () => Date
  /** 单源整体超时（含 fallback 链全部尝试），默认 45s */
  perSourceTimeoutMs?: number
  health?: SourceHealthStore
  /** health.record 用的业务日期（YYYY-MM-DD） */
  healthDate?: string
  /** B043：source 级 worker 数；默认 6，避免单 ProxyAgent 43 路突发。 */
  sourceConcurrency?: number
  /** B043：transport retry 基准退避；生产默认 750ms，测试可置 0。 */
  transportRetryDelayMs?: number
}

const SOURCE_TIMEOUT_SENTINEL = Symbol("source-timeout")
const DEFAULT_SOURCE_CONCURRENCY = 6
const DEFAULT_TRANSPORT_RETRY_DELAY_MS = 750
type ConcurrencyGroupState = {
  active: number
  limit: number
  minIntervalMs: number
  nextStartAtMs: number
}

function buildConcurrencyGroupStates(
  sources: DigestSource[],
): Map<string, ConcurrencyGroupState> {
  const states = new Map<string, ConcurrencyGroupState>()
  for (const source of sources) {
    const group = source.concurrencyGroup
    if (!group) continue
    const limit =
      Number.isFinite(group.maxConcurrency) && group.maxConcurrency > 0
        ? Math.max(1, Math.floor(group.maxConcurrency))
        : 1
    const minIntervalMs =
      Number.isFinite(group.minIntervalMs) && (group.minIntervalMs ?? 0) > 0
        ? Math.max(1, Math.floor(group.minIntervalMs ?? 0))
        : 0
    const state = states.get(group.key)
    if (state) {
      state.limit = Math.min(state.limit, limit)
      state.minIntervalMs = Math.max(state.minIntervalMs, minIntervalMs)
      continue
    }
    states.set(group.key, {
      active: 0,
      limit,
      minIntervalMs,
      nextStartAtMs: 0,
    })
  }
  return states
}

function retryableTransportError(
  error: unknown,
  policy: TransientGetRetryPolicy,
  signal: AbortSignal,
): error is SafeHttpError {
  if (signal.aborted || !(error instanceof SafeHttpError)) return false
  if (error.kind === "network" || error.kind === "timeout") return true
  return (
    error.kind === "http_status" &&
    typeof error.status === "number" &&
    (policy.retryHttpStatuses?.includes(error.status) ?? false)
  )
}

function retryableHostname(url: string, policy: TransientGetRetryPolicy): boolean {
  if (!policy.retryHostnames) return true
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return policy.retryHostnames.some((allowed) => allowed.toLowerCase() === hostname)
  } catch {
    return false
  }
}

async function waitForTransportRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (delayMs <= 0) return true
  return new Promise<boolean>((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(ready)
    }
    const onAbort = () => finish(false)
    signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => finish(!signal.aborted), delayMs)
  })
}

function bindSourceHttp(
  base: SafeHttpClient,
  source: DigestSource,
  sourceSignal: AbortSignal,
  retryState: { remaining: number },
  defaultDelayMs: number,
): SafeHttpClient {
  return {
    async fetchText(url, opts = {}) {
      const signal =
        opts.signal && opts.signal !== sourceSignal
          ? AbortSignal.any([sourceSignal, opts.signal])
          : sourceSignal
      const boundOpts = { ...opts, signal }
      const method = opts.method ?? "GET"
      const policy = source.transientGetRetry
      let attempt = 1
      for (;;) {
        try {
          const body = await base.fetchText(url, boundOpts)
          if (attempt > 1) {
            console.warn(`[daily-digest] ${source.sourceId} transport-recovered attempt=${attempt}`)
          }
          return body
        } catch (error) {
          if (
            method !== "GET" ||
            !policy ||
            retryState.remaining <= 0 ||
            !retryableHostname(url, policy) ||
            !retryableTransportError(error, policy, signal)
          ) {
            throw error
          }
          retryState.remaining -= 1
          const baseDelayMs = policy.delayMs ?? defaultDelayMs
          const delayMs =
            baseDelayMs <= 0
              ? 0
              : Math.max(1, Math.round(baseDelayMs * (0.75 + Math.random() * 0.5)))
          attempt += 1
          console.warn(
            `[daily-digest] ${source.sourceId} transport-retry attempt=${attempt}/${policy.maxAttempts} kind=${error.kind}${typeof error.status === "number" ? ` status=${error.status}` : ""} delayMs=${delayMs}`,
          )
          if (!(await waitForTransportRetry(delayMs, signal))) throw error
        }
      }
    },
  }
}

function tryAcquireConcurrencyGroup(
  source: DigestSource,
  states: Map<string, ConcurrencyGroupState>,
  nowMs: number,
): { release?: () => void; waitUntilMs?: number } {
  const group = source.concurrencyGroup
  if (!group) return { release: () => {} }
  const state = states.get(group.key)
  if (!state) throw new Error(`missing concurrency group state: ${group.key}`)
  if (state.active >= state.limit) return {}
  if (nowMs < state.nextStartAtMs) return { waitUntilMs: state.nextStartAtMs }
  state.active += 1
  state.nextStartAtMs = nowMs + state.minIntervalMs
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      state.active -= 1
    },
  }
}

async function runOne(
  source: DigestSource,
  deps: Required<Pick<OrchestratorDeps, "http" | "perSourceTimeoutMs">> & {
    now: () => Date
    httpDirect?: SafeHttpClient
    transportRetryDelayMs: number
  },
): Promise<SourceFetchResult> {
  const started = Date.now()
  const controller = new AbortController()
  // 长跑源（X 逐账号限速）自带预算覆盖默认值 —— 45s 默认会掐死限速遍历并整包丢弃
  const budgetMs = source.timeoutBudgetMs ?? deps.perSourceTimeoutMs
  const timer = setTimeout(() => controller.abort(), budgetMs)
  const retryState = {
    remaining: Math.max(0, (source.transientGetRetry?.maxAttempts ?? 1) - 1),
  }
  const http = bindSourceHttp(
    deps.http,
    source,
    controller.signal,
    retryState,
    deps.transportRetryDelayMs,
  )
  const httpDirect = deps.httpDirect
    ? deps.httpDirect === deps.http
      ? http
      : bindSourceHttp(
          deps.httpDirect,
          source,
          controller.signal,
          retryState,
          deps.transportRetryDelayMs,
        )
    : undefined
  const base = {
    sourceId: source.sourceId,
    attempts: 1,
    fetchedAt: new Date().toISOString(),
  }
  try {
    const raced = await Promise.race([
      source.fetch({
        http,
        httpDirect,
        signal: controller.signal,
        now: deps.now,
      }),
      new Promise<typeof SOURCE_TIMEOUT_SENTINEL>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(SOURCE_TIMEOUT_SENTINEL), {
          once: true,
        })
      }),
    ])
    if (raced === SOURCE_TIMEOUT_SENTINEL) {
      return {
        ...base,
        status: "timeout",
        items: [],
        errors: [`source timeout > ${budgetMs}ms`],
        durationMs: Date.now() - started,
      }
    }
    return { ...base, status: "ok", items: raced, errors: [], durationMs: Date.now() - started }
  } catch (err) {
    return {
      ...base,
      status: "failed",
      items: [],
      errors: [String(err).slice(0, 500)],
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 跨源去重：同 dedupeKey 保留 publishedAt 较新者（null 视为最旧） */
export function dedupeItems(items: NormalizedItem[]): NormalizedItem[] {
  const byKey = new Map<string, NormalizedItem>()
  for (const item of items) {
    const prev = byKey.get(item.dedupeKey)
    if (!prev) {
      byKey.set(item.dedupeKey, item)
      continue
    }
    if (prev.category === "github" && item.category === "github") {
      const priority = (candidate: NormalizedItem) => {
        const state = candidate.githubMeta?.eligibility.state
        // 跨榜证据冲突按 fail-closed：明确 no 高于 yes；yes/no 都可替换证据不足的 unknown。
        return state === "no" ? 2 : state === "yes" ? 1 : 0
      }
      const previousPriority = priority(prev)
      const currentPriority = priority(item)
      if (currentPriority > previousPriority) {
        // Map.set(existing) 会保留旧插槽：daily unknown 被 newcomer yes 替换后会跑到
        // 新秀榜已排序块的最前面。先删再写，使替代项回到当前榜种的原始排名位置。
        byKey.delete(item.dedupeKey)
        byKey.set(item.dedupeKey, item)
        continue
      }
      if (currentPriority < previousPriority) continue
    }
    const prevT = prev.publishedAt ? Date.parse(prev.publishedAt) : -1
    const curT = item.publishedAt ? Date.parse(item.publishedAt) : -1
    if (curT > prevT) byKey.set(item.dedupeKey, item)
  }
  return [...byKey.values()]
}

export async function runAllSources(
  sources: DigestSource[],
  deps: OrchestratorDeps,
): Promise<{ results: SourceFetchResult[]; items: NormalizedItem[] }> {
  const now = deps.now ?? (() => new Date())
  const perSourceTimeoutMs = deps.perSourceTimeoutMs ?? 45_000
  const transportRetryDelayMs = deps.transportRetryDelayMs ?? DEFAULT_TRANSPORT_RETRY_DELAY_MS
  const requestedConcurrency = deps.sourceConcurrency ?? DEFAULT_SOURCE_CONCURRENCY
  const sourceConcurrency =
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.max(1, Math.floor(requestedConcurrency))
      : DEFAULT_SOURCE_CONCURRENCY
  const results = new Array<SourceFetchResult>(sources.length)
  const concurrencyGroups = buildConcurrencyGroupStates(sources)
  const pending = sources.map((_, index) => index)
  const running = new Set<Promise<void>>()
  while (pending.length > 0 || running.size > 0) {
    let earliestPacingMs: number | undefined
    while (pending.length > 0 && running.size < sourceConcurrency) {
      const nowMs = Date.now()
      let selectedPosition = -1
      let releaseGroup: (() => void) | undefined
      for (let position = 0; position < pending.length; position += 1) {
        const source = sources[pending[position]]
        const acquisition = tryAcquireConcurrencyGroup(source, concurrencyGroups, nowMs)
        if (acquisition.release) {
          selectedPosition = position
          releaseGroup = acquisition.release
          break
        }
        if (
          acquisition.waitUntilMs !== undefined &&
          (earliestPacingMs === undefined || acquisition.waitUntilMs < earliestPacingMs)
        ) {
          earliestPacingMs = acquisition.waitUntilMs
        }
      }
      if (selectedPosition < 0 || !releaseGroup) break

      const [index] = pending.splice(selectedPosition, 1)
      const source = sources[index]
      // biome-ignore lint/style/useConst: cleanup closure must reference the tracked promise itself.
      let task!: Promise<void>
      task = (async () => {
        try {
          results[index] = await runOne(source, {
            http: deps.http,
            httpDirect: deps.httpDirect,
            perSourceTimeoutMs,
            now,
            transportRetryDelayMs,
          })
        } finally {
          releaseGroup()
        }
      })().finally(() => {
        running.delete(task)
      })
      running.add(task)
    }

    if (running.size >= sourceConcurrency || earliestPacingMs === undefined) {
      if (running.size > 0) await Promise.race(running)
      continue
    }

    let pacingTimer: ReturnType<typeof setTimeout> | undefined
    const pacingReady = new Promise<void>((resolve) => {
      pacingTimer = setTimeout(resolve, Math.max(0, earliestPacingMs - Date.now()))
    })
    try {
      await Promise.race([...running, pacingReady])
    } finally {
      if (pacingTimer) clearTimeout(pacingTimer)
    }
  }
  const items = dedupeItems(results.flatMap((r) => r.items))
  if (deps.health && deps.healthDate) deps.health.record(deps.healthDate, results)
  return { results, items }
}
