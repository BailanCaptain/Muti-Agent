import assert from "node:assert/strict"
import { test } from "node:test"

import { planArtifactRemoval, runWorktreeCleanup, type CleanupDeps } from "./worktree-cleanup"
import type { WorktreeInventoryEntry } from "./worktree-inventory"

/**
 * 续作 AC12 · worktree 清理序列（deps 全注入，零真 IO）
 * 数据安全（D15/Iron Law 1）：planArtifactRemoval **只预删可再生构建产物 node_modules/.next**；
 * 其余授权数据由 `git worktree remove`（**非原子**）删，不可再生原配置由安全门 fail-closed 守。
 */

const F028: WorktreeInventoryEntry = {
  name: "F028",
  branch: "feat/F028-x",
  head: "bbb",
  path: "C:/repo/.worktrees/F028",
  isMain: false,
  preview: null,
  mergeStatus: { ahead: 0, behind: 2, mergedHint: true },
}
const MAIN: WorktreeInventoryEntry = {
  name: "main",
  branch: "dev",
  head: "aaa",
  path: "C:/repo",
  isMain: true,
  preview: null,
  mergeStatus: null,
}

function makeDeps(overrides: Partial<CleanupDeps> = {}): { deps: CleanupDeps; calls: string[] } {
  const calls: string[] = []
  const deps: CleanupDeps = {
    name: "F028",
    inventory: async () => [MAIN, F028],
    execGitMain: async (args) => {
      calls.push(`gitMain:${args.join(" ")}`)
      return ""
    },
    execGitAt: async (cwd, args) => {
      calls.push(`gitAt:${cwd}:${args.join(" ")}`)
      return "" // status --porcelain 空 = 无未提交
    },
    listEntries: async () => ["node_modules", ".next", "src", "package.json"], // 默认无 backup
    stopPreview: async (name) => {
      calls.push(`stop:${name}`)
      return { ok: true }
    },
    rmArtifacts: async (p) => {
      calls.push(`rm:${p}`)
      return ["node_modules"]
    },
    releasePorts: async (n) => {
      calls.push(`release:${n}`)
    },
    deleteState: async (n) => {
      calls.push(`deleteState:${n}`)
    },
    appendAudit: async (e) => {
      calls.push(`audit:${e.action}:${e.ok}`)
    },
    ...overrides,
  }
  return { deps, calls }
}

// ── 预删边界（德彪 code-r1 P1：只显式预删可再生构建产物，数据/配置交给 git 非原子删）──
test("F028 AC12 · planArtifactRemoval 只预删可再生构建产物 node_modules/.next", () => {
  const entries = [
    "node_modules",
    ".next",
    ".runtime", // worktree preview 数据——可删但交给 git worktree remove（非原子）删，不预删
    ".env",
    ".env.local",
    ".env.backup-by-preview",
    ".env.development.local.backup-by-preview", // 用户原配置备份，不可再生——绝不预删
    "data",
    "multi-agent.sqlite",
    "src",
    ".agents",
    "package.json",
    ".git",
    "docs",
  ]
  const plan = planArtifactRemoval(entries)
  assert.deepEqual(plan.sort(), ["node_modules", ".next"].sort())
  // 可再生构建产物 → 预删（避免 Windows file-busy 让 git remove 失败）
  for (const regen of ["node_modules", ".next"]) {
    assert.ok(plan.includes(regen), `${regen} 是可再生构建产物，预删`)
  }
  // 关键边界：数据/配置/备份/源码 一律**不预删**（数据交给 git 非原子删；不可再生配置由安全门守，绝不进删除路径）
  for (const notPredel of [
    ".runtime",
    ".env",
    ".env.local",
    ".env.backup-by-preview",
    ".env.development.local.backup-by-preview",
    "data",
    "multi-agent.sqlite",
    "src",
    ".agents",
    "package.json",
    ".git",
    "docs",
  ]) {
    assert.ok(!plan.includes(notPredel), `${notPredel} 绝不预删（git 非原子删 或 保留）`)
  }
})

// ── 编排 ──────────────────────────────────────────────────────────────────

