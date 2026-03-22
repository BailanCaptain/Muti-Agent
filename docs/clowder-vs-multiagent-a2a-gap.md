# Clowder AI vs Multi-Agent：A2A 有序性差距深度分析

> 本文基于两个项目的完整源码对比，解释为什么 Clowder AI 的多智能体协作更有序，以及 Multi-Agent 该如何收敛。

---

## 一句话结论

Clowder AI 是**结构化任务路由系统**：每次 @mention 产生一个带有所有权、来源、上下文快照的任务条目，通过每槽独立互斥锁并发执行，多条路径（callback + 文本扫描）受双重去重保护。

Multi-Agent 是**共享群聊接话系统**：@mention 只是字符串匹配，触发后把三句模糊提示放进一个全组串行队列，agent 读到的是实时混合时间线，callback 路径和 stdout 路径会对同一内容双重入队。

---

## 差距总览

| 维度 | Multi-Agent | Clowder AI | 影响 |
|------|------------|-----------|------|
| 路由原语 | 字符串匹配 + 模糊提示 | 结构化 `QueueEntry`，携带 from/to/taskSnippet | 桂芬问题：回复对象漂移 |
| 执行并发 | 全组串行（一次一只） | 每槽 `(threadId, catId)` 独立互斥 | 排队等待，顺序放大上下文污染 |
| 上下文隔离 | 实时混合时间线（last 40） | 分发时冻结快照 + `cursorBoundaries` | 德彪先回，桂芬看到的"最新"变成德彪的回复 |
| 跨路径去重 | 无 | `hasActiveOrQueuedAgentForCat` 双路互斥 | 德彪双发：callback 路径 + stdout 路径各触发一次 |
| 调用隔离 | sessionGroup 级 | `parentInvocationId` 级（F108） | 并发调用互不干扰 |
| 消息分类 | 无分类（全是 assistant 气泡） | `progress` / `final` / `a2a_handoff` | 进度播报和正式答复无法区分 |
| MCP 工具集 | 2 个（post_message, get_thread_context） | 10+ 个（任务、记忆、协作全集） | agent 无法感知任务状态、历史记忆 |
| 记忆管理 | 仅 SQLite 消息记录 + nativeSessionId | session 摘要 + evidence search + reflect | agent 无跨会话记忆，重开就忘 |
| 去重副作用 | rootTriggeredProviders 封死合法二次回合 | QueueEntry source+slot 精确去重 | 同一 root 下同一 provider 只能出场一次 |

---

## 差距一：任务路由模型——群聊接话 vs 结构化任务

### Multi-Agent 的现状

当 A2A 分发时，传给下一只 agent 的是三行字符串（`dispatch.ts:183-187`）：

```typescript
content: [
  `You were mentioned by ${options.sourceAlias} in the shared room.`,
  `Latest public message: ${options.content}`,
  `Read the shared room context and continue the collaboration as ${mention.alias}.`,
].join("\n")
```

这里没有：
- `replyToMessageId`：不知道自己要回复哪条消息
- `taskSnippet`：不知道"给我的那段任务"是什么
- `callerCatId`：没有调用者所有权，任何消息都能触发任何 agent

dispatch 队列的结构（`dispatch.ts:15-24`）：

```typescript
export type QueuedDispatch = {
  sessionGroupId: string
  rootMessageId: string       // 只知道链条源头
  sourceMessageId: string     // 触发消息 ID（不注入给 agent）
  sourceProvider: Provider
  sourceAlias: string
  targetProvider: Provider
  targetAlias: string
  content: string             // 只有上面那三句话
}
```

`sourceMessageId` 字段存在，但**不传给 agent**。agent 收到后只能调用 `get_thread_context` 读取实时时间线，而此时时间线已经包含了串行执行中前一只 agent 的新回复。

### Clowder AI 的做法

`QueueEntry`（`InvocationQueue.ts`）携带完整的结构化语义：

