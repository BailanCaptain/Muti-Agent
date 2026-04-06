---
name: worktree
description: >
  创建 Git worktree 隔离开发环境。
  Use when: 开始任何代码修改、新功能开发、bug fix。
  Not for: 纯文档修改（≤5 行）、不涉及代码的讨论。
  Output: 隔离的 worktree 开发环境。
---

# Worktree（隔离开发环境）

用 Git worktree 创建隔离开发环境，避免在 main 上直接修改。

## 创建 Worktree

**开工前必做**：确保 main 已同步。

```bash
# 1. 同步 main（ahead=0 behind=0）
git fetch origin
git checkout main
git rebase origin/main

# 2. 创建 worktree
git worktree add ../multi-agent-{feature} -b feat/{feature}

# 3. 进入 worktree
cd ../multi-agent-{feature}

# 4. 安装依赖（如果 worktree 是全新目录）
pnpm install
```

**命名规则**：
- 分支名：`feat/{feature-name}`（kebab-case）
- 目录名：`../multi-agent-{feature-name}`

## 硬规则

1. **创建前必须 main 同步** — `git log --oneline origin/main..main` 和 `git log --oneline main..origin/main` 都应该为空
2. **一个 feature 一个 worktree** — 不要在同一个 worktree 里做多个 feature
3. **不直接在 main 上开发** — 除非是 ≤5 行的 trivial 修改

## 清理 Worktree

**PR merge 后必做**：

```bash
# 1. 回到主仓库
cd /c/Users/-/Desktop/Multi-Agent

# 2. 更新 main
git checkout main && git pull origin main

# 3. 删除 worktree
git worktree remove ../multi-agent-{feature}

# 4. 删除分支 + 清理
git branch -d feat/{feature}
git worktree prune
```

## Common Mistakes

| 错误 | 正确 |
|------|------|
| main 没同步就开 worktree | 先 fetch + rebase |
| 忘了在 worktree 里装依赖 | 新 worktree 先跑 `pnpm install` |
| merge 后不清理 worktree | 用完必须 remove + prune |
| 在 main 上直接改代码 | 开 worktree |

## 下一步

Worktree 创建完成后 → **直接进入 `tdd`** 开始实现。
