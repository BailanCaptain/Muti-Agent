"use client"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2 骨架)
 * 真相源：V16.5 chap 18 line 1948-1954 + plan v3.1 §1.3 "Phase 3 只展示，不做 promote"
 *
 * 实施分批：
 *   - Day 12-13 (本批): placeholder
 *   - Phase 3 Week 4: 接 GET /api/wiki/drafts 只读列表
 *   - Phase 4: 加 promote / demote / 批量审批 按钮 (feature.md AC-P4-1/3/4)
 */
export function DraftApprovalTab() {
  return (
    <div
      className="flex flex-col gap-2 p-3 text-xs text-slate-500"
      data-testid="draft-approval-tab"
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        审批待办 · Phase 3 只读 · Phase 4 加 promote 按钮
      </div>
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-slate-400">
        ⏳ draft 列表占位 — Week 4 接 GET /api/wiki/drafts
      </div>
    </div>
  )
}
