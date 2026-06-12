---
id: F032
title: SOP 谓词执行器·审计模式（A-审计 = A0+A1）
status: spec
owner: 黄仁勋
created: 2026-06-13
---

# F032 — SOP 谓词执行器·审计模式（A-审计）

> 排队中：clowder-ai 借鉴批次第 3 个。
> 参考：clowder-ai `sop-definitions/development.yaml` + `scripts/sop-definitions.mjs`（YAML→TS codegen）+ `packages/api/src/infrastructure/harness-eval/sop/sop-predicate-evaluator.ts`。
> ⚠ 德彪核查：clowder 该组件是**事后 harness-eval，不是 runtime 拦截器**——本 feature 同样只做审计，拦截另立 F034。

## Why

家规/manifest hard_rules 全是 prompt 级提醒靠自觉，流程性违规（commit hash 未核、reviewer=author、worktree 前 main 未同步……）反复发生，每次代价 1-3 轮返工 review。第一步先把规则变成**可执行谓词 + 违规审计报告**，用真实数据看哪些违规高频，再决定拦什么（F034）。

## What

- Phase A（原 A0）：manifest hard_rules schema 化 → codegen → 纯函数 evaluator（command_pattern / git_state_predicate / handle_check / env_check 等谓词类型），只有单测
- Phase B（原 A1）：trace/evidence adapter，对接真实 feature 流程数据，输出审计报告，结果四态 `pass / violation / unknown / manual`
- 小孙感知：每个 feature 走完流程出一份"违规清单 + 证据"报告

## Acceptance Criteria（骨架，立项细化）

- [ ] AC1: 谓词 schema + codegen + 纯 evaluator 单测全绿
- [ ] AC2: 至少 3 条现有家规成功谓词化并在历史数据上回放出正确判定
- [ ] AC3: 审计报告产出链路（每 feature 一份），四态如实输出，**unknown 不准伪装 pass**
- [ ] AC4: 误报率验证——对照人工判定抽查

## Dependencies

- 无硬依赖；manifest.yaml sop_navigation 骨架已存在

## Design Decisions（预置约束，德彪 OQ4）

| 决策 | 结论 | 原因 |
|------|------|------|
| 模式 | 只审计不拦截 | "没观测到 ≠ 没发生"：bypassPermissions/yolo 下工具事件执行后解析，trace 可被别名/脚本/MCP 绕过 |
| 结果语义 | pass/violation/unknown/manual 四态 | 观测不完整必须显式 unknown，禁伪 pass |

## Evolution

- **Evolved from**: F019（Skill 告示牌 / WorkflowSop 状态机）
- **Blocks**: F034（硬拦截吃本 feature 的审计数据）
