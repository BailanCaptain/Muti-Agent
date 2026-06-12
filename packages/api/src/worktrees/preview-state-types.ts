/**
 * F028 · preview 状态文件终态 schema（plan v5「进程模型」节）
 * 文件落 `<主仓>/.runtime/worktree-preview-ui/<worktreeId>.json`（D13 slug 命名）。
 * creationDate = CIM Win32_Process CreationDate 提取的 epoch-ms 串（同源采集精确比较，D7）。
 */

export type ProcessRecord = {
  pid: number
  creationDate: string
  startedAt: string
}

export type PreviewState = {
  worktreeName: string
  worktreeId: string
  apiPort: number
  webPort: number
  processes: {
    api: ProcessRecord | null
    web: ProcessRecord | null
  }
}
