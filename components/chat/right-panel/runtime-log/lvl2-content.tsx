"use client"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { DraftApprovalTab } from "./tabs/draft-approval-tab"
import { KnowledgeBaseTab } from "./tabs/knowledge-base-tab"
import { PromptInspectorTab } from "./tabs/prompt-inspector-tab"
import { ViewfinderTab } from "./tabs/viewfinder-tab"
import { WarningsTab } from "./tabs/warnings-tab"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 二级 tab 内容路由
 * 真相源：V16.5 §18 line 1948-1954
 *
 * 当前是 switch 直接渲染当前 tab。Phase 3 Week 4 真实数据接入后，每个 Tab
 * 组件内部管 fetch state — switch 一次性 render 让所有 tab state 自然保留
 * (React 状态生命周期由组件 mount/unmount 决定)。
 *
 * AC-P3-2 状态保留契约: 切换 tab 各自 fetch 状态不重新 loading + scroll 位置
 * reload 误差 ≤ 10px。骨架阶段先保证 tab 切换 + 路由对，真实保留 Week 4 加。
 *
 * 注：当前是 unmount/remount pattern（switch render 一个）。若需要保留 scroll/fetch
 * state 跨 tab 切换，可改 always-render + visibility (display:none) — Week 4 评估。
 */
export function Lvl2Content() {
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)

  return (
    <div className="flex-1 overflow-auto" role="tabpanel" data-testid="runtime-log-lvl2-content">
      {activeLvl2 === "viewfinder" && <ViewfinderTab />}
      {activeLvl2 === "prompt-inspector" && <PromptInspectorTab />}
      {activeLvl2 === "draft-approval" && <DraftApprovalTab />}
      {activeLvl2 === "warnings" && <WarningsTab />}
      {activeLvl2 === "knowledge-base" && <KnowledgeBaseTab />}
    </div>
  )
}
