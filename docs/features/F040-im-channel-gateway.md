---
id: F040
title: 外部 IM 渠道网关（飞书先行）+ 手机端接入路线
status: spec
owner: 黄仁勋
created: 2026-07-03
---

# F040 — 外部 IM 渠道网关（飞书先行）+ 手机端接入路线

## Why

小孙原话（2026-07-03）：

> 我想把我们的系统接入飞书或者微信，还有能有一个 ios 应用了，这样的话我可以在手机上跟你们对话，怎么做？clowder-ai 其实已经做好了，我们可以参考他的。

现状痛点：Multi-Agent 唯一入口是本机 web UI（localhost:3000），小孙离开电脑就跟团队断联。通勤/外出/躺床上时无法派活、无法收进度、无法拍板 —— 而 F033 交互卡片、F037 日报这些能力都憋在桌面里。

## What

小孙在**飞书 App**（手机/平板/电脑端）里私聊咱们的机器人，等于直接在 room 里说话：

- 消息进入绑定的 room，走与 web 输入框**完全相同**的入站链路（村长身份、@提及照常路由到黄仁勋/范德彪/桂芬）
- 房间里每个 agent 的最终回复逐条推回飞书私聊（长文本分片）
- 未配置凭证时 connector 静默不启动，绝不影响主服务
- **多人参与（Phase 2）**：建飞书群拉朋友进来，群里 @机器人 说话 = 多人在同一个 room 里聊，每条消息带发送者昵称归因（详见「多人参与」节）

**「iOS 应用」的解法 = 三阶段路线**（原生 App 需 Apple 开发者账号 $99/年 + Mac 构建链 + 签名分发，收益对单用户场景增量很小，clowder-ai 也没做原生）：

| 路线 | 载体 | 开发量 | 得到什么 |
|------|------|--------|---------|
| A（Phase 1 私聊 / Phase 2 群） | 飞书 App 即客户端 | 仅后端 connector | 手机对话、推送、语音输入（飞书自带）；群 = 多人参与 |
| B（Phase 3，小孙自用不外发） | PWA：现有 web UI 加 manifest/图标/apple meta | 前端小改 | Safari「添加到主屏幕」，全功能 UI（LAN/Tailscale 访问）|
| C（按需另立项） | Capacitor 原生壳 | 中 | App Store 分发（仅当 A+B 不满足再议）|

## 调研结论（2026-07-03，clowder-ai 对照 + 本仓链路实测；已按德彪 r1 修正两处误判）

### clowder-ai connector 架构（参考仓：`C:\Users\-\Desktop\cafe-multi-agent\clowder-ai`）

7 IM 渠道统一网关（`packages/api/src/infrastructure/connectors/`，注册表 `packages/shared/src/types/connector.ts:202-251`）：

| 渠道 | 入站模式 | 需公网？ | 对我们的含义 |
|------|---------|---------|-------------|
| 飞书 | webhook **或** WS 长连接（`FEISHU_CONNECTION_MODE=websocket`，`lark.WSClient`） | **长连接免公网** | ✅ 首选：本机 Windows 直接跑 |
| 企微智能机器人 | WS 长连接（`@wecom/aibot-node-sdk`） | 免 | 微信生态备选（要企业主体，免费可注册）|
| 微信个人号 | iLink Bot 长轮询 + 扫码登录 | 免 | 非公开常规渠道，账号风险 + 会话过期运维重，不推荐 MVP |
| 企微自建应用 | HTTP AES 回调 | **要** | 后置 |
| 钉钉 / Telegram / 小艺 | 长连接/长轮询 | 免 | 不在需求内 |

可抄的关键机制：统一 `ConnectorRouter`（外部会话 ↔ 内部 thread 绑定 + 群白名单）、`FeishuTokenManager`（tenant_access_token 提前 5 分钟刷新）、出站终稿投递 hook 与流式占位卡分离。**要改进的弱点**：clowder 飞书 verification token 未配置时跳过校验（`FeishuAdapter.ts:122`）、入站去重仅内存 LRU（`InboundMessageDedup.ts` 重启即失忆）—— 我们必须 fail-closed + durable 账本。

