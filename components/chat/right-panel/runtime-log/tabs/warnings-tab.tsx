"use client"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2 骨架)
 * 真相源：V16.5 chap 18 line 1948-1954
 *
 * 实施分批：
 *   - Day 12-13 (本批): placeholder
 *   - Phase 3 Week 4: 接 GET /api/wiki/warnings (chained_suspect / drift / 等)
 */
export function WarningsTab() {
  return (
    <div className="flex flex-col gap-2 p-3 text-xs text-slate-500" data-testid="warnings-tab">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        警告 · Phase 3 Week 4 接入
      </div>
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-slate-400">
        ⏳ warnings 列表占位 — chained_suspect / DriftDetector / unresolved decision 等
      </div>
    </div>
  )
}
