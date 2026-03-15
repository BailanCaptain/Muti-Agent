# A2A 与前后端通信详解

这份文档专门回答三个问题：

1. 前端把一条消息发出去之后，后端到底怎么接住并调起 CLI？
2. agent 在运行时怎么把增量内容、状态和公开消息再推回聊天室？
3. A2A 协作具体是怎么触发、排队和继续执行的？

下面的解释都直接对应当前代码，而不是抽象示意图。

## 1. 总体角色分工

### 前端负责什么

前端负责两件事：

- 把用户输入整理成一个标准的实时事件发给后端
- 把后端推回来的标准事件更新到 Zustand store，再渲染成界面

关键文件：

- `components/chat/composer.tsx`
- `components/stores/chat-store.ts`
- `components/ws/client.ts`
- `app/page.tsx`
- `components/stores/thread-store.ts`

### 后端负责什么

后端负责把“聊天输入”变成“可追踪的 agent 运行”：

- 创建用户消息
- 创建 assistant 占位消息
- 注册 invocation 身份
- 拉起 runtime
- 把 CLI 输出变成 websocket 事件
- 在需要时通过 callback API 和 A2A 继续协作

关键文件：

- `packages/api/src/routes/ws.ts`
- `packages/api/src/services/message-service.ts`
- `packages/api/src/runtime/cli-orchestrator.ts`
- `packages/api/src/routes/callbacks.ts`
- `packages/api/src/orchestrator/dispatch.ts`
- `packages/api/src/orchestrator/invocation-registry.ts`

## 2. 前端发消息到后端的链路

### 第一步：用户提交输入

入口在 `components/chat/composer.tsx`。

提交表单时，组件调用：

- `useChatStore().sendMessage`

这一步不直接碰 WebSocket 细节，而是先经过 store。

### 第二步：前端组装标准事件

`components/stores/chat-store.ts` 里：

- 调用 `useThreadStore.getState().buildSendPayload(input)`
- 解析 `@agent`
- 找到目标 `provider` 和对应 `threadId`
- 通过 `socketClient.send(...)` 发出：

```ts
{
  type: "send_message",
  payload: {
    threadId,
    provider,
    content,
    alias
  }
}
```

为什么这里就把 `threadId` 和 `provider` 一起发过去？

- 前端已经知道当前会话组里每个 provider 对应哪个 thread
- 后端的 ws route 就可以保持简单，只处理“运输”和“交给 service”

### 第三步：浏览器通过 WebSocket 发给 Fastify

`components/ws/client.ts` 只做一件事：

- 把标准事件序列化成 JSON
- 通过同一个 WebSocket 连接发出去

对应的后端入口是：

- `packages/api/src/routes/ws.ts`

`registerWsRoute` 的 `wsHandler` 收到浏览器消息后，会：

1. `JSON.parse(raw.toString())`
2. 转成 `RealtimeClientEvent`
3. 交给 `options.messages.handleClientEvent(...)`

也就是说：

- `routes/ws.ts` 不做业务判断
- 真正的调度逻辑都放在 `MessageService`

## 3. 后端如何把一条聊天输入变成一次 agent 运行

### 第一步：写入用户消息

代码在：

- `packages/api/src/services/message-service.ts`

`handleSendMessage(...)` 会先：

1. 找到目标 thread
2. `appendUserMessage`
3. `registerUserRoot(userMessage.id)`

这里的 `rootMessageId` 很关键。

它不是给前端看的，而是给协作链看的：

- 同一条用户消息触发出来的后续 agent 接力
- 都会挂在同一个 root 上
- 后面做 hop 限制、A2A 去重和链路追踪都靠它

### 第二步：立刻把用户消息推回前端

服务端接着会发两个事件：

- `message.created`
- `thread_snapshot`

这样前端不需要等 CLI 启动完，用户消息会立即出现在时间线里。

### 第三步：创建 assistant 占位消息

真正拉起 CLI 前，`runThreadTurn(...)` 会先：

1. `appendAssistantMessage(thread.id, "")`
2. 把这个占位消息绑定到当前 `rootMessageId`
3. 立即发一个 `message.created`

这样做的原因非常现实：

- CLI 的输出通常是流式的
- 后续每个 `assistant_delta` 都必须知道该追加到哪一条消息

如果不先建占位消息，前端就没有稳定的目标气泡可以追加内容。

