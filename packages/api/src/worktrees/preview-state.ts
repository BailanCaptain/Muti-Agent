import fs from "node:fs/promises"
import path from "node:path"

import { slugifyWorktreeId } from "./preview-guards"
import type { PreviewState } from "./preview-state-types"

/**
 * F028 Task 3 · 状态文件存取 + 审计日志 + boot reconcile（AC9）
 * 文件名只由 worktreeId slug 构成（D13：feat/x 不产生嵌套路径）。
 * reconcile 铁则：失配只清记录，**绝不杀进程**（AC9 / D7）。
 */

export type AuditEntry = {
  action: string
  worktree: string
  ok: boolean
  stage?: string
  message?: string
}

export type PreviewStateStore = {
  readonly baseDir: string
  readState: (worktreeName: string) => Promise<PreviewState | null>
  writeState: (state: PreviewState) => Promise<void>
  listStates: () => Promise<PreviewState[]>
  appendAudit: (entry: AuditEntry) => Promise<void>
}

export function createPreviewStateStore(deps: {
  baseDir: string
  now: () => string
}): PreviewStateStore {
  const { baseDir, now } = deps

  function stateFile(worktreeName: string): string {
    return path.join(baseDir, `${slugifyWorktreeId(worktreeName)}.json`)
  }

  async function ensureBase(): Promise<void> {
    await fs.mkdir(baseDir, { recursive: true })
  }

  return {
    baseDir,
    async readState(worktreeName) {
      try {
        const raw = await fs.readFile(stateFile(worktreeName), "utf8")
        return JSON.parse(raw) as PreviewState
      } catch {
        return null // 不存在 / 损坏 JSON → null 不抛（caller 视作无状态）
      }
    },
    async writeState(state) {
      await ensureBase()
      await fs.writeFile(stateFile(state.worktreeName), `${JSON.stringify(state, null, 2)}\n`, "utf8")
    },
    async listStates() {
      try {
        const files = await fs.readdir(baseDir)
        const states: PreviewState[] = []
        for (const file of files) {
          if (!file.endsWith(".json")) continue
          try {
            const raw = await fs.readFile(path.join(baseDir, file), "utf8")
            states.push(JSON.parse(raw) as PreviewState)
          } catch {
            // 单个坏文件不拖垮全列表
          }
        }
        return states
      } catch {
        return []
      }
    },
    async appendAudit(entry) {
      await ensureBase()
      const line = JSON.stringify({ time: now(), ...entry })
      await fs.appendFile(path.join(baseDir, "audit.log"), `${line}\n`, "utf8")
    },
  }
}

/**
 * 主 API 启动 reconcile：每条 process 记录实测 CreationDate——
 * pid 不存在或失配 → 字段置 null 落盘；匹配 → 原样。
 * deps.kill 仅用于测试证明零调用（reconcile 永不杀进程）。
 */
export async function reconcileOnBoot(deps: {
  store: PreviewStateStore
  probeCreationDate: (pid: number) => Promise<string | null>
  kill?: (pid: number) => Promise<void>
}): Promise<void> {
  const states = await deps.store.listStates()
  for (const state of states) {
    let dirty = false
    for (const key of ["api", "web"] as const) {
      const rec = state.processes[key]
      if (!rec) continue
      const actual = await deps.probeCreationDate(rec.pid)
      if (actual === null || actual !== rec.creationDate) {
        state.processes[key] = null
        dirty = true
      }
    }
    if (dirty) await deps.store.writeState(state)
  }
}
