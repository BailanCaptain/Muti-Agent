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
