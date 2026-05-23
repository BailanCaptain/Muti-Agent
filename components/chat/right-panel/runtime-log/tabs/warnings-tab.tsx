"use client"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2 5-tab 容器) — placeholder
 *
 * 真相源：
 *   - V16.5 chap 18 line 1953 (WarningsTab → GET /api/wiki/warnings 引用)
 *   - V16.5 chap 22 line 3208-3210 (wiki/warnings/ 数据源：dead-ref / dedup / drift)
 *   - plan v3.2 patch (2026-05-23 小孙拍 B)：本 tab 推 Phase 4
 *
 * 推 Phase 4 原因（plan §3 Week 1-2 8 endpoint 未列 /api/wiki/warnings）：
 *   - 后端依赖 wiki/warnings/*.md 写盘（compiler 派生）
 *   - 数据源 = DriftDetector / ChainedAlertNotifier 等 jobs 写盘（Phase 1 P12 + Phase 2 P22）
 *   - Phase 3 scope 内 wiki 尚空，endpoint 等价空列表 → placeholder 等价 endpoint
 */
export function WarningsTab() {
  return (
    <div className="flex flex-col gap-2 p-3 text-xs text-slate-500" data-testid="warnings-tab">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        警告 · Phase 4 接入（推迟）
      </div>
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-slate-400">
        ⏳ Phase 4 上线 — 接 GET /api/wiki/warnings（dead-ref / dedup-candidate / viewfinder-drift /
        chained-suspect 等 DriftDetector + ChainedAlertNotifier 派生告警）
      </div>
    </div>
  )
}
