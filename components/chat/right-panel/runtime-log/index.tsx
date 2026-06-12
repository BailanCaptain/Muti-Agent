"use client"

import { useLayoutStore } from "@/components/stores/layout-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { A2ACallDrawer } from "./a2a-call-drawer"
import { Lvl1Tabs } from "./lvl1-tabs"
import { Lvl2Content } from "./lvl2-content"
import { Lvl2Tabs } from "./lvl2-tabs"
import { RuntimeLogHeader } from "./runtime-log-header"
import { ProjectTreeTab } from "./tabs/project-tree/project-tree-tab"
import { WorktreesTab } from "./tabs/worktrees/worktrees-tab"

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
  const activeLvl1 = useRuntimeLogStore((state) => state.activeLvl1)
  // F027 P3-1 扩展（小孙 2026-06-02）：展开时高度由 layout-store runtimeLogHeight 控制（可竖直拖高）。
  const runtimeLogHeight = useLayoutStore((state) => state.runtimeLogHeight)

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white"
      data-testid="runtime-log-container"
      style={
        collapsed
          ? // 折叠时只显示 header (~28px)
            { flex: "0 0 auto", minHeight: "auto" }
          : // 展开时高度由分隔线拖动控制（flex:none 让 height 生效，不被 flex grow/shrink 覆盖）
            { flex: "0 0 auto", height: `${runtimeLogHeight}px` }
      }
    >
      <RuntimeLogHeader />
      {!collapsed && (
        <>
          <Lvl1Tabs />
          {/* F028: LVL1 内容切换——always-render + display 控制（保 F027 r2 P2-1
              的 lvl2 fetch/scroll 状态契约）；WorktreesTab 自带 enabled 懒 fetch 门 */}
          <div
            className="flex min-h-0 flex-1 flex-col"
            style={{ display: activeLvl1 === "system-prompt" ? "flex" : "none" }}
          >
            <Lvl2Tabs />
            <Lvl2Content />
          </div>
          <div
            className="min-h-0 flex-1 overflow-hidden"
            style={{ display: activeLvl1 === "worktrees" ? "block" : "none" }}
          >
            <WorktreesTab />
          </div>
          <div
            className="min-h-0 flex-1 overflow-hidden"
            style={{ display: activeLvl1 === "project-tree" ? "block" : "none" }}
          >
            <ProjectTreeTab />
          </div>
        </>
      )}
      {/* F027 Phase 3 Day 20 (AC-P3-5/4) · shared a2a click drawer.
          Portal-style fixed overlay 不受 collapsed 影响, viewfinder + prompt-inspector pill 共享 store. */}
      <A2ACallDrawer />
    </div>
  )
}
