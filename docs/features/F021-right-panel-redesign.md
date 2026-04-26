---
id: F021
title: 右侧面板重设计 — 观测带 + 智能体列表 + 两级配置（全局默认/会话专属）+ Side-Drawer
status: done
owner: 黄仁勋
created: 2026-04-19
first_completed: 2026-04-21
reopened: 2026-04-22
recompleted: 2026-04-26
completed: 2026-04-26
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

### Phase 6：上下文窗口 + Seal 阈值齿轮可配 + fillRatio 实时观测（reopened 2026-04-22）

> **Why（小孙原话，2026-04-22）**：
> "seal阈值我觉得很有必要，比如模型更新了，上下文窗口变大了，我们每次都需要修改代码出个commit来做吗，比如我长任务，我需要你们注意力集中，防止漂移，难道我又要替代改吗"
> "我应该可以跟齿轮一样 既可以全局，又可以本次会话"
> "就在这个feature里面做"

**根因**：当前 `packages/shared/src/constants.ts` 把两张本质应是"运行参数"的表写死在代码里 ——
1. `CONTEXT_WINDOW_FALLBACKS`（model → window）：模型版本升级（如 Opus 4.7 200k → 1M）必须改代码 + commit
2. `SEAL_THRESHOLDS_BY_PROVIDER`（per-provider warn/action 阈值）：长任务希望"早 seal 防漂移"必须改代码 + commit

F018 已经把 seal 改造为 reference-only 接力（ThreadMemory rolling + Bootstrap 7 区段 + sanitizeHandoffBody），early seal 代价已经很低，应该把"什么时候 seal"的决策权交给用户而不是绑死代码。

**What**：
- 复用 F021 已有的两层 overrides 表（`global_overrides` + `session_overrides`）各加 2 列
- 取值三层 fallback：**会话覆盖 → 全局默认 → 代码 fallback**（任一层删除自动回退下一层，永不导致系统不可用）
- `constants.ts` 两张表保留作为代码 fallback 兜底
- 前端齿轮两 Tab 各加两个 input（最大窗口 + Seal 阈值百分比）+ observation-bar 加 fillRatio 实时进度条

**明确不在 scope**（其他 8 处架构内常量留代码）：
- `MAX_BOOTSTRAP_TOKENS = 2000` / Bootstrap 工具段占比 25%
- ThreadMemory cap `max(1200, min(3000, prompt*3%))`
- `MAX_AUTO_RESUMES = 2` / `DEFAULT_MAX_MESSAGES = 20` / `BLOAT_DROP_THRESHOLD = 0.4`
- `CHARS_PER_TOKEN = 4` / continuation-guard 短消息门槛

理由：这些是架构内参数，调错代价隐蔽（影响接力质量但用户感知不到），不适合暴露给齿轮。

**Acceptance Criteria**：

- [x] AC-22: SQLite 迁移：`global_overrides` 加 `context_window INTEGER` + `seal_pct REAL`；`session_overrides` 加 `context_window INTEGER` + `seal_pct REAL`（NULL = 继承上一层）
- [x] AC-23: 后端 `computeSealDecision(provider, usage, threadId, sessionId)` 改签名，按"会话 → 全局 → 代码 fallback"三层取值；返回的 `warn` 自动 = `action - 0.05`（UI 只暴露 action，不暴露 warn）
- [x] AC-24: 后端新增 `resolveContextWindow(model, threadId, sessionId)` 走同样三层取值；保留 `getContextWindowForModel` 作为代码 fallback 内部调用
- [x] AC-25: 前端齿轮 **Global Defaults Tab** 加 per-provider 两个 input：「最大窗口」(number, tokens) + 「Seal 阈值」(0-100%)；Inherit/Override badge 跟 model 一致
- [x] AC-26: 前端齿轮 **Session Overrides Tab** 加同样两个 input；scope **thread-level**（一条聊天线一直生效，跨多次 seal/新 native session 仍激进）—— 与 F021 model/effort 的 session-level 行为不同，需独立确认 store key
- [x] AC-27: 前端 **observation-bar** 加 fillRatio 实时进度条：每 provider 一行 `▓▓░░ XX% (used/window) 距 seal Y%`；超过 warn 阈值变黄、超过 action 变红
- [x] AC-28: Fallback 链路集成测试：删 session 覆盖 → 自动回退全局；删全局默认 → 自动回退代码 fallback；任一层独立可用
- [x] AC-29: 校验：`0.3 ≤ seal_pct ≤ 1.0`、`context_window > 0`；非法值前端拒绝保存 + 后端 reject
- [x] AC-30: 小孙端到端验收：(a) 全局调 Claude 阈值到 50% → 验证 seal 提早 (b) 切某 thread 设 60% → 验证只此 thread 生效，新 thread 仍走全局默认 (c) observation-bar 进度条与实际 fillRatio 对得上
- [x] AC-31（去冗余）: 删 ObservationBar 里 SealProgress 行；agent-card「上下文 ▓▓░░ 45%」加 hover tooltip 显示 `已用 12k / 100k · 距 seal 25%`（信息回填，不丢内容）
- [x] AC-32（seal 感知）: seal 触发 → 后端往该 thread 持久化一条 system-notice 消息（role="assistant" + messageType="system_notice"）+ ws 推 message.created；前端 timeline-panel 加 `messageType === "system_notice"` 分支渲染 SystemNoticeBubble（橙色横幅，居中宽幅，role=note）；agent-card 同时显示「已封存 · 待重启」徽章直到下一轮 user 消息（派生于消息流，无新状态字段）

