---
id: F006
title: UI/UX 深度重塑与运行时治理 V2
status: kickoff
owner: 桂芬
created: 2026-04-13
---

# F006 — UI/UX 深度重塑与运行时治理 V2

**Status**: design-confirmed
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
- [ ] AC1: 侧边栏改为毛玻璃透明质感（bg-white/80 + blur），边框采用极细浅色描边。
- [ ] AC2: 侧边栏支持右键菜单（置顶、重命名、删除）。

### Phase 2: 右侧指挥中心合体 (Unified Control)
- [ ] AC3: 实现 Status Panel 置顶的活跃 Agent 控制区，支持单点停止。
- [ ] AC4: 整合 Agent 与 Model 配置，移除冗余 Tab。
- [ ] AC5: 增加「心里话模式」拨杆，控制 Thinking 区域全局显隐。

### Phase 3: 输出规范与步进器 (The Mirror)
- [ ] AC6: 实现前端「输出清洗器」，强行修正换行符（\n）和不规范的 Markdown 符号。
- [ ] AC7: Thinking 区域升级为「步进器」组件，支持显示工具调用参数（args）。
- [ ] AC8: 实现不同身份的 @mention 高亮（老黄-紫，德彪-金，桂芬-蓝）。

### Phase 4: 后端补全与联调 (Final Polish)
- [ ] AC9: 后端路由支持 `/api/threads/:threadId/cancel/:agentId`。
- [ ] AC10: 全量 UI 走查，确保毛玻璃主题在亮/暗模式下均无死角。

## Dependencies

- 依赖 `F005`（作为重构基础）
- 渲染层需要 `react-markdown` 深度定制组件。

## Evolution

- **Evolved from**: F005（运行时治理 UI）
- **Blocks**: 无
- **Related**: F001 (UI 焕新)
