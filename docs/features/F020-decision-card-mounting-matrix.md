---
id: F020
title: 决策卡片挂载矩阵：按场景分流的决策 UX 重构
status: spec
owner: 黄仁勋
created: 2026-04-18
---

# F020 — 决策卡片挂载矩阵：按场景分流的决策 UX 重构

**Created**: 2026-04-18

## Why

F002 Decision Board 上线后在 B007 里暴露三类问题，其中根因 C（UI 选型）随着实际使用又进一步细化出"按对话形态分流"的需求，已经超出单个 bug fix 的范围：

1. **挂载语义一刀切**（B007 根因 C 延伸）
   - 当前 B007 修复方向是"全屏 modal → 时间线底部全局面板"，但"全局面板"仍然让**所有场景共用一个位置**
   - 小孙的真实诉求：单 agent 问答、A2A 单链回程、多人讨论——这三种场景"决策从哪儿来"的语义不同，UI 挂载位置也应该不同
   - 单 agent 抛决策 ≠ 链级产物 ≠ 多人讨论收敛产物

2. **决策和上下文脱节**
   - 单 agent 场景：决策应该和抛它的那条消息**共生死**（消息折叠/引用/转发时决策跟随）
   - A2A 链场景：决策是整链的产物，不属于任何单条消息
   - 当前"session 底部全局面板"让决策飘在所有消息下方，滑回时间线后完全看不到源头

3. **折叠态没有提示**（B007 未覆盖）
   - 链/消息被折叠后，没有"这里有待拍板"的视觉提示
   - 导致决策容易被漏掉

4. **B007 根因 A/B 的代码 bug 仍需修**
   - `collectPendingDecisionItems` 不尊重 `[撤销拍板]`
   - Phase 2 全员 consensus 后不清 Board
   - 这两个是 F002 实现里遗留的细节 bug，F020 一并吸收修复

### 为什么是 Feature 不是 Bug

原本打算开 B008 承接本次"挂载矩阵"重构，关联检测发现：
- B008 编号已被 `spawn-enametoolong-windows` 占用
- 更关键：B007 本就是这个问题的起点，**新挂载矩阵 ⊇ B007 根因 C**
- "挂载矩阵"涉及前端组件拆分、WS 事件字段扩展（anchorGroupId）、Agent prompt 约定（无变化）、折叠态徽章渲染——跨组件、跨层、用户体感变化明显，符合 Feature 标准

结论：**不立新 B 号，F020 Supersedes B007**。B007 在 F020 完成时一并关闭，根因 A/B 纳入 F020 AC 作为"一并修复项"。

## What

按"决策从哪儿来"的语义，建立挂载矩阵：

| 场景 | 挂哪 | 弹出时机 | 语义 |
|------|------|---------|------|
| **单 agent 抛决策** | 该消息**气泡内部底部**（不溢出气泡） | 消息 settle 就弹 | 决策 ⊆ 消息，共生死 |
| **A2A 单链回程**（1v1） | **链级 Footer**（链外独立卡片） | 链 settle 就弹 | 决策是整链产物 |
| **多人讨论**（P1 并行 + P2 串讨 / 深链） | 链级 Footer | 讨论收敛后才弹（沿用 F002 settle+convergence 逻辑） | 同上，讨论过程中分歧可被自然消化 |

### 用户感知到的变化

- **单 agent Q&A**：黄仁勋发一条问消息带决策项，决策 radio 出现在消息气泡底部，和正文同属一个气泡（用分隔线分段）。折叠该消息时决策一起折。
- **A2A 单链回程**：范德彪 review 完 F018，在链尾抛出决策。决策卡片挂在**链外的 Footer**（不是某一条消息下方），和 Seal 印章、链头元信息一起构成链的完整输出。
- **多人讨论**：P1 并行思考、P2 串行讨论 3 轮，讨论过程中决策可能被消化；整链 settle 后把最终未收敛的分歧点一次性弹出来，挂链级 Footer。
- **折叠态徽章**：无论哪种挂法，被折叠时在折叠头右侧显示 `🟡 N 待拍板` 徽章，一眼可见。

### 用户不感知但关键的变化

- 前端新增 `<InlineDecisionFooter>` 组件（消息气泡内嵌）vs 复用现有 `<ChainFooter>` 扩展决策区
- WS 事件字段扩展：`decision.board_flush` 增加 `anchor: { type: 'message' | 'chain', id: string }`
- 运行时区分"消息级 pending"vs"链级 pending"：沿用 `SettlementDetector`，但 scope 切到 anchor 粒度
- 老消息（无 anchorGroupId）向后兼容：降级回时间线底部全局面板

## Acceptance Criteria

### 挂载矩阵语义

- [ ] **AC1 — 单 agent 决策挂消息体内**：agent 在单条消息（无 A2A 链上下文）中抛 `[拍板]`，决策区渲染在该消息气泡内部底部，使用分隔线与正文分段，不溢出气泡边界
- [ ] **AC2 — 单 agent 决策共生死**：折叠该消息时决策区一起折叠；展开时一起展开；消息被删除/引用时决策随之
- [ ] **AC3 — A2A 单链决策挂链 Footer**：1v1 A2A 回程场景，决策卡片挂在链级 Footer（独立于任何单条消息气泡），位于链 Seal 印章同一区域
- [ ] **AC4 — 多人讨论决策挂链 Footer**：深链/并行讨论场景同 AC3，链 settle 后才弹，沿用 F002 SettlementDetector 收敛逻辑不动
- [ ] **AC5 — 弹出时机细分**：单 agent 场景用"消息 settle"触发（单消息 complete 即可），链场景用"链 settle + 2s debounce + convergence check"（沿用 F002）
- [ ] **AC6 — 向后兼容降级**：老消息（`anchorGroupId` 缺失或无匹配 anchor）回落到 session 底部全局面板（当前 B007 修复后的行为）

