import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

import { planArtifactRemoval, runWorktreeCleanup, type CleanupDeps } from "./worktree-cleanup"
import type { WorktreeInventoryEntry } from "./worktree-inventory"

/**
 * 续作 AC12 · **真 Git worktree 集成测试**（德彪 code-r1 P1：数据安全不准只靠 fake execGitMain）。
 * 真 git init + worktree add + runWorktreeCleanup 真 execGit/真 fs，证明：
 *   ① 干净 worktree（仅 tracked + ignored 数据）→ 清理成功、目录消失、分支删除、ignored 数据随之删；
 *   ② 含 untracked **非 ignored** 用户未保存文件 → git worktree remove 拒（无 --force）、目录与文件保留。
 * 只 fake 非 git 依赖（stopPreview/releasePorts/deleteState/appendAudit）。
 */

const execFileAsync = promisify(execFile)

// B019 防线（check-adr-004-diff.test.ts 同款）：当本测试在 git pre-commit hook 上下文中被
// tsx --test 触发时，父进程的 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 等 env 会让子进程 git
// **忽略 cwd 直接操作真实 worktree**——本测试 setupRepo 的 `git init/add/commit -m init`
// 会因此在真 worktree 造出 "init" 提交并清空 index（实测污染过 F027-v14-judge worktree）。
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
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of GIT_ENV_VARS_TO_STRIP) delete env[key]
  return env
}
const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    env: cleanGitEnv(),
  })
  return stdout
}

