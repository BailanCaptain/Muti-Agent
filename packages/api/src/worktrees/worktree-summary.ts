/**
 * F028 Task 6 · worktree 进展摘要（AC4）
 * branch/HEAD/最近 10 commits/merge-base 基准 diff stat/未提交三计数。
 * execGit 注入（cwd 由 caller 绑定 worktree 根），git 失败返回结构化 error 不抛。
 */

export type CommitRow = { hash: string; subject: string; date: string }

export type WorktreeSummary = {
  branch: string
  head: string
  commits: CommitRow[]
  diffStat: { baseRef: string; files: number; insertions: number; deletions: number }
  working: { staged: number; unstaged: number; untracked: number }
}

export type SummaryError = { error: string }

const LOG_SEP = "\x1f" // unit separator——subject 含空格/| 时安全切分
const COMMIT_LIMIT = 10

export function parseDiffShortstat(stdout: string): {
  files: number
  insertions: number
  deletions: number
} {
  const files = /(\d+) files? changed/.exec(stdout)
  const insertions = /(\d+) insertions?\(\+\)/.exec(stdout)
  const deletions = /(\d+) deletions?\(-\)/.exec(stdout)
  return {
    files: files ? Number(files[1]) : 0,
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  }
}

export function parseStatusPorcelain(stdout: string): {
  staged: number
  unstaged: number
  untracked: number
} {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length < 2) continue
    const x = line[0]
    const y = line[1]
    if (x === "?" && y === "?") {
      untracked += 1
      continue
    }
    if (x !== " " && x !== "?") staged += 1 // 首列非空非 ? = staged（同行双列各计一次）
    if (y !== " ") unstaged += 1
  }
  return { staged, unstaged, untracked }
}

function parseLog(stdout: string): CommitRow[] {
  const rows: CommitRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [hash, subject, date] = line.split(LOG_SEP)
    if (!hash || subject === undefined || date === undefined) continue
    rows.push({ hash, subject, date })
  }
  return rows
}

export async function buildWorktreeSummary(deps: {
  worktreePath: string
  baseRef: string
  execGit: (args: string[]) => Promise<string>
}): Promise<WorktreeSummary | SummaryError> {
  const { baseRef, execGit } = deps
  try {
    const [branchOut, headOut, logOut] = await Promise.all([
      execGit(["rev-parse", "--abbrev-ref", "HEAD"]),
      execGit(["rev-parse", "--short", "HEAD"]),
      execGit(["log", `--format=%h${LOG_SEP}%s${LOG_SEP}%cI`, `-${COMMIT_LIMIT}`]),
    ])
    const mergeBase = (await execGit(["merge-base", baseRef, "HEAD"])).trim()
    const [diffOut, statusOut] = await Promise.all([
      execGit(["diff", "--shortstat", `${mergeBase}..HEAD`]),
      execGit(["status", "--porcelain"]),
    ])
    return {
      branch: branchOut.trim(),
      head: headOut.trim(),
      commits: parseLog(logOut),
      diffStat: { baseRef, ...parseDiffShortstat(diffOut) },
      working: parseStatusPorcelain(statusOut),
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