// happy：安全门→停→rm→remove→branch -d→release→deleteState，顺序正确，ok
test("F028 AC12 · happy path runs steps in order and succeeds", async () => {
  const { deps, calls } = makeDeps()
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, true)
  const names = res.steps.map((s) => s.name)
  assert.deepEqual(names, [
    "safety-gate",
    "stop-preview",
    "rm-artifacts",
    "worktree-remove",
    "branch-delete",
    "release-ports",
    "delete-state",
  ])
  assert.ok(res.steps.every((s) => s.ok))
  // rm 必须先于 git worktree remove（避免 file busy）
  const rmIdx = calls.indexOf("rm:C:/repo/.worktrees/F028")
  const removeIdx = calls.indexOf("gitMain:worktree remove C:/repo/.worktrees/F028")
  assert.ok(rmIdx > -1 && removeIdx > -1 && rmIdx < removeIdx, "rm 必须先于 worktree remove")
  assert.ok(calls.includes("gitMain:branch -d feat/F028-x"))
  assert.ok(calls.includes("audit:cleanup:true"))
})

// 主仓 → 拒，零破坏性步骤
test("F028 AC12 · main worktree blocked, no destructive ops", async () => {
  const { deps, calls } = makeDeps({ name: "main" })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, false)
  assert.equal(res.steps[0].name, "safety-gate")
  assert.equal(res.steps[0].ok, false)
  assert.ok(!calls.some((c) => c.startsWith("stop:") || c.startsWith("rm:") || c.includes("worktree remove")))
})

// 未提交工作 → 拒，零破坏性步骤
test("F028 AC12 · uncommitted work blocked, no destructive ops", async () => {
  const { deps, calls } = makeDeps({
    execGitAt: async () => " M src/foo.ts\n?? bar.ts\n", // status 非空
  })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, false)
  assert.match(res.steps.at(-1)?.message ?? "", /未提交/)
  assert.ok(!calls.some((c) => c.startsWith("stop:") || c.startsWith("rm:") || c.includes("worktree remove")))
})

// 德彪 code-r2 P1：检测到 preview 未恢复的原配置备份（.env*.backup-by-preview）→ 安全门拒，
// 零破坏性步骤（git worktree remove 非原子，不让不可再生配置进删除路径）
test("F028 AC12 · unrestored .env*.backup-by-preview blocks cleanup (non-regenerable config)", async () => {
  const { deps, calls } = makeDeps({
    listEntries: async () => ["node_modules", ".env.development.local.backup-by-preview", "src"],
  })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, false)
  assert.match(res.steps.at(-1)?.message ?? "", /原配置备份|backup-by-preview|恢复/)
  assert.ok(
    !calls.some((c) => c.startsWith("stop:") || c.startsWith("rm:") || c.includes("worktree remove")),
    "检测到不可再生备份必须在任何破坏性步骤前中止",
  )
})

// 对照（防修过头）：普通 .env.local 不阻止清理（用户已确认要删的 worktree config，随树删）
test("F028 AC12 · ordinary .env.local does NOT block cleanup", async () => {
  const { deps } = makeDeps({
    listEntries: async () => ["node_modules", ".next", ".env.local", "src"],
  })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, true, ".env.local 不该挡掉正常清理")
})

// 德彪 code-r3 P1：listEntries 读失败 → 安全门 **fail-closed** 拒，零破坏性步骤（绝不把读
// 失败伪装成"没有备份"放行）
test("F028 AC12 · listEntries failure → safety-gate fail-closed, zero destructive ops", async () => {
  const { deps, calls } = makeDeps({
    listEntries: async () => {
      throw new Error("EACCES readdir")
    },
  })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, false)
  assert.match(res.steps.at(-1)?.message ?? "", /原配置备份|无法核/)
  assert.ok(
    !calls.some((c) => c.startsWith("stop:") || c.startsWith("rm:") || c.includes("worktree remove")),
    "读不到目录必须 fail-closed 中止",
  )
})

// foreign preview（stop occupied-foreign）→ 中止，rm/remove 不跑，人话提示
test("F028 AC12 · foreign preview aborts before destructive ops", async () => {
  const { deps, calls } = makeDeps({
    stopPreview: async () => ({ ok: false, stage: "occupied-foreign", message: "x" }),
  })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, false)
  const stopStep = res.steps.find((s) => s.name === "stop-preview")
  assert.equal(stopStep?.ok, false)
  assert.match(stopStep?.message ?? "", /脱管|人工/)
  assert.ok(!calls.some((c) => c.startsWith("rm:") || c.includes("worktree remove")), "脱管必须中止破坏性操作")
})

