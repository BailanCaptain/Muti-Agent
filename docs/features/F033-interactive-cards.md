---
id: F033
title: 交互卡片：select/confirm 选择块（C2）
status: spec
owner: 黄仁勋
created: 2026-06-13
---

# F033 — 交互卡片：select/confirm 选择块（C2）

> 排队中：clowder-ai 借鉴批次第 4 个，Blocked by F030。
> 参考：clowder-ai `docs/features/F096-interactive-rich-blocks.md`（含 Post-ship Lessons：单选也要确认步骤、confirm 消息必须带上下文、IME isComposing 守卫）。

## Why

agent 要小孙做选择目前只能纯文字问答，决策散在 thread 里事后难找。交互卡片让"选方案/确认操作"变成持久化的可点击块，选完留痕。

## What

- 在 F030 协议上新增 interactive kind：select / multi-select / confirm
- 与现有 `request_decision`（decision-card.tsx / decision-manager.ts）的关系在 Design Gate 厘清：可能是 decision card 的渲染升级，而非平行新系统
- groupId 表单**已砍**（YAGNI，德彪 OQ3）

## Acceptance Criteria（骨架，立项细化）

- [ ] AC1: select/confirm 交互块渲染 + 选择回传
- [ ] AC2: 选择后块 disabled + 选择结果持久化（刷新不丢）
- [ ] AC3: confirm 回传消息自带上下文（clowder B2 教训）
- [ ] AC4: 中文 IME 输入不误提交（clowder B3 教训）

## Dependencies

- **Blocked by**: F030（协议基础）

## Design Decisions（预置约束，德彪 OQ1-3 否决项）

| 决策 | 结论 | 原因 |
|------|------|------|
| 响应通道 | **禁照抄 clowder "选择=发普通文字"**，必须保留结构化 decision.respond | 我们 request_decision 阻塞等结构化响应（message-service.ts:3214），纯文字会挂死 MCP promise；普通消息只做审计副本 |
| groupId 表单 | 砍 | YAGNI |
| 与 F020 关系 | 立项时小孙决定合并还是独立 | F020 决策卡片挂载矩阵高度相关 |

## Evolution

- **Evolved from**: F030
- **Related**: F020、F002（Decision Board）
