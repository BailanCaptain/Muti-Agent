import assert from "node:assert/strict"
import { test } from "node:test"

import { buildWorktreeSummary, parseDiffShortstat, parseStatusPorcelain } from "./worktree-summary"

/** F028 Task 6 · 进展摘要（plan v5 用例 1-4，execGit 注入） */

const LOG_OUT = [
  "abc1234\x1f编排器落地\x1f2026-06-11T06:00:00+08:00",
  "def5678\x1f安全原语九连\x1f2026-06-11T05:00:00+08:00",
].join("\n")

// (2) shortstat 解析
test("F028 T6 · parseDiffShortstat parses triple and empty output", () => {
  assert.deepEqual(parseDiffShortstat(" 12 files changed, 840 insertions(+), 120 deletions(-)"), {
    files: 12,
    insertions: 840,
    deletions: 120,
  })
  assert.deepEqual(parseDiffShortstat(" 1 file changed, 2 insertions(+)"), {
    files: 1,
    insertions: 2,
    deletions: 0,
  })
  assert.deepEqual(parseDiffShortstat(""), { files: 0, insertions: 0, deletions: 0 })
})

// (3) status --porcelain 三计数；同行双列各计一次
test("F028 T6 · parseStatusPorcelain counts staged/unstaged/untracked", () => {
  const out = [
    "M  staged-only.ts",      // staged
    " M unstaged-only.ts",    // unstaged
    "MM both.ts",             // staged+unstaged 各计一次
    "A  added.ts",            // staged
    "?? new-file.ts",         // untracked
    "?? another.md",          // untracked
  ].join("\n")
  assert.deepEqual(parseStatusPorcelain(out), { staged: 3, unstaged: 2, untracked: 2 })
  assert.deepEqual(parseStatusPorcelain(""), { staged: 0, unstaged: 0, untracked: 0 })
})

// (1)(2) buildWorktreeSummary 组装
test("F028 T6 · buildWorktreeSummary assembles commits, merge-base diffstat, working counts", async () => {
  const gitCalls: string[][] = []
  const summary = await buildWorktreeSummary({
    worktreePath: "C:/repo/.worktrees/F028",
    baseRef: "dev",
    execGit: async (args) => {
      gitCalls.push(args)
      const key = args.join(" ")
      if (key.startsWith("log")) return LOG_OUT
      if (key.startsWith("merge-base")) return "base1234\n"
      if (key.startsWith("diff")) return " 3 files changed, 10 insertions(+), 2 deletions(-)"
      if (key.startsWith("status")) return "?? x.ts"
      if (key.startsWith("rev-parse")) return "headabcd\n"
      if (key.startsWith("branch") || key.includes("abbrev-ref")) return "feat/F028\n"
      return ""
    },
  })
  assert.ok(!("error" in summary))
  if ("error" in summary) return
  assert.equal(summary.commits.length, 2)
  assert.deepEqual(summary.commits[0], {
    hash: "abc1234",
    subject: "编排器落地",
    date: "2026-06-11T06:00:00+08:00",
  })
  assert.equal(summary.diffStat.baseRef, "dev")
  assert.deepEqual(
    { f: summary.diffStat.files, i: summary.diffStat.insertions, d: summary.diffStat.deletions },
    { f: 3, i: 10, d: 2 },
  )
  assert.deepEqual(summary.working, { staged: 0, unstaged: 0, untracked: 1 })
  // diff 必须以 merge-base 结果为基（不是裸 dev）
  const diffCall = gitCalls.find((c) => c[0] === "diff")
  assert.ok(diffCall?.some((a) => a.includes("base1234")))
})

// (4) git 报错 → 结构化 error
test("F028 T6 · buildWorktreeSummary returns structured error on git failure", async () => {
  const summary = await buildWorktreeSummary({
    worktreePath: "C:/repo/.worktrees/F028",
    baseRef: "dev",
    execGit: async () => {
      throw new Error("fatal: not a git repository")
    },
  })
  assert.ok("error" in summary)
  if ("error" in summary) assert.match(summary.error, /not a git repository/)
})
