---
id: B013
status: fixed
resolved: 2026-04-14
related: F006
---

# B013 — 前端输出不统一/丑 + 德彪窜房间 + 心里话/工具折叠

Related: F006

## Bug Report 六件套

### 1. 报告人
小孙（产品负责人），2026-04-14 多轮实测后反复反馈

### 2. Bug 现象

**A. 前端输出不统一、好丑**
agent 消息中，工具调用在深色终端块（CliOutputBlock），文本回复在浅色泡泡（BlockRenderer）——两种视觉语言冲突，和 clowder-ai 统一的深色终端风格差距大。

**B. 德彪 review 窜到另一个房间**
A2A 回程的 status 消息和 fBloat 检测/自动续接的 status 消息缺少 `sessionGroupId`，导致前端无法过滤，消息泄漏到当前活跃会话。

**C. 心里话/深度思考问题**
- 德彪（Codex）: stderr 垃圾进入 thinking（已在 commit `111e30c` 修复 14 个过滤模式）
- 仁勋（Claude）: CLI 不暴露 thinking 事件（CLI 设计限制，无法修复）
- 桂芬（Gemini）: `event.thought` 通路正常

### 3. 复现步骤

**Bug A:**
1. 启动应用，向任意 agent 发送需要工具调用的消息（如"读 README"）
2. 期望：工具调用和文本回复视觉统一
3. 实际：工具调用在深色块，文本回复在浅色泡泡，视觉割裂

**Bug B:**
1. 打开两个会话 A 和 B
2. 在 A 中让 agent 执行长任务（触发 fBloat 检测或自动续接）
3. 切换到 B
4. 期望：B 不受 A 的 status 消息影响
5. 实际：A 的 status 消息出现在 B 中

### 4. 根因分析

**Bug A — 逐行对比 cli-output-block.tsx (392行) vs clowder-ai CliOutputBlock.tsx (468行)**

| 维度 | Clowder AI | 我们（修复前） |
|------|-----------|---------------|
| 内容渲染 | 工具 + text 事件统一在深色块内 | 工具在深色块，文本在外部 BlockRenderer |
| 布局事件 | `useLayoutEffect` 派发 `chat-layout-changed` | 无 → 虚拟滚动可能跳动 |
| PawPrint 图标 | 有 | 无 |
| data-testid | 有 | 无 |
| stdout 分隔符 | `─── stdout ───` 分隔工具和文本 | 无 |

**核心问题：message-bubble.tsx 渲染顺序为 CliOutputBlock(tools) → Thinking → BlockRenderer(content)，三个组件各自独立渲染，视觉割裂。Clowder-ai 将 tools + content 统一在一个深色终端块内。**

**Bug B — 4 处 status emit 缺 sessionGroupId**

| 位置 | 说明 | thread 可用？ |
|------|------|-------------|
| line 626 | 线程未找到 | ❌ null |
| line 760 | 线程未找到 | ❌ null |
| line 1114 | fBloat 检测 | ✅ 有 |
| line 1250 | 自动续接 | ✅ 有 |

Lines 626/760 是错误响应（thread=null），只发给请求方 socket。Lines 1114/1250 是真 bug——thread 存在但 status 未携带 sessionGroupId。

### 5. 修复方案

**Bug A（commit `949b133`）：**
1. `cli-output-block.tsx` 新增 `content?: string` prop，在展开体底部渲染文本（MarkdownMessage + 深色主题样式 `[&_p]:text-slate-300` 等）
2. `─── stdout ───` 分隔符分隔工具和文本
3. `message-bubble.tsx` 改渲染逻辑：有 toolEvents 时 `<CliOutputBlock content={message.content} />`，无 toolEvents 时 `<BlockRenderer />`
4. 新增 `useLayoutEffect` 派发 `chat-layout-changed` 虚拟滚动重算事件
5. 新增 PawPrint 图标和 `data-testid` 属性

**Bug B（commit `949b133`）：**
- `message-service.ts` line 1114: fBloat 检测 status 补 `sessionGroupId: thread.sessionGroupId`
- `message-service.ts` line 1250: 自动续接 status 补 `sessionGroupId: thread.sessionGroupId`

**放弃的备选**：
- 全局 socket room 隔离（ws 层做 join/leave room）→ 改动面太大，当前逐事件过滤已足够
- thinking 统一到 CliOutputBlock 内 → thinking 和 tool 是不同类型的信息，分开渲染语义更清晰

### 6. 验证方式

**Bug A 验证**：
- 前端 `tsc --noEmit`: 零错误
- 启动开发服务器，向三个 agent 发送工具调用消息，确认工具 + 文本在同一个深色终端块内统一渲染
- 确认折叠/展开时虚拟滚动不跳动

**Bug B 验证**：
- API `tsc --noEmit`: 5 个预存错误（非本次引入）
- 测试 24/24 通过
- 打开两个会话，在 A 中触发长任务，确认 B 不受 A 的 status 消息影响