### Phase 6 Corrigendum（plan 阶段对照真实代码后修正，2026-04-25）

写 AC 时基于错误的代码假设（"两层 overrides 表"），plan 阶段对照真实代码修正：

| AC | 原描述 | 真实代码 | 修正实施路径 |
|---|---|---|---|
| AC-22 | `global_overrides` / `session_overrides` 表加列（SQLite 迁移） | 不存在这两张表。全局 = JSON 文件 `multi-agent.runtime-config.json`；会话 = `session_groups.runtime_config TEXT`（整段 JSON） | **无 schema 迁移**。扩 `AgentOverride` TypeScript 类型加 `contextWindow?: number; sealPct?: number`，前后端 sanitize 同步扩，JSON round-trip 自动支持 |
| AC-26 | scope 是否 thread-level "需独立确认 store key" | `session_groups.runtime_config` 本身就是 thread/session_group 级（一条聊天线一直生效） | thread-level scope **天然满足**，不需要新 store key |

实施按修正后路径走（详见 `docs/plans/F021-phase6-context-config-plan.md`）。

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
| 2026-04-21 | Squash merge 到 dev（commit `e21316d`）—— AC-01~AC-21 全绿，前端 77/77 + 后端 961/961 + typecheck 0 |
| 2026-04-22 | **Reopened** — 小孙发起 seal 阈值 + 上下文窗口齿轮可配讨论（"模型升级要改代码 commit / 长任务防漂移"），追加 Phase 6（AC-22~AC-30）；按 feat-lifecycle 重开规则 status: done → in-progress |
| 2026-04-25 | Task 1–6 + AC-28/29 全部 commit；preview 验收时小孙发现两个盲区：①agent-card 与 ObservationBar 进度条信息冗余 ②seal 真触发时无显眼反馈（status 一行轻量易错过）→ 追加 AC-31/AC-32（Task 7：去冗余 + 持久化 system-notice 消息 + sealed badge）|
| 2026-04-26 | Phase 6 完工验收：范德彪 code review APPROVED（含 P1/P2 修复 commit `51ba650`：full snapshot 派生 sealed + agent-card detail 改 `(剩余 N%)`）；小孙 AC-30 端到端验收 PASS；worktree-report.md 落档 `.agents/acceptance/F021/20260426T105700Z/`，进 merge-gate |
| 2026-04-26 | Squash merge 到 dev（commit `04e6b53` `feat(F021-P6): 上下文窗口/Seal 阈值齿轮可配 + fillRatio 实时观测 + seal 感知`）；worktree + `feat/F021-phase6-context-config` 分支销毁；F021 全周期收尾，AC-01~AC-32 全绿，status: done |

## Links

- Discussion: ROOM-042（本轮讨论 · timeline 见 MEMORY room context）
- Design: `docs/right-panel-redesign-huang-v2.png` · `docs/full-layout-redesign-huang.png`
- Related: F022（左侧 sidebar 重设计，并行推进）

## Evolution

- **Evolved from**: F005（运行时治理 UI）· F001（UI 焕新）
- **Blocked by**: F025（前端单测基础设施）
- **Blocks**: 无
- **Related**: F022（同期，并行）· F017（跨房间协作感知，未来联动）
