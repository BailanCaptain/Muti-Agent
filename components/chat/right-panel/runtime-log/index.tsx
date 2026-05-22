"use client"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { A2ACallDrawer } from "./a2a-call-drawer"
import { Lvl1Tabs } from "./lvl1-tabs"
import { Lvl2Content } from "./lvl2-content"
import { Lvl2Tabs } from "./lvl2-tabs"
import { RuntimeLogHeader } from "./runtime-log-header"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 容器
 * 真相源：V16.5 §18 line 1927-1944 + line 1948-1954
 *
 * 结构 (V16.5 §18 line 1931-1935):
 *   - RuntimeLogHeader (含整体折叠按钮)
 *   - Lvl1Tabs (一级标题：system prompt + 日志/未来)
 *   - Lvl2Tabs (二级 5 tabs)
 *   - Lvl2Content (当前 lvl2 tab 内容)
 *
 * collapsed 时只显示 header (折叠状态)，恢复后保留之前 active lvl1/lvl2 选择。
 *
 * 集成: status-panel.tsx 末尾 sticky 5 段下方 (F021 现状 RoomBadge /
 * ObservationBar / AgentList / FoldControls / RoomSwitches 之下)。
 */
export function RuntimeLog() {
  const collapsed = useRuntimeLogStore((state) => state.collapsed)

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white"
      data-testid="runtime-log-container"
      style={{
        // 折叠时只显示 header (~28px)，展开时占满剩余空间
        flex: collapsed ? "0 0 auto" : "1 1 0",
        minHeight: collapsed ? "auto" : "200px",
      }}
    >
      <RuntimeLogHeader />
      {!collapsed && (
        <>
          <Lvl1Tabs />
          <Lvl2Tabs />
          <Lvl2Content />
        </>
      )}
      {/* F027 Phase 3 Day 20 (AC-P3-5/4) · shared a2a click drawer.
          Portal-style fixed overlay 不受 collapsed 影响, viewfinder + prompt-inspector pill 共享 store. */}
      <A2ACallDrawer />
    </div>
  )
}