```typescript
interface QueueEntry {
  id: string
  threadId: string
  userId: string
  content: string                   // 完整原始内容（不是重组的三行字）
  messageId: string | null          // 触发消息 ID（AC-B6-P1 回填）
  mergedMessageIds: string[]        // 合并消息的 ID 列表
  source: 'user' | 'connector' | 'agent'  // 明确来源
  targetCats: string[]              // 明确目标（可多个）
  intent: string                    // 'execute' 等任务意图
  status: 'queued' | 'processing'
  createdAt: number
  autoExecute: boolean              // F122B：是否自动执行（A2A 条目为 true）
  callerCatId?: string              // 谁发起的 A2A（所有权守护）
}
```

`WorklistRegistry`（`WorklistRegistry.ts`）进一步记录：

```typescript
interface WorklistEntry {
  list: CatId[]
  a2aFrom: Map<CatId, CatId>           // 每只被 A2A 触发的 cat，记录是谁触发的
  a2aTriggerMessageId: Map<CatId, string>  // 触发消息 ID
  a2aCount: number
  maxDepth: number
  executedIndex: number
}
```

**关键差异**：agent 执行时，路由层会把 `a2aFrom`（谁触发我）和 `a2aTriggerMessageId`（哪条消息触发）一起带入上下文组装，agent 不需要自己猜"我该回复谁"。

### 调用者守护

Clowder AI 在 `WorklistRegistry.pushToWorklist()` 里有 caller guard：

```typescript
if (callerCatId !== undefined) {
  const currentCat = entry.list[entry.executedIndex]  // 当前正在执行的 cat
  if (currentCat !== callerCatId) {
    return { added: [], reason: 'caller_mismatch' }   // 拒绝陈旧 callback
  }
}
```

**含义**：只有当前正在执行位置的 cat 才能向 worklist 追加新目标。一个已经被抢占的旧 invocation 的 callback 回来时，由于当前执行位置已经移动，会被拒绝。

Multi-Agent 没有这个守护——任何持有有效 `callbackToken` 的 invocation 都可以触发下一跳，即使该 invocation 已经过时。

---

## 差距二：Cross-Path 双路触发——德彪为什么每次回两条

### 问题复现路径

Multi-Agent 里一次 invocation 存在两条输出面：

**路径 A：Callback API（`callbacks.ts:72`）**
```
Codex 运行中 → MCP post_message → POST /api/callbacks/post-message
  → repository.appendMessage(thread.id, "assistant", content)   ← 消息入库 #1
  → onPublicMessage() → enqueuePublicMentions()                 ← A2A dispatch #1
```

**路径 B：Stdout（`message-service.ts:393`）**
```
Codex 进程退出 → runTurn().promise resolved
  → sessions.overwriteMessage(assistant.id, { content: result.content })  ← 消息入库 #2
  → enqueuePublicMentions(result.content, matchMode: "line-start")         ← A2A dispatch #2
```

路径 A 把消息写入一条新记录；路径 B 把预先创建的空占位覆盖写入另一条记录。如果 Codex 既走 callback 又在 stdout 输出同样内容，结果是两条内容相同的 assistant 消息，两次 A2A dispatch。

数据库验证：全库中 `assistant_msgs > invocations` 的 thread，`codex` 有 28 个，`gemini` 有 8 个，`claude` 只有 1 个。

### Clowder AI 的修法（commit a11fd9d）

在 `route-serial.ts` 的文本扫描路径里，执行前先查 InvocationQueue 状态：

```typescript
for (const nextCat of mentions) {
  // ─── Cross-path 去重守护 ───────────────────────────────────────────
  if (hasQueuedOrActiveAgentForCat && hasQueuedOrActiveAgentForCat(threadId, nextCat)) {
    log.info(
      { threadId, catId: nextCat, fromCat: catId },
      'A2A text-scan dedup: cat already in InvocationQueue, skipping'
    )
    continue   // Callback 路径已经入队 → 文本扫描路径跳过
  }
  // ────────────────────────────────────────────────────────────────────

  // 继续正常 worklist 追加...
}
```

关键是两个粒度不同的查询方法，分别用于两条路径：

```typescript
// Callback 路径去重（只检查 queued 状态）
hasQueuedAgentForCat(threadId: string, catId: string): boolean {
  return this.entries.some(
    (e) => e.threadId === threadId &&
           e.source === 'agent' &&
           e.status === 'queued' &&         // 只查 queued
           e.targetCats.includes(catId)
  )
}

// 文本扫描路径去重（检查 queued + processing）
hasActiveOrQueuedAgentForCat(threadId: string, catId: string): boolean {
  return this.entries.some(
    (e) => e.threadId === threadId &&
           e.source === 'agent' &&
           (e.status === 'queued' || e.status === 'processing') &&  // 两个状态都挡
           e.targetCats.includes(catId)
  )
}
```

