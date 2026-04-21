---
id: F021
title: 右侧面板重设计 — 观测带 + 智能体列表 + 两级配置（全局默认/会话专属）+ Side-Drawer
status: in-progress
owner: 黄仁勋
created: 2026-04-19
---

# F021 — 右侧面板重设计

**Created**: 2026-04-19

## Why

当前 `components/chat/status-panel.tsx`（657 行）在 340px 宽度里塞了 **9 块信息**，一屏展不下：

- 控制面板标题 / 房间健康度 / 消息统计 / 折叠控制 / 心里话 toggle / 智能体配置（每个 provider 5 层信息 × 3）/ 会话链
- 真正症结：**观测数据和操作入口混在一起**；**全局/房间/会话三层配置继承**导致心智灾难；**会话链**抢占一级视觉

> 小孙："右侧信息太冗余了。"

三人讨论收敛：不是样式不够精致，是信息分层错了。

### 讨论来源

- 本轮 collaborative-thinking（2026-04-18）全员讨论并达成共识
- 设计图：
  - `docs/right-panel-redesign-huang-v2.png`（v2 含共识细节）
  - `docs/full-layout-redesign-huang.png`（整体布局）

## What

把右侧面板重构为 **3 段式**，配置态从 Popover 改 Side-Drawer，继承层级从三层砍到两层：

1. **顶部 ROOM 归属徽章** — `ROOM · {名字} · #hash`，第一眼建立"在哪个房间"心智
2. **观测带**（薄 3 数字）— 消息数 / 证据数 / 跟进数 + 会话链链接（降级为右上角）
3. **智能体列表**（一行一人）— 头像 · 名字 · 模型 pill · ⚙ 设置入口 · 运行状态
4. **房间开关**（心里话 / 发言器） — 保留作为房间级独立领地
5. **Side-Drawer 配置态** — 从右侧滑出，Segmented Tab 切换「全局默认 / 会话专属」
6. **覆盖指示** — 模型 pill 右侧 2px 橙色小点 = 该 agent 存在会话专属覆盖

## Acceptance Criteria

### Phase 1：观测带 + 智能体行（1.5 天）
- [x] AC-01: 拆分 `status-panel.tsx` 为 3 个子组件：`ObservationBar` / `AgentList` / `RoomSwitches`
- [x] AC-02: 顶部 ROOM 归属徽章（`ROOM · {title} · #{shortHash}`）
- [x] AC-03: 观测带只展示 3 个数字（消息/证据/跟进）+ 会话链链接
- [x] AC-04: 智能体行：头像 + 名字 + 模型 pill + ⚙ + 运行指示（pulse 或 idle）
- [x] AC-05: 右侧面板整体滚动高度 ≤ 屏高（1080p 下无纵向滚动）

### Phase 2：Side-Drawer 配置态（1 天）
- [x] AC-06: 点击 ⚙ 从右侧滑出 Drawer（不是 Popover）
- [x] AC-07: Drawer 顶部 Segmented Tab：「全局默认」/「会话专属」
- [x] AC-08: 全局默认 Tab：一个保存按钮写入全局 config
- [x] AC-09: 会话专属 Tab：显示继承自全局的值，编辑后可保存为会话覆盖
- [x] AC-10: 模型 pill 右侧橙色小圆点仅当存在会话专属覆盖时显示

### Phase 3：运行中保护 + 下一轮生效（0.5 天）
- [x] AC-11: 会话运行中（streaming）时，「应用到当前会话」按钮 disable
- [x] AC-12: 文案提示"运行中，下一轮生效"
- [x] AC-13: 编辑写入 `pendingConfig`（下一轮启动时读取）
- [x] AC-14: invocation 启动时 snapshot pendingConfig 到本次 invocation 元数据（可追溯）
- [x] AC-15: 快照写入 `invocationStats` 记录

### Phase 4：验收
- [x] AC-16: 桂芬视觉验收通过
- [x] AC-17: 范德彪 code review 通过（无运行中配置竞态）
- [x] AC-18: 小孙端到端跑一轮 → OK

### Phase 5：验收中发现的缺陷回修 — 聊天气泡 model pill（feature 内修，不建 B-ID）