移动端结论：clowder-ai **没有原生 iOS/RN/Capacitor**；= 可安装 PWA（manifest + apple-touch-icon + `@ducanh2912/next-pwa`，API NetworkOnly 不做离线）+ 响应式 web + **官方主推飞书/Telegram 当手机入口**。

### 本仓挂载点（实测锚点，含德彪 r1 逐条核实）

- **入站权威入口**：WS client 事件 `{type:"send_message", payload:{threadId, provider, content, alias, contentBlocks?, clientMessageId?}}` → `MessageService.handleClientEvent`（`packages/api/src/services/message-service.ts:1112`；`routes/ws.ts:161` 接线）。connector 以进程内 headless client 身份复用同一入口，不开第二条写路径。
- **⚠️ 幂等误判修正（r1 P1-1）**：`clientMessageId` 只是前端回显字段（message-service.ts:1330 全文件唯一出现点），`appendUserMessage(:1307)` 生成随机 id，messages 表**无任何 external id 唯一约束** —— 服务端没有现成幂等能力，connector 必须自建 durable 入站账本。
- **⚠️ final 语义修正（r1 P1-2）**：per-turn emit 流里 assistant 的 `message.created` 是**空占位**，过程是 delta，终稿经 `overwriteMessage` 落库（:1635/:2517 等 8 处终态路径），**realtime 层无 finalized 事件**；落库后内部 eventBus 发 `invocation.finished`（:2533，`events/event-types.ts:27`）。「先持久化后发事件」的顺序使 eventBus 成为出站 hook 的正确订阅点。`handleClientEvent` 本身 fire-and-forget 不可 await，A2A worklist continuation 在原调用链之外继续跑 —— 出站必须按 final 逐条投，不能按「函数返回」打包。
- **⚠️ busy 语义（r1 P1-3）**：`getBusyStatus` 命中 → 仅 emit status + `return`（:1294-1302），**消息不持久化即丢**；archived/deleted 有 sendable 门（:1277-1292，fail-closed 已存在）。飞书事件已 ACK 后对方不会重试 → 排队必须 connector 侧自建。
- **广播咽喉**：`RealtimeBroadcaster.broadcast`（ws.ts:65，F031 seq/epoch 仅保护 WS broadcast，不保护渠道出站）。
- **安全边界**：F029 外发边界代码**未合 dev**；F037 设计合同 v2 已确立 SafeHttpClient 出站合同 → F040 复用全量合同，**谁先落地谁抽共享模块**。
- **绑定存储**：本仓无 Redis（clowder 用 Redis Hash）→ SQLite 表 + drizzle migration。
- **配置**：`packages/api/src/config.ts` 读 env；凭证由小孙手填 `.env`（铁律 3）。

## 架构设计 v2（吸收德彪 r1，待小孙拍板 + r2）

