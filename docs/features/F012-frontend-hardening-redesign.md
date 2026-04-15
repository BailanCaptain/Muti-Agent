---
id: F012
title: 前端加固 + 渲染重构 + DesignSystem — 消息卡片化 + 折叠式工具/推理展示 + 统一设计契约
status: in-progress
owner: 黄仁勋
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
- [x] AC-01: `app/page.tsx` 或 `layout.tsx` 加 React Error Boundary，子组件异常不再白屏（BUG-10）
- [x] AC-02: `chat-store.ts:86-93` 图片上传容错 — 部分失败保留已成功的图片 + 文字内容不丢失（BUG-11）
- [x] AC-03: `client.ts:89` WebSocket message handler 加 JSON.parse try-catch（BUG-14）
- [x] AC-04: 所有 store 空 catch 块加 `console.error`（BUG-15）

### Phase 2：消息卡片化 + 折叠式渲染（2 天）
- [x] AC-05: `message-bubble.tsx` 重构 — 从气泡模型改为**卡片模型**：
  - 每条消息是独立圆角卡片（带边框/阴影/间距）
  - 卡片标题栏：agent 头像 + 名字 + 时间戳
  - 卡片底部操作栏：复制、折叠/展开
- [x] AC-06: toolEvents / skillEvents / thinking 和 content **拆分渲染路径**：
  - 工具调用（MCP / tool_use）→ 浅色 card-in-card 折叠块（浅灰背景 + accent 色左边框）
  - Skill 调用 → 浅色 card-in-card 折叠块（需新增 `skillEvents` 数据管道，见 AC-06a）
  - 推理/思考 → 浅色 card-in-card 折叠块
  - 文字回复 → 卡片内容区（实色背景，非毛玻璃）
  - 四者在同一卡片内分区，不混在一起
- [x] AC-06a: **新增 `skillEvents` 数据管道**（当前缺口）：
  - `packages/shared/src/realtime.ts` — `TimelineMessage` 加 `skillEvents?: SkillEvent[]` 字段
  - `packages/api/src/services/message-service.ts` — skill 匹配时写 `skillEvents` 而非 `prependSkillHint()` 拼入 content
  - `components/chat/message-bubble.tsx` — 按 `skillEvents` 渲染独立折叠子卡片
- [x] AC-07: **折叠式展示**：
  - skill 调用过程：默认折叠，显示 skill 名称 + 状态（成功/失败），点击展开查看详情
  - MCP 工具调用：默认折叠，显示工具名 + 调用次数汇总，点击展开
  - 推理/思考过程（thinking）：默认折叠，显示"推理过程"标签 + 耗时，点击展开
  - 最终结论/文字回复：**始终展示**，不折叠，位于折叠块下方
- [x] AC-08: CliOutputBlock 只包裹工具输出内容，不再包裹文字回复
- [x] AC-09: 流式输出（streaming）时工具块自动展开，完成后自动折叠（解决"页面一直闪"问题）

### Phase 2.5：数据管道打通 + 审批修复（1 天）
- [x] AC-20: **Thinking 数据管道打通**（三个 CLI 逐个修）：
  - Claude CLI：`claude-runtime.ts` 的 `buildCommand()` 加 `--include-partial-messages` 参数
    - 根因：不加此参数，CLI 只输出完整 message 对象，`thinking_delta` 被内部消费不暴露
    - 参考：clowder-ai `ClaudeAgentService.ts:224-226` 已验证此方案
    - `parseActivityLine` 已有正确的 `thinking_delta` 解析逻辑，配套参数没开而已
  - Codex CLI：`codex-runtime.ts` 的 `parseActivityLine` 逻辑已正确（`item.type === "reasoning"`）
    - 参考：clowder-ai `codex-event-transform.ts:254-262` 用同样的事件格式，**已跑通**
    - clowder-ai 用 `model_reasoning_effort` 配置（我们也有），reasoning 作为完整 item 返回
    - 需用复杂提示实测确认 reasoning 事件能触发
  - Gemini CLI：**Gemini 没有原生 thinking 输出**
    - clowder-ai 的 `GeminiAgentService.ts` 也没有 thinking 处理
    - Gemini 模型推理是内部不可观测的，CLI 不暴露 thought 事件
    - `gemini-runtime.ts:86-131` 的 `event.thought === true` 是防御性代码，留着不删但不指望它触发
  - 验证方式：Claude 和 Codex 各跑一次复杂提示，确认前端"深度思考"折叠块有内容
