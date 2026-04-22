---
name: merge-gate
description: >
  合入 dev 的完整流程：门禁检查 → PR → squash merge → Phase 文档同步 → 清理。
  Use when: reviewer 放行后准备合入、开 PR、准备 merge。
  Not for: 开发中、review 未通过、自检未完成。
  Output: PR merged + worktree cleaned。
---

# Merge Gate

合入 dev 的完整流程：门禁检查 → PR → squash merge → 清理。

## 铁律：1 feature = 1 commit 🔴

合入目标分支后，一个 feature（kickoff / design / plan / 实现 / 完工 docs 全部）
在 git log 里**只是一个 commit**。TDD per-green-step commit 是开发期间的安全网，
合入前必须整合。独立目的的改动（如夹带的 bug fix）分开保留。

**gh 不可用时的本地 squash**：

```bash
git checkout {feature}
git reset --soft {base}      # base = feature 第一个 commit 的父
git commit -m "feat(Fxxx): …"
git checkout {target}
git merge --ff-only {feature}
```

`git merge --ff-only` 单独用是错的，必须配 soft reset。

**已经误推的 atomic 历史**：`reset --hard` 丢掉顶层要保留的 commit → `reset --soft`
回到 base → 单 commit → `cherry-pick` 顶层 commit 回来 → `git push --force-with-lease`。
只在自己主导的 feature/dev 分支做，dev/release 永远不碰。

## 核心知识

### 门禁 6 硬条件（全部满足才能开 PR）

1. Reviewer 有**明确放行信号**（"放行"/"LGTM"/"通过"/"可以合入"/"Approved"）
2. **所有 P1/P2** 已修复且经 reviewer 确认
3. Review 针对**当前分支/当前工作**（不是历史 review）
4. Feature doc 涉及的 AC 已打勾
5. **全量测试绿灯**（基于最新 `origin/dev` rebase 后）
6. **验收证据硬门（F024 · 严解）**：
   - 单 feature merge 前必须存在 `{current-worktree}/.agents/acceptance/{feature-id}/*/worktree-report.md`
   - 多 feature 协同 merge（staging worktree）前必须存在 `{staging-worktree}/.agents/acceptance/{stagingId}/*/integration-report.md`
   - 报告内必须带 manifest 三元组（`featureId` / `commitSha` / `visionVersion`）
   - 报告不进 git（已被 `.gitignore`），本门校验走 **FS 路径**而非 `git log`；worktree 清理前完成校验

### 合入前全量验证

```bash
# 1. 同步 dev
git fetch origin
git rebase origin/dev

# 2. 全量验证
pnpm test                              # 全部通过
pnpm --filter @multi-agent/shared build # shared 包构建
pnpm --filter @multi-agent/api build    # API 包构建

# 全绿才能继续。任一步骤失败 → 修复后重跑
```

**为什么需要这一步**：quality-gate 和 review 跑的测试基于旧 base SHA。并行开发中，其他人的 PR 合入 dev 后可能改变共享契约，导致你的代码在新 dev 上 break。

### 合入方式（唯一正确做法）

```bash
# 1. Push feature branch
git push origin feat/{feature-name}

# 2. 开 PR
gh pr create --title "feat(Fxxx): {description}" --body "$(cat <<'EOF'
## Summary
- {变更描述}

## Feature
- Spec: docs/features/Fxxx-name.md
- AC covered: {列出覆盖的 AC 编号}

## Test plan
- [ ] pnpm test 全部通过
- [ ] 手动验证关键场景

## Review
- Reviewer: {reviewer 名}
- 放行信号: {引用放行原文}
EOF
)"

# 3. Squash merge（GitHub 处理）
gh pr merge {PR_NUMBER} --squash --delete-branch

# 4. Phase 文档同步（见下方）

# 5. 合入后：停 preview → 副产物清理 → 切 dev → Worktree 物理删除（见下方）
```

## 合入后清理流程

**按 F024 Design Decisions**：验收证据（`.agents/acceptance/` 下截图/日志/报告）只留 worktree 本地，不进 git；worktree 被 `git worktree remove` 后证据随之消失。**如需长期归档由人工显式复制到主仓外**，走人工操作，不是自动流程。

### 5a-0. 先停 preview 进程（必做前置）

合入前 reviewer 可能还在跑 L1 preview，节点进程会占住 `node_modules/` 和端口。必须先停 preview，否则 5a 的 `rm -rf node_modules` 会失败 / 5c 的 `git worktree remove` 会报 file busy。

**正常停法**（启动 preview 的终端还在）：在该终端按 `Ctrl+C`，SIGINT handler 会自动跑 `releasePorts` + `restoreDotenv`。

**兜底**（终端已关 / 进程孤儿化）：
```bash
# 查 worktree 占用的端口（主仓）
cat .worktree-ports.json
# 按端口找 PID 并杀（Windows git-bash）
netstat -ano | grep LISTEN | grep :{API_PORT}
taskkill //F //PID {pid}
# 孤儿化会留 .env*.backup-by-preview 和 .worktree-ports.json 残留，由 5a 补清
```