### 折叠态 UX

- [ ] **AC7 — 折叠徽章**：消息气泡或链 Footer 被折叠时，折叠头右侧渲染 `🟡 N 待拍板` 徽章（N = 该 anchor 下未决分歧点数）
- [ ] **AC8 — 徽章点击展开**：点击徽章展开对应气泡/链并滚动到决策区

### 已决策 vs 未决策分段

- [ ] **AC9 — 段内分两块**：决策区内部分"已收敛（绿 ✓）"和"未收敛（琥珀 ⏳）"两段；折叠态徽章只数未收敛项
- [ ] **AC10 — 动态更新**：用户拍板一项后，该项从未收敛段移到已收敛段，徽章 N 减 1；全部拍板后徽章消失

### B007 根因 A/B 吸收

- [ ] **AC11 — [撤销拍板] 过滤**：`collectPendingDecisionItems` 尊重 `[撤销拍板]`，被撤销项不进 pending 列表（补 B007 根因 A）
- [ ] **AC12 — Phase 2 consensus 清 Board**：Phase 2 全员 `[consensus]` 后自动从 DecisionBoard 移除该 session 项目（补 B007 根因 B）

### 动画 & 视觉

- [ ] **AC13 — 单 agent 动画**：决策区从气泡底伸出，180ms 高度过渡
- [ ] **AC14 — 链 Footer 动画**：决策卡片从链尾伸出，180ms
- [ ] **AC15 — 不破坏 F001/F002 视觉语言**：复用 F002 的深墨蓝 + 暖金色调，消息气泡内嵌版本适配气泡背景色

### 工程质量

- [ ] **AC16 — 测试覆盖**：anchor 路由单测（message vs chain vs fallback）、折叠徽章单测、向后兼容降级单测；message-service 端到端覆盖新 anchor 字段
- [ ] **AC17 — 回归 F002 AC1-AC15 全绿**：挂载矩阵改造不得回归 F002 原有验收
- [ ] **AC18 — 文案统一**："拍板" → "分歧点"（B007 根因 C 尾部诉求，全局 UI 文案）

## Dependencies

- **F002（Decision Board）**：SettlementDetector / DecisionBoard / ChainStarterResolver 三个运行时模块复用，只扩展 anchor 字段，不重写
- **F006（UI/UX 深度重塑）**：链 Footer、消息气泡组件体系
- **F012（前端加固 + 渲染重构）**：in-progress，若 F012 Phase 仍在动消息气泡结构，F020 需要和 F012 协调组件抽象
- **B007**：Supersedes（F020 完成时一并关闭）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 单 agent 决策挂哪 | (a) 消息气泡内部底部 / (b) 气泡外独立 Footer / (c) session 底部 | **(a)** | 小孙原话："单个 agent 需要我决策的时候 应该挂载消息体里面，在所有消息的最下面，但是不应该出消息体"。决策 ⊆ 消息 = 共生死语义 |
| A2A 链决策挂哪 | (a) 最后一条综合者消息内 / (b) 链级 Footer 独立卡片 | **(b)** | 小孙原话（Q1）："Q1 挂在 b"。链决策是整链产物，不属于任何单条消息 |
| 多人讨论弹出时机 | (a) 讨论过程中实时弹 / (b) 讨论收敛后才弹 | **(b)** | 小孙原话（Q2）："讨论完之后才弹，有可能讨论过程中需要决策点会收敛，这点不改变之前的逻辑"。沿用 F002 收敛语义 |
| 老消息是否兼容 | (a) 强制迁移 / (b) 无 anchor 降级全局面板 | **(b)** | 向后兼容，避免历史数据失焦 |
| 新 bug 号是否立 | (a) 立 B017 / (b) 不立，F020 Supersedes B007 | **(b)** | B007 根因 C 已覆盖本次需求方向，新挂载矩阵是 B007 修复思路的精化；B008 号被占用；避免语义割裂 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-18 | Mockup 产出（9 张场景图 + HTML 原型），小孙方向性确认 |
| 2026-04-18 | Design Gate Round 1 — 小孙确认 Q1/Q2 挂载规则 |
| 2026-04-18 | Kickoff |

## Links

- Mockup: [F020-mockup.html](F020-mockup.html)
- Mockup 场景图: F020-s1.png ~ F020-s9.png（同目录）
- Related: F002（运行时基座）/ F006（UI 体系）/ F012（前端重构 in-progress 协调）
- Supersedes: B007（Decision Board 收敛泄漏 — 根因 A/B/C 统一收入 F020 AC11/AC12/AC18）

## Evolution

- **Evolved from**: F002（Decision Board 一期）
- **Blocks**: 无
- **Related**: F006, F012, **F026（A2A 可靠通信层）** — F026 的 DiscussionCoordinator 是本 feature "多人讨论收敛后弹"决策卡片的触发源，两者 Phase 5 协同
- **Supersedes**: B007
