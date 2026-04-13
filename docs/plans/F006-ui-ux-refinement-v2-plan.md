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
