# F006 — UI/UX 深度重塑与运行时治理 V2 Implementation Plan

**Feature:** F006 — `docs/features/F006-ui-ux-refinement-and-runtime-governance-v2.md`
**Goal:** 彻底重塑 Multi-Agent 的视觉与交互体验，通过右侧指挥中心、前端渲染清洗、毛玻璃主题及工具步进器，实现极致的运行时治理与审美统一。

**Acceptance Criteria:**
- [ ] AC1: 侧边栏改为毛玻璃透明质感（bg-white/80 + blur），边框采用极细浅色描边。
- [ ] AC2: 侧边栏支持右键菜单（置顶、重命名、删除）。
- [ ] AC3: 实现 Status Panel 置顶的活跃 Agent 控制区，支持单点停止。
- [ ] AC4: 整合 Agent 与 Model 配置，移除冗余 Tab。
- [ ] AC5: 增加「心里话模式」拨杆，控制 Thinking 区域全局显隐。
- [ ] AC6: 实现前端「输出清洗器」，强行修正换行符（\n）和不规范的 Markdown 符号。
- [ ] AC7: Thinking 区域升级为「步进器」组件，支持显示工具调用参数（args）。
- [ ] AC8: 实现不同身份的 @mention 高亮（老黄-紫，德彪-金，桂芬-蓝）。
- [ ] AC9: 后端路由支持 `/api/threads/:threadId/cancel/:agentId`。
- [ ] AC10: 全量 UI 走走查，确保毛玻璃主题在亮/暗模式下均无死角。

**Architecture:**
- **Frontend**: 使用 Tailwind CSS 的 `backdrop-blur` 实现毛玻璃；利用 `react-markdown` 的自定义渲染器实现输出清洗和身份高亮；在 `StatusPanel` 中引入 `ExecutionBar` 的逻辑，并通过 `ThreadStore` 实现精准取消。
- **Backend**: 扩展 `MessageService` 和 `InvocationRegistry`，通过 `agentId` 定位并取消特定的执行句柄。

**Tech Stack:** Tailwind CSS, Framer Motion (用于 Chip 动画), react-markdown, remark-breaks, Express.

---

### Task 1: 后端精准取消路由 (Precise Cancellation)

**Files:**
- Modify: `packages/api/src/routes/threads.ts`
- Modify: `packages/api/src/services/message-service.ts`
- Test: `packages/api/test/cancellation.test.ts`

**Step 1: 编写失败测试 (确认无法按 agentId 取消)**
```typescript
import { test } from "node:test";
import assert from "node:assert";

test("cancelSpecificAgent", async () => {
  const res = await fetch(`${API_URL}/api/threads/${threadId}/cancel/${agentId}`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
});
```
**Step 2: 运行测试并确认失败 (Expected: 404)**
**Step 3: 最小实现 - 增加路由与 MessageService 逻辑**
```typescript
// MessageService.ts 逻辑增加 cancelAgentInThread(threadId, agentId)
```
**Step 4: 运行测试确认通过**
**Step 5: Commit**

---

### Task 2: 侧边栏毛玻璃与右键菜单 (Designer's Soul)

**Files:**
- Modify: `app/globals.css`
- Modify: `components/chat/session-sidebar.tsx`
- Modify: `components/chat/session-context-menu.tsx`

**Step 1: 全局 CSS 定义毛玻璃变量**
```css
.glass-surface { @apply bg-white/70 backdrop-blur-md border-white/20 shadow-sm; }
```
**Step 2: 应用到 SessionSidebar**
**Step 3: 完善右键菜单逻辑 (Rename/Delete/Pin)**
**Step 4: 验证侧边栏通透感与交互**
**Step 5: Commit**

---

### Task 3: 右侧指挥中心与配置整合 (Command Center)

**Files:**
- Modify: `components/chat/status-panel.tsx`
- Modify: `components/chat/execution-bar.tsx` (Logic migration)
- Modify: `components/chat/composer.tsx` (Cleanup)

