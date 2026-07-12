"use client"

import { SideCard, useSideContent } from "./replace-compare-panel"
import type { SameSourceConflictItem } from "./use-promote-api"

/**
 * F042 AC3 · 同源撞车面板（promote 返 409 SAME_SOURCE_EXISTS 时渲染）。
 *
 * 场景：本 draft 与正式区已有条目 sources[0].path 相同（同一篇文档先后收录出双胞胎，
 * F031 新旧两版并存自相矛盾的病根）。强制显式二选一：
 *   - 「取代旧版」→ modal 带 supersedePaths=全部冲突路径重新提交（服务端要求全覆盖，
 *     无半态）；旧版归档进 wiki/_superseded/（move not delete + 事件留痕，可恢复）并退出召回面
 *   - 「去合并」→ 中止本次 promote（机器不合并内容）；用户手动把增量并入已有条目
 *
 * 布局 1:1 镜像 ReplaceComparePanel（SideCard/useSideContent 直接复用，不引新视觉）。
 * 与 replace 的差异：取代无 CAS 哈希依赖（旧版归档保留确认时刻内容，move 可恢复），
 * 按钮只由 reason/提交态门控；对比内容在按钮上方加载展示供人判断。
 */

export interface SameSourcePanelProps {
  srcDraftPath: string
  conflicts: SameSourceConflictItem[]
  /** 点「取代旧版」→ modal 带 supersedePaths（全部冲突路径）重新提交。 */
  onSupersede: () => void
  /** 取代按钮禁用（reason 未填 / 正在提交）。 */
  supersedeDisabled: boolean
  /** 点「去合并」→ 关弹窗，用户手动合并进已有条目。 */
  onMerge: () => void
}

function ConflictCompareRow(props: { srcDraftPath: string; conflict: SameSourceConflictItem }) {
  const existing = useSideContent("/api/wiki/page/content", props.conflict.path)
  const draft = useSideContent("/api/wiki/drafts/content", props.srcDraftPath)
  return (
    <div className="mt-2">
      <div className="text-xs text-purple-700">
        同源旧版：<span className="font-mono break-all">{props.conflict.path}</span>
      </div>
      <div className="mt-1 flex gap-2">
        <SideCard title="正式区旧版" side={existing} newer={false} />
        <SideCard title="本 draft（新版）" side={draft} newer={true} />
      </div>
    </div>
  )
}

export function SameSourcePanel({
  srcDraftPath,
  conflicts,
  onSupersede,
  supersedeDisabled,
  onMerge,
}: SameSourcePanelProps) {
  return (
    <div
      className="mb-4 rounded border border-purple-300 bg-purple-50 p-3"
      data-testid="same-source-panel"
    >
      <div className="text-sm font-medium text-purple-800">
        正式区已有同源条目（来自同一篇原始文档）
      </div>
      <div className="mt-1 text-xs text-purple-700">
        直接转正会造成新旧两版并存、搜索自相矛盾。请二选一：
        <span className="font-medium">取代旧版</span>
        （旧版归档到 _superseded/ 可恢复，并退出搜索/召回）或
        <span className="font-medium">去合并</span>（中止本次转正，手动把增量并入已有条目）。
      </div>

      {conflicts.map((c) => (
        <ConflictCompareRow key={c.path} srcDraftPath={srcDraftPath} conflict={c} />
      ))}

      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="text-[11px] text-gray-500">
          取代 = 旧版归档 _superseded/（可恢复）+ 本 draft 转正
        </span>
        <button
          type="button"
          onClick={onMerge}
          className="rounded border border-purple-300 px-3 py-1.5 text-sm text-purple-700 hover:bg-purple-100"
          data-testid="same-source-merge-button"
        >
          去合并
        </button>
        <button
          type="button"
          onClick={onSupersede}
          disabled={supersedeDisabled}
          className="rounded bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          data-testid="same-source-supersede-button"
        >
          取代旧版{conflicts.length > 1 ? `（${conflicts.length} 条）` : ""}
        </button>
      </div>
    </div>
  )
}
