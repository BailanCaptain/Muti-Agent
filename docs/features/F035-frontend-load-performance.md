---
id: F035
title: 前端加载性能：bundle 基线 + 代码分割（D1）
status: spec
owner: 黄仁勋
created: 2026-06-13
---

# F035 — 前端加载性能：bundle 基线 + 代码分割（D1）

> 排队中：clowder-ai 借鉴批次第 6 个（队尾）。

## Why

chat 组件全部静态导入在入口（page.tsx 直接静态导入六个顶层组件），零 `next/dynamic`。但"该不该分割、分割多少"目前没有数据——德彪 OQ1：先有 bundle 基线和预算才动手，不赌。

## What

**基线先行**：AC1 就是跑 bundle analyzer 出基线 + 定预算。数据说该分割 → 对非首屏面板（StatusPanel/DebugPanel/preview 等）做 `next/dynamic`；数据说没问题 → 提前 close，不为做而做。

## Acceptance Criteria（骨架，立项细化）

- [ ] AC1: bundle analyzer 基线报告（首屏 JS 体积 / 各 chunk 构成）+ 预算定义
- [ ] AC2: 若超预算——非首屏组件按需加载，首屏体积降幅达预算目标
- [ ] AC3: 加载性能前后对照（冷启动可量化指标）
- [ ] AC4: 若基线达标——记录结论提前 close（合法出口）

## Dependencies

- 无硬依赖。前置小 debt：D0（修 next.config.ts `ignoreBuildErrors: true`）不占 feature 号，独立 PR 先行

## Design Decisions（预置约束）

| 决策 | 结论 | 原因 |
|------|------|------|
| 立项依据 | 数据驱动，基线先行 | "36 组件全静态导入"等断言需 analyzer 证明（德彪 OQ5：subagent 行数数据曾错报，量化断言必实测） |
| D2 组件/store 重构 | **不立项** | 原依据"thread-store 2907 行"实测 695 行，前提为错数据；按真实痛点再议 |

## Evolution

- **Evolved from**: F009（全链路性能优化）
- **Related**: F012
