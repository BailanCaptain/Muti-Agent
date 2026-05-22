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
 * r2 范-r1 P2-1 修：**always-render 5 tabs** + display 控制 active visibility，
 * 不再 mount/unmount 切换。AC-P3-2 line 178 契约 "切换 tab 内 fetch 状态保留
 * (不重新 loading) + scroll 位置 reload 误差 ≤ 10px" 物理依赖各 tab 组件持续
 * mount (state 才不丢)。
 *
 * 副作用：app 启动时 5 个 tab 都 mount → 各 tab 内 useEffect fetch 同时触发。
 * Week 4 真实接入时各 tab 内部应：
 *   - 首次 mount 时不 fetch (按需懒触发，如 activeLvl2 === my-key 才 fetch)
 *   - 或保留 fetch 但加 cache layer 避免重复请求
 * 当前骨架 placeholder 无 fetch，无副作用。
 */
export function Lvl2Content() {
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)

  return (
    <div className="flex-1 overflow-auto" role="tabpanel" data-testid="runtime-log-lvl2-content">
      <div style={{ display: activeLvl2 === "viewfinder" ? "block" : "none" }}>
        <ViewfinderTab />
      </div>
      <div style={{ display: activeLvl2 === "prompt-inspector" ? "block" : "none" }}>
        <PromptInspectorTab />
      </div>
      <div style={{ display: activeLvl2 === "draft-approval" ? "block" : "none" }}>
        <DraftApprovalTab />
      </div>
      <div style={{ display: activeLvl2 === "warnings" ? "block" : "none" }}>
        <WarningsTab />
      </div>
      <div style={{ display: activeLvl2 === "knowledge-base" ? "block" : "none" }}>
        <KnowledgeBaseTab />
      </div>
    </div>
  )
}
