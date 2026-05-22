"use client"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2 骨架 · 默认 lvl2 tab)
 * 真相源：V16.5 chap 18 line 2030-2079 Prompt Inspector tab 7 块 mockup
 *
 * 实施分批：
 *   - Day 12-13 (本批): placeholder + default tab 契约
 *   - Day 14-15: 接 GET /api/rooms/:id/prompt-inspector + AC-P3-3 透明显示
 *     7 块（标题 / ✅ 注入 / ❌ 未注入 / 🤖 自动召回 / 📊 Adaptive Recall Policy /
 *     🤝 agent session / 🔔 wake-up 触发因 V16.5.2 + AC-P3-5）+ 底部 4 按钮
 */
export function PromptInspectorTab() {
  return (
    <div
      className="flex flex-col gap-2 p-3 text-xs text-slate-500"
      data-testid="prompt-inspector-tab"
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        Prompt 检视 · 默认 tab · Day 14-15 接入
      </div>
      <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-slate-400">
        ⏳ prompt-inspector 7 块占位 — chap 18 mockup
        <br />🔔 wake-up 触发因 (AC-P3-5 V16.5.2 · WS event wake.trigger Week 3 G1 已派发) / 📊
        token 总账 / ✅ 注入 part 表 / ❌ 未注入 (B022 防回归) / 🤖 自动召回 + Quality Gate 三段 /
        📊 Adaptive Recall Policy / 🤝 agent session open_threads / 底部 4 按钮
      </div>
    </div>
  )
}
