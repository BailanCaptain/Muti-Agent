---
id: F013
title: CI/CD 门禁 — GitHub Actions + pre-commit hook + 文档状态校验
status: in-progress
owner: 黄仁勋
created: 2026-04-14
---

# F013 — CI/CD 门禁

**Created**: 2026-04-14

## Why

三方审计发现项目**零 CI、零 pre-commit hook**。typecheck 断了一个多月、测试有 2 条红、文档状态三套真相——全都没有自动化机制拦截。每次改动都是"裸奔"，完全靠人工验证。

> 范德彪："`status` 变更必须绑定绿灯校验和文档同步，否则这轮修完还是会漂。"

三人一致选择 **[C] Hook + CI 分阶段**：先上 CI 做不可绕过的最终守门，再补本地 hook 缩短反馈回路。

### 讨论来源

- 全面排查讨论综合报告
- 分歧点决议：完成态门禁 → [C] Hook + CI 分阶段（三人一致）
- A4 架构隐忧：前端零测试 + 零 CI/CD + 零 pre-commit

## Acceptance Criteria

### Phase 1：GitHub Actions CI（半天）
- [x] AC-01: 创建 `.github/workflows/ci.yml`，push 到 dev/main 及 PR 时触发
- [x] AC-02: CI Job 1 — `pnpm typecheck`：类型检查失败则 ❌
- [x] AC-03: CI Job 2 — `pnpm test`：测试失败则 ❌
- [x] AC-04: CI Job 3 — 文档校验脚本（`check-docs.sh`）：4 项检查全过
- [x] AC-04a: CI Job 4 — `pnpm lint`：Biome 代码规范检查失败则 ❌
- [x] AC-04b: CI Job 5 — `pnpm build`：构建失败则 ❌
- [ ] AC-05: CI 在 PR 页面显示状态 badge（✅ / ❌）— push 后验证
- [ ] AC-06: 分支保护规则：dev/main 分支要求 CI 通过才能合入（如仓库权限允许）

### Phase 2：pre-commit hook（半天）
- [x] AC-07: 安装 husky + lint-staged
- [x] AC-08: pre-commit hook 执行 `pnpm typecheck`（快速拦截类型错误）
- [x] AC-09: pre-commit hook 执行文档校验脚本（`check-docs.sh`）
- [x] AC-10: hook 失败时输出清晰的错误信息和修复建议

### Phase 3：文档校验脚本（扩展版）
- [x] AC-11: 编写 `scripts/check-docs.sh`，含以下 4 项检查：
  - (a) 正文 `**Status**: xxx` 双写检测（扫描 `docs/features/*.md` 和 `docs/bugReport/*.md`）
  - (b) ROADMAP ↔ feature frontmatter `status:` 交叉校验（不一致则 ❌）
  - (c) `status: done` 的 feature 必须有 `completed:` 字段
  - (d) status 值白名单校验（仅允许 spec / in-progress / done）
  - 任一项检测失败 → 输出文件名 + 行号 + 原因，exit 1
- [x] AC-12: 脚本可在 CI 和本地 hook 中复用

### 门禁
- [ ] AC-13: push 到 dev 自动触发 CI，typecheck + test + 文档校验全过
- [ ] AC-14: 本地 commit 时 pre-commit hook 拦截 typecheck 失败
- [ ] AC-15: 故意引入类型错误，确认 CI 和 hook 都能拦截

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 门禁载体 | A: 只 hook / B: 只 CI / C: 两者 | C | hook 可被 --no-verify 绕过，CI 不可绕过但慢；两者互补 |
| CI 平台 | A: GitHub Actions / B: 自建 | A | 项目已在 GitHub，零成本接入 |
| hook 工具 | A: husky / B: simple-git-hooks / C: lefthook | A | 社区最广，文档最全 |
| 文档校验粒度 | A: 只查双写 / B: 查双写+状态值合法性 | A（先） | 先解决双写问题，合法性校验后续按需加 |

## CI Workflow 设计

```yaml
# .github/workflows/ci.yml
name: CI Gate
on:
  push:
    branches: [dev, main]
  pull_request:
    branches: [dev, main]

jobs:
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test

  doc-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/check-docs.sh

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
```

## 验证命令

```bash
# 本地验证 hook
git commit --allow-empty -m "test hook"  # 应通过（无类型错误）

# 故意破坏类型
echo "const x: number = 'oops'" >> packages/api/src/test-break.ts
git add . && git commit -m "test"  # 应被 hook 拦截
rm packages/api/src/test-break.ts

# 故意加文档双写
echo '**Status**: spec' >> docs/features/F010-baseline-greenlight.md
git add . && git commit -m "test"  # 应被 hook 拦截
git checkout -- docs/features/F010-baseline-greenlight.md

# CI 验证
git push  # 观察 GitHub Actions 页面
```

## Timeline

| 日期 | 事件 | 说明 |
|------|------|------|
| 2026-04-14 | 三方审计 | 发现零 CI/CD、零 pre-commit hook |
| 2026-04-14 | 共识达成 | 完成态门禁选 [C] Hook + CI 分阶段 |
| 2026-04-14 | F013 立项 | CI 门禁，与 F011/F012 并行 |
| 2026-04-14 | Phase 1-3 实现 | CI workflow + husky + check-docs.sh + biome 配置治理 |

## Links

- F010: 基线回绿（前置依赖 — CI 需要绿基线才有意义）

## Evolution

- **Depends on**: F010（基线回绿）
- **Parallel**: F011（后端加固）、F012（前端加固）
- **Enables**: 后续所有 Feature 的自动化验收守门