**Step 1: 将 ExecutionBar 的 Chip 逻辑搬迁至 StatusPanel 置顶区域**
**Step 2: 合并智能体配置与模型配置为单一列表**
**Step 3: 增加「心里话模式」拨杆并对接 ThreadStore**
**Step 4: 移除输入框上方的冗余 ExecutionBar**
**Step 5: Commit**

---

### Task 4: 前端输出清洗与步进器 (The Mirror)

**Files:**
- Modify: `components/chat/markdown-message.tsx`
- Create: `components/chat/rich-blocks/step-tracker.tsx`
- Modify: `components/chat/message-bubble.tsx`

**Step 1: 实现 Markdown Sanitizer (处理 \n 和格式偏差)**
**Step 2: 开发 StepTracker 组件 (✅/⏳ 步进模式)**
**Step 3: 实现身份色 @mention 高亮渲染**
**Step 4: 联调 Thinking Delta 实时更新步进状态**
**Step 5: Commit**

---

### Task 5: 最终联调与视觉打磨 (Final Polish)

**Files:**
- Modify: `tailwind.config.ts`
- Modify: `app/layout.tsx`

**Step 1: 确认暗色模式适配 (bg-slate-900/80)**
**Step 2: 全流程演示测试 (运行 -> 实时工具显示 -> 精准停止 -> 格式校准)**
**Step 3: 清理旧代码与冗余组件**
**Step 4: Final Commit**

---

## Phase 6: Event Transformer 架构（输出结构化 + 编码修复 + 冗余清理）

**Goal:** 后端在 NDJSON 解析时就把工具调用结构化为 `ToolEvent`，前端直接消费结构化数据，彻底删掉 step-tracker 的正则解析。同时修掉德彪输出中文乱码。

**Architecture:** 每个 runtime 新增 `transformToolEvent()` 方法，返回结构化 `ToolEvent`。cli-orchestrator 收集后传给 message-service，存入 DB `tool_events` 列，通过 WebSocket 推送前端。StepTracker 从结构化数据渲染。

**不做什么:**
- 不改消息存储架构（不加新表，只加列）
- 不做 clowder 级别的 progress/final 消息分类 — clowder 用 `done` 事件的 `isFinal` 标志区分"中间进度"和"最终答复"（`route-serial.ts:1139` 中 `index === worklist.length - 1` 决定），这是更上层的消息分级改造，后续 Feature 再做
- 不做 MCP 工具集扩展
- 不改 parseAssistantDelta（文本流正常工作）

---

### Task 6: 定义 ToolEvent 类型（shared 包）

**Files:**
- Create: `packages/shared/src/tool-event.ts`
- Modify: `packages/shared/src/index.ts` — 导出新类型
- Modify: `packages/shared/src/realtime.ts` — TimelineMessage 加 `toolEvents`

**Step 1:** 创建 `ToolEvent` 类型：`{ type: "tool_use" | "tool_result", toolName, toolInput?, content?, status: "started" | "completed" | "error", timestamp }`
**Step 2:** 从 `index.ts` 导出
**Step 3:** `TimelineMessage` 加 `toolEvents?: ToolEvent[]`
**Step 4:** 跑 `pnpm --filter @multi-agent/shared exec tsc --noEmit`

---

### Task 7: DB migration — messages 表加 tool_events 列

**Files:**
- Modify: `packages/api/src/db/sqlite.ts` — MessageRecord 加字段 + ALTER TABLE

**Step 1:** `MessageRecord` 加 `toolEvents: string`（JSON string）
**Step 2:** `migrate()` 加 `ALTER TABLE messages ADD COLUMN tool_events TEXT NOT NULL DEFAULT '[]'`
**Step 3:** 跑测试

---

