import type { AuditEntry } from "./preview-state"
import type { WorktreeInventoryEntry } from "./worktree-inventory"

/**
 * 续作 AC12 · worktree 清理序列（小孙『只做必须做的』MVP）
 *
 * 安全门（含 .env*.backup-by-preview 不可再生原配置 fail-closed 守）→ 停 preview（复用
 * orchestrator.stop 的 D7 预检，绝不按端口杀）→ 预删可再生构建产物（仅 node_modules/.next）→
 * git worktree remove（无 --force，删整树含 worktree 自造数据；**非原子**：抛错但已注销时仍
 * 收口端口/状态并标残留需人工）→ git branch -d（内建合并保护）→ releasePorts + deleteState。
 *
 * 无事务日志/tombstone（D21 已收敛删除）。失败语义：worktree 仍注册→可重点击重试；已注销
 * 但有残留→收口已跑、报残留目录需人工删（git worktree remove 非原子，德彪 code-r3 P2）。
 */

export type CleanupStep = { name: string; ok: boolean; message?: string }
export type CleanupResult = { ok: boolean; steps: CleanupStep[] }

export type CleanupDeps = {
  name: string
  inventory: () => Promise<WorktreeInventoryEntry[]>
  /** 主仓 cwd 跑 git（worktree remove / branch -d）；非零退出须 reject */
  execGitMain: (args: string[]) => Promise<string>
  /** worktree cwd 跑 git（status --porcelain 核未提交） */
  execGitAt: (worktreePath: string, args: string[]) => Promise<string>
  /** worktree 顶层条目名（fs readdir）；安全门检 preview 未恢复的原配置备份用。**读失败必须
   *  reject、绝不吞成 []**——否则会 fail-open 让不可再生原配置进非原子删除路径（德彪 code-r3 P1）。 */
  listEntries: (worktreePath: string) => Promise<string[]>
  /** 复用 orchestrator.stop；occupied-foreign = 脱管不自动 kill */
  stopPreview: (name: string) => Promise<{ ok: boolean; stage?: string; message?: string }>
  /** 清可再生构建产物（仅 node_modules + .next），返回已删名 */
  rmArtifacts: (worktreePath: string) => Promise<string[]>
  releasePorts: (worktreeName: string) => Promise<void>
  deleteState: (worktreeName: string) => Promise<void>
  appendAudit: (entry: AuditEntry) => Promise<void>
}

/**
 * 清理前**显式预删**的目录——只列「**可再生**的构建产物」，且它们是 Windows 下
 * `git worktree remove` 撞 file-busy 的元凶（node_modules 海量句柄 / .next 被 next dev 占）：
 *   node_modules / .next
 *
 * **为什么只列可再生产物**（德彪 code-r1/r2 P1）：worktree 的其余数据/配置——.runtime 隔离
 * SQLite、.agents/acceptance uploads、`.env*`——交给后续 `git worktree remove`（无 --force）
 * 删（实测：remove 删 ignored 文件、仅对 untracked 非 ignored 的"用户未保存工作"才拒）。
 * 小孙 2026-06-14「worktree 造的数据可删」由此满足：数据随 worktree 删。
 *
 * **注意 git worktree remove 非原子**（德彪 code-r2 P1）：递归删除中途失败（如文件占用）git
 * 仍继续并注销 worktree，可能留部分删除的半态。故对**不可再生的**
 * `.env*.backup-by-preview`（preview 未恢复的用户原配置）由**安全门提前拒绝**清理，绝不让它进
 * 这条非原子删除路径；普通可再生数据 / 用户已确认要删的 worktree config 则接受随删。
 */
const ARTIFACT_DIRS = new Set(["node_modules", ".next"])

/**
 * 给定 worktree 顶层条目名，返回**可显式预删子集**——只有可再生构建产物 node_modules/.next。
 * **绝不**列 .runtime、.agents、数据、.env 类、源码、package.json、.git、顶层 data——
 * 它们或交给 git worktree remove（**非原子**删）、或须保留。边界=只预删确认可再生的构建产物。
 */
