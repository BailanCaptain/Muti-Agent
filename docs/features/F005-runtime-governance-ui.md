---
id: F005
title: 运行时治理 UI — 权限系统 + 面板重构 + 侧边栏重做
status: merged
owner: 黄仁勋
created: 2026-04-11
---

# F005 — 运行时治理 UI：权限系统 + 面板重构 + 侧边栏重做

**Status**: merged (dev, commit b623b14)
**Created**: 2026-04-11

## Why

当前前端的核心问题不是"少几个功能"，而是**运行时治理信息架构散了**。权限、模型配置、会话导航各自有半套实现，但没有组织成统一系统：

1. **权限系统是空壳**：前端 `approval-card.tsx` 只有二元操作（允许/拒绝），scope 硬编码为 `"once"`。后端 `ApprovalManager.respond()` 的 `_scope` 参数被忽略。没有桌面通知、pending 恢复、规则持久化。后端靠 stderr 文本匹配猜测是否需要审批，天然脆弱。
2. **右侧配置面板冗余**：当前会话模型和全局默认配置同时展示在同一卡片内，用户分不清"改的是这次还是以后"。没有权限配置入口。
3. **左侧会话列表假结构**：分区标签是硬编码（"大厅"/"已置顶"），无真正置顶/分组/未读/右键菜单逻辑。

来源：小孙提出三个痛点 + 三人协作讨论（2026-04-11）+ 对照 clowder-ai 参考实现。

## What

用户可感知的变化：
- Agent 请求权限时，消息流中弹出审批卡片，支持「仅此次 / 此会话 / 全局」三级授权，支持 glob 通配符匹配（如 `npm *`）
- 已授权的同类操作自动放行，用户无感（渐进式信任，越用越安静）
- 权限规则落 SQLite，跨会话生效；独立设置 Modal 可查看/删除/管理规则
- 右侧面板改为 Tab 切换（会话态 / 全局态 / 审批规则），消除配置冗余
- 左侧会话列表按项目分组 + 极简 Linear 风格（黑底白字、靠间距体现层次）
- 输入框上方增加执行条，常驻显示 pending 审批 + agent 运行状态
- 桌面 Notification + tab title 闪烁，不会漏掉审批请求

## Acceptance Criteria

### Phase 1: 权限治理核心（后端 + 协议）
- [x] AC1: 审批事件结构化指纹：每个权限请求携带 `{tool, target, risk, provider}` 结构化字段，替换 stderr 文本猜测
- [x] AC2: ApprovalManager 支持三级 scope（once / thread / global），`respond()` 方法正确处理 scope 参数
- [x] AC3: 权限规则 SQLite 持久化：global 规则跨会话生效，thread 规则随会话结束清除
- [x] AC4: 规则匹配支持 glob 通配符（如 `npm *` 匹配 `npm test`、`npm install` 等）
- [x] AC5: `GET /api/authorization/pending?sessionGroupId=` 接口，支持刷新后恢复 pending 状态
- [x] AC6: 规则命中时自动放行，不触发前端审批卡片

### Phase 2: 前端审批卡片 + 执行条 + 通知
- [x] AC7: ApprovalCard 渐进式 scope UI：默认 3 按钮（允许仅此次 / 更多选项▼ / 拒绝），展开后显示会话级/全局级选项
- [x] AC8: 执行条（Execution Bar）：输入框上方常驻，显示各 agent 运行状态 + pending 审批计数
- [x] AC9: `useApprovalNotification` hook：桌面 Notification（requireInteraction）+ tab title 闪烁 + 去重
- [x] AC10: 审批卡片边缘低频黄色呼吸脉冲，方便滚屏时定位

### Phase 3: 右侧面板 Tab 重构 + 独立设置 Modal
- [x] AC11: 右侧面板改为 3 Tab：会话态（当前模型/effort/运行状态）/ 全局态（默认配置）/ 审批规则（当前会话 pending + 最近规则）
- [x] AC12: 独立设置 Modal：权限规则管理 tab（查看/删除/一键重置） + 预留扩展 tab 位
- [x] AC13: 消除模型配置双入口冗余：一个 provider 卡片只有一个模型选择器，通过 toggle 切换"仅此会话" vs "全局默认"