> 小孙（2026-04-21）："聊天框的不会变呀 你看看 我已经选了 pro 了，但是聊天模型还是 flash。"

右侧面板 AgentList 的 pill 和消息气泡里的 model pill 没有正确反映会话当前 resolved model——改了会话覆盖后 pill 不跟随变化；而且历史气泡也应该被"冻结"在它当时产生的 model，避免后续全局/会话配置变更导致历史记录跳字。

- [x] AC-19: 右侧面板 AgentList 的 pill 即时反映 resolved model（会话覆盖 > 全局默认 > `card.currentModel` fallback），会话切换/覆盖变更后 pill 立刻更新
- [x] AC-20: 后端消息表新增 `messages.model` snapshot 列（ALTER 迁移 `F021-messages-add-model`），assistant 消息 append 时把本次 resolved model 冻结写入该列
- [x] AC-21: 聊天气泡 pill 读取 `message.model` snapshot；旧消息（pre-F021 / user / connector 消息）fallback 到 `thread.currentModel`；改会话覆盖后只影响新气泡，历史气泡保持原样（小孙 2026-04-21 人工验收通过）

## Dependencies

- 依赖现有 `status-panel.tsx` / `AgentConfigProvider` / 会话状态 store
- 运行中检测依赖 F012 的 streaming 状态事件
- **Blocked by F025**（前端单测基础设施）— 本 feature 的 TDD 实施节奏依赖 vitest + @testing-library/react 落地后才能起飞；F025 合 dev 前 F021 worktree/plan 保留待命

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 配置态展现 | Popover / Side-Drawer | **Drawer** | Popover 挤不下 Tab + 按钮 + 继承提示 |
| 模型配置继承层级 | 三层（全局→房间→会话）/ 两层（全局→会话） | **两层** | 三层是心智灾难，"房间"作为 UI 维度保留但不参与模型继承 |
| 运行中改模型 | 立即生效 / 挂起到下一轮 | **挂起到下一轮** | 避免 token 统计和 session 对不上的竞态 |
| 会话覆盖的视觉标记 | 颜色 / 小点 / 文字标签 | **模型 pill 右侧 2px 橙色小点** | 不侵入 ⚙（⚙ 是入口，不是状态） |
| 会话链位置 | 一级视觉 / 观测带右上角链接 | **观测带右上角链接** | 降级让位给智能体列表 |
| ROOM 徽章位置 | 顶部显眼 / 省略 | **顶部紫色条** | 让房间归属第一眼可见 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-18 | collaborative-thinking 讨论（黄仁勋 + 范德彪 + 桂芬）|
| 2026-04-19 | Kickoff |
| 2026-04-20 | Plan 落地（`docs/plans/F021-right-panel-redesign-plan.md`，4 Phase 拆分）|
| 2026-04-20 | **Blocked on F025**：动手前发现前端零单测基础设施，拆出 F025 先做 |
| 2026-04-20 | F025 合 dev → F021 rebase unblock，进 Phase 1 TDD（Task 1.1 ObservationBar）|
| 2026-04-20 | Phase 1–3 实现完成（AC-01~AC-15 全绿，后端 862 + 前端 42 测试通过，`pnpm build` 绿）；进 Phase 4 独立验收 |
| 2026-04-21 | Phase 4 验收中发现聊天气泡 / 右面板 pill 不跟随会话 resolved model → 新增 Phase 5（AC-19/20/21）；实现完成后小孙人工验收通过，请范德彪 code review（AC-17）|
| 2026-04-21 | 范德彪二轮扩大范围 review 提 2 P1 + 1 P2 → `d749074` 字段级 merge + 清 pending + Tab 同步闭环；residual risk `2c06753` Drizzle 定向回归 → 二轮放行，AC-17 通过 |

## Links

- Discussion: ROOM-042（本轮讨论 · timeline 见 MEMORY room context）
- Design: `docs/right-panel-redesign-huang-v2.png` · `docs/full-layout-redesign-huang.png`
- Related: F022（左侧 sidebar 重设计，并行推进）

## Evolution

- **Evolved from**: F005（运行时治理 UI）· F001（UI 焕新）
- **Blocked by**: F025（前端单测基础设施）
- **Blocks**: 无
- **Related**: F022（同期，并行）· F017（跨房间协作感知，未来联动）