### Task 8: session-repository 支持 tool_events 读写

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository.ts` — listMessages/appendMessage/overwriteMessage 加 tool_events

**Step 1:** `listMessages` SQL 加 `tool_events`，`hydrateMessage` 里 `JSON.parse`
**Step 2:** `appendMessage` 加 `toolEvents` 参数，INSERT 加列
**Step 3:** `overwriteMessage` 支持 `toolEvents` 更新
**Step 4:** 跑测试

---

### Task 9: session-service 透传 toolEvents

**Files:**
- Modify: `packages/api/src/services/session-service.ts` — mapTimelineMessage/toTimelineMessage/overwriteMessage 透传

**Step 1:** `mapTimelineMessage` 加 `toolEvents` 参数
**Step 2:** `toTimelineMessage` 读 `message.toolEvents` 传给 map
**Step 3:** `overwriteMessage` 透传
**Step 4:** 跑 tsc + 测试

---

### Task 10: WebSocket 新增 assistant_tool_event 事件

**Files:**
- Modify: `packages/shared/src/realtime.ts` — RealtimeServerEvent 加新类型

**Step 1:** 加 `{ type: "assistant_tool_event", payload: { messageId: string, event: ToolEvent } }`
**Step 2:** 跑 shared tsc

---

### Task 11: Claude runtime — transformToolEvent()

**Files:**
- Modify: `packages/api/src/runtime/base-runtime.ts` — 加默认方法
- Modify: `packages/api/src/runtime/claude-runtime.ts` — 实现

**Step 1:** `base-runtime.ts` 加 `transformToolEvent()` 默认返回 null
**Step 2:** Claude 实现：`assistant` → `tool_use`（从 content block 提取），`user` → `tool_result`
**Step 3:** 跑 tsc

---

### Task 12: Codex runtime — transformToolEvent()

**Files:**
- Modify: `packages/api/src/runtime/codex-runtime.ts`

**Step 1:** 实现：`item.started + command_execution` → `tool_use:Bash`，`item.completed + command_execution` → `tool_result:Bash`，`item.completed + file_change` → `tool_use:Edit`
**Step 2:** 跑 tsc

---

### Task 13: Gemini runtime — transformToolEvent()

**Files:**
- Modify: `packages/api/src/runtime/gemini-runtime.ts`

**Step 1:** 实现：`tool_use` → `ToolEvent`，`tool_result` → `ToolEvent`
**Step 2:** 跑 tsc

---

### Task 14: cli-orchestrator 接入 transformToolEvent

**Files:**
- Modify: `packages/api/src/runtime/cli-orchestrator.ts` — RunTurnOptions/RunTurnResult 扩展 + onStdoutLine 调用

**Step 1:** `RunTurnOptions` 加 `onToolEvent` 回调
**Step 2:** `RunTurnResult` 加 `toolEvents: ToolEvent[]`
**Step 3:** `onStdoutLine` 中 JSON.parse 后调用 `runtime.transformToolEvent(event)`，命中则 push + 回调
**Step 4:** 跑 tsc

---

### Task 15: message-service 存储和广播 toolEvents

**Files:**
- Modify: `packages/api/src/services/message-service.ts` — onToolEvent 回调 + overwriteMessage 包含 toolEvents

**Step 1:** `runThreadTurn` 声明 `let toolEvents: ToolEvent[] = []`
**Step 2:** 添加 `onToolEvent` 回调：push + emit `assistant_tool_event`
**Step 3:** 所有 `overwriteMessage` 调用加 `toolEvents: JSON.stringify(toolEvents)`
**Step 4:** 跑测试

---

### Task 16: 修复子进程编码（德彪乱码）

**Files:**
- Modify: `packages/api/src/runtime/base-runtime.ts` — spawn env + stderr encoding

**Step 1:** spawn 环境变量加 Windows UTF-8：`PYTHONIOENCODING: "utf-8"`, `LANG: "en_US.UTF-8"`
**Step 2:** stderr `chunk.toString("utf-8")` 显式指定
**Step 3:** 跑测试

---

### Task 17: parseActivityLine 清理工具行（thinking 净化）

**Files:**
- Modify: `packages/api/src/runtime/claude-runtime.ts` — 删除 tool_use/tool_result 摘要返回
- Modify: `packages/api/src/runtime/codex-runtime.ts` — 删除 command_execution/file_change 摘要返回
- Modify: `packages/api/src/runtime/gemini-runtime.ts` — 删除 tool_use/tool_result 摘要返回

**Step 1:** Claude：保留 `thinking_delta`，删除工具摘要行
**Step 2:** Codex：保留 `reasoning`，删除工具摘要行
**Step 3:** Gemini：工具事件全移到 transformToolEvent，parseActivityLine 返回 null
**Step 4:** 跑 tsc + 测试

---

### Task 18: 前端 StepTracker 重写 + WebSocket 接收

**Files:**
- Rewrite: `components/chat/rich-blocks/step-tracker.tsx` — 从 `ToolEvent[]` 渲染
- Modify: `components/chat/message-bubble.tsx` — 传 `toolEvents` 而非 `thinking`
- Modify: WebSocket 消息处理 — 接收 `assistant_tool_event`

**Step 1:** StepTracker 重写：`import { ToolEvent }` → 按 status 渲染图标 + toolName + args
**Step 2:** `message-bubble.tsx`：`<StepTracker toolEvents={message.toolEvents ?? []} />`
**Step 3:** WebSocket 处理 `assistant_tool_event` → 追加到对应 message 的 toolEvents
**Step 4:** 跑 tsc

---

### Task 19: 冗余代码清理（⚠️ 必须完成）

**要删除的代码清单：**

| 文件 | 要删的代码 | 原因 |
|------|-----------|------|
| `step-tracker.tsx` | `parseThinkingToSteps()`、`cleanThinkingText()`、`ToolStep` 类型、所有正则 | 被 `ToolEvent[]` 结构化数据替代 |
| `message-bubble.tsx` | thinking 解析的 useMemo + cleanThinkingText 调用 | StepTracker 直接消费 toolEvents，不需要前端解析 |
| `claude-runtime.ts` | `formatClaudeToolInput()` 函数（约 35 行） | 工具摘要不再由 parseActivityLine 生成 |
| `codex-runtime.ts` | `parseActivityLine()` 中 command_execution/file_change 摘要代码 | 移到 transformToolEvent |
| `gemini-runtime.ts` | `formatGeminiParams()` 函数（约 35 行）+ parseActivityLine 工具部分 | 移到 transformToolEvent |

**Step 1:** 逐个文件删除上述冗余代码
**Step 2:** 跑全量 tsc（前端 + API + shared）确认无引用断裂
**Step 3:** 跑全量测试确认无回归

---

### Task 20: 端到端验证

**Step 1:** 跑全量 tsc（前端 + API + shared）
**Step 2:** 跑全量测试
**Step 3:** 手动验证：启动 dev server → 发消息 → 确认 StepTracker 显示结构化工具步骤、thinking 只含纯推理、德彪中文正常
**Step 4:** 确认冗余代码清单全部已删除，`grep` 验证无残留正则

---

### 执行顺序和依赖关系

```
Task 6 (ToolEvent 类型)
  ↓