`hasQueuedAgentForCat` 用于 callback 路径自身去重（不重复入队同一 cat）；`hasActiveOrQueuedAgentForCat` 用于文本扫描路径，连"已经在处理中"的也要拦截，防止文本扫描在 callback 条目正在执行时又追加一次。

### Multi-Agent 的当前状态

`dispatch.ts` 里的 `rootTriggeredProviders`（`dispatch.ts:48`）只做了 root 级别的去重：

```typescript
// 同一 root chain 内，同一 provider 只能被触发一次
if (alreadyTriggered.has(mention.provider) || dedupedProviders.has(mention.provider)) {
  continue
}
```

这个去重是跨 root 状态机层面的，而双路触发发生在**同一个 invocation 的两条输出面**，不是两个不同的 root chain，所以 `rootTriggeredProviders` 挡不住双路触发。

副作用：`rootTriggeredProviders` 还有一个问题——它把同一 root chain 下同一 provider 的**合法二次回合**也封死了（`dispatch.ts:160-162`）：

```typescript
if (alreadyTriggered.has(mention.provider) || dedupedProviders.has(mention.provider)) {
  continue  // 合法的"黄仁勋再次被触发"也会被跳过
}
```

Clowder AI 用 `source='agent'` 精确标记 A2A 来源，只去重 agent-sourced 条目，user-sourced 的新回合不受影响。

---

## 差距三：上下文隔离——桂芬为什么回复了德彪

### 时序放大问题

Multi-Agent 的 `flushDispatchQueue`（`message-service.ts:455-490`）是全组串行执行：

```typescript
// 全组互斥：任何一条线程在跑，就不取下一个 dispatch
const hasRunningThread = groupThreads.some((thread) => runningThreadIds.has(thread.id))
if (hasRunningThread) {
  return null   // 等所有人都停了才处理下一个
}
```

时序展开（黄仁勋同时 @德彪 和 @桂芬 不同问题）：

```
T=0  黄仁勋发消息，mention 队列：[德彪, 桂芬]
T=1  德彪开始执行（阻塞桂芬）
T=2  德彪执行完，回复落库
T=3  桂芬开始执行
     → 桂芬调用 GET /api/callbacks/thread-context（limit=40）
     → 返回的是截至 T=3 的全量时间线，T=2 德彪的回复已经在里面
     → "continue the collaboration as 桂芬" → 桂芬看到最新消息是德彪的回复
     → 桂芬顺着德彪接话，而不是回答黄仁勋给它的问题
```

`thread-context` 返回的是实时混合时间线（`callbacks.ts:137-148`）：

```typescript
const messages = threads
  .flatMap((t) =>
    options.repository.listMessages(t.id).map((message) => ({
      // ...
    })),
  )
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  .slice(-limit)       // 最近 40 条，不分 snapshot 时刻
```

没有 `before_message_id` 参数，每次都是 live 状态。

### Clowder AI 的做法

**ADR-008 Context Freezing**：`executeEntry` 在 QueueProcessor 里维护 `cursorBoundaries`，只在 invocation 成功后才推进游标：

```typescript
const cursorBoundaries = new Map<string, string>()
const persistenceContext: PersistenceContext = { failed: false, errors: [] }

// routeExecution 执行时传入边界
for await (const msg of router.routeExecution(
  userId, entry.content, threadId, entry.messageId,
  entry.targetCats, { intent: entry.intent },
  {
    cursorBoundaries,        // 收集游标边界
    persistenceContext,
    currentUserMessageId: entry.messageId,  // 锚定到入队时的消息 ID
    // ...
  }
)) { ... }

// 成功后才 ack（游标才推进）
await router.ackCollectedCursors(userId, threadId, cursorBoundaries)
```

**per-cat 上下文组装**：`route-serial.ts` 维护 `previousResponses` 数组，每只 cat 执行时，prompt 里明确包含了"前几只 cat 已经说了什么"：