```
飞书开放平台 ←— WS 长连接（lark.WSClient 仅承担长连接；REST 一律走 SafeHttpClient，SDK 不发 REST）
     │ im.message.receive_v1
     ▼
FeishuConnector（packages/api 进程内）
  1. chat_type == p2p 硬门：群/话题事件 Phase 1 一律拒（防群上下文注入绑定 room）
  2. open_id 白名单 fail-closed：仅 FEISHU_ALLOWED_OPEN_IDS；拒绝记审计，不入 room
  3. 入站账本（SQLite）：INSERT UNIQUE(connector_id, external_chat_id, external_message_id)
     先登记后注入；冲突 = 已处理，直接返回 —— 平台重投 / connector 重启重放都挡住
     （内存 LRU 仅作性能优化，不承担正确性）
  4. 绑定 FIFO 持久队列（SQLite）：busy / 派发中 / 异常时排队不丢；
     当前 root settle 后 drain，严格保序注入；进程重启队列恢复
     ▼ 逐条注入
MessageService.handleClientEvent({type:"send_message", alias:"村长", ...})   ← 与 web 同一入口
     │ 房间内派发 / @提及路由 / A2A（F026 机制原样生效）
     │ …… 每个 agent 终稿 overwriteMessage 落库 → eventBus "invocation.finished"（先持久化后发事件）
     ▼
OutboundDeliveryHook（订阅 invocation.finished，按绑定过滤 sessionGroup）
  5. 逐 final 投递：direct final / multi-@ A2A finals / worklist continuation final /
     错误终态回执，每条独立投递（不按「一轮」打包）
  6. 出站账本（SQLite）：key=(channel_binding_id, internal_message_id)，
     状态机 pending → attempted → sent | failed_terminal；
     启动 reconcile：有 final 无 sent → 补投；attempted 结果未知 → 补投一次并标记可能重复
     （at-least-once：偶重复优于静默漏推，对齐 F037 D10/D11）
  7. 出站执行：SafeHttpClient（F037 合同全量 + host pin open.feishu.cn）
     + tenant_access_token 提前刷新 + 长文本分片（上限/顺序号/单分片重试，plan 期定数值）
     ▼
飞书 DM → 小孙手机
```

防回环：入站只收白名单 open_id + p2p；飞书 bot 不会收到自己发出的 DM 事件。
busy/archived 状态回执：connector 消费 status 事件（如「会话已归档」）转发给飞书用户，不静默。

### 设计合同 v2 要点（吸收范德彪 r1：3 P1 + 4 P2 全接）

1. **入站幂等 = durable 账本**（P1-1）：三元组 UNIQUE 先登记后注入；不依赖 `clientMessageId`（纯回显）。
2. **出站边界 = invocation.finished 订阅**（P1-2）：终稿粒度投递；禁止从 realtime emit 猜 final；AC 覆盖四类 final。
3. **同绑定 FIFO 持久排队**（P1-3）：忙时排队不丢、保序、重启恢复、可审计；不依赖调用方重试。
4. **出站账本 + startup reconcile**（P2-1）：pending/attempted/sent/failed_terminal 状态机，防「final 已落库但发送前后崩溃」的漏推/重复推。
5. **SafeHttpClient 合同全量上测试面**（P2-2）：redirect 逐跳校验 / DNS rebinding / IANA special-use 精确段 / userinfo / 非常规端口 / 流式 body 上限 / timeout+abort；**SDK 仅承担 WS 长连接，REST 全走 SafeHttpClient**（SDK REST 绕不过合同就不用 SDK 发 REST）。
6. **p2p 硬门**（P2-3）：Phase 1 拒绝一切非私聊事件（含白名单用户在群里发言）；Phase 2 升级为 `p2p ∪ 白名单群且 @bot`。
7. **绑定配置语义统一**（P2-4）：env 仅作首次启动 bootstrap 播种；SQLite binding 行是运行时真相源；默认 provider 启动时校验（无效 → connector 不启动）；session group archived/deleted → 消费 sendable 门 status 并回执用户。

### v3 增补（吸收范德彪 r2：3 新 P1 + 2 P2 全接，r1 七条核验全 ✅）

8. **归因不进派发解析文本**（r2 P1-1）：前缀独立成行 + 昵称剥 `@`/`[Call:` 字面量 + `@bot` 剥离保行首；依据=classifyMention 行首 walk-left 判 gray（mention-router.ts:255-260）而 user 路径 content 原样进 enqueuePublicMentions（message-service.ts:1339-1346, matchMode anywhere）。
9. **成员级 fail-closed + 角色分级**（r2 P1-2）：chat AND sender 双白名单；owner/participant 角色；特权命令面 owner-only。
10. **出站按 binding provenance 路由**（r2 P1-3）：rootMessageId → channel_binding_id 溯源投递；无外部来源 final 不投 IM。
11. **`invocation.finished` payload 扩展**（r2 P2-4）：现 payload 仅 invocationId/threadId/agentId/exitCode（event-types.ts:27-34），额外补 `assistantMessageId` + `rootMessageId`（加法扩展）；**禁止**实现时用「查 thread 最新 assistant message」兜底。

