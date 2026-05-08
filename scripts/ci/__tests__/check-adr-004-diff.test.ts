import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"

const SCRIPT = resolve(__dirname, "..", "check-adr-004-diff.sh")

// 当这个测试在 git pre-commit hook 上下文中被 tsx --test 触发时，
// 父进程的 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 等 env 会让子进程 git
// 忽略 cwd 并直接操作真实 worktree（曾两次污染 F026-p0，见 B019 历史）。
// 所有对 temp repo 的 git 调用必须显式剥离这些环境变量。
const GIT_ENV_VARS_TO_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "GIT_PREFIX",
  "GIT_EXEC_PATH",
  "GIT_CONFIG",
  "GIT_CONFIG_NOSYSTEM",
]

function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of GIT_ENV_VARS_TO_STRIP) delete env[key]
  return { ...env, ...extra }
}

function git(cwd: string, args: string[]) {
  execFileSync(
    "git",
    ["-c", "user.name=ADR Guard Test", "-c", "user.email=adr-guard@example.test", ...args],
    { cwd, env: cleanGitEnv(), stdio: "pipe" },
  )
}

test("ADR-004 diff guard uses merge-base for explicit BASE refs", () => {
  const repo = mkdtempSync(join(tmpdir(), "adr004-diff-"))
  const scriptCopy = join(repo, "scripts", "ci", "check-adr-004-diff.sh")
  mkdirSync(dirname(scriptCopy), { recursive: true })
  copyFileSync(SCRIPT, scriptCopy)

  git(repo, ["init", "-q"])
  writeFileSync(join(repo, "AGENTS.md"), "base\n")
  git(repo, ["add", "AGENTS.md"])
  git(repo, ["commit", "-m", "base", "-q"])
  git(repo, ["branch", "-M", "main"])

  git(repo, ["checkout", "-b", "dev", "-q"])
  writeFileSync(join(repo, "AGENTS.md"), "base\ndev-added\n")
  git(repo, ["commit", "-am", "dev prompt churn", "-q"])

  git(repo, ["checkout", "-b", "feat", "main", "-q"])
  writeFileSync(join(repo, "AGENTS.md"), "base\nfeat-added\n")
  git(repo, ["commit", "-am", "feature prompt leak", "-q"])

  git(repo, ["remote", "add", "origin", repo])
  git(repo, ["fetch", "origin", "dev:refs/remotes/origin/dev", "-q"])
  git(repo, ["branch", "-D", "dev"])

  const result = spawnSync("bash", [scriptCopy], {
    cwd: repo,
    env: cleanGitEnv({ BASE: "origin/dev" }),
    encoding: "utf8",
  })

  assert.notEqual(
    result.status,
    0,
    `expected feature prompt insertion to be rejected, got exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  assert.match(result.stdout, /AGENTS\.md net \+1 lines/)
})
