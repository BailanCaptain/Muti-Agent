---
id: F012
title: 前端加固 + 渲染重构 + DesignSystem — 消息卡片化 + 折叠式工具/推理展示 + 统一设计契约
status: spec
owner: 桂芬
created: 2026-04-14
---

# F012 — 前端加固 + 渲染重构 + DesignSystem

**Created**: 2026-04-14

## Why

### 健壮性问题
- 前端无 Error Boundary — 任何子组件异常 → 全页白屏（BUG-10）
- 图片上传一张失败全部丢弃，包括文字内容（BUG-11）
- 前端 WebSocket JSON.parse 无 try-catch（BUG-14）
- 所有 store 的 catch 块为空，生产环境无法排查问题（BUG-15）

### 渲染结构问题
- CliOutputBlock 把工具输出和文字回复混在一个深色块里（"黑匣子"），语义和视觉都有问题
- 三人一致共识：这是**结构问题不是样式问题**，必须在 `message-bubble.tsx` 拆分 toolEvents 和 content 的渲染路径

### 村长的视觉需求（卡片模型）

村长通过截图明确了期望的消息体格式：

1. **卡片化**：每条消息是独立的圆角卡片，不是"气泡连成一片"
2. **可折叠**：skill 调用、MCP 工具调用、推理过程都能折叠显示，结论在下方
3. **结构化标题栏**：顶部显示 agent 名字、时间戳、状态标签
4. **内容区分明**：文字内容和工具输出/代码块有清晰的视觉分区
5. **操作栏**：底部有复制、折叠等操作按钮

> 核心方向：**从气泡模型换成卡片模型**，同时实现 skill + MCP + 推理过程的折叠式展示。

### DesignSystem 问题
- Provider 色彩在 cli-output-block、message-bubble、status-panel 三处重复定义且不一致
- 加一个新 Agent 要改 3 个文件
- 村长已选定 [B] 统一设计契约

### 讨论来源

- 全面排查讨论综合报告
- 村长截图：QQ111.png（卡片式消息体 + 可折叠标注）、QQ20260414-142214.png（多卡片实际效果）
- 分歧点决议：DesignSystem 契约化 → [B] 统一设计契约（村长已定）
- 三人一致（更新）：UI 视觉风格 → 统一浅色卡片风（去终端风），工具块用浅色 card-in-card + accent 左边框
- 村长明确：不要终端风
- Mockup 参考：`docs/features/F012-mockup.html`

## Acceptance Criteria

### Phase 1：健壮性修复（1 天）
- [ ] AC-01: `app/page.tsx` 或 `layout.tsx` 加 React Error Boundary，子组件异常不再白屏（BUG-10）
- [ ] AC-02: `chat-store.ts:86-93` 图片上传容错 — 部分失败保留已成功的图片 + 文字内容不丢失（BUG-11）
- [ ] AC-03: `client.ts:89` WebSocket message handler 加 JSON.parse try-catch（BUG-14）
- [ ] AC-04: 所有 store 空 catch 块加 `console.error`（BUG-15）

### Phase 2：消息卡片化 + 折叠式渲染（2 天）
- [ ] AC-05: `message-bubble.tsx` 重构 — 从气泡模型改为**卡片模型**：
  - 每条消息是独立圆角卡片（带边框/阴影/间距）
  - 卡片标题栏：agent 头像 + 名字 + 时间戳
  - 卡片底部操作栏：复制、折叠/展开
- [ ] AC-06: toolEvents / skillEvents / thinking 和 content **拆分渲染路径**：
  - 工具调用（MCP / tool_use）→ 浅色 card-in-card 折叠块（浅灰背景 + accent 色左边框）
  - Skill 调用 → 浅色 card-in-card 折叠块（需新增 `skillEvents` 数据管道，见 AC-06a）
  - 推理/思考 → 浅色 card-in-card 折叠块
  - 文字回复 → 卡片内容区（实色背景，非毛玻璃）
  - 四者在同一卡片内分区，不混在一起
- [ ] AC-06a: **新增 `skillEvents` 数据管道**（当前缺口）：
  - `packages/shared/src/realtime.ts` — `TimelineMessage` 加 `skillEvents?: SkillEvent[]` 字段
  - `packages/api/src/services/message-service.ts` — skill 匹配时写 `skillEvents` 而非 `prependSkillHint()` 拼入 content
  - `components/chat/message-bubble.tsx` — 按 `skillEvents` 渲染独立折叠子卡片
- [ ] AC-07: **折叠式展示**：
  - skill 调用过程：默认折叠，显示 skill 名称 + 状态（成功/失败），点击展开查看详情
  - MCP 工具调用：默认折叠，显示工具名 + 调用次数汇总，点击展开
  - 推理/思考过程（thinking）：默认折叠，显示"推理过程"标签 + 耗时，点击展开
  - 最终结论/文字回复：**始终展示**，不折叠，位于折叠块下方