### Phase 4: 左侧侧边栏重做
- [x] AC14: 会话按项目/工作区分组，支持折叠展开
- [x] AC15: 右键上下文菜单：重命名 / 置顶 / 删除 / 归档
- [x] AC16: 未读标记：非活跃会话有新消息时显示 unread 计数
- [x] AC17: 运行态信号：侧边栏会话项显示 running / waiting approval 状态
- [x] AC18: 极简 Linear 视觉风格：黑底白字、极细线条、靠间距体现层次
- [x] AC19: 后端 project 数据模型支持（SessionGroup 增加 projectTag 字段）

### 贯穿项
- [x] AC20: WebSocket 指数退避重连 + 断连消息缓冲
- [x] AC21: 三栏布局支持面板折叠/展开（至少），最好支持拖拽调宽 + localStorage 持久化

## Dependencies

- 无外部依赖
- 内部依赖：`packages/shared/src/realtime.ts`（协议扩展）、`packages/api/src/orchestrator/approval-manager.ts`（后端重构）
- **Evolved from**: F001（UI 焕新）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 权限交互模式 | A: 内联 / B: 阻塞 / C: 混合 | 内联 + 三级 scope 自动放行 | 小孙拍板：类 clowder-ai 渐进式授权，已授权操作自动放行 |
| 权限 scope 持久化 | A: 仅内存 / B: SQLite | B: SQLite | 小孙拍板：跨会话生效，体验优先 |
| 权限规则匹配 | A: 精确匹配 / B: glob 通配符 | B: glob 通配符 | 小孙拍板：`npm *` 放行所有 npm 命令 |
| 右侧面板组织 | A: 会话态+底部折叠 / B: Tab 切换 | B: Tab 切换（会话/全局/审批） | 小孙拍板 |
| 权限配置 UI | A: 右侧手风琴 / B: 独立 Modal | B: 独立设置 Modal | 小孙拍板：预留扩展性 |
| 左侧分组维度 | A: 置顶+最近 / B: 项目分组 | B: 项目/工作区分组 | 小孙拍板 |
| 侧边栏视觉 | A: 极简 Linear / B: 赛博风 | A: 极简 Linear | 小孙拍板 |
| 模型能力 vs 权限 | 自动耦合 / 解耦 | 完全解耦 | 团队共识：高能力模型不应自动获得更高权限 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-04-11 | 三人协作讨论（Phase 1 独立思考 + Phase 2 串行收敛） |
| 2026-04-11 | 小孙拍板全部决策项 |
| 2026-04-11 | Kickoff |
| 2026-04-11 | Plan — 18 Tasks, 4 Phases, 21 AC 全覆盖 |
| 2026-04-11 | Phase 1 后端核心完成: 结构化指纹 + glob 匹配 + SQLite 持久化 + 规则自动放行 |
| 2026-04-11 | Phase 2 前端完成: 三级 scope 卡片 + 执行条 + 桌面通知 + pending 恢复 |
| 2026-04-12 | Phase 3+4+贯穿项完成 (3 agent 并行) |
| 2026-04-12 | 范德彪 review: P1/P2a/P2b 修复 + AC17 补修 |
| 2026-04-12 | 小孙拍板放行，squash merge 到 dev (b623b14) |

## Links

- Discussion: 2026-04-11 协作讨论（collaborative-thinking，权限/面板/侧边栏优化）
- Reference: `reference-code/clowder-ai/`（AuthorizationCard / useAuthorization / ThreadSidebar / RightStatusPanel）
- Plan: `docs/plans/F005-runtime-governance-ui-plan.md`
- Related: F001（UI 焕新，前序）

## Evolution

- **Evolved from**: F001（UI 焕新：配置入口统一 + 消息渲染升级）
- **Blocks**: 无
- **Related**: F003（A2A 运行时闭环 — 统一事件模型可能需要协调）
