---
id: F001
title: UI 焕新 — 配置入口统一 + 消息渲染升级
status: done
owner: 黄仁勋
created: 2026-04-10
completed: 2026-04-10
---

# F001 — UI 焕新：配置入口统一 + 消息渲染升级

**Status**: done
**Created**: 2026-04-10
**Completed**: 2026-04-10（commit `43c7eda`）

## Why

当前存在两个结构性 UX 问题：
1. **模型配置双入口冲突**：Composer 上的 `AgentConfigBar`（写 runtime-config，持久化）与 StatusPanel 智能体配置（写 thread store，仅内存）概念重叠，且运行时优先级 `runtimeOverride.model ?? thread.currentModel` 导致用户无法判断"谁说了算"。
2. **消息渲染质量低**：手写 markdown parser（`markdown-message.tsx` 583 行正则）边界 case 多、无代码复制、无语法高亮、无结构化卡片能力。与参考实现（clowder-ai 的 react-markdown + RichBlocks）差距明显。

来源：小孙提出 + 三人协作讨论收敛（2026-04-10）。

## What

用户可感知的变化：
- 输入框区域变干净，只负责"写消息 + 点名 + 发送"
- 模型配置统一在右侧面板操作，当前会话配置常显，全局默认配置折叠可展开
- Agent 回复支持完整 GFM（表格、任务列表）、代码块语法高亮 + 复制按钮
- 不同 Agent 的消息气泡有专属颜色，一眼可辨
- 支持 CardBlock、DiffBlock 结构化展示

## Acceptance Criteria

- [x] AC1: Composer 区域无任何模型/配置控件，`AgentConfigBar` 组件已删除
- [x] AC2: StatusPanel 智能体卡片支持当前会话模型配置（常显）+ 全局默认配置（折叠）
- [x] AC3: 两处配置统一走 `PUT /api/runtime-config` API，消除双写
- [x] AC4: 消息正文使用 react-markdown + remark-gfm 渲染，禁用 rehype-raw
- [x] AC5: 代码块带语法高亮样式 + 右上角复制按钮
- [x] AC6: 前端 `normalizeMessageToBlocks()` 适配层统一 content/thinking/inlineConfirmations 渲染路径
- [x] AC7: Per-provider 气泡视觉差异化（专属边框色/背景色）
- [x] AC8: CardBlock 渲染组件（标题/正文/字段列表/动作按钮）
- [x] AC9: DiffBlock 渲染组件（inline diff 展示）
- [x] AC10: 现有消息向后兼容（无 blocks 字段时降级为单个 markdown block）

## Dependencies

- 无外部依赖
- 内部依赖：`packages/shared/src/realtime.ts`（TimelineMessage 类型，本轮前端适配层不改外部协议）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 模型配置入口 | A: 彻底迁移到看板 / B: 看板+Composer留快捷入口 | A（彻底迁移） | Composer 单一职责，配置不属于输入区 |
| 全局默认配置位置 | A: 挪到 Settings 页 / B: 留在智能体卡片折叠 | B（卡片内折叠） | 小孙拍板 |
| Markdown 渲染器 | A: 继续手写 parser / B: react-markdown 生态 | B | 手搓正则工程账不划算，边界 case 和回归风险越补越散 |
| 消息协议是否改 | A: 前端适配层不改协议 / B: 扩展 TimelineMessage.blocks | A（本轮） | 投入产出比：后端还不能发 rich block，先用前端 adapter 拿架构收益 |
| Rich Blocks 范围 | A: 推下轮 / B: 顺手做 Card+Diff | B | 小孙拍板 |
| HTML 直通 | 启用 rehype-raw / 禁用 | 禁用 | agent 输出不完全可控，HTML 直通 = XSS 面 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-10 | 协作讨论（桂芬/黄仁勋/范德彪三人串行收敛） |
| 2026-04-10 | 小孙拍板：全局配置折叠(B) + 顺手做Card+Diff(B) |
| 2026-04-10 | Kickoff |
| 2026-04-10 | Design Gate 通过（小孙放行，前端 UI/UX 类） |
| 2026-04-10 | AC1-AC10 全部交付并 merge（commit `43c7eda`），Status → done |

## Links

- Discussion: 本次协作讨论（collaborative-thinking，2026-04-10）
- Plan: `docs/plans/F001-ui-refresh-plan.md`（待创建）
- Related: 无

## Evolution

- **Evolved from**: 无（首个 Feature）
- **Blocks**: 无
- **Related**: F005（运行时治理 UI — 本 Feature 的自然演进）
