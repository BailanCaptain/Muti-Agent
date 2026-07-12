/**
 * F042 AC2 · ShadowWindowNotifier — 影子观察窗主动提示（只两时机，无常态推送，小孙 07-10 拍）。
 *
 *   ① 观察窗跑满（50 次 direct_turn 召回 或 首行距今 ≥14 天先到，且有数据）→ 一次性小结
 *      （命中率/采纳率/Top 条目 + 放开注入与否的建议），走房间消息卡（seal notice 同链）。
 *   ② 标注攒满 30 条（recall_adopted 非 NULL 行）→ 一次性提示可拍 rerank 立项。
 *
 * 两阶段协议（caller = message-service direct 支采纳钩子，每 turn 顺手查——D3 不新造 cron）：
 *   check() 只算候选不置位 → caller 发卡成功后 markSent(kind) 烧一次性标志（app_state）。
 *   发卡失败不烧标志，下一 turn 自动重试。同 turn 只出一张卡，小结优先于 rerank 提示。
 *
 * 一次性重置 = 人工删 app_state 对应行（f042_shadow_summary_sent / f042_rerank_hint_sent）。
 * IM 推送 deferred：飞书出站锚定 rootMessageId（入站溯源），系统自发卡推不过去——本期房间卡为终点。
 */

import type { RecallStatsWindow } from "../../routes/phase3/recall-stats"

const SUMMARY_FLAG = "f042_shadow_summary_sent"
const RERANK_FLAG = "f042_rerank_hint_sent"
const WINDOW_SIZE = 50
const WINDOW_MAX_AGE_MS = 14 * 24 * 3600 * 1000
const RERANK_ANNOTATION_THRESHOLD = 30
const INJECT_RECOMMEND_ADOPTION = 0.6

export type ShadowNoticeKind = "shadow_summary" | "rerank_hint"

export interface ShadowNoticeCandidate {
  kind: ShadowNoticeKind
  content: string
}

export interface ShadowWindowNotifierDeps {
  stats: { getStats(q: { window: number }): RecallStatsWindow }
  appState: { get(key: string): string | null; set(key: string, value: string): void }
}

export class ShadowWindowNotifier {
  constructor(private readonly deps: ShadowWindowNotifierDeps) {}

  /** 算候选（不置位）。无候选/统计失败 → null。 */
  check(): ShadowNoticeCandidate | null {
    let stats: RecallStatsWindow
    try {
      stats = this.deps.stats.getStats({ window: WINDOW_SIZE })
    } catch {
      return null
    }
    if (this.deps.appState.get(SUMMARY_FLAG) === null) {
      if (!windowFull(stats)) return null
      return { kind: "shadow_summary", content: buildSummary(stats) }
    }
    if (this.deps.appState.get(RERANK_FLAG) === null) {
      if (stats.annotatedCount < RERANK_ANNOTATION_THRESHOLD) return null
      return { kind: "rerank_hint", content: buildRerankHint(stats) }
    }
    return null
  }

  /** 发卡成功后置位（发失败别调——下一 turn 重试）。 */
  markSent(kind: ShadowNoticeKind): void {
    this.deps.appState.set(
      kind === "shadow_summary" ? SUMMARY_FLAG : RERANK_FLAG,
      new Date().toISOString(),
    )
  }
}

/** 等价接口（message-service 注入用；测试可注 stub）。 */
export type ShadowWindowNotifierLike = Pick<ShadowWindowNotifier, "check" | "markSent">

/**
 * F042 AC6（德彪 2.5）· 14 天时间分支加最小样本下限：3-5 行数据撑不起
 * 命中率/采纳率结论，时间到了也不发（防小样本小结误导 inject 决策）。
 * 满 50 次的数量分支不受影响。
 */
const WINDOW_MIN_SAMPLE_FOR_AGE = 20

function windowFull(s: RecallStatsWindow): boolean {
  if (s.totalRecalls >= WINDOW_SIZE) return true
  if (s.totalRecalls >= WINDOW_MIN_SAMPLE_FOR_AGE && s.oldestAt) {
    const age = Date.now() - new Date(s.oldestAt).getTime()
    if (Number.isFinite(age) && age >= WINDOW_MAX_AGE_MS) return true
  }
  return false
}

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n * 100)}%`
}

function buildSummary(s: RecallStatsWindow): string {
  const top = s.topEntries
    .slice(0, 5)
    .map((e, i) => `${i + 1}. ${e.path}（${e.count} 次）`)
    .join("\n")
  const recommend =
    s.adoptionRate !== null && s.adoptionRate >= INJECT_RECOMMEND_ADOPTION
      ? `采纳率 ${pct(s.adoptionRate)} ≥ 60%，**建议放开注入**：重启时设 \`MULTI_AGENT_DIRECT_TURN_RECALL=inject\`（.env 改动请人工操作）。`
      : `采纳率 ${pct(s.adoptionRate)} 未到 60%，建议继续 shadow 攒数据；可从 Prompt Inspector 抽低分召回行看「查得偏在哪」。`
  return [
    "📊 **记忆影子观察窗小结**（一次性，不会常态推送）",
    "",
    `- 窗口：${s.totalRecalls} 次 direct_turn 召回（${s.oldestAt ?? "—"} ~ ${s.newestAt ?? "—"}）`,
    `- 命中率：${pct(s.hitRate)}（召回结果非空的比例）`,
    `- 采纳率：${pct(s.adoptionRate)}（回复引用召回条目 / 已判定 ${s.annotatedCount} 行）`,
    ...(top ? ["- Top 命中条目：", top] : ["- Top 命中条目：无"]),
    "",
    recommend,
    "",
    `明细：GET /api/recall/stats?window=${s.window}`,
  ].join("\n")
}

function buildRerankHint(s: RecallStatsWindow): string {
  return [
    "🎯 **召回标注攒够了**（一次性提示）",
    "",
    `recall_adopted 判定行已攒 ${s.annotatedCount} 条（阈值 ${RERANK_ANNOTATION_THRESHOLD}）——`,
    "rerank 转正立项的数据前提已满足（F042 spec Out-of-scope 触发条件）。",
    "要拍的话说一声，走 feat-lifecycle 立项：离散 grade 0-3 + rankScore/gateDecision 分离 + 校准回归门。",
  ].join("\n")
}
