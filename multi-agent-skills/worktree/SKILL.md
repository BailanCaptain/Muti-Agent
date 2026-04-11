---
name: worktree
description: >
  创建 Git worktree 隔离开发环境。
  Use when: 开始任何代码修改、新功能开发、bug fix。
  Not for: 纯文档修改（≤5 行）、不涉及代码的讨论。
  Output: 隔离的 worktree 开发环境。
triggers:
  - "开始开发"
  - "新 worktree"
  - "开 worktree"
---

# Worktree（隔离开发环境）

用 Git worktree 创建隔离开发环境，避免在 dev 上直接修改。

## 开工前 Recall 🔴

**创建 worktree 前，先搜相关上下文**（防重复造轮子）：

```bash
# 搜现有 feature / 历史讨论
grep -ri "{关键词}" docs/features/ docs/ROADMAP.md
```

同时通过 `search-memories("{关键词}")` 查找历史讨论中的相关信息。

## 创建 Worktree

### Step 0: Dev 同步检查（不可跳过）🔴

```bash
# 1. 拉取最新
git fetch origin

# 2. 检查 dev 是否和 remote 同步
git log --oneline origin/dev..dev   # 应该为空（不 ahead）
git log --oneline dev..origin/dev   # 应该为空（不 behind）

# 3. 如果不同步
git checkout dev
git rebase origin/dev
```

**ahead=0 behind=0 才能继续。** 旧 base 开 worktree = 合入时冲突地狱。

### Step 1: 创建

```bash
# 创建 worktree + feature 分支
git worktree add ../multi-agent-{feature} -b feat/{feature}

# 进入 worktree
cd ../multi-agent-{feature}

# 安装依赖
pnpm install
```

### 命名规则

- 分支名：`feat/{feature-name}`（kebab-case）
- 目录名：`../multi-agent-{feature-name}`
- Bug fix：`fix/{bug-name}`

## 硬规则

1. **创建前必须 dev 同步** — ahead=0 behind=0
2. **一个 feature 一个 worktree** — 不要在同一个 worktree 里做多个 feature
3. **不直接在 dev 上开发** — 除非是 ≤5 行的 trivial 修改
4. **不改主仓库** — worktree 里的改动只在 worktree 目录中，主仓库保持干净

## 安全核查清单

创建完毕后过一遍：

```
- [ ] dev 已同步（ahead=0 behind=0）
- [ ] 分支名符合 feat/{name} 规范
- [ ] pnpm install 成功
- [ ] git status 干净（worktree 内）
- [ ] 确认 cwd 是 worktree 目录（不是主仓库）
```

## 清理 Worktree

**PR merge 后必做**：

```bash
# 1. 回到主仓库
cd /c/Users/-/Desktop/Multi-Agent

# 2. 更新 dev
git checkout dev && git pull origin dev

# 3. 删除 worktree
git worktree remove ../multi-agent-{feature}

# 4. 删除分支 + 清理
git branch -d feat/{feature}
git worktree prune
```

## Common Mistakes

| 错误 | 正确 |
|------|------|
| dev 没同步就开 worktree | 先 fetch + rebase，确认 ahead=0 behind=0 |
| 忘了在 worktree 里装依赖 | 新 worktree 先跑 `pnpm install` |
| merge 后不清理 worktree | 用完必须 remove + prune |
| 在 dev 上直接改代码 | 开 worktree |
| 在主仓库目录改代码以为是 worktree | 检查 `pwd`，确认在 `../multi-agent-{feature}` 下 |
| 不搜历史直接开始 | 先 Recall 搜相关 feature 和讨论 |

## 下一步

Worktree 创建完成后 → **直接进入 `tdd`** 开始实现。