## 多人参与（2026-07-03 小孙新需求）

小孙原话：

> 我可以把 ios 这个 PWA 安装到别人手机上 他们可以在房间里聊天 看看我们当前方案是否能实现

**结论：诉求能实现，但正确载体是「飞书群桥接」，不是「多人 PWA」。**

- **多人 PWA 为什么不行（as-is）**：PWA 只是现有 web UI 的壳，而本系统目前**零用户体系** —— 无登录/鉴权，任何能打开页面的人就是村长（timeline 对 user 角色硬编码村长 `session-service.ts:689`；`send_message` 的 `alias` 字段服务端从未消费，实测 message-service 全文件无 `payload.alias` 引用）。且别人手机要够得着这台机器：要么公网暴露（HTTPS + 真鉴权 + 攻击面，F029 级课题），要么人人装 Tailscale（非技术朋友装不动）。把 PWA 发给别人 = 把无锁的完整控制台交出去。**多人 PWA 需要先立「用户身份/鉴权/归因」底座 feature，远期按需另立项。**
- **飞书群桥接为什么顺**：身份/账号/推送/iOS+Android 客户端全部由飞书代劳。建一个飞书群拉朋友进来 → 群成员 @机器人 说话 → 消息带发送者昵称进绑定 room → agent 回复回群。仍然**免公网**（同一条 WS 长连接）、**fail-closed**（群 chat_id 白名单：只有小孙拉白的群能说话，成员策略默认白名单群内全员可发）。朋友手机装的是飞书 App，跟「装 PWA」同级操作。
- **发送者归因两级**（群模式必做，Phase 2 内；合同按德彪 r2 P1-1 加固）：
  1. MVP：归因前缀**独立成行**（`[飞书·<昵称>]\n<原文>`）——`classifyMention` 行首判定 walk-left 遇非空白即降 gray（mention-router.ts:255-260 实锤），同行前缀会杀死 `@范德彪` 派发；昵称必须转义/剥除 `@`、`[Call:` 等派发关键字面量（昵称是不可信输入，不得成为解析器输入）；`@bot` 提及剥离时保留用户命令行首
  2. 正式：user 消息持久化 sender 展示名 + timeline 映射取真名（替换 :689 硬编码），schema 加列 + migration
  - 回归样例（AC11）：昵称含 `@` / 正文行首 `@范德彪` / 群内 `@bot @范德彪 …` 混排，三组均正确路由
- **成员级权限（r2 P1-2）**：群白名单 ≠ 授权全群 —— 入站门 = `chat_id ∈ 群白名单 AND sender_open_id ∈ 成员白名单`（fail-closed，防新成员入群即获派活权）；成员带角色：**owner**（小孙）全权，**participant** 可对话可 @ agent，特权命令面（/bind、审批类、未来 IM 命令）owner-only；非白名单成员 → 拒 + 审计 + 群内回执
- **出站溯源（r2 P1-3）**：入站账本/FIFO 记 `channel_binding_id` → 注入后建 `rootMessageId → channel_binding_id` 映射 → final 沿 root/call chain 溯源，只投递到**来源 binding**（群触发回群、私聊触发回私聊）；**无外部来源的 final（room 内后台/定时产物）不投任何 IM 绑定**（防噪；「旁听模式」按 binding 开关留远期）
- **排队回执 UX**：群内多人连发时，queued ack 带原 sender 昵称 + 队列位置（否则不知道谁的任务在跑）
- **边界如实说**：群成员只能「对话」，看不到 web UI 面板（时间线/审批/交互卡片）——「在房间里聊天」这个诉求群桥接完全覆盖；哪天要给别人全 UI，再立用户体系 feature。

## Design Decisions

