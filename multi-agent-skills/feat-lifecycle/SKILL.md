---
name: feat-lifecycle
description: 当处理新功能、bugfix、重构或需要完整推进一个开发任务时使用。用于按标准交付流程推进任务，直到完成合入。
---
## 按以下流程推进任务：

writing-plans
→ worktree
→ tdd
→ quality-gate
→ request-review
→ receive-review
→ merge-gate
→ done

## 规则：

- 没有明确计划时，先进入 `writing-plans`
- 需要隔离开发时，先进入 `worktree`
- 实现阶段默认进入 `tdd`
- 实现完成后，必须进入 `quality-gate`
- 通过质量检查后，才能进入 `request-review`
- reviewer 有反馈时，进入 `receive-review`
- reviewer 明确放行后，才能进入 `merge-gate`

## 路由：

- 新任务，且没有计划 → `writing-plans`
- 已有计划，准备开始实现 → `worktree` 或 `tdd`
- 实现完成 → `quality-gate`
- 质量检查通过 → `request-review`
- reviewer 已提出问题 → `receive-review`
- reviewer 已明确批准 → `merge-gate`

## 禁止跳过：

- `writing-plans`
- `quality-gate`
- `request-review`
- `merge-gate`

没有 reviewer 明确放行时，不允许合入。

