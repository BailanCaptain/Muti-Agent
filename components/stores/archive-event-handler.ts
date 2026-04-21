import { useEffect, useRef } from "react"

// F022 Phase 3.5 (review 4th round): 把 session.archive_state_changed 的前端
// dispatch 决策抽成纯函数，便于测试两条状态机分支：
//   1) archivedAt|deletedAt 非空 → bump version + 清 active（如果匹配）
//   2) restore（两个时间戳都 null） → 仅 bump version，不清 active
// 之前这段逻辑内联在 app/page.tsx 里，没有自动化覆盖，回归风险高。
export type ArchiveStateChangedPayload = {
  sessionGroupId: string
  archivedAt: string | null
  deletedAt: string | null
}

export type ArchiveStateChangedActions = {
  bumpArchiveStateVersion: () => void
  clearActiveGroupIfMatches: (groupId: string) => void
}

export function dispatchArchiveStateChanged(
  payload: ArchiveStateChangedPayload,
  actions: ArchiveStateChangedActions,
): void {
  actions.bumpArchiveStateVersion()
  if (payload.archivedAt || payload.deletedAt) {
    actions.clearActiveGroupIfMatches(payload.sessionGroupId)
  }
}

// F022 Phase 3.5 (review 4th round follow-up): archiveStateVersion 订阅 +
// reload 效果之前内联在 session-sidebar.tsx:314 的 useEffect 里，CI 无法抓到
// 删掉 reloadSessionGroups() 或改坏 deps 的回归。抽成可测 hook。
//
// 初次 render 跳过（使用 initial version 为 0，触发一次也无大碍但会产生多余 fetch）。
// 归档列表只在展开时刷新，避免无谓请求。
export function useArchiveStateReloader(
  archiveStateVersion: number,
  reloadSessionGroups: () => Promise<void> | void,
  reloadArchived: () => Promise<void> | void,
  archivedOpen: boolean,
): void {
  const isInitialRef = useRef(true)
  useEffect(() => {
    if (isInitialRef.current) {
      isInitialRef.current = false
      return
    }
    void reloadSessionGroups()
    if (archivedOpen) void reloadArchived()
  }, [archiveStateVersion, reloadSessionGroups, reloadArchived, archivedOpen])
}
