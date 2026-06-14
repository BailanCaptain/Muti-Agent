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

/**
 * 续作 AC11 · 合并状态（best-effort 提示，非硬门）。每信号独立降级 null。
 * ahead = HEAD 独占提交数；behind = baseRef 独占；mergedHint = HEAD 是否已被 baseRef 包含。
 */
export type MergeStatus = {
  ahead: number | null
  behind: number | null
  mergedHint: boolean | null
}

export type WorktreeInventoryEntry = WorktreeRow & {
  preview: PreviewStatus | null
  /** 主仓行 = null（不算合并状态）；非主行 = MergeStatus（字段各自可降级 null） */
  mergeStatus: MergeStatus | null
}

export type RegistryEntry = { worktreeName: string; apiPort: number; webPort: number }

export type InventoryDeps = {
  execGitWorktreeList: () => Promise<string>
  readRegistry: () => Promise<RegistryEntry[]>
  probePort: (port: number) => Promise<boolean>
  readState: (worktreeName: string) => Promise<PreviewState | null>
  /** CIM Win32_Process CreationDate（epoch-ms 串）；进程不存在 → null */
  probeCreationDate: (pid: number) => Promise<string | null>
  /** AC11 合并状态基准（通常 "dev"） */
  baseRef: string
  /** AC11：在某 worktree 路径下跑 git（非零退出须 reject，error.code=退出码） */
  execGitAt: (worktreePath: string, args: string[]) => Promise<string>
}

const SHORT_HEAD_LEN = 8

function gitExitCode(err: unknown): number | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === "number") return code
  }
  return null
}

/**
 * AC11 合并状态：两条 git 命令各自独立 try/catch，**永不抛**。
 * - ahead/behind：`git rev-list --left-right --count <baseRef>...HEAD` → "behind\tahead"
 * - mergedHint：`git merge-base --is-ancestor HEAD <baseRef>` 纯退出码（0=已含、1=未含、其它=未知 null）
 */
export async function computeMergeStatus(
  execGit: (args: string[]) => Promise<string>,
  baseRef: string,
): Promise<MergeStatus> {
  let ahead: number | null = null
  let behind: number | null = null
  let mergedHint: boolean | null = null
  try {
    const out = (await execGit(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`])).trim()
    const m = /^(\d+)\s+(\d+)$/.exec(out)
    if (m) {
      behind = Number(m[1])
      ahead = Number(m[2])
    }
  } catch {
    // 降级 null
  }
  try {
    await execGit(["merge-base", "--is-ancestor", "HEAD", baseRef])
    mergedHint = true // exit 0
  } catch (err) {
    mergedHint = gitExitCode(err) === 1 ? false : null // 1=确定未含；其它（坏 ref/IO）=未知
  }
  return { ahead, behind, mergedHint }
}

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
    // AC11 合并状态：主仓不算；非主行 best-effort 计算，整体爆掉降级 null（不连累列表）
    let mergeStatus: MergeStatus | null = null
    if (!row.isMain) {
      try {
        mergeStatus = await computeMergeStatus(
          (args) => deps.execGitAt(row.path, args),
          deps.baseRef,
        )
      } catch {
        mergeStatus = { ahead: null, behind: null, mergedHint: null }
      }
    }
    // 合入后真机 bug 修复：F024 CLI `pnpm worktree:preview` 用全分支名 claim registry
    // （worktreeName=row.branch），F028 自己的 start 用短名（row.name）。两种 key 都要认，
    // 否则 CLI 起的 preview 全误判未运行。branch 全分支名 git 保证唯一，精确等值不会误吸附。
    const entry = registry.find((e) => e.worktreeName === row.name || e.worktreeName === row.branch)
    if (!entry) {
      result.push({ ...row, preview: null, mergeStatus })
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
      mergeStatus,
    })
  }
  return result
}
