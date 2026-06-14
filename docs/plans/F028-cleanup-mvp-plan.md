# F028 续作 · Worktree 清理 MVP 实施计划

**Feature:** F028 — `docs/features/F028-workspace-explorer-tabs.md`（续作 AC11-13）
**Goal:** Worktree 列表一眼看出可清理 + 一键清理（停 preview→删生成物→git worktree remove→branch -d→释放端口→消失），不背企业级删除装置。
**Scope:** 小孙 2026-06-13『只做必须做的』收敛。AC11（列表合并状态）+ AC12（清理）。AC13 takeover 待小孙确认不做。
**Architecture:** 复用现有 deps-注入纯模块风格；停 preview 复用 orchestrator 私有 `precheckProc`+`killAndConfirmFree`（绝不按端口杀）；清理序列单独纯模块。
**Tech:** TS / node:test（后端）/ vitest（前端）/ git plumbing。

---

## Terminal Schema（终态形态，步骤围绕它，不写临时脚手架）

```ts
// worktree-inventory.ts — 每行加合并状态（AC11）
export type MergeStatus = {
  ahead: number | null    // HEAD 独占（git rev-list --left-right --count baseRef...HEAD 右）
  behind: number | null   // baseRef 独占（左）
  mergedHint: boolean | null  // git merge-base --is-ancestor HEAD baseRef（exit 0=true）
}
export type WorktreeInventoryEntry = WorktreeRow & {
  preview: PreviewStatus | null
  mergeStatus: MergeStatus | null   // 主仓行 = null；每信号独立 try/catch 降级
}

// preview-orchestrator.ts — 加 stop（AC12 步骤②，D16）
export type PreviewOrchestrator = { /* ...现有... */ stop: (name: string) => Promise<PreviewActionResponse> }

// preview-state.ts — 加 deleteState（AC12 步骤⑥）
export type PreviewStateStore = { /* ...现有... */ deleteState: (worktreeName: string) => Promise<void> }

// worktree-cleanup.ts（新）— 清理序列（AC12）
export type CleanupStep = { name: string; ok: boolean; message?: string }
export type CleanupResult = { ok: boolean; steps: CleanupStep[] }
export function runWorktreeCleanup(deps: CleanupDeps): Promise<CleanupResult>
```

---

## Task 1: AC11 后端 — 合并状态计算（纯函数 + inventory 接线）

**Files:**
- Modify: `packages/api/src/worktrees/worktree-inventory.ts`（加 MergeStatus + buildInventory deps `mergeStatusFor`）
- Test: `packages/api/src/worktrees/worktree-inventory.test.ts`

**TDD:**
1. 写失败测试：`computeMergeStatus` — 给 fake execGit 返回 `"3\t5"` → `{behind:3, ahead:5}`（左=behind 右=ahead）；is-ancestor exit 0 → mergedHint true，exit 1 → false
2. 跑测试确认 fail（函数未定义）
3. 实现 `computeMergeStatus(execGit, baseRef)`：`rev-list --left-right --count <baseRef>...HEAD` 解析左右；`merge-base --is-ancestor HEAD <baseRef>` 用 exit code（execGit 抛=非祖先=false）；**每信号独立 try/catch**，单失败该字段 null
4. 跑测试确认 pass
5. 写失败测试：buildInventory 主仓行 mergeStatus=null；单行 git 失败不连累整列表（其它行仍出 + 该行 mergeStatus 各字段降级）；detached（branch="(detached)"）→ 降级不抛
6. 接线 buildInventory：每非主行调 `deps.mergeStatusFor(row.path)`，包 try/catch 整体降级 null
7. 跑全 inventory 测试确认 pass
8. Commit

## Task 2: AC11 前端 — 可清理标记

**Files:**
- Modify: `components/chat/right-panel/runtime-log/tabs/worktrees/use-worktrees-api.ts`（WorktreeRow 镜像 mergeStatus 可空）
- Modify: `components/chat/right-panel/runtime-log/tabs/worktrees/worktrees-tab.tsx`（每行渲染 ahead/behind + "本地 dev 已包含提交"徽标 + 可清理提示）
- Test: `worktrees-tab.test.tsx`

**TDD:** 红（断言徽标文案/ahead-behind 渲染/null 容错不崩）→ 实现 → 绿 → Commit

## Task 3: AC12 后端 — orchestrator.stop（复用预检 kill）

**Files:**
- Modify: `packages/api/src/worktrees/preview-orchestrator.ts`（加 stop：withOperation→双进程预检→killAndConfirmFree→deleteState 不在此，仅停进程）
- Test: `preview-orchestrator.test.ts`

**TDD:**
1. 红：stop — 有 api/web 记录 + listener 是后代 → 杀两个 + 返回 ok；pid 已死（probeCreationDate null）→ 幂等 ok 不抛；listener 非后代/无记录有 listener → occupied-foreign 不杀
2. 实现 stop：复用 `precheckProc`（双进程全量预检后才杀）+ `killAndConfirmFree`；记录已 null/pid 死则跳过该进程（幂等）；foreign → fail("occupied-foreign")
3. 绿 → Commit

