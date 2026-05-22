"use client"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2 5-tab 容器) — placeholder
 *
 * 真相源：
 *   - V16.5 chap 18 line 1954 (KnowledgeBaseTab → GET /api/wiki/index 引用)
 *   - V16.5 chap 22 line 2172-2199 (wiki/index.md + wiki/index/*.md 派生视图层级)
 *   - V16.5 chap 25 line 2535-2537 入口 B [+ Drop 资料]
 *   - plan v3.2 patch (2026-05-23 小孙拍 B)：本 tab 推 Phase 4
 *
 * 推 Phase 4 原因（plan §3 Week 1-2 8 endpoint 未列 /api/wiki/index）：
 *   - 后端依赖 wiki/index.md + wiki/index/*.md 派生视图（compiler 写盘）
 *   - 数据源 = WikiCompilerDebounce + RoomCompilerTick 派生（Phase 1 P12 + Phase 2 P22）
 *   - Phase 3 scope 内 wiki 尚空，endpoint 等价空列表 → placeholder 等价 endpoint
 *   - [+ Drop 资料] 入口 B → IngestModal 由 Day 19-20 AC-P3-6 实施（独立 button）
 */
export function KnowledgeBaseTab() {
  return (
    <div
      className="flex flex-col gap-2 p-3 text-xs text-slate-500"
      data-testid="knowledge-base-tab"
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-wider text-slate-400">
          知识库 · Phase 4 接入（推迟）
        </div>
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded bg-slate-200 px-2 py-1 text-[10px] text-slate-400"
          title="Day 19-20 AC-P3-6 IngestModal 入口 B 实施时启用"
        >
          + Drop 资料 (待启用)
        </button>
      </div>
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-slate-400">
        ⏳ Phase 4 上线 — 接 GET /api/wiki/index（wiki/index.md + wiki/index/concepts.md /
        rules.md / rooms-active.md 派生视图）
      </div>
    </div>
  )
}