// 复刻 preview-runtime 的 rmArtifacts 适配层（真 fs + 导出的 planArtifactRemoval 策略）
async function realRmArtifacts(worktreePath: string): Promise<string[]> {
  const entries = await fs.readdir(worktreePath)
  const removed: string[] = []
  for (const name of planArtifactRemoval(entries)) {
    await fs.rm(path.join(worktreePath, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

async function setupRepo(): Promise<{ mainRepo: string; cleanup: () => Promise<void> }> {
  const mainRepo = await fs.mkdtemp(path.join(os.tmpdir(), "f028-cleanup-it-"))
  await git(mainRepo, ["init", "-b", "dev"])
  await git(mainRepo, ["config", "user.email", "test@example.com"])
  await git(mainRepo, ["config", "user.name", "test"])
  await git(mainRepo, ["config", "commit.gpgsign", "false"])
  await fs.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.next\n.runtime/\n.env*\n", "utf8")
  await fs.writeFile(path.join(mainRepo, "README.md"), "root\n", "utf8")
  await git(mainRepo, ["add", "."])
  await git(mainRepo, ["commit", "-m", "init"])
  return {
    mainRepo,
    cleanup: async () => {
      await fs.rm(mainRepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
    },
  }
}

function makeDeps(name: string, wtPath: string, mainRepo: string, branch: string): CleanupDeps {
  const entry: WorktreeInventoryEntry = {
    name,
    branch,
    head: "x",
    path: wtPath.replace(/\\/g, "/"),
    isMain: false,
    preview: null,
    mergeStatus: null,
  }
  return {
    name,
    inventory: async () => [entry],
    execGitMain: (args) => git(mainRepo, args),
    execGitAt: (p, args) => git(p, args),
    listEntries: (p) => fs.readdir(p), // 不吞异常（德彪 code-r3 P1：安全门须 fail-closed）
    stopPreview: async () => ({ ok: true }),
    rmArtifacts: realRmArtifacts,
    releasePorts: async () => {},
    deleteState: async () => {},
    appendAudit: async () => {},
  }
}

// ① 干净 worktree（tracked + ignored 数据）→ 清理成功、消失、分支删、数据随之删
test("F028 AC12 IT · clean worktree with ignored data → removed + branch deleted + data gone", async () => {
  const { mainRepo, cleanup } = await setupRepo()
  try {
    const wtPath = path.join(mainRepo, ".worktrees", "wtA")
    await git(mainRepo, ["worktree", "add", "-b", "feat/wtA", wtPath, "dev"])
    // worktree 自造的 ignored 数据（小孙：可删）
    await fs.mkdir(path.join(wtPath, "node_modules", "foo"), { recursive: true })
    await fs.writeFile(path.join(wtPath, "node_modules", "foo", "x.js"), "x", "utf8")
    await fs.mkdir(path.join(wtPath, ".runtime", "worktree-preview", "data"), { recursive: true })
    await fs.writeFile(path.join(wtPath, ".runtime", "worktree-preview", "data", "multi-agent.sqlite"), "DBDATA", "utf8")

    const res = await runWorktreeCleanup(makeDeps("wtA", wtPath, mainRepo, "feat/wtA"))

    assert.equal(res.ok, true, `清理应成功；steps=${JSON.stringify(res.steps)}`)
    assert.equal(
      await fs.access(wtPath).then(() => true).catch(() => false),
      false,
      "worktree 目录应被删除（含 .runtime SQLite 等 worktree 自造数据）",
    )
    const branches = await git(mainRepo, ["branch", "--list", "feat/wtA"])
    assert.equal(branches.trim(), "", "已合并入 dev 的分支应被 git branch -d 删除")
  } finally {
    await cleanup()
  }
})

// ② 含 untracked 非 ignored 用户文件 → git worktree remove 拒、目录与文件保留（数据安全双保险之 git 侧）
test("F028 AC12 IT · untracked non-ignored user file → remove refused, file preserved", async () => {
  const { mainRepo, cleanup } = await setupRepo()
  try {
    const wtPath = path.join(mainRepo, ".worktrees", "wtB")
    await git(mainRepo, ["worktree", "add", "-b", "feat/wtB", wtPath, "dev"])
    await fs.mkdir(path.join(wtPath, "node_modules"), { recursive: true })
    // 用户未保存工作（untracked 非 ignored）——绝不能被静默删
    const userFile = path.join(wtPath, "USER_UNSAVED.txt")
    await fs.writeFile(userFile, "important user work", "utf8")

    // 注：本测试绕过 runWorktreeCleanup 的安全门（其 git status 检测会先拦未提交工作），
    // 直接验证最后一道防线：git worktree remove（无 --force）对 untracked 非 ignored 文件的拒绝。
    let removeErr: unknown = null
    try {
      await git(mainRepo, ["worktree", "remove", wtPath.replace(/\\/g, "/")])
    } catch (e) {
      removeErr = e
    }
    assert.ok(removeErr !== null, "git worktree remove 必须对 untracked 非 ignored 文件拒绝（无 --force）")
    assert.equal(
      await fs.access(userFile).then(() => true).catch(() => false),
      true,
      "用户未保存文件必须保留",
    )
  } finally {
    await cleanup()
  }
})

// ③ 走**完整 runWorktreeCleanup**（不绕过，德彪 code-r2 批评点）：preview 未恢复的原配置备份
//    存在 → 安全门拒、worktree 与备份均保留（不可再生配置绝不进非原子删除路径）
test("F028 AC12 IT · runWorktreeCleanup refuses + preserves when .env*.backup-by-preview present", async () => {
  const { mainRepo, cleanup } = await setupRepo()
  try {
    const wtPath = path.join(mainRepo, ".worktrees", "wtC")
    await git(mainRepo, ["worktree", "add", "-b", "feat/wtC", wtPath, "dev"])
    // preview 异常退出残留：用户原配置被改名、未恢复（gitignored，git status 看不见）
    const backup = path.join(wtPath, ".env.development.local.backup-by-preview")
    await fs.writeFile(backup, "USER_ORIGINAL_SECRET=keepme", "utf8")

    const res = await runWorktreeCleanup(makeDeps("wtC", wtPath, mainRepo, "feat/wtC"))

    assert.equal(res.ok, false, "检测到未恢复原配置备份必须拒绝清理")
    assert.match(res.steps.at(-1)?.message ?? "", /原配置备份|backup-by-preview|恢复/)
    assert.equal(
      await fs.access(wtPath).then(() => true).catch(() => false),
      true,
      "worktree 必须保留（未进非原子删除路径）",
    )
    assert.equal(
      await fs.access(backup).then(() => true).catch(() => false),
      true,
      "不可再生原配置备份必须保留",
    )
  } finally {
    await cleanup()
  }
})