## Task 4: AC12 后端 — 清理序列 + deleteState

**Files:**
- Create: `packages/api/src/worktrees/worktree-cleanup.ts`
- Modify: `packages/api/src/worktrees/preview-state.ts`（加 deleteState：unlink stateFile，ENOENT 幂等）
- Test: `packages/api/src/worktrees/worktree-cleanup.test.ts` + `preview-state.test.ts`

> **真相源注**：本序列在实施中经德彪 code-r1→r5 演进（数据安全边界 / git remove 非原子 / fail-closed）。**权威真相源以 feature doc 的 D15 + AC12 为准**；下方已同步为实际交付语义。

**清理序列（AC12 顺序，全 deps 注入）：**
1. 安全门：`entry` 不在 inventory → 拒；`entry.isMain` → 拒；`hasUncommitted(path)`（git status --porcelain 非空）→ 拒；**不可再生原配置保护**（德彪 code-r2 P1）：`listEntries(path)` 检出 `.env*.backup-by-preview`（preview 未恢复的用户原配置）→ 拒；`listEntries` 读失败 → **fail-closed** 拒（德彪 code-r3 P1，绝不把读失败伪装成"没备份"放行）。普通 `.env.local` 不拦。
2. stop preview（注入 `stop(name)`；返回 occupied-foreign → 中止，step ok:false message="该 preview 脱管，请人工停进程后再清理"）
3. 预删**可再生构建产物**：`rmArtifacts(path)` — **仅** `node_modules` + `.next`（避 Windows file-busy 让 remove 失败）；失败**非中止**。worktree 其余自造数据（.runtime 隔离 SQLite / .agents uploads / `.env.local` 等——小孙 2026-06-14『worktree 造的数据可删』）随后交 git worktree remove 删
4. `git worktree remove <path>`（**无 --force**；execGit 绑主仓 cwd）。**git remove 非原子**（德彪 code-r2/r3 P2）：失败后复查 `isWorktreeRegistered`——**仍注册**=真失败可**重点击重试**，中止（不删分支/状态）；**已注销**（git 抛错但已 deregister）=`removeClean=false`，继续收口（⑤⑥，防 registry/state 孤儿）+ 标"残留目录需人工删"
5. `git branch -d <branch>`（git 内建合并保护，失败/未合并→step ok:false message 标 residue，**不中止**——非失败链）
6. `releasePorts(name)` + `releasePorts(branch)`（两 key 都试，幂等）+ `store.deleteState(name)`（收口非致命尾）
7. 返回 `{ok: removeClean, steps}`（已注销但有残留→ok:false 让用户知道需人工删；前端**始终** refetch 让列表反映 git 真实状态，德彪 code-r4 P2）；`appendAudit` 尽力而为不抛

**TDD:** 逐步红→绿（安全门四拒：非 inventory/主仓/未提交/backup-by-preview + listEntries fail-closed / foreign 中止 / planArtifactRemoval 只预删 node_modules+.next / 顺序：remove 在 rm 后 / branch -d 未合并保留为 residue 非中止 / **remove 失败仍注册→中止不删分支** / **remove 已注销→继续收口+报残留** / 3 真 git 集成）→ Commit

## Task 5: AC12 后端 — 路由接线

**Files:**
- Modify: `packages/api/src/routes/worktrees.ts`（POST `/api/worktrees/:name/cleanup`，controlEnabled only，assertAllowedOrigin，inventory 解析 entry，isMain 拒，调 runWorktreeCleanup）
- Modify: 组合根 `preview-runtime.ts`（注入 cleanup deps：execGit 绑 mainRoot、rmArtifacts、releasePorts、registryPath、orchestrator.stop）
- Test: `worktrees.test.ts`

**TDD:** 红（404 非 inventory / 400 isMain / 403 错误 Origin / 200 + steps）→ 实现 → 绿 → Commit

## Task 6: AC12 前端 — 清理按钮

**Files:**
- Modify: `use-worktrees-api.ts`（cleanup action + steps 结果类型）
- Modify: `worktrees-tab.tsx`（可清理行显示「清理」+ 二次确认 + 进行中/steps 结果 + 成功后从列表移除/刷新）
- Test: `worktrees-tab.test.tsx`

**TDD:** 红（确认弹窗 / 调用 cleanup / steps 渲染 / 成功后该行消失）→ 实现 → 绿 → Commit

---

## 验收（quality-gate 自检对小孙原话）
- "列表一眼看出可清理" → AC11 徽标 + 提示（前端实操截图）
- "做完会自动消失吗" → AC12 一键清理 + 清完即时消失（前端实操截图）

## Review 节奏
plan 不单独派德彪（MVP 小 + 复用已审原语）；**德彪 code review 在全 TDD 绿 + quality-gate + acceptance-guardian 后**（高价值点：破坏性清理逻辑）。