// git worktree remove 失败 + worktree **仍注册** → 中止可重试，不删分支、不删状态
test("F028 AC12 · remove fails & still registered → abort (retryable), no branch/state", async () => {
  const { deps, calls } = makeDeps({
    execGitMain: async (args) => {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("fatal: contains untracked files")
      if (args[0] === "worktree" && args[1] === "list") return "worktree C:/repo/.worktrees/F028\n" // 仍注册
      return ""
    },
  })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, false)
  const removeStep = res.steps.find((s) => s.name === "worktree-remove")
  assert.equal(removeStep?.ok, false)
  assert.match(removeStep?.message ?? "", /仍注册|可重试/)
  // execGitMain 被 override 不记 calls（德彪 code-r4 P3：calls 断言会恒真）→ 断言 res.steps：
  // 仍注册的真失败必须在收口前中止，绝不出现 branch-delete / delete-state step。
  assert.ok(!res.steps.some((s) => s.name === "branch-delete"), "仍注册的失败禁删分支")
  assert.ok(!res.steps.some((s) => s.name === "delete-state"), "仍注册的失败禁删状态")
  assert.ok(!calls.some((c) => c.startsWith("deleteState:")), "仍注册的失败禁删状态（dep 未被调用）")
})

// 德彪 code-r3 P2：remove **抛错但已注销**（git 非原子）→ 继续收口（branch/端口/状态）+ 标残留
test("F028 AC12 · remove throws but deregistered → finalize cleanup + report residue", async () => {
  const { deps, calls } = makeDeps({
    execGitMain: async (args) => {
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("EBUSY mid-delete")
      if (args[0] === "worktree" && args[1] === "list") return "worktree C:/repo\n" // 不含 F028 = 已注销
      return ""
    },
  })
  const res = await runWorktreeCleanup(deps)
  const removeStep = res.steps.find((s) => s.name === "worktree-remove")
  assert.equal(removeStep?.ok, false)
  assert.match(removeStep?.message ?? "", /已注销|残留|人工/)
  assert.equal(res.ok, false, "有残留 → 整体 ok:false 让用户知道需人工删")
  // 但收口必须跑（防 registry/state 孤儿）；execGitMain 被 override 不记 calls，故 branch 查 steps
  assert.ok(res.steps.some((s) => s.name === "branch-delete"), "已注销 → 仍尝试删分支")
  assert.ok(calls.some((c) => c.startsWith("release:")), "已注销 → 仍释放端口")
  assert.ok(calls.some((c) => c.startsWith("deleteState:")), "已注销 → 仍清状态")
})

// branch -d 失败（未合并）→ 不中止：worktree 已删，分支保留为 residue，ok 仍 true
test("F028 AC12 · branch -d failure is non-fatal residue (worktree already removed)", async () => {
  const { deps, calls } = makeDeps({
    execGitMain: async (args) => {
      if (args[0] === "branch") throw new Error("error: branch not fully merged")
      return ""
    },
  })
  const res = await runWorktreeCleanup(deps)
  assert.equal(res.ok, true, "worktree 已删成功，分支 residue 不算失败")
  const branchStep = res.steps.find((s) => s.name === "branch-delete")
  assert.equal(branchStep?.ok, false)
  assert.match(branchStep?.message ?? "", /保留|residue|未合并|branch -D/)
  assert.ok(calls.some((c) => c.startsWith("deleteState:")), "remove 成功后仍收口状态")
})

// 德彪 code-r6 P2：registry 两 key（短名 + 全分支名，ccc7843：UI vs F024 CLI 起的 preview）
// 必须**独立** best-effort——短名 key 释放失败绝不能跳过分支名 key（否则 registry 端口泄漏）。
test("F028 AC12 · releasePorts 首 key 失败仍尝试第二 key（两 key 独立 best-effort）", async () => {
  const attempted: string[] = []
  const { deps } = makeDeps({
    releasePorts: async (n) => {
      attempted.push(n)
      if (n === "F028") throw new Error("proper-lockfile timeout") // 短名 key 释放失败
    },
  })
  const res = await runWorktreeCleanup(deps)
  // 两 key 都尝试了（短名 + 全分支名），首个抛错不跳过第二个
  assert.deepEqual(attempted, ["F028", "feat/F028-x"], "首 key 失败也必须尝试第二 key")
  const rel = res.steps.find((s) => s.name === "release-ports")
  assert.equal(rel?.ok, false, "有 key 失败 → release-ports step ok:false")
  assert.match(rel?.message ?? "", /F028/)
  // 端口释放失败是非致命尾：不影响 worktree 已删，后续 delete-state 仍跑、整体 ok 仍 true
  assert.equal(res.ok, true, "端口释放失败非致命，不翻 res.ok")
  assert.ok(res.steps.some((s) => s.name === "delete-state"), "端口失败后仍收口状态")
})