### 第四步：注册 invocation 身份

还是在 `runThreadTurn(...)` 里：

- `InvocationRegistry.createInvocation(thread.id, thread.alias)`

这里生成的是一组临时身份：

- `invocationId`
- `callbackToken`
- `threadId`
- `agentId`
- `expiresAt`

对应代码：

- `packages/api/src/orchestrator/invocation-registry.ts`

这组身份的用途是：

- 让 callback API 能确认“是谁在发请求”
- 防止裸请求直接伪造 agent 行为
- 把正在运行的 CLI turn 和后续 callback 操作绑定起来

## 4. runtime 如何拉起不同的 CLI

入口在：

- `packages/api/src/runtime/cli-orchestrator.ts`

`runTurn(...)` 做的事情是：

1. 根据历史消息构造 prompt
2. 注入 system prompt
3. 注入技能 prompt
4. 选择对应 runtime 适配器
5. 通过环境变量传入 invocation 身份和 callback 信息

几个关键环境变量：

- `MULTI_AGENT_API_URL`
- `MULTI_AGENT_INVOCATION_ID`
- `MULTI_AGENT_CALLBACK_TOKEN`
- `MULTI_AGENT_MODEL`
- `MULTI_AGENT_NATIVE_SESSION_ID`

这一步的设计重点是：

- 上层统一 `RunTurnOptions`
- 下层 `codexRuntime` / `claudeRuntime` / `geminiRuntime` 各自处理命令差异

所以 orchestrator 看起来像这样：

```text
MessageService
  -> runTurn
    -> runtime adapter
      -> CLI process
```

## 5. CLI 输出为什么能实时回到前端

### stdout 走增量文本

`cli-orchestrator.ts` 里：

- `runtime.runStream(...)`
- `onStdoutLine(...)`

如果一行 stdout 是 JSON 事件，就尝试解析：

- assistant delta
- session id
- model

如果不是结构化 JSON，也会退化成普通文本 delta。

然后 `MessageService` 会把它转成：

- `assistant_delta`

再由 websocket route 推给浏览器。

### stderr 走活动流

同时，runtime 也会把 stdout / stderr 的活动通过 `onActivity` 往上抛。

`MessageService` 会记录为：

- `invocation.activity`

此外，这里还专门做了一层“确认提示提取”：

- 如果 CLI 在 stderr 里输出“请确认 / need your confirmation / please provide ...”
- 服务端会把这段提示写回当前 assistant 消息
- 然后暂停本轮运行

这样前端能直接看到 agent 的追问，而不会卡在一个空白气泡里。

## 6. 前端如何消费这些实时事件

浏览器的主入口在：

- `app/page.tsx`

页面只做事件分发：

- `assistant_delta` -> `applyAssistantDelta`
- `message.created` -> `appendTimelineMessage`
- `thread_snapshot` -> `replaceActiveGroup`
- `status` -> `setStatus`

真正的合并策略在 `components/stores/thread-store.ts`：

- `mergeTimeline(...)`

这里为什么不是“快照来了就整段替换”？

因为流式过程里经常会出现：

- 本地已经拼到了更长的 assistant 文本
- 数据库快照还稍微落后一点

如果直接替换，界面会出现内容回退闪烁。

所以这里做的是：

- 优先保留更长的那份文本
- 再按 `createdAt` 排序

## 7. callback API 到底解决什么问题

callback API 的代码在：

- `packages/api/src/routes/callbacks.ts`

它提供三类能力：

### `POST /api/callbacks/post-message`

作用：

- agent 在运行期间主动往当前 thread 发一条公开消息

典型用途：

- 中间状态同步
- 主动解释
- 呼叫下一个 agent

### `GET /api/callbacks/thread-context`

作用：

- agent 读取自己当前 thread 最近的上下文

适用场景：

- CLI 不是原生 MCP，但仍然需要“看最近消息”

### `GET /api/callbacks/pending-mentions`

作用：

- agent 查询在自己运行期间有没有新的公开 mention

适用场景：

- 需要看 A2A 队列前后的补充信息

### 为什么 callback API 需要 `callbackToken`

因为这些接口不是给浏览器直接开放业务能力的，而是给“当前正在执行的 agent”开的临时后门。

只有：

- invocationId 匹配
- callbackToken 匹配
- 没过期

