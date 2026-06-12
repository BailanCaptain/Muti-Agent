---
id: F030
title: Rich Blocks 只读卡片协议（C1）
status: spec
owner: 黄仁勋
created: 2026-06-13
---

# F030 — Rich Blocks 只读卡片协议（C1）

> clowder-ai 借鉴批次（F030-F035）第 1 个。调研对照 + 德彪 codex 讨论一轮定边界，小孙拍"界面体验优先"。
> 参考实现：`C:\Users\-\Desktop\cafe-multi-agent\clowder-ai`（docs/features/F022-rich-blocks.md、F096、cat-cafe-skills/rich-messaging/SKILL.md）。

## Why

review 结论、AC 清单、evidence 摘要现在全是长 Markdown 砌墙，小孙在长 thread 里要自己挖关键状态（"过没过？几个 P1？"）。clowder-ai 的声明式卡片协议验证了：agent 发一段小 JSON → 前端渲染成带语义色的结构化卡片，扫一眼即得状态。

我们已有雏形（F012 引入 `lib/blocks.ts` CardBlock/DiffBlock + `block-renderer.tsx`），但**缺 agent 侧的发送协议和使用指引**——卡片能力存在，三个 agent 却从不发。本 feature 是接线 + 扩展，不是新建。

## What

agent 可声明式发送只读卡片，小孙感知：review 结论变成绿/黄/红卡片、AC 清单变成 checklist 视图。

- card kind 升级：tone（info/success/warning/danger）+ fields 键值对
- 新增 checklist kind
- agent → 前端的发送通道 + 入口强校验（非法 block fail-closed 降级纯文本）
- 防粘连：block 绑定消息/invocation，invocation 完成后迟到 block 拒绝
- rich-messaging skill：教三 agent 何时发/怎么发（先文字后块、不确定就纯文本）

## Acceptance Criteria

- [ ] AC1: CardBlock 支持 tone + fields，渲染组件按 tone 着色；现有 card 消费方不回归
- [ ] AC2: 新增 ChecklistBlock kind + 渲染组件（含勾选状态只读显示）
- [ ] AC3: agent 发卡片通道落地（MCP 工具 / 内联围栏，Design Gate 定）+ Zod discriminatedUnion 入口校验，非法 block 降级纯文本不崩渲染
- [ ] AC4: block 与消息/invocation 绑定 + 去重 + invocation 完成后拒迟到块（防挂错气泡，clowder F096 B4 教训）
- [ ] AC5: rich-messaging skill 写好 + manifest 注册 + 三 agent 挂载 + check:skills 过
- [ ] AC6: dogfood——一次真实 review 结论以卡片发出，小孙确认可读性提升

## Dependencies

- 无硬依赖（现有 Block 体系 F012 已就绪）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 发送通道 | MCP 工具 vs 消息内联围栏（cc_rich 式） | 待 Design Gate | clowder 双轨都有，主 MCP 备内联 |
| 范围边界 | 是否含 interactive | 否，只读；交互归 F033 | 德彪建议拆读写，独立交付 |
| 后端预期 | "零后端改动"？ | 否，有 MCP/Zod/持久化后端件 | 德彪核查 clowder 实现，该说法过宽 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-06-13 | Kickoff（clowder-ai 借鉴批次，德彪讨论意见见 .runtime/reviews/clowder-ai-reference-discussion-request.md） |

## Links

- Related: F012（消息卡片化基础，done）、F020（决策卡片挂载矩阵，spec）、F033（交互卡片，backlog）

## Evolution

- **Evolved from**: F012
- **Blocks**: F033（交互卡片建立在本协议上）
- **Related**: F020
