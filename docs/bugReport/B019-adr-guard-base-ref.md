---
B-ID: B019
title: ADR-004 diff guard explicit BASE skipped merge-base
status: open
related: F026 (A2A reliability layer)
reporter: 范德彪
created: 2026-04-25
severity: P1
---

# B019 - ADR-004 diff guard explicit BASE skipped merge-base

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | Bug 现象 | GitHub Actions 路径显式传 `BASE=origin/dev` 后，脚本把 moving branch tip 当 diff 起点，而不是 feature fork point。若 dev 在 feature 分叉后也修改 prompt 文件，dev 的删除/新增可抵消 feature 的 prompt 新增，ADR-004 diff guard 漏报。 |
| 2 | 证据 | 新增回归测试 `scripts/ci/__tests__/check-adr-004-diff.test.ts` 构造 `main -> dev(+1)` 与 `main -> feat(+1)`，旧脚本输出 `AGENTS.md net 0 lines` 且 exit 0。 |
| 3 | 假设 | 根因是 `scripts/ci/check-adr-004-diff.sh` 的显式 `BASE` 分支直接 `BASE_REF="$BASE"`；fallback 分支才执行 `git merge-base <ref> HEAD`。 |
| 4 | 诊断策略 | 用临时 git repo 隔离复现，不修改当前仓库 refs；先观察 Red，再只改 `BASE` 分支。 |
| 5 | 用户可见修正 | CI 传 `BASE=origin/dev` 时仍按 fork point 计算 F026 自身 prompt diff，不被 dev 后续 churn 抵消。 |
| 6 | 复现验收 | `pnpm exec tsx --test scripts/ci/__tests__/check-adr-004-diff.test.ts` 通过；`BASE=origin/dev bash scripts/ci/check-adr-004-diff.sh` clean；`BASE=origin/main ...` 仍复现旧误报。 |

## 根因

脚本存在两套 base 解析语义：

- `BASE` 未设置：`git merge-base <candidate> HEAD`，检查 feature 自分叉以来的净新增。
- `BASE` 已设置：直接 `git diff "$BASE" HEAD`，检查相对 moving branch tip 的净差。

CI 修复 Pass 3 正好走第二条路径，因此 `origin/dev` 后续 prompt churn 可以抵消 feature 分支自己的 prompt 新增。

## 修复方案

显式 `BASE` 分支先尝试 `git merge-base "$BASE" HEAD`，成功时使用 fork point SHA；解析失败时保留原值，兼容手工传入特殊 diff 起点的旧用法。

新增回归测试覆盖最小场景：dev 和 feature 从同一 base 分叉后各自给 `AGENTS.md` 加一行，guard 必须按 merge-base 看到 feature 的 `+1` 并返回非零。

## 验证

- Red: 新增测试在旧实现下失败，输出 `AGENTS.md net 0 lines`，exit 0。
- Green: `pnpm exec tsx --test scripts/ci/__tests__/check-adr-004-diff.test.ts` -> 1/1 pass。
- Guard: `bash scripts/ci/check-adr-004-diff.sh` -> clean。
- Guard: `BASE=origin/dev bash scripts/ci/check-adr-004-diff.sh` -> clean，base 为 merge-base SHA `6ff120d...`。
- Guard: `BASE=origin/main bash scripts/ci/check-adr-004-diff.sh` -> 4 violations，保留旧误报复现路径。
- Regression: `pnpm typecheck` -> exit 0。
- Regression: `pnpm run test:api` -> 1137/1137 pass。
- Regression: `pnpm run test:components` -> 90/90 pass。
- Check: `pnpm check` -> 0 errors, 1 existing warning (`orphan-dir refs`).