Task 7 (DB migration) ← 依赖 Task 6
  ↓
Task 8 (repository) ← 依赖 Task 7
  ↓
Task 9 (session-service) ← 依赖 Task 8
  ↓
Task 10 (WebSocket 事件) ← 依赖 Task 6
  ↓
Task 11-13 (三个 runtime) ← 依赖 Task 6，可并行
  ↓
Task 14 (cli-orchestrator) ← 依赖 Task 11-13
  ↓
Task 15 (message-service) ← 依赖 Task 9, 10, 14
  ↓
Task 16 (编码修复) ← 独立，可随时做
  ↓
Task 17 (清理 parseActivityLine) ← 依赖 Task 11-13
  ↓
Task 18 (前端 StepTracker) ← 依赖 Task 10, 15
  ↓
Task 19 (冗余代码清理) ← 依赖 Task 17, 18
  ↓
Task 20 (端到端验证)
```

### 与当前 worktree 的关系

当前 `multi-agent-f006-fixes` worktree 中有 5 个未提交文件：
- **保留 cherry-pick**: message-service.ts（emitThreadSnapshot 补发）、markdown-message.tsx（useMemo）、status-panel.tsx（定时器稳定化）、message-bubble.tsx（memo）
- **丢弃**: step-tracker.tsx 的正则改动 — 被 event transformer 彻底替代
