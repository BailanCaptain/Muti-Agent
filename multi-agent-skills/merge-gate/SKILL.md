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

### 门禁 5 硬条件（全部满足才能开 PR）

1. Reviewer 有**明确放行信号**（"放行"/"LGTM"/"通过"/"可以合入"/"Approved"）
2. **所有 P1/P2** 已修复且经 reviewer 确认
3. Review 针对**当前分支/当前工作**（不是历史 review）
4. Feature doc 涉及的 AC 已打勾
5. **全量测试绿灯**（基于最新 `origin/dev` rebase 后）

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

# 5. 更新本地 + 清理
git checkout dev && git pull origin dev
git worktree remove ../multi-agent-{feature}  # 如果用了 worktree
git branch -d feat/{feature-name}
git worktree prune
```

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
| Merge 后不清理 worktree | 必须 remove + prune |
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
