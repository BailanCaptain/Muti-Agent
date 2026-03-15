# 技术栈总览

## 前端

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- Zustand

前端职责很明确：

- 渲染统一聊天室界面
- 维护当前会话组、本地草稿和实时连接状态
- 通过 WebSocket 发送 `send_message` / `stop_thread`
- 接收后端推送的 `assistant_delta`、`message.created`、`thread_snapshot`、`status`

对应代码：

- `app/page.tsx`
- `components/stores/chat-store.ts`
- `components/stores/thread-store.ts`
- `components/ws/client.ts`

## 后端

- Fastify
- `@fastify/websocket`
- TypeScript

后端不是单纯的 API 层，它还承担了 orchestrator 的职责：

- 解析前端 WebSocket 事件
- 持久化消息、会话组和 invocation
- 拉起不同的 CLI runtime
- 把 CLI 的增量输出再推回前端
- 为 agent 暴露 callback API
- 在公开消息里继续做 `@agent` 分发，完成 A2A 协作

对应代码：

- `packages/api/src/routes/ws.ts`
- `packages/api/src/services/message-service.ts`
- `packages/api/src/orchestrator/dispatch.ts`
- `packages/api/src/orchestrator/invocation-registry.ts`
- `packages/api/src/runtime/cli-orchestrator.ts`
- `packages/api/src/routes/callbacks.ts`

## 存储

- SQLite

SQLite 当前保存的是系统运行事实，不只是聊天记录：

- session group
- thread
- message
- invocation
- agent event

对应代码：

- `packages/api/src/db/sqlite.ts`
- `packages/api/src/db/repositories/session-repository.ts`

## 协作扩展层

- callback API
- MCP server
- skills loader / matcher
- A2A dispatch queue

这几层让系统从“一个页面调三个 CLI”升级成“多个 agent 在同一条协作链里接力”。

如果你要看详细链路，请继续看：

- `docs/a2a-and-realtime.md`
