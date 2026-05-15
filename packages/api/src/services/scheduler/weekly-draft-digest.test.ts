/**
 * F027 P19.10 · WeeklyDraftDigest 测试 — AC-P2-12
 *
 * 覆盖：
 *   - classifyDraftPath: user-drop / subdir / non-draft
 *   - **AC-P2-12 核心：混合 5 user-drop + 4 类子目录 draft fixture**
 *     → digest 只含 5 user-drop，4 类子目录全不推
 *   - pushDigest 回调被调 + throw 不打断
 *   - 空 draft 集 → 空 digest
 *   - 无 pushDigest（dry-run）→ digest 仍返回
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  type DraftDigest,
  type DraftEntry,
  WeeklyDraftDigest,
  classifyDraftPath,
} from "./weekly-draft-digest"

// ── classifyDraftPath ───────────────────────────────────────────────────

test("WeeklyDraftDigest · classifyDraftPath: user-drop 顶层文件", () => {
  assert.equal(classifyDraftPath("wiki/concepts/draft/2026-05-09-rag.md"), "user-drop")
  assert.equal(classifyDraftPath("wiki/concepts/draft/foo.md"), "user-drop")
})

test("WeeklyDraftDigest · classifyDraftPath: 4 类子目录 = subdir", () => {
  assert.equal(classifyDraftPath("wiki/concepts/draft/_auto/x.md"), "subdir")
  assert.equal(classifyDraftPath("wiki/concepts/draft/_backfill/x.md"), "subdir")
  assert.equal(classifyDraftPath("wiki/concepts/draft/_quarantined/x.md"), "subdir")
  assert.equal(classifyDraftPath("wiki/concepts/draft/_expired/x.md"), "subdir")
})

test("WeeklyDraftDigest · classifyDraftPath: 非 draft 路径 = non-draft", () => {
  assert.equal(classifyDraftPath("wiki/concepts/finalized.md"), "non-draft")
  assert.equal(classifyDraftPath("docs/features/F999.md"), "non-draft")
})

test("WeeklyDraftDigest · classifyDraftPath: Windows backslash 归一", () => {
  assert.equal(classifyDraftPath("wiki\\concepts\\draft\\foo.md"), "user-drop")
  assert.equal(classifyDraftPath("wiki\\concepts\\draft\\_auto\\x.md"), "subdir")
})

// ── AC-P2-12 核心：混合 5+4 fixture ─────────────────────────────────────

test("WeeklyDraftDigest · AC-P2-12: 混合 5 user-drop + 4 类子目录 → digest 只含 5", async () => {
  const drafts: DraftEntry[] = [
    // 5 user-drop 顶层
    { path: "wiki/concepts/draft/2026-05-01-a.md", title: "Draft A" },
    { path: "wiki/concepts/draft/2026-05-02-b.md", title: "Draft B" },
    { path: "wiki/concepts/draft/2026-05-03-c.md", title: "Draft C" },
    { path: "wiki/concepts/draft/2026-05-04-d.md", title: "Draft D" },
    { path: "wiki/concepts/draft/2026-05-05-e.md", title: "Draft E" },
    // 4 类子目录 draft（不推）
    { path: "wiki/concepts/draft/_auto/auto-1.md" },
    { path: "wiki/concepts/draft/_backfill/bf-1.md" },
    { path: "wiki/concepts/draft/_quarantined/sus-1.md" },
    { path: "wiki/concepts/draft/_expired/old-1.md" },
  ]
  const pushed: DraftDigest[] = []
  const digester = new WeeklyDraftDigest({
    scanDrafts: async () => drafts,
    pushDigest: async (d) => {
      pushed.push(d)
    },
  })
  const digest = await digester.run()

  assert.equal(digest.userDropDrafts.length, 5, "只 5 个 user-drop 进 digest")
  assert.equal(digest.skippedSubdirDrafts, 4, "4 类子目录 draft 全跳过")
  assert.equal(digest.skippedNonDraft, 0)
  assert.deepEqual(
    digest.userDropDrafts.map((d) => d.title).sort(),
    ["Draft A", "Draft B", "Draft C", "Draft D", "Draft E"],
  )
  // push 收到同一 digest
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].userDropDrafts.length, 5)
})

test("WeeklyDraftDigest · 全是子目录 draft → digest userDropDrafts 空", async () => {
  const digester = new WeeklyDraftDigest({
    scanDrafts: async () => [
      { path: "wiki/concepts/draft/_auto/x.md" },
      { path: "wiki/concepts/draft/_expired/y.md" },
    ],
  })
  const digest = await digester.run()
  assert.equal(digest.userDropDrafts.length, 0)
  assert.equal(digest.skippedSubdirDrafts, 2)
})

test("WeeklyDraftDigest · 空 draft 集 → 空 digest", async () => {
  const digester = new WeeklyDraftDigest({ scanDrafts: async () => [] })
  const digest = await digester.run()
  assert.equal(digest.userDropDrafts.length, 0)
  assert.equal(digest.skippedSubdirDrafts, 0)
  assert.equal(digest.skippedNonDraft, 0)
  assert.match(digest.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test("WeeklyDraftDigest · 防御: scanDrafts 误返非 draft 路径 → 记 skippedNonDraft", async () => {
  const digester = new WeeklyDraftDigest({
    scanDrafts: async () => [
      { path: "wiki/concepts/draft/real.md" },
      { path: "wiki/concepts/finalized.md" }, // 非 draft
    ],
  })
  const digest = await digester.run()
  assert.equal(digest.userDropDrafts.length, 1)
  assert.equal(digest.skippedNonDraft, 1)
})

// ── pushDigest 回调 ─────────────────────────────────────────────────────

test("WeeklyDraftDigest · 无 pushDigest（dry-run）→ digest 仍返回", async () => {
  const digester = new WeeklyDraftDigest({
    scanDrafts: async () => [{ path: "wiki/concepts/draft/x.md" }],
    // 不注入 pushDigest
  })
  const digest = await digester.run()
  assert.equal(digest.userDropDrafts.length, 1)
})

test("WeeklyDraftDigest · pushDigest throw → 不打断 run() 返回 digest", async () => {
  const digester = new WeeklyDraftDigest({
    scanDrafts: async () => [{ path: "wiki/concepts/draft/x.md" }],
    pushDigest: async () => {
      throw new Error("R-201 push failed")
    },
  })
  const digest = await digester.run()
  assert.ok(digest)
  assert.equal(digest.userDropDrafts.length, 1)
})

test("WeeklyDraftDigest · clock 注入反映在 generatedAt", async () => {
  const fixed = new Date("2026-05-18T09:00:00.000Z")
  const digester = new WeeklyDraftDigest({
    scanDrafts: async () => [],
    clock: () => fixed,
  })
  const digest = await digester.run()
  assert.equal(digest.generatedAt, "2026-05-18T09:00:00.000Z")
})
