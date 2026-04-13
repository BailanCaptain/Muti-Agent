---
id: F006
title: UI/UX 深度重塑与运行时治理 V2
status: completed
owner: 桂芬
created: 2026-04-13
completed: 2026-04-14
---

# F006 — UI/UX 深度重塑与运行时治理 V2

**Status**: completed
**Created**: 2026-04-13

## Why

F005 虽然合入了，但用户（小孙）反馈极差，存在严重的视觉与交互缺陷：
1. **视觉压抑**：侧边栏“死黑”，配色和间距缺乏美感。
2. **交互突兀**：输入框上方的头像展示太生硬，干扰输入。
3. **信息冗余**：右侧面板配置重复（会话配置 vs 默认配置），信息组织混乱。
4. **治理缺失**：无法手动终止单个 Agent，MCP/Skill 加载缺乏实时可见性。
5. **渲染不一**：Agent 输出格式混乱（换行符处理不当），缺乏统一美感。

## What

1. **侧边栏重塑 (Glassmorphism)**：引入毛玻璃质感与呼吸感动效，优化间距，消除“黑乎乎”的压抑感。
2. **状态面板指挥中心 (Command Center)**：
   - 将“运行状态”从输入框上方撤出，整合进右侧 Status Panel 最顶端。
   - 提供实时 Agent 运行 Chip（头像、计时、状态、[🛑 停止] 按钮）。
   - 合并“智能体配置”与“模型配置”，移除冗余的“默认栏”。
3. **前端渲染规范化 (Frontend Sanitizer)**：
   - 在前端渲染层统一处理所有 Agent 的输出，强行校准换行（`remark-breaks`）和 Markdown 格式。
   - 确保德彪、老黄和桂芬的输出在视觉上高度一致。
4. **MCP 调用步进器 (Step Tracker)**：
   - 消息流中的 Thinking 区域改为“进度步进器”模式。
   - 实时显示工具调用：`✅ tool_name { args }`，已完成的打勾，进行中的旋转。
5. **运行时控制升级**：后端支持单 Agent 精准停止，前端通过状态面板触发。

## Acceptance Criteria

### Phase 1: 视觉基调与侧边栏 (Designer's Soul)
- [x] AC1: 侧边栏改为毛玻璃透明质感（bg-white/80 + blur），边框采用极细浅色描边。
- [x] AC2: 侧边栏支持右键菜单（置顶、重命名、删除）。

### Phase 2: 右侧指挥中心合体 (Unified Control)
- [x] AC3: 实现 Status Panel 置顶的活跃 Agent 控制区，支持单点停止。
- [x] AC4: 整合 Agent 与 Model 配置，移除冗余 Tab。
- [x] AC5: 增加「心里话模式」拨杆，控制 Thinking 区域全局显隐。

### Phase 3: 输出规范与步进器 (The Mirror)
- [x] AC6: 实现前端「输出清洗器」，强行修正换行符（\n）和不规范的 Markdown 符号。
- [x] AC7: Thinking 区域升级为「步进器」组件，支持显示工具调用参数（args）。
- [x] AC8: 实现不同身份的 @mention 高亮（老黄-紫，德彪-金，桂芬-蓝）。

### Phase 4: 后端补全与联调 (Final Polish)
- [x] AC9: 后端路由支持 `/api/threads/:threadId/cancel/:agentId`。
- [x] AC10: 全量 UI 走查，确保毛玻璃主题在亮/暗模式下均无死角。

### Phase 5: Bug 修复与性能优化 (Stability & Performance)
- [x] AC11: 串行讨论 DecisionBoard 跨会话泄漏修复 — `InlineDecisionBoard` 加 `sessionGroupId !== activeGroupId` 校验。
- [x] AC12: Timeline 消息列表虚拟化（`@tanstack/react-virtual`），只渲染可视区域内的消息。
- [x] AC13: SessionCard 用 `React.memo` 包裹，避免无关状态变化触发全卡片重渲染。
- [x] AC14: StatusPanel 消息统计用 `useMemo` 缓存，避免每次渲染重复 `.filter()` 计算。
- [x] AC15: 侧边栏 `providers` 订阅细粒度化（从全对象 → `anyRunning` 布尔派生），减少不必要的重渲染。

### Phase 6: Event Transformer 架构（输出结构化 + 编码修复）
- [x] AC16: 三个 runtime（Claude/Codex/Gemini）各有 `transformToolEvent()` 方法，返回结构化 `ToolEvent { type, toolName, toolInput, content, status, timestamp }`
- [x] AC17: messages 表新增 `tool_events` TEXT 列（JSON 数组），存储结构化工具事件
- [x] AC18: WebSocket 新增 `assistant_tool_event` 事件类型，实时推送工具调用
- [x] AC19: `TimelineMessage` 新增 `toolEvents` 字段，前端直接消费结构化数据
- [x] AC20: StepTracker 从 `toolEvents[]` 渲染，**删除所有正则解析逻辑**（parseThinkingToSteps、cleanThinkingText 等）
- [x] AC21: `thinking` 字段只含纯推理文本，不含工具调用噪音
- [x] AC22: 子进程编码固定为 UTF-8，德彪中文输出不再乱码
- [x] AC23: 删除所有因 event transformer 而变冗余的代码（正则解析、formatClaudeToolInput、formatGeminiParams、parseActivityLine 工具部分等）
- [x] AC24: 所有现有测试通过，无回归

### Phase 6.1: 会话隔离 + 流式稳定性（Review 驱动修复）
- [x] AC25: WebSocket 全部 13 种事件类型带 `sessionGroupId`，前端按 `activeGroupId` 过滤
- [x] AC26: 输入框草稿按会话隔离（`drafts: Record<string, string>`）
- [x] AC27: 流式输出内容周期性落盘（`streamingFlushers`），切会话再切回不丢数据
- [x] AC28: `decision.request` + `decision.board_flush` 切会话后可恢复（REST + fetchPending）
- [x] AC29: `status` 事件 18 个发射点补 `sessionGroupId`，前端过滤

### 不做什么（后续 Feature）
- **不做 clowder 级别的 progress/final 消息分类** — clowder 用 `isFinal` 标志区分"中间进度消息"和"最终答复"（由 `route-serial.ts` 中 `index === worklist.length - 1` 决定），这是更上层的消息分级改造，不在 F006 范围内
- 不做 MCP 工具集扩展
- 虚拟化 `estimateSize` 初值微调（P3，后续按实际数据调优）
- Agent Chip 过渡动画（P3，后续加 framer-motion）

## Dependencies

- 依赖 `F005`（作为重构基础）
- 渲染层需要 `react-markdown` 深度定制组件。

## Evolution

- **Evolved from**: F005（运行时治理 UI）
- **Blocks**: 无
- **Related**: F001 (UI 焕新)