```typescript
let previousResponses: Array<{ catId: string; content: string }> = []

// 每次执行时
let prompt = message
if (previousResponses.length > 0) {
  prompt = `${message}\n\n${previousResponses.map(
    (r) => `@${r.catId}: ${r.content}`
  ).join('\n\n')}`
}

// 执行完追加
previousResponses.push({ catId, content: response })
```

agent 收到的 prompt 里**已经显式包含前一只 agent 的回复**，不需要自己去 `thread-context` 猜。

---

## 差距四：并发执行模型——全组串行 vs 每槽独立

### Multi-Agent：全组串行

`activeInvocations`（`dispatch.ts:50`）在 sessionGroup 级别追踪：

```typescript
private readonly activeInvocations = new Map<string, Set<string>>()
// key: sessionGroupId，value: Set of invocationIds
```

`takeNextQueuedDispatch`（`dispatch.ts:235`）：

```typescript
const hasRunningThread = groupThreads.some((thread) => runningThreadIds.has(thread.id))
if (hasRunningThread) {
  return null  // 整组任何一条线程在跑 → 不取下一个
}
```

**结果**：黄仁勋 → 德彪和桂芬，即使两者完全独立，桂芬也必须等德彪跑完。等待时间 = 德彪完整执行时间（可能几分钟）。等桂芬终于开始，时间线已经被德彪的回复污染。

### Clowder AI：每槽独立

`InvocationTracker`（`InvocationTracker.ts`）的 slot key 是 `${threadId}:${catId}`：

```typescript
class InvocationTracker {
  private active = new Map<string, ActiveInvocation>()
  // key: `${threadId}:${catId}`，每只 cat 独立

  start(threadId: string, catId: string, ...): AbortController {
    const key = slotKey(threadId, catId)
    this.active.get(key)?.controller.abort()  // 只 abort 同一 slot
    // 其他 slot 不受影响
  }

  has(threadId: string, catId?: string): boolean {
    if (catId) return this.active.has(slotKey(threadId, catId))
    // 不传 catId = 查整个 thread 是否有任何 slot 活跃
  }
}
```

`QueueProcessor.tryAutoExecute`（`QueueProcessor.ts`）：

```typescript
for (const entry of entries) {
  const entryCat = entry.targetCats[0]
  const sk = slotKey(threadId, entryCat)

  if (this.processingSlots.has(sk)) continue     // 该 cat 在执行中 → 跳过
  if (this.deps.invocationTracker.has(threadId, entryCat)) continue

  // 其他 cat 的 slot 不影响这里 → 可以并发启动
  this.processingSlots.add(sk)
  void this.executeEntry(entry).then(...)
}
```

**结果**：黄仁勋 → 德彪和桂芬，两者可以**真正并行执行**，桂芬不需要等德彪。各自在各自的 slot 里独立运行。

---

## 差距五：调用隔离（F108 parentInvocationId）

Multi-Agent 的 WorklistRegistry 等价物（`queues: Map<string, QueuedDispatch[]>`）以 sessionGroupId 为键，多个并发调用共享同一个队列：

```typescript
private readonly queues = new Map<string, QueuedDispatch[]>()
// key: sessionGroupId（全组共享）
```

Clowder AI 的 `WorklistRegistry`（`WorklistRegistry.ts`）：

```typescript
// 双层索引
const registry = new Map<string, WorklistEntry>()
// key: parentInvocationId ?? threadId

const threadIndex = new Map<string, Set<string>>()
// key: threadId → Set<registryKey>（支持多并发调用的线程级查询）

// 注册时
const registryKey = parentInvocationId ?? threadId
registry.set(registryKey, entry)
threadIndex.get(threadId)?.add(registryKey)
```

当两个并发 invocation 同时在同一 thread 活跃时（例如 connector 触发和用户触发），每个 invocation 有自己独立的 worklist，互不干扰。Multi-Agent 里则会共享同一个 queue，产生状态污染。

---

## 差距六：消息分类——进度播报 vs 正式答复

### Multi-Agent：无分类

所有 agent 输出都是同级别的 `assistant` 消息，无论是 Codex 的工具调用日志还是最终答复：

