---
id: B007
title: Decision Board 收敛泄漏 — 已收敛决策仍弹给用户 + UI 体感问题
related: F002
reporter: 小孙
created: 2026-04-11
---

# B007 — Decision Board 收敛泄漏

## 1. 报告人

小孙（产品/CVO），在实际使用 F002 Decision Board 后发现多个问题。

## 2. 复现步骤

**期望行为**：Phase 2 串行讨论中 agents 达成共识后，已收敛的决策不应弹给用户；决策卡片应嵌入对话流而非全屏 modal。

**实际行为**：
1. Phase 2 讨论已收敛（agents 发了 [consensus]），但 fan-in 卡片仍显示所有 [拍板] 项目
2. 全屏 modal 占满屏幕，体感差
3. 所有决策项目混在一起，不区分已收敛/未收敛
4. "拍板"命名不适合 A2A 场景（讨论中可收敛，应叫"分歧点"）

## 3. 根因分析

**根因 A — `collectPendingDecisionItems` 不尊重 `[撤销拍板]`**
- `message-service.ts:1870-1889`：只扫描 `[拍板]`，忽略 `[撤销拍板]`
- Phase 2 中 agent 撤销的决策仍显示在 fan-in 卡片中

**根因 B — Phase 2 consensus 不清除 DecisionBoard**
- `message-service.ts:1727-1743`：全员 `[consensus]` 只 break 循环，不从 Board 移除项目
- 讨论收敛后 Board 上项目完好，settle 后全部 flush

**根因 C — UI 选型需迭代**
- F002 当初选了全屏 modal，实际使用后小孙认为应内联嵌入
- fan-in 选择器和待决策项目混杂在同一个 description 字段

## 4. 修复方案

1. `collectPendingDecisionItems` 增加 `[撤销拍板]` 过滤
2. Phase 2 全员 consensus 后，自动从 DecisionBoard 清除该 session 项目
3. 全屏 modal → inline 卡片，嵌入时间线
4. 分离已收敛观点 vs 未收敛分歧点
5. 全局 "拍板" → "分歧点" 命名更新

## 5. 验证方式

- 单测：`collectPendingDecisionItems` 覆盖 [撤销拍板] 过滤
- 单测：Phase 2 consensus 后 Board 自动清空
- 前端：inline 卡片正确嵌入时间线
- 全局搜索确认无遗漏的 "拍板" UI 文案