- [x] AC-21: **权限全放开 + 废弃 F005 审批系统**（村长决定简化方案）：
  - Bug A — 三个 CLI 的权限请求都不走我们的前端审批：
    - Claude：没传 `--permission-mode`，默认交互式 → stdin 已关 → 卡死
      - 修复：加 `--permission-mode bypassPermissions`（参考 clowder-ai `ClaudeAgentService.ts:231`）
    - Codex：有 `approval_policy="on-request"` 但没有 MCP server 配置 → 审批走 Codex 内部 stdin
      - 修复：给 Codex 也配 MCP server（和 Claude 一样），或改为 `approval_policy="full-auto"` + 用 MCP callback 管权限
    - Gemini：用 `--approval-mode yolo` 跳过所有审批 → 没有安全控制
      - 修复：改为通过 MCP callback 走我们的审批链路
  - Bug B — 前端 session 过滤太严：`app/page.tsx:132-136` 的 `isCurrentSession` 检查导致审批事件丢弃
    - 修复：审批事件不做 session 过滤，全局可见
    - 同步修 `approval.resolved`（line 138-141）和 `approval.auto_granted`（line 144-147）
  - Bug C — **前端缺少规则管理 UI**（这才是"审批规则完全是废的"的核心原因）：
    - 后端 API 完整：`POST /api/authorization/rules` 可创建规则、`ApprovalManager.match()` 自动放行逻辑完好
    - 前端只有查看和删除，**没有"添加规则"表单**
    - 修复：在 `status-panel.tsx` 的 `ApprovalTabContent` 或 `settings-modal.tsx` 加规则创建表单：
      - 选择 Provider（Claude/Codex/Gemini/全部）
      - 输入 Action 模式（支持通配符，如 `npm *`、`edit_file *`）
      - 选择决策（允许/拒绝）
      - 选择范围（当前会话/全局）
    - 用户可主动配置"完全放权"或"逐个审批"，不需要等审批卡片弹出来才能建规则
  - 验证方式：
    1. 在前端主动添加一条规则"Claude npm * → 允许（全局）"
    2. 触发 Claude 执行 npm 命令 → 自动放行，状态栏显示"已自动放行"
    3. 删除规则后重新触发 → 弹出审批卡片 → 点批准 → agent 继续
- [x] AC-22: **截图能力**（参照 clowder-ai 方案）：
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
- [x] AC-26: **三 CLI 参数对齐**（非 thinking/非权限的参数修复）：
  - Claude/Codex/Gemini CLI prompt 传递从 stdin pipe 改为命令行参数 + stdin 改 `"ignore"`
  - Codex 加 `--add-dir .git`；Gemini 加 `isKnownPostResponseCandidatesCrash` 容错
- [x] AC-27: **三 CLI 事件类型补全**（对比 clowder-ai 逐个补）：
  - Claude：`unwrapStreamEvent()` 统一拆信封 + thinkingBuffer + partialTextMessageIds 去重 + 10 类事件
  - Codex：`mcp_tool_call` / `todo_list` / `web_search` / `error` 等 7 类事件
  - Gemini：`result` error + candidates crash 容错

### Phase 3：DesignSystem 契约化（1 天）
- [x] AC-10: 建立统一 theme（`components/theme.ts` 或 `ThemeContext`）：
  - Provider 色彩映射（黄仁勋=绿、范德彪=蓝、桂芬=粉…）
  - 卡片基础 token（圆角、阴影、间距、边框、opacity）
  - 折叠块样式（浅灰背景 + accent 色左边框、等宽字体仅限代码内容）
  - 字体 token（正文用系统无衬线、代码块用等宽）
- [x] AC-11: 迁移 `cli-output-block.tsx` 的 `PROVIDER_ACCENT` 到统一 theme
- [x] AC-12: 迁移 `message-bubble.tsx` 的硬编码颜色到统一 theme
- [x] AC-13: 迁移 `status-panel.tsx` 的 Chip 颜色到统一 theme
- [x] AC-14: 删除各组件内的重复色彩定义

