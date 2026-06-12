import type { PreviewState } from "./preview-state-types"

/**
 * F028 Task 1 · worktree 枚举器（AC3）
 * git worktree list --porcelain 解析 + F024 registry 合并 + 端口存活探测 +
 * 进程所有权三态（D7：state 记录 pid 的 OS 实测 CreationDate 精确相等才算 ui）。
 *
 * deps 全注入（execGit / registry / probe / state / CreationDate），模块零真 IO——
 * spawn 类真 IO 只存在于 preview-deps.ts 适配层（plan v5 风险表：防 flaky）。
 */

export type WorktreeRow = {
  name: string
  branch: string
  head: string
  path: string
  isMain: boolean
}

export type PreviewStatus = {
  apiPort: number
  webPort: number
  apiAlive: boolean
  webAlive: boolean
  ownership: "ui" | "foreign" | "none"
}

export type WorktreeInventoryEntry = WorktreeRow & { preview: PreviewStatus | null }

export type RegistryEntry = { worktreeName: string; apiPort: number; webPort: number }

export type InventoryDeps = {
  execGitWorktreeList: () => Promise<string>
  readRegistry: () => Promise<RegistryEntry[]>
  probePort: (port: number) => Promise<boolean>
  readState: (worktreeName: string) => Promise<PreviewState | null>
  /** CIM Win32_Process CreationDate（epoch-ms 串）；进程不存在 → null */
  probeCreationDate: (pid: number) => Promise<string | null>
}

const SHORT_HEAD_LEN = 8

/** `git worktree list --porcelain` 块解析；首块 = 主仓（git 契约），detached → "(detached)" */
export function parseWorktreePorcelain(stdout: string): WorktreeRow[] {
  const rows: WorktreeRow[] = []
  const blocks = stdout.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0)
  for (const block of blocks) {
    let path = ""
    let head = ""
    let branch = "(detached)"
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim()
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim().slice(0, SHORT_HEAD_LEN)
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "")
      // "detached" 行：保持默认 "(detached)"
    }
    if (!path) continue
    const isMain = rows.length === 0
    const segments = path.replace(/\\/g, "/").split("/").filter(Boolean)
    const name = isMain ? "main" : (segments[segments.length - 1] ?? path)
    rows.push({ name, branch, head, path, isMain })
  }
  return rows
}

/**
 * 所有权判定（德彪 r1 P2-3 修订）：**每个 alive 端口**都必须有自己的记录且 CreationDate
 * 实测精确相等 → ui；任一活端口缺记录/失配 → foreign（活而无证的 listener 已脱管）。
 * 死端口不需要记录（compile-backend 后 web 暂死是合法 ui 形态）；全死由调用方判 none。
 */
async function resolveOwnership(
  state: PreviewState | null,
  alive: { api: boolean; web: boolean },
  probeCreationDate: InventoryDeps["probeCreationDate"],
): Promise<"ui" | "foreign"> {
  if (!state) return "foreign"
  for (const key of ["api", "web"] as const) {
    if (!alive[key]) continue
    const rec = state.processes[key]
    if (!rec) return "foreign"
    const actual = await probeCreationDate(rec.pid)
    if (actual === null || actual !== rec.creationDate) return "foreign"
  }
  return "ui"
}

export async function buildInventory(deps: InventoryDeps): Promise<WorktreeInventoryEntry[]> {
  const [stdout, registry] = await Promise.all([deps.execGitWorktreeList(), deps.readRegistry()])
  const rows = parseWorktreePorcelain(stdout)
  const result: WorktreeInventoryEntry[] = []
  for (const row of rows) {
    const entry = registry.find((e) => e.worktreeName === row.name)
    if (!entry) {
      result.push({ ...row, preview: null })
      continue
    }
    const [apiAlive, webAlive] = await Promise.all([
      deps.probePort(entry.apiPort),
      deps.probePort(entry.webPort),
    ])
    let ownership: PreviewStatus["ownership"]
    if (!apiAlive && !webAlive) {
      ownership = "none"
    } else {
      const state = await deps.readState(row.name)
      ownership = await resolveOwnership(state, { api: apiAlive, web: webAlive }, deps.probeCreationDate)
    }
    result.push({
      ...row,
      preview: { apiPort: entry.apiPort, webPort: entry.webPort, apiAlive, webAlive, ownership },
    })
  }
  return result
}