```typescript
// callbacks.ts:72
const message = options.repository.appendMessage(thread.id, "assistant", body.content.trim())
// 类型固定为 "assistant"，没有 progress/final 区分
```

数据库 `messages` 表：

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  threadId TEXT NOT NULL,
  role TEXT NOT NULL,     -- 只有 'user' 和 'assistant'，无子类型
  content TEXT NOT NULL,
  thinking TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL
)
```

### Clowder AI：显式事件分类

路由层产出多种消息类型：

```typescript
// route-serial.ts 产出的事件类型
type AgentMessage =
  | { type: 'text'; catId: string; content: string }           // 文本内容（流式）
  | { type: 'done'; catId: string; isFinal: boolean }          // 回合结束
  | { type: 'a2a_handoff'; catId: string; fromCat: string }    // A2A 交接信号
  | { type: 'status'; message: string }                        // 状态文本
  | { type: 'error'; catId: string; error: string }            // 错误
```

`QueueProcessor.executeEntry` 里显式收集最终文本：

```typescript
for await (const msg of router.routeExecution(...)) {
  if (msg.type === 'text' && msg.catId === primaryCat) {
    responseText += msg.content    // 只累积 text 类型
  }
  socketManager.broadcastAgentMessage({ ...msg, invocationId }, threadId)
}
```

前端收到 `a2a_handoff` 事件时能显式渲染"正在交给下一只 cat"的 UI 状态，而不是把所有内容平铺成一堆气泡。

---

## 差距七：MCP 工具能力

### Multi-Agent：2 个工具

`mcp/server.ts` 只暴露：

```typescript
{
  name: "post_message",
  description: "Post a public assistant message to the current thread via callback API.",
  inputSchema: { properties: { content: { type: "string" } } }
}

{
  name: "get_thread_context",
  description: "Get recent thread context for the current invocation.",
  inputSchema: { properties: { limit: { type: "number" } } }
}
```

agent 能做的只有：发消息、读消息。无法：
- 查询任务状态
- 更新任务进度
- 搜索历史记忆
- 发起讨论
- 读取 pending mentions
- 创建 rich 内容块

### Clowder AI：10+ 工具

完整工具集：

| 工具 | 用途 |
|------|------|
| `cat_cafe_post_message` | 发消息（异步） |
| `cat_cafe_get_thread_context` | 读上下文 |
| `cat_cafe_get_pending_mentions` | 查询待处理 @提及 |
| `cat_cafe_update_task` | 更新任务状态 |
| `cat_cafe_list_tasks` | 列出任务列表 |
| `cat_cafe_search_evidence` | 搜索项目知识库 |
| `cat_cafe_reflect` | 反思/合成洞察 |
| `cat_cafe_read_session_digest` | 读历史会话摘要 |
| `cat_cafe_read_session_events` | 读会话事件详情 |
| `cat_cafe_multi_mention` | 并行召唤多只 cat 讨论 |
| `cat_cafe_create_rich_block` | 创建结构化富内容 |
| `cat_cafe_register_pr_tracking` | 注册 PR review 追踪 |
| `cat_cafe_list_threads` | 列出 thread 摘要 |

**差距的直接影响**：Multi-Agent 的 agent 只能"说话"，无法"感知状态"。当黄仁勋问多个问题，agent 没有工具检查"我是否还有待回复的任务"，只能猜测，自然产生漂移。

---

## 差距八：记忆管理

### Multi-Agent：只有 nativeSessionId

跨会话连续性完全依赖 CLI 工具的原生 session 恢复：

```typescript
// session-repository.ts
updateThread(threadId: string, model: string | null, nativeSessionId: string | null) {
  this.repository.updateThread(threadId, {
    currentModel: model,
    nativeSessionId,  // 保存 Claude/Codex/Gemini 的 session ID
  })
}