| # | 决策 | 选项 | 结论 | 原因 |
|---|------|------|------|------|
| D1 | 首发渠道 | 飞书 / 微信个人号 / 企微 | **飞书（拍死，小孙 2026-07-03「按你推荐的来」）** | 官方 API 完整、长连接免公网、多端 App 体验好；个人微信无官方 bot 接口（iLink 属非常规渠道，封号险）；企微要企业主体 |
| D2 | 飞书接入模式 | webhook / WS 长连接 | **WS 长连接（拍死）** | 免公网 IP/域名/隧道，本机 Windows 直接跑；官方 SDK 原生支持 |
| D3 | 会话绑定 | env-only / SQLite 真相源 | **拍死（小孙 2026-07-03）：专用移动房间**（bootstrap 播种自动建/可换绑）+ SQLite binding 真相源 | r1 P2-4：默认 provider 启动校验、archived fail-closed 回执；@提及在消息内容里照常路由 |
| D4 | 出站范围 | 逐 final / 全房间旁听 | **绑定 room 内逐 final 投递（invocation.finished 粒度，拍死）** | r1 P1-2 重定义后拍死：四类 final 独立投递；progress/delta 不投（流式占位 Phase 2 再议）|
| D5 | 入站安全 | 全放行 / open_id 白名单 | **白名单 fail-closed + p2p 硬门（拍死）** | 修正 clowder 弱点；未配白名单 = connector 不启动；拒绝记审计 |
| D6 | 手机端路线 | 原生 App / PWA / 飞书即客户端 | **三阶段（拍死，小孙 2026-07-03）** | 阶段 1 零前端开发即可手机对话；原生壳投入产出比最差放最后（r1 P3-2 认可无硬伤）|
| D7 | 微信生态 | 个人微信 / 企微机器人 / 不做 | **MVP 不做（拍死，小孙 2026-07-03）；二渠道候选=企微智能机器人** | 企微 WS 长连接同样免公网；个人微信风险不可控 |
| D8 | 绑定存储 | Redis / SQLite | **SQLite + drizzle（拍死）** | 本仓无 Redis，不为此引基础设施 |
| D9 | 出站安全 | 裸 fetch / SDK REST / SafeHttpClient | **SafeHttpClient 合同全量 + 域名 pin；SDK 仅 WS（拍死）** | r1 P2-2；F037 合同共享，谁先落地谁抽 |
| D10 | 入站幂等 | 内存 LRU / durable 账本 | **durable 入站账本 UNIQUE 三元组（拍死）** | r1 P1-1：clientMessageId 无服务端约束；LRU 重启失忆 |
| D11 | 出站可靠性 | 尽力而为 / 账本+reconcile | **出站账本状态机 + startup reconcile，at-least-once（拍死）** | r1 P2-1：偶重复优于静默漏推，对齐 F037 D10/D11 |
| D12 | 同绑定并发 | 拒绝丢弃 / FIFO 持久排队 | **FIFO 持久排队 + settle 后 drain（拍死）** | r1 P1-3：现有入口 busy 即丢；飞书已 ACK 不会重试 |
| D13 | 多人参与模式 | 多人 PWA / 飞书群桥接 | **飞书群桥接提级 Phase 2（小孙 2026-07-03 go）；多人 PWA 挂起待用户体系另立项** | 零用户体系（人人皆村长 :689）+ 网络可达双硬伤 vs 群桥接身份/客户端/推送全由飞书代劳且免公网、fail-closed 群白名单 |
| D14 | 群成员权限 | 群白名单即放行 / 成员级白名单+角色 | **chat AND sender 双白名单 + owner/participant 角色（拍死）** | r2 P1-2：仅群白名单=新成员入群即获完整派活权；participant 可对话可 @，特权命令面 owner-only |
| D15 | 出站路由依据 | 按 sessionGroup 过滤 / binding provenance 溯源 | **rootMessageId→channel_binding_id 溯源投递（拍死）；无外部来源 final 不投 IM** | r2 P1-3：仅 sessionGroup 过滤会私聊/群聊互串；后台 final 乱投 = 噪音 |
| D16 | final 标识来源 | 查最新 assistant message / 扩展事件 payload | **`invocation.finished` 加法扩展 assistantMessageId+rootMessageId（拍死）** | r2 P2-4：现 payload 无 messageId（event-types.ts:27-34）；「查最新」在并发下是错误答案 |

