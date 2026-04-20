---
id: F025
title: 前端单测基础设施 — vitest + @testing-library/react + happy-dom
status: spec
owner: 黄仁勋
created: 2026-04-20
---

# F025 — 前端单测基础设施

**Created**: 2026-04-20

## Why

当前 repo **前端零单测基础设施**：

- `components/` 下 26 个 `.tsx`，**0 个 `.test.tsx`**
- `pnpm test` 只扫 `packages/**/*.test.ts` 和 `scripts/**/*.test.ts`（`tsx --test`），前端组件完全跳过
- 历史上发生过 F010「基线回绿 + P0 止血」级别的回归事故，前端侧无自动化保护

F021（右侧面板重设计）写 plan 时假设"前端能 TDD"，动手前发现根基缺失：
- 若混在 F021 里顺手把框架搭了 → diff 信号噪声爆炸、review 风险扩散到合 dev
- 若前端这轮不加测试 → Task 1.1~2.7 全靠人眼 + TypeScript 兜底，后续 F012/F017/F020/F022 都会重复承受这个风险

> 小孙（2026-04-20）："我觉得可以，先 F025。"

### Roadmap 验证

未来纯前端重度 feature ≥ 5 个：F012（前端加固）/ F017（sidebar 运行指示）/ F020（决策卡片矩阵）/ F021（本文触发者）/ F022（左侧 sidebar）。前端单测框架是**公共地基**，不是一次性投入。

## What

给 repo 补前端组件单测能力，**与现有 `tsx --test` 后端测试并存但互不干扰**：

1. 引入 **vitest + @testing-library/react + happy-dom**
2. 新增 `vitest.config.ts`（只扫 `components/**/*.test.{ts,tsx}`）
3. 新增 `pnpm test:components` 脚本；`pnpm test` 顶层聚合两个命令（后端 tsx --test + 前端 vitest）
4. 提供一个**示例 demo 测试**证明 pipeline 跑通（建议：给 `components/chat/status-panel.tsx` 写一个最小快照类测试，或新建一个 trivial 子组件作为 sample）
5. 配套文档：在 `multi-agent-skills/refs/` 或 feature doc 里给一段"如何写组件测试"速查

### 不做什么（YAGNI）

- **不** 把现有 `tsx --test` 迁到 vitest（双框架并存接受；迁移是 F025 下游可选 follow-up，不是 F025 的 AC）
- **不** 引入 E2E（playwright 等）— 已有 `pnpm worktree:preview` 人眼 + F024 L1/L2 覆盖 e2e 场景
- **不** 引入 visual regression（截图 diff）— 交给 F024 / 人眼验收
- **不** 为现有 26 个组件补测试 — 那是下游 feature 增量做

## Acceptance Criteria

- [ ] AC-01：`pnpm test:components` 命令存在、跑 vitest、扫 `components/**/*.test.{ts,tsx}`
- [ ] AC-02：根目录 `pnpm test` 聚合跑后端（tsx --test）+ 前端（vitest），全绿
- [ ] AC-03：存在至少 1 个真实前端组件测试文件，断言 DOM 渲染（非占位符），通过
- [ ] AC-04：`pnpm type-check` / `pnpm lint` 对 `.test.tsx` 也生效，不报错
- [ ] AC-05：CI（若 F013 已接入）在 PR 上自动跑 `pnpm test`，前端测试纳入门禁
- [ ] AC-06：`multi-agent-skills/refs/` 或 feature doc 补一段最短的「前端组件测试怎么写」速查（import 路径、happy-dom 断言示例、常见坑）
- [ ] AC-07：不影响现有后端测试（`packages/**/*.test.ts` 仍由 tsx --test 跑，0 回归）
- [ ] AC-08：示例测试能捕获一个真实的假阳性（故意改坏组件 → 测试挂 → 确认保护有效）

## Dependencies

- 无硬依赖（F024 已落地，与本 feature 并行兼容；CI 集成 AC-05 依赖 F013，但 F013 已完成）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 测试 runner | vitest / jest / node:test + 自己配 JSX transform | **vitest** | Vite 生态标准、ESM 原生、HMR 测试、社区主流；Next.js App Router 项目事实默认 |
| DOM 实现 | jsdom / happy-dom | **happy-dom** | 启动 2-3× 于 jsdom、内存占用更低；React 19 兼容；缺失 API（极少数场景）出现时再按需切回 jsdom |
| 组件断言库 | @testing-library/react / enzyme | **@testing-library/react** | React 19 官方推荐、测试行为不测实现细节、无维护状态差 |
| 和现有 `tsx --test` 关系 | 统一迁到 vitest / 并存 | **并存**（F025 scope）+ 迁移作为可选下游 | 迁移 scope 爆炸（packages/ + scripts/ 所有测试要改）；并存仅增一个命令层聚合 |
| 测试文件位置 | `__tests__/` 目录 / 同目录 `.test.tsx` | **同目录 `.test.tsx`** | 和现有后端 `.test.ts` 位置惯例一致、review 时 diff 连续 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-20 | Kickoff（F021 动手前发现基础设施缺失，拆出独立 infra feature）|

## Links

- Plan: `docs/plans/F025-frontend-unit-test-infra-plan.md`
- Blocks: [F021](F021-right-panel-redesign.md) — F021 TDD plan 依赖 F025 落地

## Evolution

- **Evolved from**: 无（F021 立项后发现的基础设施缺口，新起独立 feature）
- **Blocks**: F021（F021 Task 1.1~2.7 原 TDD 节奏需要本 feature 先落地）
- **Related**: F012 / F017 / F020 / F022（都是前端重度 feature，F025 落地后受益）；F024（Worktree 验收基础设施，互补不重叠：F024 管 L1/L2 人眼 + 集成验收，F025 管单元级保护）；F013（CI 门禁，F025 AC-05 依赖其已落地的 Actions pipeline）
