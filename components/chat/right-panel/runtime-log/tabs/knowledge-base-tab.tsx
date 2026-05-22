"use client"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2 骨架)
 * 真相源：V16.5 chap 18 line 1948-1954 + chap 25 line 2535-2537 入口 B [+ Drop 资料]
 *
 * 实施分批：
 *   - Day 12-13 (本批): placeholder（含 [+ Drop 资料] 按钮预留位置 — Week 4 接 IngestModal）
 *   - Phase 3 Week 4: 接 GET /api/wiki/index 只读列表 + [+ Drop 资料] 触发 IngestModal
 */
export function KnowledgeBaseTab() {
  return (
    <div
      className="flex flex-col gap-2 p-3 text-xs text-slate-500"
      data-testid="knowledge-base-tab"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-slate-400">
          知识库 · Phase 3 Week 4 接入
        </div>
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded bg-slate-200 px-2 py-1 text-[10px] text-slate-400"
          title="Week 4 接 IngestModal 入口 B"
        >
          + Drop 资料 (待启用)
        </button>
      </div>
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-slate-400">
        ⏳ wiki index 列表占位 — Week 4 接 GET /api/wiki/index + 入口 B IngestModal
      </div>
    </div>
  )
}