export function planArtifactRemoval(entries: string[]): string[] {
  return entries.filter((e) => ARTIFACT_DIRS.has(e))
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const normPath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

/** 复查 worktree 是否仍在 `git worktree list` 中（remove 非原子失败后判"已注销 vs 真失败"）。 */
async function isWorktreeRegistered(
  execGitMain: (args: string[]) => Promise<string>,
  worktreePath: string,
): Promise<boolean> {
  const out = await execGitMain(["worktree", "list", "--porcelain"])
  const target = normPath(worktreePath)
  return out
    .split(/\r?\n/)
    .some((line) => line.startsWith("worktree ") && normPath(line.slice("worktree ".length).trim()) === target)
}

export async function runWorktreeCleanup(deps: CleanupDeps): Promise<CleanupResult> {
  const steps: CleanupStep[] = []
  const add = (name: string, ok: boolean, message?: string): boolean => {
    steps.push(message === undefined ? { name, ok } : { name, ok, message })
    return ok
  }
  const finish = async (ok: boolean): Promise<CleanupResult> => {
    // 审计尽力而为：appendAudit 失败绝不能让已完成的清理变成抛异常（德彪 code-r1 P2-2：
    // 否则端点返 500 无 steps，前端 .steps.map 崩）。
    try {
      await deps.appendAudit({ action: "cleanup", worktree: deps.name, ok })
    } catch {
      // 审计失败不影响清理结果
    }
    return { ok, steps }
  }

  // ① 安全门：目标在 inventory + 非主仓 + 无未提交工作
  const inv = await deps.inventory()
  const entry = inv.find((e) => e.name === deps.name)
  if (!entry) return finish(add("safety-gate", false, `worktree ${deps.name} 不在 inventory`))
  if (entry.isMain) return finish(add("safety-gate", false, "主仓不可清理"))
  try {
    const status = (await deps.execGitAt(entry.path, ["status", "--porcelain"])).trim()
    if (status.length > 0) {
      return finish(add("safety-gate", false, "存在未提交工作，拒绝清理（防丢未保存改动）"))
    }
  } catch (err) {
    return finish(add("safety-gate", false, `无法核未提交工作: ${msg(err)}`))
  }
  // 不可再生原配置保护（德彪 code-r2 P1）：`.env*.backup-by-preview` 是 preview 把**用户原
  // 配置**改名后未恢复的备份（非 worktree 自造、不可再生）。git worktree remove **非原子**——
  // 中途失败可能已删该备份却仍注销 worktree，留不可恢复半态。故检测到即拒绝自动清理，要人工
  // 先恢复（正常重启/关闭 preview 会还原）。注：普通 `.env.local` 等是用户已二次确认要删的
  // worktree config，随树删是意图内，不在此拒绝之列（否则几乎所有 worktree 都清不掉）。
  try {
    const backups = (await deps.listEntries(entry.path)).filter((e) => /^\.env.*\.backup-by-preview$/.test(e))
    if (backups.length > 0) {
      return finish(
        add(
          "safety-gate",
          false,
          `检测到 preview 未恢复的原配置备份（${backups.join(", ")}）。请先正常重启/关闭该 preview 让它还原配置，再清理。`,
        ),
      )
    }
  } catch (err) {
    return finish(add("safety-gate", false, `无法核原配置备份: ${msg(err)}`))
  }
  add("safety-gate", true)

  // ② 停 preview（复用预检 kill，绝不按端口杀）；脱管 → 中止
  const stop = await deps.stopPreview(deps.name)
  if (!stop.ok) {
    const message =
      stop.stage === "occupied-foreign"
        ? "该 preview 脱管，请人工停进程后再清理"
        : (stop.message ?? "停 preview 失败")
    return finish(add("stop-preview", false, message))
  }
  add("stop-preview", true)

  // ③ 预删可再生构建产物（node_modules/.next，避免 Windows file-busy 让 remove 失败）——失败
  //    非中止。worktree 其余自造数据（.runtime/uploads 等）随后由 git worktree remove 一并删。
  try {
    const removed = await deps.rmArtifacts(entry.path)
    add("rm-artifacts", true, removed.length ? `已删 ${removed.join(", ")}` : "无构建产物可删")
  } catch (err) {
    add("rm-artifacts", false, `清构建产物失败: ${msg(err)}`)
  }

  // ④ git worktree remove（无 --force）。**非原子**（德彪 code-r3 P2）：git 可能"抛错但已注销
  //    worktree"。失败后复查是否仍注册——仍注册=真失败可重点击重试，中止；已注销=继续收口
  //    （端口/状态/分支）+ 标残留目录需人工删（否则 registry/state 孤儿 + worktree 已从列表消失
  //    无法重试）。
  let removeClean = true
  try {
    await deps.execGitMain(["worktree", "remove", entry.path])
    add("worktree-remove", true)
  } catch (err) {
    let stillRegistered = true
    try {
      stillRegistered = await isWorktreeRegistered(deps.execGitMain, entry.path)
    } catch {
      stillRegistered = true // 复查都失败 → 保守当仍注册，中止可重试
    }
    if (stillRegistered) {
      return finish(
        add("worktree-remove", false, `git worktree remove 失败（worktree 仍注册，可重试）: ${msg(err)}`),
      )
    }
    removeClean = false
    add(
      "worktree-remove",
      false,
      `git worktree remove 中途失败但 worktree 已注销，残留目录需人工删：${entry.path}（${msg(err)}）`,
    )
  }

  // ⑤ git branch -d（内建合并保护）——未合并/失败保留分支为 residue，非失败链
  if (entry.branch && entry.branch !== "(detached)") {
    try {
      await deps.execGitMain(["branch", "-d", entry.branch])
      add("branch-delete", true)
    } catch (err) {
      add(
        "branch-delete",
        false,
        `分支 ${entry.branch} 保留（未合并/失败 residue，确认后可手动 git branch -D）: ${msg(err)}`,
      )
    }
  }

  // ⑥ 收口（非致命尾）：释放端口（registry 短名 + 全分支名两 key——ccc7843：UI vs F024 CLI
  //    起的 preview 注册 key 不同）。**两 key 独立 best-effort**：首 key 释放失败绝不跳过第二
  //    key，否则另一 key 的端口注册泄漏（德彪 code-r6 P2）。
  const releaseKeys =
    entry.branch && entry.branch !== entry.name ? [entry.name, entry.branch] : [entry.name]
  const releaseErrors: string[] = []
  for (const key of releaseKeys) {
    try {
      await deps.releasePorts(key)
    } catch (err) {
      releaseErrors.push(`${key}: ${msg(err)}`)
    }
  }
  if (releaseErrors.length === 0) add("release-ports", true)
  else add("release-ports", false, `释放端口失败（不影响已删 worktree）: ${releaseErrors.join("; ")}`)
  try {
    await deps.deleteState(entry.name)
    add("delete-state", true)
  } catch (err) {
    add("delete-state", false, `清状态失败: ${msg(err)}`)
  }

  // removeClean=false（已注销但有残留）→ ok:false，让用户知道有残留目录需人工删；收口已跑
  return finish(removeClean)
}
