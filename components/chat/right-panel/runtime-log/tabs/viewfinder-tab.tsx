"use client"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2 骨架 · 内容 placeholder)
 * 真相源：V16.5 chap 11 line 1255-1294 viewfinder 6 段 vision example
 *
 * 实施分批：
 *   - Day 12-13 (本批): placeholder 占位 + tab 切换状态保留契约
 *   - Phase 3 Week 4 Day 21-22: 接 GET /api/rooms/:id/viewfinder + AC-P3-4 a2a 人话化
 *     + click <AtPill> in-place drawer 复用 F026 <A2ATreeView>
 */
export function ViewfinderTab() {
  return (
    <div className="flex flex-col gap-2 p-3 text-xs text-slate-500" data-testid="viewfinder-tab">
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        取景器 · Phase 3 Week 4 接入
      </div>
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-slate-400">
        ⏳ viewfinder 6 段视图占位 — chap 11 vision example
        <br />
        §1 当前主题 / §2 当前进度 / §3 下一步+谁做 / §4 等谁/blocker (含 a2a AtPill) / §5 关键决策 /
        §6 不要再做
      </div>
    </div>
  )
}