- [ ] AC-08: CliOutputBlock 只包裹工具输出内容，不再包裹文字回复
- [ ] AC-09: 流式输出（streaming）时工具块自动展开，完成后自动折叠（解决"页面一直闪"问题）

### Phase 2.5：数据管道打通 + 审批修复（1 天）
- [ ] AC-20: **Thinking 数据管道打通**（三个 CLI 全修）：
  - Claude CLI：`claude-runtime.ts` 的 `buildCommand()` 加 `--include-partial-messages` 参数 + effort 改为 `max`
    - 根因：不加此参数，CLI 只输出完整 message 对象，`thinking_delta` 被内部消费不暴露
    - 参考：clowder-ai `ClaudeAgentService.ts:225` 已验证此方案
    - `parseActivityLine` 已有正确的 `thinking_delta` 解析逻辑，不是死代码，是配套参数没开
  - Codex CLI：`codex-runtime.ts:86` 修 `item.output` → `item.aggregated_output`（字段名 bug）
    - 用复杂提示验证 `reasoning` 事件是否触发
  - Gemini CLI：用复杂提示验证 `thought: true` 事件是否触发
  - 验证方式：三个 CLI 各跑一次复杂提示，确认前端"深度思考"折叠块有内容
- [ ] AC-21: **审批卡片修复**（两个 bug）：
  - Bug A — 前端 session 过滤太严：`app/page.tsx:132-136` 的 `isCurrentSession` 检查导致审批事件被丢弃
    - 修复：去掉 `approval.request` 的 session 过滤，审批卡片应全局可见（不论当前查看哪个 session）
    - 同步修 `approval.resolved`（line 138-141）和 `approval.auto_granted`（line 144-147）
  - Bug B — CLI 权限模式缺失：`claude-runtime.ts` 的 `buildCommand()` 没传 `--permission-mode`
    - 修复：加 `--permission-mode bypassPermissions`，让 CLI 不拦截权限，全部走 MCP callback
    - 参考：clowder-ai `ClaudeAgentService.ts:54,231-232` 用的就是 `bypassPermissions`
  - 验证方式：触发需要权限的操作，确认前端弹出审批卡片 + 点击审批后 agent 继续执行
- [ ] AC-22: **截图能力**（参照 clowder-ai 方案）：
  - 参考实现：clowder-ai `preview-gateway.ts` + `bridge-script.ts` + `ImageExporter.ts` + `preview.ts:138-163`
  - 需要新增的组件：
    - PreviewGateway 反向代理（让 iframe 安全加载本地 dev server）
    - Bridge Script（注入 iframe，SVG foreignObject + Canvas 截屏）
    - ImageExporter（Puppeteer 无头浏览器截屏，长页面滚动拼接）
    - Screenshot API Route（`POST /api/preview/screenshot` 存到 `/uploads/`）
    - Auto-open API（agent 主动打开浏览器面板）
  - 新增依赖：`puppeteer`、`sharp`、`http-proxy`
  - 截屏流程：Agent 调用 auto-open → Bridge 截屏 → POST 到后端 → 存 PNG → 返回 URL → 作为 ContentBlock 存入消息
  - 验证方式：agent 能自动截屏 mockup/dev server 页面 + 截图在消息中正确渲染

### Phase 3：DesignSystem 契约化（1 天）
- [ ] AC-10: 建立统一 theme（`components/theme.ts` 或 `ThemeContext`）：
  - Provider 色彩映射（黄仁勋=绿、范德彪=蓝、桂芬=粉…）
  - 卡片基础 token（圆角、阴影、间距、边框、opacity）
  - 折叠块样式（浅灰背景 + accent 色左边框、等宽字体仅限代码内容）
  - 字体 token（正文用系统无衬线、代码块用等宽）
- [ ] AC-11: 迁移 `cli-output-block.tsx` 的 `PROVIDER_ACCENT` 到统一 theme
- [ ] AC-12: 迁移 `message-bubble.tsx` 的硬编码颜色到统一 theme
- [ ] AC-13: 迁移 `status-panel.tsx` 的 Chip 颜色到统一 theme
- [ ] AC-14: 删除各组件内的重复色彩定义