## Acceptance Criteria

### Phase 1 — 飞书 MVP（私聊闭环）

- [ ] AC1: 配齐 env 后 WS 长连接建立，断线自动重连；缺任一必需 env → connector 不启动、主服务零影响、启动日志明示
- [ ] AC2: 小孙飞书私聊发文本 → 绑定 room 出现村长消息 → 正常触发派发（与 web 输入等价）
- [ ] AC3: 逐 final 回推：direct final / 消息内 @范德彪 的 A2A finals / worklist continuation final / 错误终态回执，各自独立到达飞书；无空消息、无半截消息（终稿=overwriteMessage 后的内容；依赖 D16 `invocation.finished` payload 扩展）
- [ ] AC4: 非白名单 open_id 来信被拒 + 审计留痕不入 room；**非 p2p（群/话题）事件一律拒**（含白名单用户在群里发言）
- [ ] AC5: 幂等：同一 external_message_id 平台重投 + connector 重启重放，均不重复入库、不重复唤醒 agent（入站账本 UNIQUE 生效的正/负例）
- [ ] AC6: 出站安全测试面 = SafeHttpClient 合同全量（host pin 负例 / redirect 逐跳 / DNS rebinding / IANA 精确段 / userinfo / 非常规端口 / 流式 body 上限 / timeout+abort）+ 证明 REST 全走 SafeHttpClient、SDK 仅承担 WS；tenant_access_token 过期前自动刷新
- [ ] AC7: 排队：turn 进行中连发多条 → 全部持久化、严格按序执行、零丢失；进程中途重启 → 队列恢复继续 drain
- [ ] AC8: 出站可靠：final 落库后 connector 崩溃 / 飞书 API 失败 → 重启 reconcile 补投不漏；attempted 结果未知补投一次并标记；账本状态机可审计
- [ ] AC9: 小孙手机真机全链路验收：派活 → 收到各 agent 回复

### Phase 2 — 飞书群桥接·多人参与（2026-07-03 新需求提级）

- [ ] AC10: 群入站门 fail-closed：`chat_id ∈ 群白名单 AND sender_open_id ∈ 成员白名单` 且 @bot 才进 room；非白名单群 / 非白名单成员 / 未 @ 一律拒 + 审计 + 群内回执；participant 角色触发特权命令面被拒（owner-only）
- [ ] AC11: 发送者归因合同：归因文本不进派发解析行（前缀独立成行）+ 昵称剥 `@`/`[Call:` + `@bot` 剥离保行首；回归三样例全过：昵称含 `@` / 正文行首 `@范德彪` / `@bot @范德彪 …` 混排；正式路径=sender 持久化 + 替换 session-service.ts:689 硬编码（schema migration）
- [ ] AC12: 群内多人快速连发 → 复用 D12 FIFO（binding 粒度=群）保序全入库零丢失；queued ack 带原 sender 昵称 + 队列位置
- [ ] AC13: 出站溯源：群触发的 finals 只回群、私聊触发的只回私聊（rootMessageId→binding 正反例）；无外部来源的 room 内 final 不投任何 IM 绑定

### Phase 3 — 体验强化

- [ ] AC14: PWA（小孙自用移动全 UI）：manifest + 图标 + apple meta，iPhone Safari 可添加到主屏（LAN/Tailscale 访问 + 安全说明落 docs；**不对外分发** — D13）
- [ ] AC15: 流式占位卡（发送中→编辑成终稿）或等效体验
- [ ] AC16: 图片/文件收发（复用 ContentBlock）

### Phase 4 — 二渠道/部署扩展（候选，不在 F040 交付范围）

