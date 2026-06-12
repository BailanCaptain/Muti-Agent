---
id: F034
title: SOP 谓词硬拦截·确定性边界（A2）
status: spec
owner: 黄仁勋
created: 2026-06-13
---

# F034 — SOP 谓词硬拦截·确定性边界（A2）

> 排队中：clowder-ai 借鉴批次第 5 个，Blocked by F032（吃审计数据后启动）。

## Why

F032 审计报告会暴露哪些流程违规真实高频。对其中可确定性判定的子集，把"事后报告"升级为"事前拦截"，违规根本进不了返工循环。

## What

仅在三类**确定性边界**拦截（德彪 OQ1）：
1. WorkflowSop 状态流转（stage transition 前置校验）
2. merge gate（合入前 git 状态/身份校验）
3. MCP 操作（工具调用入口校验）

**通用 provider shell/tool 拦截不在默认范围**，要做需另行论证立项。

## Acceptance Criteria（骨架，立项细化）

- [ ] AC1: 按 F032 数据选定首批拦截规则（高频 + 可确定判定）
- [ ] AC2: 三边界拦截接线，违规给出明确恢复路径提示
- [ ] AC3: 硬拦截四条件逐条留证：证据源权威 / 谓词确定 / 检查与动作同边界 / 失败有恢复路径
- [ ] AC4: 假拦截（误杀）回归测试

## Dependencies

- **Blocked by**: F032（审计数据是选规则的依据）

## Design Decisions（预置约束）

| 决策 | 结论 | 原因 |
|------|------|------|
| 拦截范围 | 仅确定性边界，不碰 shell trace | "没观测到≠没发生"，trace 可绕过 |
| 不满足四条件的规则 | 保持 unknown/manual，留在 F032 审计 | 禁伪 pass |

## Evolution

- **Evolved from**: F032