才允许调用。

## 8. A2A 是怎么触发的

真正的 A2A 调度在：

- `packages/api/src/orchestrator/dispatch.ts`

核心入口：

- `enqueuePublicMentions(...)`

它只处理“公开消息里的 mention”，包括：

- 用户消息里的 `@agent`
- agent 通过 callback 发出来的公开消息里的 `@agent`
- agent 最终回答里的 `@agent`

### 触发流程

1. 解析公开消息里的 mention
2. 跳过自己 mention 自己的情况
3. 对单条消息做 provider 去重
4. 对同一 root 协作链做 provider 去重
5. 做 hop 限制
6. 把下一个 agent 的任务放入队列

这部分为什么这么多去重和限制？

因为如果没有这些约束，agent 很容易出现：

- A 提到 B
- B 又提到 A
- 两边不断 ping-pong

所以 `DispatchOrchestrator` 里专门维护了：

- `messageRoots`
- `rootHopCounts`
- `messageTriggeredProviders`
- `rootTriggeredProviders`
- `queues`

## 9. A2A 为什么不是立刻并发触发

看 `takeNextQueuedDispatch(...)`：

- 同一个 session group 里，只要还有 thread 在跑
- 就先不触发下一跳

这是有意设计成串行的。

好处是：

- 共享上下文更稳定
- 时间线顺序更容易理解
- 更容易追踪每一跳是谁触发谁

也就是说当前系统更偏向：

```text
可解释的接力式协作
```

而不是：

```text
完全并发的黑箱式群聊
```

## 10. 一条完整的 A2A 链路示例

假设用户输入：

```text
@claude 先分析这个问题，如果需要就 @codex review
```

实际链路如下：

1. 前端发送 `send_message`
2. `MessageService.handleSendMessage` 写入用户消息
3. 创建 rootMessageId
4. 创建 Claude 的 assistant 占位消息
5. 注册 invocation 身份
6. `runTurn` 拉起 Claude CLI
7. Claude 产生流式输出，前端收到 `assistant_delta`
8. Claude 最终文本或 callback 公开消息里出现 `@codex`
9. `dispatch.enqueuePublicMentions(...)` 识别到下一跳
10. 当前 invocation 结束后，`flushDispatchQueue(...)` 取出下一跳
11. `runThreadTurn(...)` 再拉起 Codex
12. Codex 基于共享上下文继续接力

所以真正的协作骨架是：

```text
公开消息 -> mention 解析 -> 队列 -> 下一跳 runtime
```

而不是直接让两个 CLI 彼此长连接互聊。

## 11. 关键对象分别解决什么问题

### `threadId`

解决：

- 一条消息到底属于哪个 provider 线程

### `sessionGroupId`

解决：

- 三个 provider 的 thread 如何组成同一个会话房间

### `rootMessageId`

解决：

- 一整条协作链如何串起来
- hop 限制和去重如何按同一条链计算

### `invocationId`

解决：

- 当前这次 CLI 运行如何被唯一标识

### `callbackToken`

解决：

- callback API 如何确认请求来自当前这次 agent 运行

## 12. 读代码时建议的顺序

如果你要真正吃透这个项目，建议按这个顺序读：

1. `components/chat/composer.tsx`
2. `components/stores/chat-store.ts`
3. `components/ws/client.ts`
4. `app/page.tsx`
5. `packages/api/src/routes/ws.ts`
6. `packages/api/src/services/message-service.ts`
7. `packages/api/src/runtime/cli-orchestrator.ts`
8. `packages/api/src/routes/callbacks.ts`
9. `packages/api/src/orchestrator/dispatch.ts`
10. `packages/api/src/orchestrator/invocation-registry.ts`

这样你会先理解：

- 前端怎么发
- 后端怎么接
- CLI 怎么跑
- callback 怎么回流
- A2A 怎么继续

## 13. 当前设计的边界

这套链路现在的优点是：

- 清晰
- 可追踪
- 易调试
- 适合单机多 agent 协作

当前没有优先做的事情包括：

- 全并发 A2A
- 多租户权限体系
- 云端分布式队列
- 超复杂富块协议

这不是缺陷，而是当前架构阶段的取舍。

先把：

- 消息链路
- invocation 身份
- callback 调用
- A2A 接力

做稳，后面再扩复杂能力，代价最低。