// claude-runtime.ts:96-98
if (sessionId) {
  args.push("--resume", sessionId)  // 用 --resume 恢复 Claude 会话
}
```

这意味着：
- 跨 session group（不同房间）**完全失忆**
- 无法检索历史决策和教训
- 无法跨会话积累项目知识

### Clowder AI：三层记忆

1. **Session Digest**（会话摘要）：每个 session 结束后 seal，生成摘要，cat 可通过 `cat_cafe_read_session_digest` 检索

2. **Evidence Search**：`cat_cafe_search_evidence` 支持关键词搜索所有历史决策、讨论、教训

3. **Reflect**：`cat_cafe_reflect` 从项目历史中合成洞察，而不只是返回原始记录

4. **Retain Memory Callback**：`cat_cafe_retain_memory_callback` 允许 agent 主动保存重要信息到持久化知识库

实际影响：Clowder AI 的 cat 在讨论问题时会先 `cat_cafe_search_evidence` 检索相关历史，带着"我们之前怎么处理类似问题"的上下文回答，而不是每次从零开始。

---

## 差距九：A2A 去重机制的精确性

### Multi-Agent：rootTriggeredProviders 的副作用

去重逻辑（`dispatch.ts:160-162`）：

```typescript
const alreadyTriggered = this.rootTriggeredProviders.get(options.rootMessageId) ?? new Set<Provider>()

if (alreadyTriggered.has(mention.provider) || dedupedProviders.has(mention.provider)) {
  continue  // 跳过
}

alreadyTriggered.add(mention.provider)  // 立即标记（入队时就标记，非执行完后）
```

**副作用 1**：入队时就标记，而不是执行完后标记。如果第一次入队失败或被取消，provider 仍然被标记为"已触发"，无法重试。

**副作用 2**：同一 root chain 下同一 provider 永远只能被触发一次。如果黄仁勋想在同一对话链路中二次请求德彪确认，系统会静默丢弃。

**副作用 3**：无法区分"来自 callback 的触发"和"来自文本扫描的触发"，只要是同一 root 下同一 provider，统统去重。

### Clowder AI：精确的多层去重

**层 1：Per-slot mutex**（InvocationTracker）
```typescript
// 同一 (threadId, catId) slot 内的新调用直接 abort 旧调用
this.active.get(key)?.controller.abort()
```

**层 2：Callback 路径去重**（只检查 queued）
```typescript
hasQueuedAgentForCat(threadId, catId) → 仅 source='agent' && status='queued'
```

**层 3：文本扫描路径去重**（检查 queued + processing）
```typescript
hasActiveOrQueuedAgentForCat(threadId, catId) → source='agent' && (queued || processing)
```

**层 4：Queue merge**（同源同意图的连续条目合并）
```typescript
if (tail && tail.status === 'queued' && tail.source === input.source &&
    tail.intent === input.intent && arraysEqual(tail.targetCats, input.targetCats)) {
  tail.content += `\n${input.content}`  // 合并而不是重复
  return { outcome: 'merged' }
}
```

**层 5：Worklist 尾部去重**（只检查 pending 部分）
```typescript
const pending = entry.list.slice(entry.executedIndex)  // 已执行的不计入
if (!pending.includes(cat)) {
  entry.list.push(cat)
}
```

每一层针对不同的触发场景，精确去重而不误杀合法的二次触发。

---

## 整改路径（详细步骤）

### P1（本周，影响最大）：修复双路触发

**目标**：消除德彪双发，消除 A2A double-dispatch。

**改动文件**：`packages/api/src/services/message-service.ts`

**具体步骤**：

1. 在 `runThreadTurn` 的闭包变量里添加 flag：

```typescript
// message-service.ts:289 附近（runThreadTurn 内部）
let callbackMessagePosted = false    // 新增：是否已有 callback 消息
let callbackMessageRole: 'progress' | 'final' | null = null  // 新增
```

2. 修改 `handleAgentPublicMessage`（被 callbacks.ts 调用），在消息注册后记录 flag。在 `message-service.ts` 中需要对 invocationId 维护一个 `callbackPostedInvocations: Set<string>`：

```typescript
// message-service.ts 类属性
private readonly callbackPostedInvocations = new Set<string>()