- 企微智能机器人 或 飞书 webhook 模式（公网部署时）—— 触发时**另立项 + 另过设计审**，不占本 feature AC

## 需小孙人工操作（铁律 3：我不碰 .env）

1. [飞书开放平台](https://open.feishu.cn/) → 创建**企业自建应用**（个人可免费建飞书团队）
2. 应用能力添加**机器人**；权限开通 `im:message`、`im:message:send_as_bot`（Phase 2 媒体再加 `im:resource`）
3. 事件订阅：订阅 `im.message.receive_v1`，连接方式选**长连接**（不用填回调 URL）
4. 「凭证与基础信息」拿 App ID / App Secret；发布应用版本并通过（自建应用秒过）
5. 获取自己的 open_id（应用发布后机器人私聊页可查，或开发者后台 API 调试台）
6. 填 `.env`（变量名以实施为准，预计）：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ALLOWED_OPEN_IDS`（逗号分隔）/ `FEISHU_BIND_SESSION_GROUP`（bootstrap 播种用，运行时真相源在 SQLite binding）
7. 重启运行时（start-project）

## Dependencies

- F037 SafeHttpClient 出站合同（共享模块，谁先落地谁抽）；F029 外发边界（设计对齐，代码未合 dev，不硬阻塞）
- F026 A2A 提及路由、F031 WS 可靠层（已在 dev，直接复用）
- 外部：飞书开放平台应用（小孙人工）、`@larksuiteoapi/node-sdk` 新依赖（合并后主仓需 pnpm install）

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-03 | Kickoff：clowder-ai 对照调研 + 本仓挂载点实测 + 架构草案 v1 + D1-D9（黄仁勋，夜间自主批；落库搭 F038 kickoff commit —— 并行 session 暂存竞态，原 `5cd2b68` 经 rebase 换号 `2bdf0ce`） |
| 2026-07-03 | 范德彪设计审 r1（codex exec）：**NEEDS-WORK 3P1+4P2+3P3** —— 幂等假设不存在 / per-turn emit 无 final 语义 / busy 即丢，全部 message-service.ts 逐条核实属实 |
| 2026-07-03 | 设计合同 v2 落盘（`36eba7e`）：入站账本 / invocation.finished 出站边界 / FIFO 持久排队 / 出站账本+reconcile / SafeHttpClient 全量 / p2p 硬门 / 绑定语义统一；D10-D12 新增 |
| 2026-07-03 | 小孙拍板：D1=飞书 / D3=专用移动房间 / D6=三阶段 / D7=不做微信（「按你推荐的来」）|
| 2026-07-03 | 新需求「别人手机进房间聊天」→ 评估：多人 PWA 不可行（零用户体系 + 网络可达双硬伤），改**飞书群桥接**提级 Phase 2（D13 + AC10-13 + 归因两级），PWA 降 Phase 3 小孙自用 → v3 落盘（`8a9ad42`）派德彪 r2 |
| 2026-07-03 | 德彪 r2：**NEEDS-WORK** —— r1 七条吸收核验全 ✅；群桥接抓 3 新 P1（同行前缀杀 @ 派发=classifyMention 行首 gray 实锤 / 群白名单≠成员授权 / 双绑定无溯源互串）+ 2 P2（finished payload 缺 messageId / phase 表矛盾）。v4 全接：合同 8-11 + D14-D16 + AC3/10-13 重写 + Phase 4 划出交付范围 → 派 r3 收口 |

## Links

- 调研详情：本文档「调研结论」节（clowder-ai file:line 锚点已内联）
- 设计审 r1 verdict：`.runtime/reviews/` scratch（不入库）
- Plan: 待 Design Gate（小孙拍板 + r2 GO）后走 writing-plans
- Related: F029 / F037 / F026 / F031

## Evolution

- **Evolved from**: 无（新领域：外部渠道）
- **Blocks**: 无
- **Related**: F029（外发边界）、F037（SafeHttpClient 共享 + 账本哲学对齐）、F026（提及路由复用）