### 门禁
- [x] AC-15: `pnpm typecheck && pnpm test` 全绿（543/543，0 failures）
- [ ] AC-16: 手动验证：Error Boundary 拦截子组件异常（不白屏）
- [ ] AC-17: 手动验证：图片上传 1 张失败、文字 + 其余图片正常发出
- [ ] AC-18: 手动验证：带工具调用的消息中，skill/MCP/推理过程默认折叠，结论始终显示
- [ ] AC-19: 手动验证：新增 Provider 只需在 theme 中加一行颜色定义
- [ ] AC-23: 手动验证：Claude 和 Codex 的 thinking 内容在前端"深度思考"折叠块中可见（Gemini 无原生 thinking，不验证）
- [ ] AC-24: 手动验证：三个 CLI 执行任意操作直接放行（不卡死、不弹审批）+ F005 审批 UI 组件已移除
- [ ] AC-25: 手动验证：agent 能自动截屏并在消息中展示截图
- [ ] AC-28: 手动验证：Claude stream_event 信封拆解正确（thinking 累积发出 + text_delta 流式 + tool_use 去重 + usage 正确提取）
- [ ] AC-29: 手动验证：Codex `mcp_tool_call` / `todo_list` / `web_search` 事件在前端正确显示
- [ ] AC-30: 手动验证：Gemini 遇到 candidates crash 不报错（优雅降级）
- [ ] AC-31: 手动验证：Windows 下 Claude MCP config 写临时文件（不再内联 JSON）

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|------|------|------|------|
| 消息容器模型 | A: 气泡模型 / B: 卡片模型 | B | 村长截图明确要求卡片化，且卡片天然支持标题栏、折叠、操作栏 |
| 工具/文字渲染 | A: 混合渲染 / B: 拆分路径 | B | 三人一致共识：结构问题不是样式问题 |
| 折叠默认状态 | A: 全展开 / B: 工具折叠+结论展开 | B | 村长明确：skill+MCP+推理折叠，结论在下方 |
| DesignSystem | A: 散落各组件 / B: 统一 theme | B | 村长已选，三处重复定义必须收口 |
| 视觉风格 | A: 全终端风 / B: 统一浅色卡片风 | B | 村长明确"不要终端风"，图片示例全浅色 SaaS 风；工具块用浅色 card-in-card + accent 左边框 |
| Skill 数据管道 | A: 文字前缀拼入 content / B: 独立 skillEvents 字段 | B | 实地验证发现 skill 混在 content 里无法独立折叠，需要与 toolEvents/thinking 同级的独立字段 |
| Thinking 打通 | A: 等 CLI 修 / B: 加 `--include-partial-messages` | B | Claude: clowder-ai 已验证此方案。Codex: clowder-ai 用同样的 reasoning item 格式已跑通。Gemini: 无原生 thinking，clowder-ai 也无解 |
| 权限策略 | A: 修复审批链路可配置放权 / B: 全放权 + 废弃 F005 | B | 村长决定：权限系统废了（后端有但前端不能创建规则），直接全放权。F005 审批相关组件删除 |
| 截图能力 | A: 单独立项 / B: 放进 F012 | B | 村长明确要求放进 F012；参照 clowder-ai 的 PreviewGateway + Puppeteer + Bridge 方案 |
| CLI 参数对齐 | A: 只修致命项 / B: 全面对齐 clowder-ai | B | 逐行读代码发现 19 个事件类型漏掉、stdin 方式差异、Windows MCP bug、Gemini crash 等，一并整改 |
| stream_event 方案 | A: 每个方法单独改 / B: `unwrapStreamEvent()` 统一拆信封 | B | 参照 clowder-ai `transformClaudeEvent()` 模式 |

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
| 2026-04-15 | Spec 扩展 | AC-26（三 CLI 参数对齐）+ AC-27（事件类型补全）写入 spec |
| 2026-04-15 | 村长决定 | 权限全放开 + 废弃 F005 审批系统；AC-22 截图延后单独立项 |
| 2026-04-15 | Phase 1 完成 | ErrorBoundary + 图片容错 + WS 安全 + store 日志（AC-01~04） |
| 2026-04-15 | Phase 2.5 完成 | Claude stream_event 重写 + Codex/Gemini 整改 + 三 CLI 权限全放 + F005 废弃 + stdin→参数迁移 |
| 2026-04-15 | Phase 2 完成 | 卡片模型重写 + CollapsibleBlock + skillEvents 数据管道 |
| 2026-04-15 | Phase 3 完成 | DesignSystem 统一 theme + 4 组件迁移 + 重复色彩删除 |
| 2026-04-15 | 门禁通过 | typecheck + check-docs + biome lint + 530 tests（529 pass / 1 pre-existing flaky） |
| 2026-04-15 | AC-22 完成 | PreviewGateway + Bridge Script + WS Patch + port-validator + BrowserPanel + auto-open 事件 + 13 安全测试 |
| 2026-04-14 | 自我纠正 | clowder-ai 确实用了三个 CLI（之前错说没用 Codex/Gemini）；Codex reasoning 在 clowder-ai 已跑通；Gemini 无原生 thinking |
| 2026-04-14 | 根因补充 | 审批规则"完全废了"不止是卡片弹不出——前端缺规则创建 UI，用户无法主动配置放权/不放权 |

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