**深度兜底**（netstat 查不到 LISTEN 但 `rm` / `git worktree remove` 仍报 file busy）：
孤儿 `tsx watch` 可能 HTTP server 已挂但 node 进程仍持 SQLite file handle；此时 `netstat` 无 LISTEN、`taskkill` 查不到端口。
走 CommandLine 过滤找 PID（Windows PowerShell）：
```powershell
Get-WmiObject Win32_Process -Filter "Name='node.exe'" `
  | Where-Object { $_.CommandLine -like '*{worktree-name}*' } `
  | Select-Object ProcessId,CommandLine
# 拿到 PID 后 taskkill //F //PID {pid}
```
**Why**：worktree preview 的 tsx watch 子进程在父进程异常退出时可能孤儿化，HTTP server 已失效但 file handle 仍占；只用 netstat 找不出来。**2026-04-22 F012 AC-20 合入时实战踩过**（3 个 tsx watch PID 全靠 WMI CommandLine 过滤才定位）。

**TD（preview 脚本根治）**：`scripts/worktree-preview.ts` 的 SIGINT handler 当前未正确 cascade 到 tsx watch 子进程，应补 `child.kill('SIGTERM')` + 等待 exit。

### 5a. 副产物清理（必做）

`git worktree remove` 遇到 untracked/modified 文件会拒绝，必须先清。**禁用 `--force`**——`.runtime/uploads` 可能含持久化数据，`--force` 会静默销毁，违反数据神圣铁律。

```bash
cd ../multi-agent-{feature}
rm -rf node_modules
rm -rf .runtime/uploads .runtime/runtime-events
rm -f .env*.backup-by-preview          # preview 异常退出残留（TD：preview 脚本根治）
# .agents/acceptance/ 里证据按策略 B 随 worktree 一起 remove 消失；如需长期归档先人工复制到主仓外
```

### 5b. 切回主仓 dev 并同步

```bash
cd /c/Users/-/Desktop/Multi-Agent
git checkout dev && git pull origin dev
```

### 5c. Worktree 物理删除 + 分支清理

调用 `worktree` skill 的「清理 Worktree · 物理删除」章节（单一真相源，本 skill 不再重复命令）。

## Phase 文档同步（每次 merge 必做）🔴

**为什么在 merge-gate 而不是 feat-lifecycle close**：一个 Feature 可能拆多个 Phase/PR，等 close 才更新文档会导致中间所有 session 读到过时状态。

**流程**：

1. **识别 Feature**：从 PR title/branch name 提取 `F{NNN}`
   - 没有 Feature ID → 跳过（纯 TD/hotfix 不需要）

2. **更新 feature doc** `docs/features/F{NNN}-*.md`：
   - **AC 打勾**：本 PR 实际完成的 AC 项 `[ ]` → `[x]`
   - **Timeline**：加一行 `| {YYYY-MM-DD} | PR #{N} merged |`
   - **Status 行**：如果是第一个 PR，`spec` → `in-progress`

3. **Commit**：`docs(F{NNN}): sync progress after PR #{N} merge [签名]`
   - 这是文档同步，不需要走 review

**检查清单**：
- [ ] 相关 AC 打勾
- [ ] Timeline 有 merge 记录
- [ ] Status 行与实际进度一致

## Quick Reference

| 条件 | 检查方式 |
|------|---------|
| Reviewer 放行？ | 搜索明确信号词 |
| P1/P2 清零？ | 检查 review 记录 |
| Feature doc 更新？ | AC 打勾 + Timeline |
| 全量测试？ | rebase 后 `pnpm test` 全绿 |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 没有 reviewer 放行就合入 | 必须有明确放行信号 |
| `git merge --ff-only` 当 squash 用 | FF 会原样带入 atomic 历史，必须配 soft reset |
| 一个 feature 在 dev 留下 N 个 atomic commit | 合入前 squash 成 1 个（含 kickoff/design/plan docs） |
| 本地 merge 后 `gh pr close` | `close` = 放弃，`merge` = 合入 |
| Merge 后不更新 feature doc | Phase 文档同步每次 merge 必做 |
| Merge 后不清理 worktree | 按 5a-0 → 5a → 5b → 5c 顺序完成 |
| 清 worktree 前没先停 preview 进程 | node_modules/端口被占，rm 和 worktree remove 会失败；先按 5a-0 Ctrl+C 或 taskkill |
| `git worktree remove --force` 绕过未清副产物 | force 会静默销毁 `.runtime/uploads` 等数据，违反数据神圣铁律；先跑 5a |
| 把 `.agents/acceptance/` 拷进 git 当归档 | F024 Design Decisions 选 B：不进 git；长期归档由人工复制到主仓外 |
| 修了 P1 不通知 reviewer | 修完后 @ reviewer 确认 |
| 历史重写用 `git push --force` | 用 `--force-with-lease`；只在自己主导的分支上做 |

## 和其他 skill 的区别

| Skill | 关注点 | 时机 |
|-------|--------|------|
| `quality-gate` | 自检（spec 对照 + 证据） | review 之前 |
| `requesting-review` / `receiving-review` | review 循环 | merge 之前 |
| **merge-gate（本 skill）** | 合入全流程 | review 通过后 |

## 下一步

合入后 → 判断 Feature 规模：

**最后一个 PR（或小 Feature）** → **进入 `feat-lifecycle` completion**：
1. 愿景三问
2. 跨 agent 验证
3. 文档闭环 + close

**中间 PR（大 Feature）** → Phase 文档同步已做 + 主动和小孙碰头：
1. 成果展示
2. 愿景进度
3. 下个 Phase 方向
4. "方向对吗？" → 小孙确认 → 继续下一个 Phase