// handleAgentPublicMessage 里，入队后
this.callbackPostedInvocations.add(options.invocationId)
```

3. `runThreadTurn` 的 `try` 块末尾（`message-service.ts:392` 附近），在 `overwriteMessage` 和 `enqueuePublicMentions` 前检查：

```typescript
if (!promptRequestedByCli) {
  // 修改：如果 callback 已经发过消息，stdout 只写 thinking，不触发 A2A
  const hasCallbackMessage = this.callbackPostedInvocations.has(identity.invocationId)

  if (!hasCallbackMessage) {
    // 没有 callback 消息：正常走 stdout 路径
    this.sessions.overwriteMessage(assistant.id, {
      content: result.content || "[empty response]",
      thinking,
    })
    if (result.content.trim()) {
      const enqueueResult = this.dispatch.enqueuePublicMentions({
        messageId: assistant.id,
        // ...
      })
    }
  } else {
    // 有 callback 消息：stdout 占位只保存 thinking，不再触发 A2A
    this.sessions.overwriteMessage(assistant.id, {
      content: "",   // 或者标记为 hidden
      thinking,
    })
    // 不调用 enqueuePublicMentions（callback 路径已经处理过了）
  }
  this.callbackPostedInvocations.delete(identity.invocationId)  // 清理
}
```

**预期效果**：德彪双发消失，全库 28 个 codex double-message thread 不再复现。

---

### P2（本周，配合 P1）：thread-context 加 before_message_id

**目标**：agent 读取上下文时，只能看到触发时刻及之前的内容。

**改动文件**：`packages/api/src/routes/callbacks.ts`

**具体步骤**：

1. 在 `GET /api/callbacks/thread-context` 路由（`callbacks.ts:116`）里支持 `before_message_id` 参数：

```typescript
const query = request.query as {
  invocationId?: string
  callbackToken?: string
  limit?: string
  before_message_id?: string    // 新增
}

// ...

const messages = threads
  .flatMap((t) =>
    options.repository.listMessages(t.id).map((message) => ({
      id: message.id,
      role: message.role,
      agentId: message.role === "assistant" ? t.alias : undefined,
      content: message.content,
      createdAt: message.createdAt,
    })),
  )
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  // 新增：如果指定了 before_message_id，只返回该消息之前的内容
  .filter(msg => {
    if (!query.before_message_id) return true
    // 找到 before_message_id 对应的 createdAt，然后过滤
    const anchorMsg = allMessages.find(m => m.id === query.before_message_id)
    if (!anchorMsg) return true
    return msg.createdAt <= anchorMsg.createdAt
  })
  .slice(-limit)
```

2. 在 `dispatch.ts` 的 `QueuedDispatch` 结构里记录 `sourceMessageId`（已有此字段），在分发给 agent 的 prompt content 里携带这个 ID：

```typescript
// dispatch.ts:183
content: [
  `You were mentioned by ${options.sourceAlias} in the shared room.`,
  `Latest public message: ${options.content}`,
  `Context anchor: ${options.messageId}`,   // 新增：告诉 agent 应该用哪个 ID 过滤上下文
  `Read the shared room context (before_message_id=${options.messageId}) and reply to the question directed at you as ${mention.alias}.`,
].join("\n"),
```

3. 更新 `agent-prompts.ts` 里的 Callback API 说明，告知 agent 使用 `before_message_id`：

```
- GET /api/callbacks/thread-context?before_message_id=<id> —— 读取消息 ID 之前的上下文（推荐使用，避免看到你执行期间其他 agent 的新回复）
```

---

### P3（下一迭代）：dispatch content 加 taskSnippet

**目标**：agent 明确知道"黄仁勋问我的是哪段文字"，而不是自己从整条消息里猜。

**改动文件**：`packages/api/src/orchestrator/dispatch.ts`

**具体步骤**：

1. 修改 `QueuedDispatch` 类型（`dispatch.ts:15`）：

```typescript
export type QueuedDispatch = {
  sessionGroupId: string
  rootMessageId: string
  sourceMessageId: string
  sourceProvider: Provider
  sourceAlias: string
  targetProvider: Provider
  targetAlias: string
  content: string
  taskSnippet?: string    // 新增：专门针对该 target 的任务片段
  replyToMessageId: string // 新增：agent 应该回复的消息 ID
}
```

2. 在 `enqueuePublicMentions` 里，解析消息时提取针对特定 target 的段落：

```typescript
// 提取针对 targetAlias 的段落：@alias 后面直到下一个 @alias 或消息末尾
function extractTaskSnippet(content: string, targetAlias: string): string {
  const lines = content.split('\n')
  const startIdx = lines.findIndex(line =>
    line.trim().toLowerCase().startsWith(`@${targetAlias.toLowerCase()}`)
  )
  if (startIdx === -1) return content  // 找不到则返回全文

  // 找到下一个 @ 行的位置
  const endIdx = lines.findIndex((line, idx) =>
    idx > startIdx && line.trim().startsWith('@')
  )

  const snippet = lines.slice(startIdx, endIdx === -1 ? undefined : endIdx).join('\n')
  return snippet || content
}

