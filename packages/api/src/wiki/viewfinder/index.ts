/**
 * F027 P12 · viewfinder anti-drift 模块 barrel export
 *
 * 真相源：docs/plans/V16.5-final.md chap 11
 *
 * 模块组成：
 *   - types          ── 全部类型定义
 *   - decision-ledger ── append-only writer + revoke + 查询
 *   - decision-extractor ── 关键词宽召 + HaikuRunner yes/no 精筛
 *   - coverage-check ── 三集合算法（broad/resolved/unresolved）
 *   - viewfinder-renderer ── 6 段 rule-based 模板（含 §4 deadline_at 24h 防御）
 *   - monthly-snapshot ── jaccard 漂移 + > 30% auto-replace（NightlyJob 接入挂 P19）
 */

export * from "./types"
export { DecisionLedger } from "./decision-ledger"
export {
  HaikuDecisionJudge,
  type HaikuLike,
  type MessageInput,
  type RunExtractorOptions,
  buildJudgePrompt,
  extractBroadCandidates,
  parseJudgmentJson,
  runExtractor,
} from "./decision-extractor"
export { computeCoverage, renderCoverageWarning } from "./coverage-check"
export {
  queryBlockerCalls,
  renderBlockers,
  renderViewfinder,
} from "./viewfinder-renderer"
export {
  computeDrift,
  simulateTelephoneGame,
  tokenize,
  type TelephoneGameOptions,
} from "./monthly-snapshot"
export { createViewfinderCompileFn, type CompileViewfinderDeps } from "./compile-fn"
