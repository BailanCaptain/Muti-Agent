import type {
  DigestSource,
  NormalizedItem,
  SafeHttpClient,
  SourceFetchResult,
  SourceHealthStore,
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
}

const SOURCE_TIMEOUT_SENTINEL = Symbol("source-timeout")

async function runOne(
  source: DigestSource,
  deps: Required<Pick<OrchestratorDeps, "http" | "perSourceTimeoutMs">> & {
    now: () => Date
    httpDirect?: SafeHttpClient
  },
): Promise<SourceFetchResult> {
  const started = Date.now()
  const controller = new AbortController()
  // 长跑源（X 逐账号限速）自带预算覆盖默认值 —— 45s 默认会掐死限速遍历并整包丢弃
  const budgetMs = source.timeoutBudgetMs ?? deps.perSourceTimeoutMs
  const timer = setTimeout(() => controller.abort(), budgetMs)
  const base = {
    sourceId: source.sourceId,
    attempts: 1,
    fetchedAt: new Date().toISOString(),
  }
  try {
    const raced = await Promise.race([
      source.fetch({
        http: deps.http,
        httpDirect: deps.httpDirect,
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
  const results = await Promise.all(
    sources.map((s) =>
      runOne(s, { http: deps.http, httpDirect: deps.httpDirect, perSourceTimeoutMs, now }),
    ),
  )
  const items = dedupeItems(results.flatMap((r) => r.items))
  if (deps.health && deps.healthDate) deps.health.record(deps.healthDate, results)
  return { results, items }
}
