# Multi-Agent 架构文档

## 目录

1. [先看结论：这次整改到底做成了什么](#先看结论这次整改到底做成了什么)
2. [为什么要整改：旧系统能用，但不够支撑多 agent 协作](#为什么要整改旧系统能用但不够支撑多-agent-协作)
3. [这次整改后，系统现在具备什么能力](#这次整改后系统现在具备什么能力)
4. [这次整改没有做什么，为什么故意不做](#这次整改没有做什么为什么故意不做)
5. [整体架构图](#整体架构图)
6. [从全局看，一条消息是怎么跑完整条链路的](#从全局看一条消息是怎么跑完整条链路的)
7. [为什么要按阶段整改，而不是一次性全写完](#为什么要按阶段整改而不是一次性全写完)
8. [每一步整改做了什么、解决什么、为什么只做这些](#每一步整改做了什么解决什么为什么只做这些)
9. [前后端怎么通信](#前后端怎么通信)
10. [运行时层是怎么统一三家 CLI 的](#运行时层是怎么统一三家-cli-的)
11. [为什么需要 invocation、事件记录和状态管理](#为什么需要-invocation事件记录和状态管理)
12. [callback API 是什么，为什么它比 MCP 更基础](#callback-api-是什么为什么它比-mcp-更基础)
13. [MCP 本地工具桥是怎么接进来的](#mcp-本地工具桥是怎么接进来的)
14. [A2A：agent 为什么终于能互相叫人了](#a2aagent-为什么终于能互相叫人了)
15. [skills 和 system prompt 为什么要分开](#skills-和-system-prompt-为什么要分开)
16. [数据库和持久化结构](#数据库和持久化结构)
17. [重构前后对比：你实际能感受到什么变化](#重构前后对比你实际能感受到什么变化)
18. [术语表：把所有关键技术名词讲清楚](#术语表把所有关键技术名词讲清楚)
19. [后续演进建议](#后续演进建议)

---

## 先看结论：这次整改到底做成了什么

一句话总结：

**这次整改不是单纯把网页换了个框架，而是把原来“一个网页去调三个 CLI”的系统，升级成了一个真正能做多 agent 协作的 orchestrator。**

从结果上看，现在系统已经能做到：

- 有统一聊天 UI，用户在同一个界面里和多个 agent 协作。
- 用户可以通过 `@范德彪`、`@黄仁勋`、`@桂芬` 路由到不同 agent。
- 三家 CLI 都能被拉起，而且不再散落在业务代码里，而是走统一 runtime。
- 后端能通过 WebSocket 把生成中的内容实时推给前端。
- 对话、消息、会话组、运行记录都能持久化到 SQLite。
- agent 不再只能被动回复，已经能主动发公开消息、主动拿上下文。
- Claude 可以通过 MCP 工具桥调用本地工具。
- Codex / Gemini 虽然第一版不走原生 MCP，但也能通过 callback API 获得同等能力。
- agent 发出的公开消息里如果 `@另一个 agent`，系统会自动触发下一跳协作。
- system prompt 和 task skill 已经拆分，agent 的行为更稳定，不再全靠“临场发挥”。

换句话说，整改后的系统已经从：

```text
统一聊天页 -> 调三个 CLI
```

升级成：

```text
统一聊天页 -> orchestrator -> runtime -> callback / MCP / A2A / skills
```

---

## 为什么要整改：旧系统能用，但不够支撑多 agent 协作

旧系统并不是“完全不能用”。它其实已经能做到几件很有价值的事：

- 一个网页里同时接三个本地 CLI。
- 用户可以发消息并看到返回。
- 有历史记录。
- 有基本的实时流式输出。

但旧系统有一个根本问题：

**它更像“一个统一入口去调三个聊天机器人”，而不像“一个多 agent 协作系统”。**

这里的区别非常重要。

### 旧系统的问题不是“不能聊天”，而是“不能协作”

如果只是问答，旧系统够用。

但只要目标变成“多 agent 协作”，就会马上遇到这些问题：

- 上层代码直接知道不同 CLI 的命令细节，扩展困难。
- 系统不知道 agent 现在到底是忙着 thinking、调用工具，还是已经真的停了。
- agent 没有自己的临时身份，任何进程都可以伪造 callback。
- agent 不能主动发言，只能被用户点名。
- agent 不能主动读共享上下文。
- Claude 即使支持 MCP，也没有本地工具桥去转发业务。
- agent 之间不能通过公开消息协作。
- 就算偶尔能协作，也缺乏统一规则，容易出现“三个人各说各话”。

所以这次整改的核心目标不是“换技术栈显得更高级”，而是：

**把系统补齐成一个真正能组织、约束、追踪和扩展多 agent 协作的工程骨架。**

---

## 这次整改后，系统现在具备什么能力

按功能看，当前系统已经具备以下能力。

### 1. 统一聊天 UI

前端是一个统一聊天界面，而不是三个互不相干的小页面。

它负责：

- 展示历史会话组。
- 展示当前会话的统一时间线。
- 展示三个 agent 的状态、模型、头像和操作入口。
- 让用户通过 `@谁` 决定这句话交给谁。

### 2. `@agent` 用户路由

用户输入 `@范德彪`、`@黄仁勋`、`@桂芬` 之后，系统会先做 mention 解析，再把这条消息路由到对应 provider 的 thread。

这一步的意义是：

- 用户不需要切换多个窗口。
- 同一个聊天室里就能明确“这次要谁来处理”。

### 3. Fastify + WebSocket

后端使用 Fastify 提供 API 和 WebSocket 服务。

它负责：

- 提供 HTTP 路由。
- 维持浏览器和服务端之间的实时连接。
- 把运行状态、增量文本、消息创建事件、线程快照推给前端。

### 4. SQLite 持久化

SQLite 是当前系统的落地数据库。

它负责保存：

- 会话组
- thread
- message
- invocation
- agent event

这样做的好处是：

- 重启后历史不会丢。
- A2A、callback、事件追踪都有基础数据可查。

### 5. 三个 CLI 可拉起

系统已经能统一调起：

- Codex CLI
- Claude Code CLI
- Gemini CLI

而且不是“硬编码一堆命令拼接”了，而是放在 runtime 层里按统一输入输出协议调用。

---

## 这次整改没有做什么，为什么故意不做

这一部分非常重要，因为工程整改最怕“什么都想做，结果什么都做不稳”。

这次整改有很多事情**故意没有做**。

### 1. 不先做移动端

原因：

- 当前最核心的问题是 runtime、callback、A2A、skills 这些后端协作能力。
- 移动端属于表现层优化，不是这次的主战场。

### 2. 不先做复杂 rich blocks

原因：

- 现在消息的核心问题不是“展示得够不够花”，而是“消息链路是否可靠”。
- 如果过早引入复杂消息块，反而会干扰实时事件设计。

### 3. 不先做多用户体系

原因：

- 当前系统仍然是单机、本地、自用/小范围协作定位。
- 多用户会立刻带来鉴权、隔离、权限、租户边界等复杂度。

### 4. 不先做云部署

原因：

- 当前主要依赖本机 CLI、本机登录态、本机工具。
- 在本地多 agent 逻辑没稳定前，上云只会放大问题。

### 5. 不先做复杂向量检索

原因：

- 当前更缺的是“正确协作机制”，不是“更花的检索层”。
- 在 system prompt、skills、callback、A2A 没稳定前，上向量检索会让问题更混。

一句话解释：

**这次整改优先解决的是“系统骨架”和“协作机制”，不是“外观扩展”和“部署规模”。**

---

## 整体架构图

```text
┌────────────────────────────────────────────────────────────┐
│                        浏览器前端                          │
│  Next.js + React + TypeScript                             │
│                                                            │
│  - 统一聊天页                                              │
│  - 历史会话侧栏                                            │
│  - 顶部 agent 卡片                                         │
│  - 输入框 / @agent 路由                                    │
│  - WebSocket 客户端                                        │
└───────────────────────┬────────────────────────────────────┘
                        │
                        │ HTTP + WebSocket
                        │
┌───────────────────────▼────────────────────────────────────┐
│                      Fastify 后端                          │
│                 Node.js + TypeScript                       │
│                                                            │
│  routes/                                                   │
│  - threads / messages / callbacks / ws                     │
│                                                            │
│  services/                                                 │
│  - session-service                                         │
│  - message-service                                         │
│                                                            │
│  orchestrator/                                             │
│  - dispatch                                                │
│  - mention-router                                          │
│  - invocation-registry                                     │
│                                                            │
│  runtime/                                                  │
│  - claude-runtime                                          │
│  - codex-runtime                                           │
│  - gemini-runtime                                          │
│                                                            │
│  callback API                                              │
│  - post-message                                            │
│  - thread-context                                          │
│  - pending-mentions                                        │
│                                                            │
│  mcp/                                                      │
│  - 本地 MCP server                                         │
│                                                            │
│  skills/                                                   │
│  - loader                                                  │
│  - matcher                                                 │
└───────────────┬───────────────────────┬────────────────────┘
                │                       │
                │                       │
     ┌──────────▼──────────┐   ┌────────▼─────────────────┐
     │      SQLite         │   │     本地 CLI 进程        │
     │                     │   │                           │
     │ - session_groups    │   │ - Codex CLI              │
     │ - threads           │   │ - Claude Code CLI        │
     │ - messages          │   │ - Gemini CLI             │
     │ - invocations       │   │                           │
     │ - agent_events      │   │ Claude 还会挂 MCP tool   │
     └─────────────────────┘   └───────────────────────────┘
```

这张图的重点不是“画得炫”，而是帮你建立一个正确心智模型：

- 前端只负责界面和交互。
- 后端负责业务、调度、运行时、callback、持久化。
- CLI 只是运行时的执行对象，不直接决定系统架构。
- SQLite 负责把系统从“临时对话”变成“可恢复、可追踪、可审计”的系统。

---

## 从全局看，一条消息是怎么跑完整条链路的

下面用一条典型消息举例：

```text
@黄仁勋 帮我分析这个功能，然后请需要的话找范德彪 review
```

### 全局流程图

```text
用户输入
  ↓
前端解析输入并通过 WebSocket 发 send_message
  ↓
Fastify 收到事件
  ↓
MessageService 创建用户消息
  ↓
DispatchOrchestrator 为这条用户消息登记 rootMessageId
  ↓
MessageService 选择目标 thread，创建 assistant 占位消息
  ↓
InvocationRegistry 创建本轮 invocationId + callbackToken
  ↓
runTurn 调用 ClaudeRuntime
  ↓
ClaudeRuntime 拉起 Claude CLI
  ↓
CLI 通过 stdout/stderr 输出活动
  ↓
后端把 assistant_delta / status / snapshot 通过 WebSocket 推给前端
  ↓
如果 Claude 主动 post_message，callback API 会把公共消息写入 thread
  ↓
如果这条公共消息里有 @范德彪
  ↓
mention-router 识别到目标 agent
  ↓
dispatch 把 Codex 下一跳放入队列
  ↓
当前 invocation 结束后，系统自动拉起 Codex
  ↓
Codex 读取共享上下文，继续协作
```

### 为什么这条链路重要

它说明现在系统不只是：

```text
用户 -> 模型 -> 回答
```

而是：

```text
用户 -> orchestrator -> runtime -> callback / A2A -> 继续协作
```

也就是说，真正负责“多 agent 协作”的，不是单个 CLI，而是后端这一整条调度链。

---

## 为什么要按阶段整改，而不是一次性全写完

因为这类系统不是“写一个大文件”就能自然长出来的。

如果把 runtime、callback、MCP、A2A、skills 一次性全部混着做，会出现几个问题：

- 你分不清每一层到底负责什么。
- 一出 bug，不知道是 CLI、callback、路由还是状态机的问题。
- 很多能力会半实现，表面看有，实际上不稳定。

所以这次整改采用了**分层、分阶段、逐步补能力**的方式。

每一步都只解决一个非常明确的问题。

这样做的好处是：

- 每一步的目标清楚。
- 每一步都能单独验证。
- 每一步都能解释“为什么这一步先加这个，不加那个”。

这也是为什么你前面一直要求：

- 这一步具体目标是什么
- 为什么必须先做这一步
- 为什么这一步只加这个不加那个

这些问题其实非常关键，因为它们能防止架构演进变成“想到哪写到哪”。

---

## 每一步整改做了什么、解决什么、为什么只做这些

这一节是全文最重要的部分之一。它不仅讲“做了什么”，更讲“为什么这么做”。

### 第 1 步：先整理目标模块结构

#### 做了什么

把后端目录整理成：

- `routes/`
- `services/`
- `orchestrator/`
- `runtime/`
- `mcp/`
- `skills/`
- `db/`
- `events/`

#### 解决什么问题

解决“未来能力到底该落在哪一层”的问题。

#### 为什么这一步只做目录和边界，不先写新功能

因为如果边界没立住，后面的 callback、MCP、A2A、skills 最后都容易继续堆进 service 里，系统会再次回到“能跑，但越来越乱”的状态。

---

### 第 2 步：把 CLI 调用升级成统一 runtime

#### 做了什么

定义统一输入输出：

- `AgentRunInput`
- `AgentRunOutput`
- `AgentRuntime`

然后分别实现：

- `ClaudeRuntime`
- `CodexRuntime`
- `GeminiRuntime`

#### 解决什么问题

让上层不再关心不同 CLI 的命令细节。

#### 为什么这一步只做 runtime，不先做 callback / skills

因为如果连“怎么跑一个 agent”都没有统一接口，后面任何 callback 注入、MCP 配置、system prompt 注入都会散在业务层里，无法维护。

---

### 第 3 步：让系统正确知道 agent 还活着没有

#### 做了什么

- runtime 同时监听 `stdout` 和 `stderr`
- 新增 `invocations`
- 新增 `agent_events`
- 新增状态枚举：`idle / running / replying / thinking / error`

#### 解决什么问题

避免把“没有 stdout”误判成“已经卡死”。

#### 为什么这一步只做活动检测和事件记录

因为如果连“它是不是还活着”都判断不准，后面的 callback、A2A、状态栏、调度时机都会错。

---

### 第 4 步：给 agent 一个 callback API

#### 做了什么

实现三个 callback 接口：

- `POST /api/callbacks/post-message`
- `GET /api/callbacks/thread-context`
- `GET /api/callbacks/pending-mentions`

#### 解决什么问题

让 agent 可以：

- 主动发公共消息
- 主动获取上下文
- 主动查看最近谁在叫自己

#### 为什么这一步不先做 MCP

因为 MCP 只是“工具调用协议”。

如果系统里还没有真正可调用的 callback API，那么 MCP server 只会变成一个空转发壳子。

所以 callback API 比 MCP 更基础。

---

### 第 5 步：给 callback 一个 invocation 身份

#### 做了什么

每次 agent 运行前创建：

- `invocationId`
- `callbackToken`
- `expiresAt`

并在 runtime 启动时注入：

- `CAT_ROOM_API_URL`
- `CAT_ROOM_INVOCATION_ID`
- `CAT_ROOM_CALLBACK_TOKEN`

#### 解决什么问题

让 callback API 不再裸奔。

#### 为什么这一步不先做用户登录 / 权限系统

因为当前要解决的是“当前这次 agent 运行是谁”，而不是“整个平台有哪些用户和租户”。

这一步是 invocation 级身份，不是多用户平台级身份。

---

### 第 6 步：写 MCP 本地工具桥

#### 做了什么

实现本地 MCP server，并注册：

- `post_message`
- `get_thread_context`

#### 解决什么问题

让 Claude 能通过原生 MCP 方式调本地工具。

#### 为什么这一步不直接让 MCP 自己查数据库

因为 MCP server 的职责是**协议适配和转发**，不是业务层。

如果 MCP server 直接查库，它就会和 callback API 并列成两套业务入口，后面更难维护。

---

### 第 7 步：让三家 agent 都具备“主动参与”能力

#### 做了什么

- ClaudeRuntime：注入 MCP
- CodexRuntime：注入 callback prompt
- GeminiRuntime：注入 callback prompt

#### 解决什么问题

让三家 agent 都能主动发消息、主动读上下文。

#### 为什么这一步允许三家实现方式不完全一样

因为这一步的目标是**能力对齐**，不是**协议洁癖**。

只要结果上三家都能主动参与协作，就已经达到阶段目标。

---

### 第 8 步：让 agent 的公开消息也能触发 `@agent`

#### 做了什么

- 对 agent 发出的公开消息执行 mention 解析
- 为下一跳创建新的 invocation
- 下一跳读共享 thread 上下文
- 加 hop 限制和去重逻辑

#### 解决什么问题

把系统从：

```text
User -> Agent
```

扩展成：

```text
User -> Agent -> Agent -> User
```

#### 为什么这一步只做串行，不做并行 storm

因为第一版的目标是**稳定协作**，不是“让所有 agent 一起冲出去说话”。

串行更容易：

- 控制 hop
- 保证顺序
- 降低无限循环风险

---

### 第 9 步：引入 skills 和 system prompt

#### 做了什么

- 把长期规则拆到 `multi-agent-skills/system/room-charter.md`
- 把任务型技能拆成：
  - `review.md`
  - `handoff.md`
- 实现 `buildSystemPrompt(agentId)`
- 每次调用 runtime 都注入 system prompt
- 命中 review / handoff 意图时额外加载 task skill

#### 解决什么问题

让协作从“随机发挥”变成“有规则、有 SOP 的协作”。

#### 为什么要把 system prompt 和 skills 分开

因为它们解决的问题不同：

- system prompt：长期生效的基本规则
- task skill：只在某类任务触发的专项规则

如果把它们全混在一起，模型每次都要吃下全部规则，提示会越来越重，也会越来越乱。

---

## 前后端怎么通信

这部分需要讲得非常清楚，因为“前后端通信”是很多初学者最容易抽象不起来的地方。

### 一共有两种通信方式

#### 1. HTTP

HTTP 更适合这些事情：

- 页面初始化拉数据
- 普通接口查询
- callback API
- 一次请求，一次返回

比如：

- 获取线程列表
- 获取会话组
- agent 回调 `post-message`

#### 2. WebSocket

WebSocket 更适合这些事情：

- 实时增量回复
- 状态变化推送
- 线程快照同步
- 长连接双向通信

这里的“双向通信”并不是“听起来很高级”的空话，它的意思是：

- 前端可以随时向后端发事件
- 后端也可以随时向前端发事件

而不是像普通 HTTP 那样必须“一问一答，一来一回就结束”。

### 为什么你平时感觉不出 WebSocket 和以前差很多

因为你现在最常见的使用方式仍然是：

```text
我发一句 -> 它回一句
```

这种场景下，HTTP 流式和 WebSocket 看起来都像“一问一答”。

但 WebSocket 真正的价值在于：

- 一条长连接可以持续发事件
- 可以很自然地同时推：
  - delta
  - status
  - snapshot
  - message.created
- 后面做更多实时协作时，不需要继续新增一堆零散接口

### 通信图

```text
浏览器
  │
  ├─ HTTP -> 拉初始化数据、调用普通 API、callback API
  │
  └─ WebSocket -> send_message / stop_thread / assistant_delta / status / snapshot
                    ↑
                    │
                  Fastify
```

### 前端具体在监听什么

前端主要监听两类东西。

#### 1. 监听用户操作

例如：

- 输入框提交
- 点击某个 agent
- 点击停止
- 选择某个历史会话

这类监听的作用是：

**把用户意图变成一个前端事件。**

#### 2. 监听 WebSocket 消息

例如：

- `assistant_delta`
- `status`
- `message.created`
- `thread_snapshot`

这类监听的作用是：

**把后端发来的最新状态同步到页面上。**

一句话理解：

- 监听用户操作：知道用户想干什么
- 监听 WebSocket：知道后端刚刚发生了什么

---

## 运行时层是怎么统一三家 CLI 的

这是整改里的一个关键技术点。

### 以前的问题

以前如果业务层直接知道这些信息：

- Claude 命令怎么拼
- Codex 参数怎么传
- Gemini 要不要 shell
- 哪家如何 resume

那么上层代码就会越来越脏。

### 现在怎么做

现在引入了统一 runtime 接口：

```ts
export type AgentRunInput = {
  invocationId: string;
  threadId: string;
  agentId: string;
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
};

export type AgentRunOutput = {
  finalText?: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
};
```

然后分别实现：

- `ClaudeRuntime`
- `CodexRuntime`
- `GeminiRuntime`

### 这样做的价值

上层 orchestrator 现在只需要说一句：

```text
请按这个输入运行这个 agent
```

它不需要知道：

- 底层命令是什么
- 参数怎么拼
- 特殊能力怎么注入

这些细节全部收进 runtime 里。

### 技术原理

runtime 的本质就是一层**适配器（adapter）**。

“适配器”这个词的意思是：

> 外部统一看起来一样，内部各做各的转换。

这很适合三家 CLI 场景，因为：

- 上层想统一
- 下层命令细节不统一

runtime 就是专门拿来消化这种差异的。

---

## 为什么需要 invocation、事件记录和状态管理

这是很多初学者最容易忽略、但实际工程里最重要的一层。

### 什么是 invocation

这里的 invocation 不是“线程”也不是“会话”，它指的是：

**某一个 agent 被真正拉起运行的一次执行实例。**

比如：

- 用户这次 `@黄仁勋`
- 系统拉起一次 Claude

这一次运行，就是一个 invocation。

### 为什么不能只有 thread，没有 invocation

因为 thread 只表示“这段会话”。

但系统真正关心的很多问题是：

- 现在这次运行是谁？
- 它有没有 callback 身份？
- 它什么时候开始？
- 它什么时候结束？
- 它出错了没有？

这些都是 invocation 层的问题，不是 thread 层的问题。

### 为什么要记录 agent events

因为单靠最终结果，很多问题你根本定位不了。

例如：

- 是真的卡死，还是只是在 stderr thinking？
- 是工具调用太久，还是模型回复慢？
- 是 callback 失败，还是 CLI 本身异常？

所以系统会把关键活动记录成事件。

### 为什么不能只看 stdout

因为很多 CLI 在 thinking 或工具调用时，活动可能先出现在 stderr。

如果系统只看 stdout，就会错误地以为：

```text
没 stdout = 卡死了
```

这是错误的。

正确做法是：

- stdout 活动算活着
- stderr 活动也算活着

---

## callback API 是什么，为什么它比 MCP 更基础

这一节非常关键。

很多人会先问：

```text
怎么接 MCP？
```

但更底层的问题其实是：

```text
agent 到底通过什么业务接口发消息、读上下文？
```

答案就是 callback API。

### callback API 是什么

callback API 就是系统专门提供给运行中 agent 调用的一组后端接口。

当前有三条：

- `POST /api/callbacks/post-message`
- `GET /api/callbacks/thread-context`
- `GET /api/callbacks/pending-mentions`

### 它们分别干什么

#### `post-message`

让 agent 主动发一条公共消息。

#### `thread-context`

让 agent 主动读取当前 thread 最近消息。

#### `pending-mentions`

让 agent 看最近有没有新的公开消息在 `@自己`。

### 为什么 callback API 比 MCP 更基础

因为 MCP 只是“工具调用协议”。

它本身不等于业务能力。

真正的业务能力是：

- 发公共消息
- 读上下文
- 查 mentions

这些能力必须先落在 callback API 上。

然后 Claude 再通过 MCP 去调这些 callback API。

所以层级关系是：

```text
业务能力 = callback API
协议桥 = MCP server
```

不是反过来。

---

## MCP 本地工具桥是怎么接进来的

当前 MCP 的定位非常清楚：

**它不是业务层，而是 Claude 调本地工具的一层协议适配。**

### MCP server 现在做什么

当前本地 MCP server 只做三件事：

1. 接收 Claude 的 MCP tool call
2. 从环境变量拿 invocation 身份
3. 转发到 callback API

它不做：

- 直接查 SQLite
- 直接写 message 表
- 直接决定业务规则

### 为什么要这么做

因为这样能保证业务只有一套。

如果 MCP server 直接查库，那就会变成：

- callback API 一套业务
- MCP server 一套业务

这会让后续维护非常痛苦。

### 调用图

```text
Claude CLI
  ↓
MCP tool call
  ↓
本地 MCP server
  ↓
callback API
  ↓
MessageService / SessionService
  ↓
SQLite + WebSocket 广播
```

---

## A2A：agent 为什么终于能互相叫人了

A2A 是 agent-to-agent 的缩写，意思是：

**一个 agent 可以通过公开消息触发另一个 agent。**

### 以前为什么做不到

以前系统只能识别：

- 用户输入里的 `@agent`

但不能识别：

- agent 公开消息里的 `@agent`

所以系统最多只能做到：

```text
User -> Agent
Agent -> User
```

### 现在怎么做到的

现在系统会在“新创建的公开消息”上做 mention 解析。

如果消息里出现：

```text
我先给方案，再请 @范德彪 review
```

那么 orchestrator 会：

1. 识别出目标 provider
2. 检查这条链的 hop 是否超限
3. 检查这条 message 是否已经触发过同一个 provider
4. 把下一跳放入队列
5. 当前运行结束后，再串行触发下一只 agent

### 为什么要有 hop 限制

因为如果不限制，就可能出现：

```text
A @ B
B @ C
C @ A
```

然后无限循环。

所以第一版规定：

- 每条用户根消息最多 4 跳
- 同一条 message 不能重复触发同一 agent
- 当前只做串行，不做并行 storm

### A2A 调用图

```text
用户消息
  ↓
触发 Claude
  ↓
Claude 公开发消息
  ↓
消息中包含 @Codex
  ↓
mention-router 识别目标
  ↓
dispatch 入队
  ↓
当前 invocation 结束
  ↓
系统自动拉起 Codex
  ↓
Codex 读取共享上下文继续协作
```

---

## skills 和 system prompt 为什么要分开

这也是这次整改非常关键的一点。

### system prompt 是什么

system prompt 是**长期规则**。

当前放在：

- `multi-agent-skills/system/room-charter.md`

它描述的是每个 agent 都必须长期遵守的东西，例如：

- 你运行在多 agent 协作房间里
- 你不是单轮聊天机器人
- 不确定就说不知道
- 需要协作时才 `@另一个 agent`
- 重要中间结论要主动 `post_message`

### task skill 是什么

task skill 是**针对某类任务额外加载的专项规则**。

当前有：

- `review.md`
- `handoff.md`

它们不是每次都加载，而是命中对应意图时才额外拼进 prompt。

### 为什么一定要分开

因为它们解决的问题根本不同：

- system prompt：决定“你是谁、你在什么环境、长期规则是什么”
- task skill：决定“这次任务要按什么 SOP 做”

如果混在一起，会出现两个问题：

1. 每次提示都越来越大
2. 模型更难分辨哪些是长期规则，哪些是当前任务规则

### 当前加载顺序

现在每次调用大致是：

```text
system prompt
  + task skill（如果命中）
  + 用户消息 / 历史上下文
```

这样做的好处是：

- 长期规则始终稳定存在
- 任务规则只在需要时出现

---

## 数据库和持久化结构

数据库现在的核心表可以简单理解成三层。

### 1. `session_groups`

表示“一次三方协作会话”。

你可以把它理解成：

**一个总房间。**

### 2. `threads`

表示某个 provider 在这个会话组里的单独会话。

你可以把它理解成：

**这个总房间里，每个 agent 自己的一条工作线。**

### 3. `messages`

表示 thread 里的具体消息。

### 4. `invocations`

表示一次真实运行。

### 5. `agent_events`

表示这次运行过程中的活动记录。

### 数据关系图

```text
session_groups
   │
   ├── threads (Codex)
   │      └── messages
   │
   ├── threads (Claude)
   │      └── messages
   │
   └── threads (Gemini)
          └── messages

invocations
   └── 关联某一个 thread 的某一次运行

agent_events
   └── 关联某一个 invocation 的活动过程
```

### 为什么要拆成这几层

因为这些层表示的不是同一个东西：

- `session_group`：一次整体协作
- `thread`：某个 agent 的会话线
- `message`：一条具体内容
- `invocation`：一次真实运行
- `agent_event`：这次运行里的活动过程

如果全塞进一两张表里，后面就很难表达：

- 历史会话
- 运行状态
- A2A 路由
- callback 身份
- 事件追踪

---

## 重构前后对比：你实际能感受到什么变化

很多架构升级，使用者第一感受不会是“天翻地覆”，而是“好像还是聊天”。这很正常。

因为这次整改的很多收益属于：

- 稳定性收益
- 可扩展性收益
- 可观测性收益

而不是“立刻多一个花哨按钮”。

### 你现在能直接感受到的变化

#### 1. 不再是三个孤立窗口，而是统一协作页面

你不需要在三个小会话里切来切去。

#### 2. 用户可以直接 `@谁`

一条消息就能定向路由到某个 agent。

#### 3. 历史会话和当前会话的组织更清晰

因为现在已经有会话组和 thread 的结构。

#### 4. 实时状态更稳定

因为系统不再只看 stdout，而是把 stderr 也纳入活动判断。

#### 5. agent 开始具备主动参与能力

这点是本次整改最本质的变化。

以前是你必须一直点它们；
现在它们已经开始能自己协作。

### 你不一定第一眼能感受到，但工程上差别很大的变化

#### 1. runtime 统一了

以后再接更多能力，不需要把业务层改得满地都是 CLI 细节。

#### 2. callback 和 invocation 身份接上了

这决定了 agent 主动参与能不能做得安全、稳定。

#### 3. MCP 不再是空概念

现在 Claude 的 MCP 已经有真实业务落点。

#### 4. A2A 已经有了基础调度机制

这意味着系统已经从“多聊天窗口”走向“多 agent 协作系统”。

---

## 术语表：把所有关键技术名词讲清楚

这一节是给技术小白专门准备的。遇到不懂的词，可以先回来看这里。

### 前端

你在浏览器里看到的页面和交互层。

### 后端

在本机服务里运行的程序，负责接收请求、调起 CLI、保存数据、做实时推送。

### HTTP

最常见的网页请求协议。

特点是：

- 一次请求
- 一次响应
- 适合普通接口

### WebSocket

一种长连接协议。

特点是：

- 连接建立后可以持续通信
- 前后端都能主动发消息
- 适合实时聊天、状态同步

### Fastify

一个 Node.js 的后端框架。

你可以把它理解成：

**负责搭 API 服务和 WebSocket 服务的后端骨架。**

### Next.js

一个 React 全栈框架。

当前这里主要把它用作前端应用框架。

### React

一种前端 UI 库，用来组织组件和页面状态。

### TypeScript

JavaScript 的带类型版本。

它最大的价值是：

- 在开发阶段更早发现错误
- 让大型工程更容易维护

### SQLite

一个轻量级本地数据库。

它不是远程数据库，而是一个本地文件数据库。

### thread

这里指的是**某个 agent 的会话线**，不是操作系统线程。

### session group

表示一次整体多 agent 会话。

### invocation

表示一次真实的 agent 运行实例。

### runtime

一层适配器，用统一接口包装不同 CLI 的调用细节。

### orchestrator

协调者。

它负责决定：

- 这条消息该交给谁
- 谁触发谁
- 下一跳什么时候开始

### callback API

给运行中的 agent 调用的后端接口。

### callback token

调用 callback API 的临时凭证。

### MCP

Model Context Protocol，一种工具调用协议标准。

在当前系统里，它是 Claude 调本地工具桥的协议层。

### skill

针对特定任务附加的规则或 SOP。

### system prompt

每次运行都要注入的长期规则。

### stdout

命令行程序的标准输出流，通常用来输出正文或结构化事件。

### stderr

命令行程序的标准错误流。

注意：它不一定只表示“错误”，有些 CLI 也会把 thinking 或工具过程写到这里。

---

## 后续演进建议

当前架构已经能支撑下一阶段继续演进，但建议按顺序来，不要一次性加太多层。

### 建议的下一步

#### 1. 把 Claude MCP 配置做成更正式的能力管理

例如支持更多本地工具，而不是只停在两个 callback tool。

#### 2. 让 Codex / Gemini 也逐步靠近标准工具调用

当前它们先走 callback prompt 注入，这是阶段性方案。

#### 3. 把 agent event 更完整地展示到调试面板

现在已经落库了，但前端还没有充分利用。

#### 4. 视需求引入 Redis

Redis 更适合这些东西：

- 短期 token
- 运行态队列
- 高频事件
- 临时锁

SQLite 适合持久化，Redis 适合运行态。

#### 5. 在 system prompt / skills 稳定后，再考虑更复杂检索

例如：

- skill embedding 检索
- 更多专项 skill
- 自动评估

这一步不该抢在前面做。

---

如果你只想记住最核心的一句话，请记住这句：

**这次整改真正做成的，不是“一个更漂亮的聊天页”，而是“一个已经具备 runtime、callback、invocation、MCP、A2A、skills 这五层关键能力的多 agent orchestrator”。**