// 使用：
const taskSnippet = extractTaskSnippet(options.content, mention.alias)

queued.push({
  // ...
  taskSnippet,
  replyToMessageId: options.messageId,
  content: [
    `You were mentioned by ${options.sourceAlias}.`,
    `Your specific task: ${taskSnippet}`,         // 只有给你的那段
    `Reply-to message ID: ${options.messageId}`,
    `Read shared context (before_message_id=${options.messageId}) for background.`,
    `Answer the question directed at you as ${mention.alias}. Do NOT reply to other agents' messages unless your task requires it.`,
  ].join("\n"),
})
```

---

### P4（架构演进）：progress vs final 事件分类

**目标**：进度播报和正式答复在协议层彻底分离。

**改动范围**：较大，涉及 `callbacks.ts`、`message-service.ts`、前端 store、`shared` 类型定义。

**具体步骤**：

1. 修改 `CallbackBody` 类型（`callbacks.ts:8`）：

```typescript
type CallbackBody = {
  invocationId?: string
  callbackToken?: string
  content?: string
  messageType?: 'progress' | 'final'   // 新增
}
```

2. 修改 `appendMessage` 调用，把 `messageType` 写入数据库（需要同步修改 `messages` 表结构）：

```sql
ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'final';
```

3. `GET /api/callbacks/thread-context` 默认不返回 `progress` 类型消息（只返回 `final`），避免进度播报污染 context：

```typescript
.filter(msg => msg.messageType !== 'progress')
```

4. 前端只把 `final` 类型的消息渲染为气泡，`progress` 类型渲染为 spinner/灰色小字。

5. 修改 `agent-prompts.ts`，告知 agent 中途的工具调用日志应该用 `messageType: 'progress'` 发送，最终答复用 `messageType: 'final'`（默认值），不需要改变调用方式，只是加一个字段。

---

### P5（长期，可选）：per-cat slot 并发

**目标**：从"全组串行"升级为"同 agent 互斥，不同 agent 可并行"。

**技术可行性**：高。主要改动是把 `activeInvocations`（Map<sessionGroupId, Set>）改成 Map<`${sessionGroupId}:${provider}`, Set>，`takeNextQueuedDispatch` 只检查目标 provider 的 slot 是否空闲。

但需要配套 P2/P3（上下文冻结 + taskSnippet），否则并行执行后两只 agent 的回复顺序不确定，时间线更乱。**建议 P1-P3 都上线稳定后再做 P5**。

---

## 差距根因总结

| 问题 | 表象 | 根因 | 对应差距编号 |
|------|------|------|------------|
| 桂芬回复了德彪 | agent 漂移到最新消息 | 全组串行 + 实时上下文 + 模糊提示 | 差距一、三、四 |
| 三个 agent 越来越乱 | 对话链条失控 | 无任务所有权，无 reply-to，无上下文冻结 | 差距一、三 |
| 德彪每次两条消息 | 重复内容 | Callback + Stdout 双路各自触发一次 | 差距二 |
| 合法二次触发被封死 | rootTriggeredProviders 副作用 | 去重粒度太粗 | 差距九 |
| agent 不知道自己有待回复任务 | 静默丢失 mention | 没有 get_pending_mentions 工具 | 差距七 |
| 重开就忘 | 跨会话失忆 | 无 evidence search，无 session digest | 差距八 |

Clowder AI 的有序性不是来自"更好的 AI"，而是来自**更严格的协议约束**：每一层（入队、执行、上下文、去重、消息分类）都有明确的守护。Multi-Agent 目前的核心问题是：把这些约束压在"AI 自己判断"上，而 AI 没有它们需要的结构信息来正确判断。

整改的本质是：**把隐式约定改成显式协议**。P1-P3 可以在不改变整体架构的前提下完成，收益最大，风险最低。