### 门禁
- [ ] AC-15: `pnpm typecheck && pnpm test` 全绿
- [ ] AC-16: 手动验证：Error Boundary 拦截子组件异常（不白屏）
- [ ] AC-17: 手动验证：图片上传 1 张失败、文字 + 其余图片正常发出
- [ ] AC-18: 手动验证：带工具调用的消息中，skill/MCP/推理过程默认折叠，结论始终显示
- [ ] AC-19: 手动验证：新增 Provider 只需在 theme 中加一行颜色定义
- [ ] AC-23: 手动验证：三个 CLI 的 thinking 内容在前端"深度思考"折叠块中可见
- [ ] AC-24: 手动验证：agent 请求权限时，审批卡片在前端正确弹出，审批后 agent 继续执行
- [ ] AC-25: 手动验证：agent 能自动截屏并在消息中展示截图

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 消息容器模型 | A: 气泡模型 / B: 卡片模型 | B | 村长截图明确要求卡片化，且卡片天然支持标题栏、折叠、操作栏 |
| 工具/文字渲染 | A: 混合渲染 / B: 拆分路径 | B | 三人一致共识：结构问题不是样式问题 |
| 折叠默认状态 | A: 全展开 / B: 工具折叠+结论展开 | B | 村长明确：skill+MCP+推理折叠，结论在下方 |
| DesignSystem | A: 散落各组件 / B: 统一 theme | B | 村长已选，三处重复定义必须收口 |
| 视觉风格 | A: 全终端风 / B: 统一浅色卡片风 | B | 村长明确"不要终端风"，图片示例全浅色 SaaS 风；工具块用浅色 card-in-card + accent 左边框 |
| Skill 数据管道 | A: 文字前缀拼入 content / B: 独立 skillEvents 字段 | B | 实地验证发现 skill 混在 content 里无法独立折叠，需要与 toolEvents/thinking 同级的独立字段 |
| Thinking 打通 | A: 等 CLI 修 / B: 加 `--include-partial-messages` | B | clowder-ai 已验证：加此参数后 CLI 输出流式事件含 `thinking_delta`，我们的 `parseActivityLine` 解析逻辑已就绪 |
| 审批卡片修复 | A: 保持 session 过滤 / B: 全局可见 | B | session 过滤导致用户看不到审批卡片，无法审批；同时补 `--permission-mode bypassPermissions` 让权限走 MCP callback |
| 截图能力 | A: 单独立项 / B: 放进 F012 | B | 村长明确要求放进 F012；参照 clowder-ai 的 PreviewGateway + Puppeteer + Bridge 方案 |

## 消息卡片结构设计

```
┌─────────────────────────────────────────┐
│ 🟢 黄仁勋 (Claude)          14:22:15    │  ← 标题栏：头像+名字+时间
├─────────────────────────────────────────┤
│ ▸ 🔧 Skill: quality-gate    ✅ 完成     │  ← 折叠块：skill 调用
│ ▸ 🔧 MCP: read_file         ✅ 完成     │  ← 折叠块：MCP 调用
│ ▸ 💭 推理过程                 收起       │  ← 折叠块：思考过程
├─────────────────────────────────────────┤
│                                         │
│  这是最终结论文字，始终展示。              │  ← 内容区：浅色实底 + accent 左边框
│  支持 Markdown 渲染。                    │
│                                         │
├─────────────────────────────────────────┤
│ 📋 复制  ⤴ 折叠  ···                    │  ← 操作栏
└─────────────────────────────────────────┘
```

## 验证命令

```bash
# 回归
pnpm typecheck && pnpm test

# 启动 dev server 手动验证视觉效果
pnpm dev
# 在浏览器中：
# 1. 触发带 skill 调用的对话，确认 skill 过程可折叠
# 2. 触发带 MCP 工具调用的对话，确认工具调用可折叠
# 3. 确认结论文字始终显示在折叠块下方
# 4. 确认 Error Boundary 工作（在 DevTools 中模拟组件异常）
```

## Timeline

| 日期 | 事件 | 说明 |
|------|------|------|
| 2026-04-14 | 三方审计 | BUG-10/11/14/15 + 黑匣子结构问题 + DesignSystem 散乱 |
| 2026-04-14 | 村长截图 | 明确卡片化 + 折叠式消息体需求 |
| 2026-04-14 | 村长决定 | DesignSystem 选 [B] 统一契约 |
| 2026-04-14 | F012 立项 | 前端加固 + 卡片化渲染 + DesignSystem 合并 |
| 2026-04-14 | 讨论共识 | 去终端风→统一浅色卡片风；去毛玻璃→实色+阴影；补 skillEvents 数据管道；Mockup 产出 |
| 2026-04-14 | 根因定位 | Thinking 不显示：缺 `--include-partial-messages` 参数（clowder-ai 验证）|
| 2026-04-14 | 根因定位 | 审批卡片不显示：前端 session 过滤丢弃事件 + CLI 没传 `--permission-mode` |
| 2026-04-14 | 村长决定 | 截图能力、Thinking 修复、审批卡片修复全部放进 F012 |

## Links

- F010: 基线回绿（前置依赖）
- F001: UI 焕新（初始 UI 重构）
- F006: UI/UX 深度重塑 V2（上一轮 UI 迭代）
- B013: 前端输出不一致（本次彻底解决）

## Evolution

- **Depends on**: F010（基线回绿）
- **Evolved from**: F001（UI 焕新）→ F006（UI/UX V2）→ B013（输出不一致修复）
- **Blocks**: 跨房间协作感知（后续立项，依赖前端加固完成）
- **Parallel**: F011（后端加固）、F013（CI 门禁）
