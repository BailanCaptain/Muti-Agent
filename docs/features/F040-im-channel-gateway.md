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
6. **p2p 硬门**（P2-3）：Phase 1 拒绝一切非私聊事件（含白名单用户在群里发言）；Phase 2 升级为 `p2p ∪ (白名单群 AND 白名单成员 AND @bot)`（成员级授权见 D14，防按「群白名单即可」的旧口径落地）。
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
- **飞书群桥接为什么顺**：身份/账号/推送/iOS+Android 客户端全部由飞书代劳。建一个飞书群拉朋友进来 → 群成员 @机器人 说话 → 消息带发送者昵称进绑定 room → agent 回复回群。仍然**免公网**（同一条 WS 长连接）、**fail-closed**（`chat_id AND sender_open_id` 双白名单：只有小孙拉白的群、且群内被小孙点名放行的成员才能说话 —— 见 D14 角色分级）。朋友手机装的是飞书 App，跟「装 PWA」同级操作。
- **发送者归因两级**（群模式必做，Phase 2 内；合同按德彪 r2 P1-1 加固）：
  1. MVP：归因前缀**独立成行**（`[飞书·<昵称>]\n<原文>`）——`classifyMention` 行首判定 walk-left 遇非空白即降 gray（mention-router.ts:255-260 实锤），同行前缀会杀死 `@范德彪` 派发；昵称必须转义/剥除 `@`、`[Call:` 等派发关键字面量（昵称是不可信输入，不得成为解析器输入）；`@bot` 提及剥离时保留用户命令行首
  2. 正式：user 消息持久化 sender 展示名 + timeline 映射取真名（替换 :689 硬编码），schema 加列 + migration
  - 回归样例（AC11）：昵称含 `@` / 正文行首 `@范德彪` / 群内 `@bot @范德彪 …` 混排，三组均正确路由
- **成员级权限（r2 P1-2）**：群白名单 ≠ 授权全群 —— 入站门 = `chat_id ∈ 群白名单 AND sender_open_id ∈ 成员白名单`（fail-closed，防新成员入群即获派活权）；成员带角色：**owner**（小孙）全权，**participant** 可对话可 @ agent，特权命令面（/bind、审批类、未来 IM 命令）owner-only；非白名单成员 → 拒 + 审计 + 群内回执
- **出站溯源（r2 P1-3）**：入站账本/FIFO 记 `channel_binding_id` → 注入后建 `rootMessageId → channel_binding_id` 映射 → final 沿 root/call chain 溯源，只投递到**来源 binding**（群触发回群、私聊触发回私聊）；**无外部来源的 final（room 内后台/定时产物）不投任何 IM 绑定**（防噪；「旁听模式」按 binding 开关留远期）
- **排队回执 UX**：群内多人连发时，queued ack 带原 sender 昵称 + 队列位置（否则不知道谁的任务在跑）
- **边界如实说**：群成员只能「对话」，看不到 web UI 面板（时间线/审批/交互卡片）——「在房间里聊天」这个诉求群桥接完全覆盖；哪天要给别人全 UI，再立用户体系 feature。

## AC13.5 顺序投递设计 v2（T13 mini-design · 德彪 r1 NEEDS-WORK 3P1+3P2 全接）

**问题**：同 root 协作链多 final（仁勋+德彪）各自 `invocation.finished` 时刻乱序——手机按完成序收、房间按起笔序显示（07-04 真机实锤：德彪 34s 完成先到，仁勋调工具 58s 后到）。

**目标**：同 binding 内、同 root 链的 finals 按其 assistant message 的房间 `created_at` 序投递；跨 root 不互等；任何 agent 卡死不得饿死投递。

**方向（德彪 r1 拍）：B' = 顺序就绪即投 + durable order gate + 非阻塞 hold**（A 会把首条时延绑死在链尾最慢 agent，真机 UX 退化）。

**状态机扩展（r1 P1-1：hold 禁止复用 pending 语义）**：
- 出站账本新增状态 **`held_order`**（与 pending 显式区分）；deliverFinal 登记时判序，被阻塞 → `held_order` + 记 `hold_since`
- **所有放行路径过同一道门 `canReleaseOrdered()`**：正常 release（前序 sent/terminal 后重扫）、`invocation.failed` 重扫、**boot reconcile**（重启后 held_order 行同样过门——顺序门不因重启失效）、60s sweeper。四路径无一例外

**判定谓词（r1 P1-2：双腿，不建 durable root 映射表）**：
- **Leg A（durable·账本自持）**：outbound 账本加列 `root_message_id` + `message_created_at`（登记时写入：root 来自 finished 事件，created_at 查 messages 表）。阻塞条件=同 binding 同 root 下存在 `message_created_at` 更早且非终态（pending/attempted/held_order）的行
- **Leg B（live·注入 dep）**：`hasEarlierRunningTurn(rootMessageId, beforeCreatedAt): boolean`——生产接 dispatch 内存 chain + invocation registry：同 root 链上 `started_at` 早于该 final `message_created_at` 的 running invocation 存在 → 阻塞。**重启后内存清零 = Leg B 自然放空，语义正确**（进程死掉的 invocation 永远不会产出 final，不该阻塞；已登记未投的残余顺序由 Leg A 承担）
- 保守性如实说：Leg B 按 invocation `started_at` 判可能过度阻塞（agent 起得早终稿晚）——代价是多等不乱序，可接受；上限由 sweeper 兜

**非阻塞 hold（r1 P1-3）**：`onInvocationFinished` 登记（含判序落 held_order）后**立即返回**——finally 清 inflight + 续 drain 原样，下一条用户消息不被 hold 间接卡住（跨 root 不互等）。放行由独立 rescan 驱动：同 root 的 finished/failed 事件触发 + sweeper tick，不占入站 turn slot。

**原子 claim（r1 P2-4）**：任何放行进发送前 CAS：`UPDATE ... SET state='attempted', attempts=attempts+1 WHERE id=? AND state IN ('pending','held_order')`，`changes=1` 才发（正常放行/failed 重扫/reconcile/sweeper 四路并发抢同一行只有一家赢）；sweeper 强制放行在同一临界区先重查前序——刚好已正常可放行的不打 forced 标。

**NULL 兼容（r1 P2-5）**：`message_created_at IS NULL` 旧行 = legacy ready：不作阻塞源、不被顺序门阻塞，按账本 `created_at` 原 AC8 语义补投。

**超时口径（r1 P2-6）**：计时基准 = **`hold_since`**（进 held_order 的时刻；不用 message_created_at——长工具调用不误强放）；`ORDER_HOLD_TIMEOUT_MS = 60_000` 常量；强制放行审计 `out-of-order-forced` 至少带 `rootMessageId / bindingId / forcedMessageId / forcedCreatedAt / blockedBy[] / holdAgeMs / forceAfterMs`。

**Schema（T14 migration）**：`channel_outbound_ledger` ADD COLUMN `root_message_id TEXT` / `message_created_at TEXT` / `hold_since TEXT`（三列 NULL 兼容旧行）。

**边界如实说**：顺序保证域 = 同 binding × 同 root 链；跨 root（两条独立用户消息）仍按各自完成序，不做全局排序（消息总线级课题，非本 AC 范围）。

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
| D17 | 渠道授权配置载体 | env 变量（改配置要重启+小孙抄 open_id）/ DB 真相源 + 管理页 | **DB 真相源 + 前端渠道管理页（小孙 2026-07-04 拍板「我想要…到时候我自己来配」）；env 降为首启种子** | 群成员放行是高频运营动作，env 路径=改配置+重启+查日志抄 ID 三重反人类；DB 化后待放行列表一键放行、热生效；fail-closed 语义不变（表空且无种子=全拒） |
| D18 | PWA 出局域网可达 | 公网暴露+登录认证 / 私有组网（Tailscale/蒲公英）/ 只限 LAN | **私有组网（小孙 2026-07-04「你说的这个不错」）：PWA 严格自用，不做多用户认证** | 出站中继（飞书）已覆盖「别人对话」场景；进站全功能 UI 只给小孙自己设备——私有组网不对公网开门、无需登录体系、TLS 由隧道代劳；装机指引落 docs（小孙 10 分钟手工活） |
| D19 | 飞书命令面（Phase 2.6，小孙 2026-07-04 拍板） | 中文词 / 英文斜杠；全局模型 / 房间级覆盖 | **英文斜杠 + owner-only fail-closed + 模型改房间级覆盖**（`/model` 缺省当前房间、可带 R-号定位任意房间、`default` 清覆盖回全局；/rooms 返回=R-号+房间名） | 手机好打、误操作爆炸半径=单房间可一键还原；D14 特权命令面 owner-only 兑现；复用 session-runtime-config 现成校验（型号防注入/强度闭集/运行中守卫） |
| D20 | 绑定房间概念走向（小孙 2026-07-04「做完绑定房间概念是不是就没了」） | 删除绑定概念 / 保留但自助化 | **保留但自助化**：绑定=「这个对话进哪个房间」的落点不可删（语境/记忆边界）；死掉的是「配置死绑定」——env 种子降 bootstrap 遗留、回执文案改指 /newroom·/switch、演化废代码专项清扫（AC-N6） | 每条入站消息必须归属某房间（channel_bindings 是运行时真相源 D3）；命令面把改绑从「小孙配 env 重启」变「一句话」 |

## Acceptance Criteria

### Phase 1 — 飞书 MVP（私聊闭环）✅ 2026-07-04 全 AC 真机闭环（未合 dev，按小孙拍板 feature 全做完再合）

- [x] AC1: 配齐 env 后 WS 长连接建立，断线自动重连；缺任一必需 env → connector 不启动、主服务零影响、启动日志明示 —— 真机 `[F040] Feishu connector started` + `ws client ready`；缺 env 走 disabled 分支只 log（config.test 全绿 + 预览多轮重启实证）
- [x] AC2: 小孙飞书私聊发文本 → 绑定 room 出现村长消息 → 正常触发派发（与 web 输入等价）—— 真机 07-04：入站账本 11 条 injected，室内 user 消息+派发全链
- [x] AC3: 逐 final 回推：direct final / A2A finals / continuation / 错误终态回执 —— 真机：仁勋+德彪双 final 各自到手机（outbound 全 sent）；错误回执/continuation 单测覆盖（outbound.test）
- [x] AC4: 非白名单拒 + 审计不入 room；非 p2p 一律拒 —— 真机：占位白名单拒绝日志 `[F040:inbound-reject]`（open_id 自举法）+ 单测正反例
- [x] AC5: 幂等 UNIQUE 正/负例 —— inbound.test + reconcile.test 全绿
- [x] AC6: SafeHttpClient 合同全量 + SDK 仅 WS + token 自动刷新 —— safe-http-client 合同测试全量 + TokenManager 300s 预刷/单飞 + 真机 token 探测实证
- [x] AC7: 排队保序零丢失 + 重启恢复 —— 真机 07-04：连发 3 条 seq 9/10/11 严格保序全 injected 顺序回投；重启恢复走 reconcile.test
- [x] AC8: 出站账本 + reconcile 补投 + possible_duplicate 标记 —— outbound/reconcile 测试全绿 + 真机账本全程 sent 可审计
- [x] AC9: 小孙手机真机全链路：派活 → 收到各 agent 回复 —— 07-04：手机"叫德彪报到" → 仁勋(蓝头卡)+德彪(橙头卡)双署名卡片到手机；B025 修复后 trigger_mention 中继链真机通

### Phase 2 — 飞书群桥接·多人参与（2026-07-03 新需求提级）

- [x] AC10: 群入站门 fail-closed：`chat_id ∈ 群白名单 AND sender_open_id ∈ 成员白名单` 且 @bot 才进 room；非白名单群 / 非白名单成员 / 未 @ 一律拒 + 审计 + 群内回执 —— 门单测 9（group-gate）+ e2e 三拒（未@静默零痕迹/陌生群不回执防探测/陌生成员回执引导）+ **真机 07-04 owner 路径放行全链**。特权命令面：Phase 2 IM 侧无命令面（空集为真）；Phase 3 若引入命令必须带 owner-only 门
- [x] AC11: 发送者归因合同：归因文本不进派发解析行（前缀独立成行）+ 昵称剥 `@`/`[Call:` 到不动点 + `@bot` 剥离保行首；回归三样例全过（attribution 6 测 + parser 混排/改名注入/纯@bot）；正式路径=sender_display_name 持久化 + session-service.ts:689 硬编码替换（T11 `1bb7c57`，组件 812 零回归）—— **真机 07-04：注入 `[飞书·村长]\n介绍下你自己` + sender_display_name=村长 实测入库**
- [x] AC12: 群内多人快速连发 → 复用 D12 FIFO（binding 粒度=群）保序全入库零丢失；queued ack 带原 sender 昵称 + 队列位置 —— group-queue 4 测 + e2e ack 断言 + **真机 07-04：小孙连发两条，第二条即时收「已排队（第 1 位）｜村长」，先后顺序 injected 双回投**
- [x] AC13: 出站溯源：群触发的 finals 只回群、私聊触发的只回私聊（rootMessageId→binding 正反例，provenance 3 测）；无外部来源的 room 内 final 不投任何 IM 绑定 —— e2e 互不串 + **真机 07-04：p2p→R-001「手机」/ 群→R-002 双 binding 隔离，回执各归各 chat**
- [x] AC13.5: 顺序投递（07-04 真机反馈提级）：同 root 协作链的 finals 按**房间消息创建序**投递。实现=`held_order` 账本态 + 双腿判定（Leg A durable 账本 / Leg B live 在飞 turn）+ CAS claim + hold_since 60s sweeper 强放（设计 v2 德彪 r1 NEEDS-WORK 6 条全接 → r2 GO；T14 `da9678b`，ordered-delivery 9 测）—— **真机 07-04 开火实录：「让德彪背首诗」德彪先完稿被 hold（outbound-held audit 在案）→ 仁勋投出 → rescan 放行德彪，投递完成序=房间起笔序，hold→release 接力 410ms**

### Phase 2.5 — 渠道管理页（2026-07-04 小孙拍板新增，D17；T16 多人真机挂起并入 AC-M4 由小孙自配自验）

- [x] AC-M1: 渠道授权配置 DB 真相源：群白名单 / 群成员白名单（open_id+名字+角色）/ 群绑定 / p2p 白名单迁 SQLite 表；env 变量降为**首启种子**（对应表空时一次性导入，表非空以 DB 为准）；fail-closed 语义保持（表空且无种子 = 全拒，connector 启动条件不变）—— 三表 `740c258`（members 一表吃两 env 域：owner=p2p+群全权）+ seed 域独立判空 + wire 接线 `6adbccb`；guardian 核 fail-closed 推演+seed 幂等/DB wins 测试
- [x] AC-M2: 配置改动**热生效**：管理面增删成员/群/绑定后，下一条入站消息即按新配置判定，无需重启进程 —— gateway config getter 化（cfg() 现读）+ store 快照写失效；🔴 单例约束（server.ts 唯一 ChannelAdminStore 供路由与 connector 共享，双 SQLite 连接下缓存失效实例内闭环）；hot-config 9 测 + wire 全链「放行后同实例即通」+ 换绑同事务改 channel_bindings `2a25f19`
- [x] AC-M3: 管理 API（fail-closed 校验）：CRUD + 拒绝审计持久化（网关四拒绝点 recordReject 聚合 upsert）+ 待放行查询 + 一键放行事务 —— 校验显式 400（末位 owner 删/降级/放行覆写三路防自锁、归档房不可绑、控制字符拒、**allow 只收 pending 成员类 + role 缺省按 reason 后端定**（德彪 r1 P1/P2 修 `d7621fa`））；路由 12 测
- [x] AC-M4: 设置→「渠道」tab：待放行一键放行（reason 分型：起名放行/放行为 owner/群加白/绑房引导）+ 成员改名删除 + 群开关+绑定房间下拉 `5aa40fa`；E2E 3 用例（成员 CRUD/群绑定开关/放行流种子直写）+ 验红记录 + 全套 6/6。**真机 ✅ 07-04 小孙亲验「整理链路通的验证过了」**（seed 导入 members=1 groups=1 开箱有数据 → 放行流全链）

### Phase 2.6 — 飞书指挥面（2026-07-04 小孙拍板：Phase 2.5 真机验收「整理链路通的验证过了」后三条反馈 + 词表两轮收敛，D19/D20）

- [x] AC-N1: 命令面基建（owner-only fail-closed）：入站文本 `/` 开头且 sender=owner → 走命令管线（**不注入房间**，回执只回飞书）；非 owner 发已知命令 → 回执「仅群主可用」不注入；未知 `/xxx` → 提示 /help；命令处理异常不击穿入站主链 —— 门后 binding 前截流 `8019c56`（陌生人摸不到命令面/未绑群可 /newroom）+ channel_command_audit UNIQUE 三元组幂等（WS 补推真机实测过的攻击面）+ 非 owner **任何** `/` 文本一律拒（不泄词表，AC 超集）+ executor 异常收口成失败回执；gateway 10 测 + guardian 突变甄别（owner 判定取反 → 8/10 红）
- [x] AC-N2: 六命令全落（词表 D19）：`/rooms`（R-号+房间名，标当前绑定）｜`/newroom <名>`（建房+当前对话换绑一步）｜`/switch <R-号|名>`（换绑=复用管理页同一原语）｜`/agent <花名>`（改绑定默认应答人，热生效）｜`/model [R-号] [<agent> <型号> [强度] | <agent> default]`（房间级模型覆盖读/写/清，复用 session-runtime-config 校验+运行中守卫）｜`/status`（房间+默认应答人+各 agent 生效模型标注覆盖/继承）｜`/help` —— channel-commands.ts `709eb6b`+`46f45c2`：parser 纯函数全形态 + executor 20 测（/model 双闸=型号格式闸防 spawn argv 注入 + validateSessionRuntimeConfigInput；busy→pending 下轮生效/空闲→config+同字段清 pending 防倒灌；default 双层清保 contextWindow）；装配 `d54ff9a` wire 全链（/newroom→建房+换绑+回执，12 测）
- [x] AC-N3: 成员**禁用**开关：channel_admin_members 加 `enabled` 列（含存量库 ALTER 迁移）；门检查 enabled=0 按非白名单拒；管理页成员行开关（替代「只能删」——小孙：「移除直接没了 没有个禁用权限的选项」）—— `e09570d`+`2b3427b`：三 DDL 面（CREATE+ALTER+drizzle 镜像，存量迁移真测试）+ getAuthView 只装 enabled（禁用 owner 连命令面都进不去，fail-closed 免费拿到）+ 守卫矩阵改「可用 owner 数」（堵「一禁一活删活的=全锁」洞）+ allowFromAudit 复活；E2E 开关双向翻转
- [x] AC-N4: 回复卡片署名带模型型号（如 `黄仁勋 · claude-opus-4-8`）——「调用的啥模型也不知道」从此可见 —— `2b3427b`：数据源 = messages.model（F021 逐消息快照，追加时冻结——改配置不改历史）；卡片头「花名 · 型号」配色仍按花名 key；文本兜底【花名 · 型号】；老行 model=null 退纯花名；reader 真表 + sender 卡片 JSON + gateway 透传三层测试
- [x] AC-N5: 管理页增强：群行「默认应答人」下拉（与 /agent 同一原语，网页/手机双入口）+ **命令参考手册节**（渠道 tab 内，词表+示例）—— `d366b5d`+`641b0f5`：setDefaultResponder 单原语双入口 + overview effectiveDefaultProvider（binding??渠道默认）+ 手册九行词表；E2E 下拉→binding 落库断言
- [x] AC-N6: 渠道概念清理（D20）：演化废代码 sweep（Phase 1→2.5 过时分支/字段/文案）+ 回执统一（unbound 回执改指 /newroom·管理页双路）+ 概念收敛结论落 doc；真机验收 = 小孙手机全词表过一遍（建房/切房/换人/换模型/看状态）—— **代码侧全落 `e153ef1`**（回执双路+换绑统一 rebindChat+sweep 核账见下方 D20 结论段；guardian 亲核无旧文案残留/countOwners 无活调用）；**真机 07-05 PASS**：audit 表 9 条全 `done` 零 error，七词全覆盖；`/newroom 测试新` 建 R-003 + `/agent 范德彪` → binding(oc_8c37)={R-003, codex} 落库实证；命令混聊天（`/agent 范德彪 我想要你来解释下`）引导重试 fail-safe 真机走过

> **D20 收敛结论（2026-07-05 落地）**：绑定概念**保留但自助化**——绑定 = 「这个对话进哪个房间」的落点，每条入站消息必须归属某房间（channel_bindings 是运行时真相源，D3），概念不可删。死掉的是「配置死绑定」：改绑从「小孙配 env 重启」变成三入口一原语（`rebindChat`）——飞书 `/switch` `/newroom`、管理页绑定下拉、（binding 缺失时当场建出，不再等首条消息 lazy-bind）；默认应答人同构（`setDefaultResponder` = `/agent` + 管理页下拉）。env 四个授权域变量（ALLOWED_OPEN_IDS/GROUP_MEMBERS/ALLOWED_GROUP_CHATS/GROUP_BINDINGS）降为首启种子（channel-config.ts 头注已更新）；unbound 回执改指 /newroom·管理页双路。sweep 核账：countOwners（enabled 盲区自锁洞）已删、PATCH 换绑双路径已并、无其他 Phase 1→2.5 死分支（wireFeishuConnector 静态 config 分支保留 = 测试/多渠道 back-compat 面，有活消费者非废代码）。

### Phase 3 — 体验强化

- [x] AC14: PWA（小孙自用移动全 UI）：manifest + 图标 + apple meta，iPhone Safari 可添加到主屏（LAN/**私有组网（Tailscale/蒲公英，D18）**访问 + 隧道装机指引与安全说明落 docs；**不对外分发、不做多用户认证** — D13/D18）（真机✅：主屏三金点 + 手机适配修3/修6 + 私有组网 publicHost 修4，iPhone 实机可用）
- [x] AC15: 流式占位卡（发送中→编辑成终稿）或等效体验（真机✅：变身 + sweeper expired 双路实证）
- [x] AC16: 图片/文件收发（复用 ContentBlock）（真机✅：私聊图/文件双向 + 群图 owner 裸发（修5）+ 出站图（im:resource 权限）+ 出站文件（send_file 修7）；已知平台限制：群裸文件入站事件飞书不推（不阻塞，见 Timeline 07-10））

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
| 2026-07-03 | 德彪 r2：**NEEDS-WORK** —— r1 七条吸收核验全 ✅；群桥接抓 3 新 P1（同行前缀杀 @ 派发=classifyMention 行首 gray 实锤 / 群白名单≠成员授权 / 双绑定无溯源互串）+ 2 P2（finished payload 缺 messageId / phase 表矛盾）。v4 全接（`ae6e0e1`）：合同 8-11 + D14-D16 + AC3/10-13 重写 + Phase 4 划出交付范围 |
| 2026-07-03 | 德彪 r3：吸收对照 5/6 ✅，唯一 ❌ = v3 残留句「白名单群内全员可发」与 D14 冲突（:126）+ 建议 :107 门公式补成员项。v5 两处清残留（`c430c69`，grep 全文无其他残留）→ 派 r4 确认 |
| 2026-07-03 | 德彪 r4：**GO** —— 两处修复确认到位，残留仅 changelog 复述不构成新口径。**Design Gate 关闭**（小孙拍板 D1-D16 + 德彪 r1→r4）→ writing-plans 产出 Phase 1 实施计划（16 Task，见 Links）→ 开 worktree 动工 |
| 2026-07-03 | **Phase 1 代码侧 T1-T15 完成**（worktree `feat/F040-im-channel-gateway`，未合 dev）：T1-T3 `af381af`（SafeHttpClient 共享 net/+三表+config）/ T4-T8 `4e0dd09`（parser+gateway 门/幂等/FIFO/注入）/ T9-T11 `bd573a0`（D16 扩展+出站 hook/账本/reconcile）/ T12-T13 `3225dfc`（TokenManager+Sender）/ T14-T15 `680f1f0`（接线+E2E）。**121 单测全绿 + typecheck/build 0 err**；quality-gate 亲验：三表+三 UNIQUE 物化、SafeHttpClient host pin、lark SDK 可 import。AC1-8 代码侧落地，**AC9 待小孙真机** |
| 2026-07-03 | **独立验收 guardian PASS**（AC1-8 有实现+真测试+亲验 121/121 无假绿，拒绝分支 spy 零调用真 fail-closed）；**德彪代码审 r1 NEEDS-WORK 2P1+2P2+2P3 全接**：P1-1 direct turn 不占 slot getBusyStatus 靠不住→gateway inflight 追踪排队（我 fake「注入即 busy」掩盖了这生产语义差，guardian 信任测试而漏——真 Codex 刚需的又一实证）/ P1-2 archived 注入只 emit status→标 rejected+回执不无条件 injected / P2-1 start 失败不击穿 boot / P3-1 seq 排序兜底 / P3-2 正文不 trim / guardian 残余3 error-final 测试。修复 125 测试全绿。**残余（doc 记录，不阻塞）**：SafeHttpClient IP 钉死/TOCTOU 未做（host 硬 pin open.feishu.cn 使 rebinding≈0，继承 F037 Phase 1 边界）、ws-reconnect 细粒度日志由 SDK 内建承担、双 SQLite 连接高并发写留意 SQLITE_BUSY（真机关注）|
| 2026-07-03 | r1 修复合 `5887592`（门禁全绿）。德彪 r2 首派卡 codex usage limit，额度恢复后重派 |
| 2026-07-03 | 德彪代码审 r2：r1 六条修复对照**全 ✅**；两个取舍点判可接受（multi-invocation 首 finished 放行 / archived 逐条回执）；抓 **P1-new**（r1 修复改出的新洞）：deliverFinal 在 inflight.delete 之前 await，sender/token 异常（getToken 不在 try 内）→ inflight 永不清 → binding 队列**永久卡死**。修复 `42dec30`：gateway try/catch/finally（audit+无条件清+续 drain 双兜底）+ sender getToken 包 try 转非 terminal SendResult（双保险）+ 卡死复现测试，127 测试全绿 |
| 2026-07-03 | **德彪代码审 r3：GO**（静态复核 :138/:145/:149 + sender :47-49 修复到位，无新增阻塞）。**代码审收敛 r1→r3，Phase 1 代码侧全闭环**。剩：① 小孙飞书开放平台建应用 + 填 .env 四变量 + 重启 ② 真机验 AC9 ③ 合并拍板（AC9 过前不合 dev；合并后主仓 pnpm install 吃新依赖）|
| 2026-07-04 | **AC9 真机主链路 ✅**（小孙建飞书应用「multi-agent」→ worktree 预览注入凭证实测）：入站门/幂等/绑定/注入/出站回投全链真机验证（inbound ledger 5 条 injected、outbound 4 条 sent、手机收到 claude 终稿）。**open_id 自举法实战有效**（占位白名单拒绝日志抓 `ou_78b3...`）。飞书后台坑：事件订阅要"长连接"+ 接收消息 v2.0 + **读权限**（`im:message.p2p_msg:readonly`，只开发消息权限收不到）+ 改完必须发新版本。web/api 双端 :3103/:8803 |
| 2026-07-04 | **真机揪出 B025**（`docs/bugReport/B025-trigger-mention-target-contract.md`，dev 老 bug 非 F040 引入）：小孙手机让仁勋"叫德彪"三连死——`trigger_mention` 参数名 `targetAgentId` 暗示 provider id、描述要花名，agent 传 `codex` → `[Call: @codex]` 网关解析不出静默零派发但工具返回假成功（haiku/opus 都踩，网页端同样复现=与 F040 无关但挡 AC9「各 agent 回复」）。**修复随本 worktree 合 dev**（`e05bbe0`）：callbacks 路由层 `resolveMentionTarget` 归一化（剥@前缀/花名精确/provider id 大小写不敏感映射/未知目标 ok:false+status 广播走 F026 冒泡通道供 agent 自纠）+ MCP schema 描述明示 + 测试矩阵（原 happy-path 竟把 `@范德彪` 原样透传当正例=双 @ 死局，一并修正）。5/5+4/4 绿 |
| 2026-07-04 | **AC7 真机 ✅**（连发 3 条间隔 4-5s，账本 seq 9/10/11 严格保序全 injected+顺序回投）。**小孙拍板：先不合 dev，feature 全部做完再合**（对齐家规 feature-completion-before-merge）→ Phase 2 群桥接接续开工。**德彪增量审 r4：GO 无 P1**（B025 归一化 fail-closed 全覆盖/FinalMessage 两消费点改齐/卡片 JSON 无注入面确认）+ 1P2+1P3 当轮修：P2=token 终态误进文本兜底（白耗网络+双 invalidate）→ SendResult 加 tokenInvalid 标记、token 类终态直接返回不兜底；P3=outbound fake 定值署名掩盖映射错 → readFinalMessageFromDb 抽独立模块 + 真表四路测试（claude/codex/gemini/无线程）。sender 16 + reader 4 全绿 |
| 2026-07-04 | **B025 修复后真机复测 ✅ = AC9「各 agent 回复」多 agent 证据**：手机"叫德彪报到" → 仁勋 trigger_mention（`[Call: @范德彪 …]` 正确）→ 德彪派发 done → "收到，我在线" → **德彪终稿回投手机**（D15 root 链跨 agent 生效，outbound 双条 sent）。小孙新反馈三条：① 收到顺序德彪先仁勋后（房间按起笔序/手机按 turn 完成序的天生竞态）→ **AC13.5 记 Phase 2**；② 不知道谁回的 ③ 卡片白条丑 → **出站署名卡片一并修**（`6119ae3` markdown 卡片 + `b357dee` 署名）：FinalMessage 契约升级（readFinalMessage 返回 content+senderAlias，server JOIN threads 映射花名）、卡片彩色 header（仁勋蓝/德彪橙/桂芬绿/未知 turquoise）、文本兜底【花名】前缀；57/57 绿。**中途坑：preview tsx watch 热重载一度不生效**（8803 老进程照跑害小孙白测一轮）→ 预览验证一律硬重启+核对新 pid listening 日志 |
| 2026-07-04 | **Phase 2 代码侧 16 Task 全落**（计划见 Links；每笔过全量门禁）：T1/T2 `d57d926` config 群三元组+消息群字段 → T3 `ab0032a` 群门双白名单+@bot → T6 `8265756` 归因前缀注入 → T8 `5f6fa6e` 群排队回执 → T9+T13 `aa172f7` 溯源正反例+顺序设计 v2 → T10 `4871468` sender 列（**三 DDL 真相源坑**：sqlite.ts/drizzle-instance.ts/schema.ts 必须一把梳齐）→ T14 `da9678b` 顺序投递全量（AC13.5 设计审德彪 r1 NEEDS-WORK 6 条全接→r2 GO）→ T11 `1bb7c57` 归因正式级 → T5+T7 `8cf0267` 群 mentions 解析+bot open_id → T12 `c79e3a7` 群链路 e2e 种子（**坑：node:sqlite 行 null-prototype，deepEqual 前必 spread**）。**坑：门禁全量测试被预览进程负载 flake 挂 → 门禁期间必停预览** |
| 2026-07-04 | **T4 真机 fixture 校准 ✅**（`f718fba`）：小孙建群发 `@multi-agent 测试`，预览 `FEISHU_DEBUG_EVENTS=1` 抓 `[F040:raw-group-event]` —— **文档 schema 假设全中零改 parser**（mentions[].key=`@_user_N`/id.open_id/name 一致）；真机多 `mentioned_type:"bot"` 字段（故意不依赖：open_id 精确比对，多 bot 群 @别家不误判）；bot open_id 探针 `bot/v3/info` = mention 值 **MATCH=true**；原始 JSON 逐字冻结 3 用例。**观察：飞书 WS 断线期间消息重连后会补推**（第一条测试消息迟到送达） |
| 2026-07-04 | **群真机 smoke 全绿（单人全链 LIVE）**：群 `oc_23e6...` 绑预览 R-002（p2p 留 R-001，两房隔离）→「@multi-agent 介绍下你自己」门放行→归因注入→黄仁勋蓝头署名卡片回群（小孙确认）→ 账本 injected/sent+root 溯源全对；**AC12 live**=连发两条第二条即时排队 ack；**AC13.5 live 开火**=「让德彪背首诗」德彪先完稿 hold→仁勋投出→rescan 放行，投递序=房间起笔序。**观察（不修，复发再立案）**：仁勋某终稿 content 里泄漏工具调用 XML 原文（`<invoke name=trigger_mention...`），网页/IM 同显——主库 5235 条历史 0 例、预览仅此 1 例，判 opus-4-8 一次性 model slop（真 call 已执行+又把 XML 写进正文），非 runtime 慢性病，按 YAGNI 不建消费端消毒器（F027 V14 教训）。**剩**：T15 quality-gate+guardian+德彪 Phase 2 全量审 → T16 多人真机（成员白名单第二人自举）→ 小孙合并拍板 |
| 2026-07-04 | **T15 三重审全收敛**：① 零上下文 guardian **PASS**（8 套 58/58 亲跑全绿，五 AC 实现锚点+假绿甄别+真机证据链自洽，「无一处文档写了代码没有」）② 真德彪 Phase 2 全量审 **r1 NEEDS-WORK 2P2 / 0P1**（并发主路径 CAS/四放行未见双发窗口；四项取舍全接受）：P2-1=drizzle MIGRATIONS 漏 sender_display_name（**三 DDL 教训第四张脸=双迁移系统也要镜像**）、P2-2=顺序门缺同毫秒 tie-breaker（房间按 (created_at,rowid) 排、门只比 created_at → 同毫秒双 final 退化完成序）③ 修复 `788fb6c`（19 文件 +367/-50）：drizzle 迁移镜像+回归测试；FinalMessage.orderSeq=messages.rowid、账本 message_order_seq 列（CREATE+重建 v2 内联+中间态 ALTER 三路径收敛）、Leg A 四放行路径 (created_at,rowid) 精确判序、Leg B 平局保守阻塞（`<=`，判定核抽纯函数 hasEarlierAliveEntry）+invocationId 自排除透传防自锁；新增 10 测试（平局正反向/判定核矩阵/迁移边）→ **德彪 r2 GO 零 findings**（六参占位/DDL 三路径/markFinalEmitted 先于 emit 时序全实证）。**Phase 2 代码侧全闭环**，剩 T16 多人真机 + 小孙合并拍板 |

| 2026-07-04 | **新群重建真机再证群门 + 方向拍板**：小孙加外部联系人需重建群+重发版 → 新群首条 `@multi-agent 测试` 命中群白名单静默拒（`[F040:inbound-reject] group-not-allowed` 审计带新 chat_id `oc_8c37...`，防探测不回执真机实证）→ 预览换新群配置重启即通（小孙「通了」）。观察：应用未开 `im:chat:readonly` 类权限，列群 API 99991672 被拒 —— 不开权限，自举法（审计日志抓 ID）即够。**小孙三拍板**：① T16 挂起，成员配置「到时候我自己来配」→ **Phase 2.5 渠道管理页立项**（D17，AC-M1~M4，T16 并入 AC-M4）② PWA 出局域网走**私有组网**不做多用户认证（D18，AC14 措辞更新）③ 重申 feature 全做完（含 Phase 3）才合 dev |

| 2026-07-04 | **Phase 2.5 代码侧全链落地 + 三重审收敛（当日立项当日闭环）**：M1-M3 `740c258`（三表+ChannelAdminStore：seed 域独立/快照写失效/审计聚合/放行事务）→ M4-M5 `6adbccb`（gateway config getter 化 11 读点归一 + 四拒绝点 recordReject + wire 种子导入；回执文案 env→管理页）→ M6-M7 `2a25f19`（REST 路由+server 单例接线+换绑同事务热更 channel_bindings）→ M8-M9 `5aa40fa`（设置→渠道 tab 三节 + E2E 3 用例验红验绿）。**三重审**：quality-gate（build/lint 0 + 全量绿）→ 零上下文 guardian **PASS**（46+168 单测+3 E2E 亲跑；单例/假绿甄别/fail-closed 全核；2 措辞观察：成员实为渠道级=与门语义一致、角色切换 API 有 UI 无）→ 真德彪 r1 **NEEDS-WORK 1P1+2P2 全真全接** `d7621fa`（P1=allow upsert 覆写可降级末位 owner 自锁（stale audit）→ PATCH 同款守卫+role 缺省按 reason；P2=allow 不限 pending/群类致审计与真相分叉→409/400 分型；P2=E2E 固定主键 retry 撞 PK→种子唯一化）3 回归测试先红后绿 → **r2 GO 零 findings**。**顺手根治 ingest-modal 慢性 flake** `df2e23f`（useEffect 晚一拍发回调，门禁序列 2/3 复现，连拦两笔 commit→断言包 waitFor）。**新坑**：playwright.config 顶层代码 worker 会重求值——暴露路径 env 给 spec 必须「已设不覆盖」守卫。剩：小孙真机自配验收（AC-M4 尾巴）→ Phase 3 |

| 2026-07-04 | **Phase 2.5 真机验收 ✅ + Phase 2.6「飞书指挥面」立项**：预览带全配置重启（boot 日志实锤 seed 导入 members=1 groups=1）→ 小孙页面放行流真机亲验「整理链路通的验证过了」→ **AC-M4 全勾，Phase 2.5 关账**。小孙三条反馈立项 2.6：①成员只能删没有禁用（AC-N3）②绑定房间该有飞书命令行建房/切房（AC-N1/N2，D20=绑定概念保留但自助化+废代码清扫 AC-N6）③默认仁勋改不了+模型型号不可见（AC-N2 /agent /model + AC-N4 卡片带型号 + AC-N5 管理页默认应答下拉）。词表两轮收敛（D19）：全英文斜杠/owner-only/模型房间级覆盖可带 R-号定位/rooms 返回=R-号+房间名/命令手册进渠道 tab。顺序：N3/N4/N5 小件先行 → N1/N2 命令面大头 → N6 清扫收尾 → Phase 3 |

| 2026-07-05 | **Phase 2.6 代码侧全落（立项次日闭环，10 commit 每笔过全量门禁）**：plan `f27f445`（终态 schema 先行：command_audit 幂等表/enabled 迁移面/型号署名合同/命令面旁路架构）→ T1 `e09570d` N3 后端（守卫矩阵改「可用 owner 数」堵一禁一活自锁洞）→ T2 `2b3427b` N3 前端+N4 型号署名（messages.model 快照源）→ T3 `d366b5d` 绑定原语三件（rebindChat/setDefaultResponder，binding 缺失当场建出）→ T4 `641b0f5` N5 前端 → T5 `8019c56` N1 命令面基建（门后 binding 前截流+channel_command_audit 幂等+owner 门）→ T6 `709eb6b` parser+五命令 → T7 `46f45c2` /model（双闸+busy→pending+default 双层清）→ T8 `d54ff9a` 装配（senderOverride 测试缝）→ T9 `e153ef1` N6 清扫（unbound 回执双路+换绑统一+D20 结论落 doc）。**坑**：JSON→bash→Python 三层转义吃 `\n`（长字符串走 Edit 不走 heredoc 替换）；「gpt 5」带空格分词成强度参数（形态归类先想分词） |

| 2026-07-05 | **Phase 2.6 三重审收敛**：① quality-gate 亲验（build exit 0 / biome lint 0 error / 全量单测每 commit 绿 / E2E 6/6）② 零上下文 guardian **PASS**（7 套 113/113 亲跑 + 三处突变甄别全部真红真恢复（owner 判定取反 8/10 红/enabled 过滤删除 3 红/格式闸短路 1 红）+ 四条 fail-closed 路径 file:line 级推演无绕过 +「无一处文档写了代码没有」）③ 真德彪 r1 **NEEDS-WORK 1P2/0P1**（PATCH groups `{enabled:false,defaultProvider}` 打未绑房群 → 先落禁用再 400 = 失败请求改变授权面）→ 修 `db73995`（全部校验前置，失败请求零写入，回归测试红先绿后）→ **r2 GO 零 findings**（seed 时序一致/members 未波及/store throw 属写入期异常非可预判 400）。**坑双记**：guardian 突变甄别与门禁并发 = 互相误红（审计期间禁跑门禁，串行重跑即绿）；E2E 全量与 codex 并发一次负载 flake（单跑+无并发全量复核 6/6 绿）。**剩：小孙真机全词表（AC-N6 尾巴）→ Phase 3** |

| 2026-07-05 | **Phase 2.6 真机全词表 ✅ 关账 + 两笔真机反馈修**：小孙手机群内 9 命令全 `done` 零 error（/help /status /rooms /switch R-001 /model 范德彪 /agent 范德彪 /newroom 测试新——七词全覆盖）；写路径落库实证 = binding(oc_8c37) → R-003「测试新」+ default_provider=codex；命令混聊天一行（`/agent 范德彪 我想要…`）引导重试 fail-safe 真机走过。**反馈修两笔**：① 「命令格式没看懂/手册不细」→ `e9595d4` /help 保姆级重写（顶部空格总规则+分组+每条可照抄例子+花名动态拼）+ USAGE 带例子 + **R-号省零等价**（/rooms 显示 R-003 而精确比对拒 R-3 = 真格式坑，sameRoomRef 数字段等价）② 「为什么还有绑定概念，不是能切房了吗」→ 概念答疑（绑定=窗口当前对着哪个房，/switch 切的就是它）+ `cec18d3` 用户可见面「绑定」→「当前房间/选房间」语系全换（回执 6+gateway 1+route 4+管理页 9，内部机制名不动）。**教训：产品质疑概念冗余时先分「概念错」还是「词错」——这两回都是词错** |

| 2026-07-05 | **Phase 3 代码侧全落（六 commit 每笔过全量门禁）**：plan `23c118b`（premise 全实测：出站走 SafeHttpClient 直连 REST/parser 非 text 全 skip/PWA 零现状/ContentBlock 无 file）→ T1 `470b2d4` AC14 PWA（manifest.ts + icon/apple-icon ImageResponse 三金点品字（satori 仅 Inter latin，中文=豆腐块故纯几何）+ viewport/appleWebApp（Next 16 渲染新标准名 `mobile-web-app-capable`）+ 私有组网 docs（Tailscale + NEXT_PUBLIC 双 env 必配）+ E2E pwa.spec）→ T2 `03abb11` AC15 占位卡（inbound_ledger 占位两列三 DDL 面；sender callApi 化 + sendPlaceholder/patchCard + 首片 PATCH 变身；gateway fire-and-forget 发卡 + claimAndSend CAS 认领/回滚 + 空手收尾 + sweep 15min）→ T3 `944c374` AC16a（ContentBlock+=file+渲染链；uploads/composer YAGNI 砍）→ T4 `91126d0` AC16b（SafeHttp rawBody/buffer/multipart 防碰撞，SSRF 面零动）→ T5 `21c90c8` AC16c 入站媒体（parser image/file 分支（群裸媒体恒未@ fail-closed）→ downloadFeishuMedia UUID 落盘白名单扩展名 → 账本 attachments 列 → 注入 contentBlocks）→ T6 `93702a9` AC16d 出站媒体（FinalMessage.mediaBlocks → sendMediaSafe（fs 集中装配层 basename）→ multipart 上传拿 key → image/file 消息跟署名卡后；失败只审计不回滚文本） |

| 2026-07-05 | **Phase 3 三重审收敛（r1→r3 两轮修口七条全闭环）**：① quality-gate 亲验（build 0 / lint 0 error / E2E 7/7 含 pwa）② 零上下文 guardian **PASS**（182 tests 亲跑 + 突变甄别 + 契约逐条实锚；另给 F1 P2=门前下载拒绝路径落孤儿文件、F3 P3=ALTER 缺 CHECK、M1 等价突变=CAS WHERE 冗余判留双保险）③ 真德彪 r1 **NEEDS-WORK 2P1+1P2 全真**：P1-1=空终稿带 assistantMessageId 不触发收尾（占位卡挂 15min）/P1-2=长文本首片 PATCH 成功余片失败→回滚错态 sweeper 毁已变身卡/P2=出站媒体 URL 无白名单 confused-deputy → **审后五修 `ae5501a`**（deliverFinal 空内容分支同套收尾/sender 透出 placeholderConsumed 部分成功不回滚/UPLOAD_URL_RE 单层白名单/evaluateGroupGate 抽纯判定+precheckInbound 门前预检/迁移 CHECK 闭集）五修各配红先行回归 → ④ **r2 4 GO + 1 NO-GO**（真洞：precheck 只问门不问可绑性，「群已授权未选房间」rejected_unbound 媒体仍先落盘——今天潜伏（群媒体恒未@到不了该步）但预检契约=忠实预测真门不许分叉）→ 修 `89b7e7a`（可绑性只读镜像=既有行 SELECT 或种子，+3 回归含零副作用断言）→ **r3 GO**（判定逐分支一致/零副作用/无漏网拒绝路径/回滚测试会红全实证）。connectors+db 349/349 绿 + api tsc 0。**剩：T7 真机校准（小孙：图文双向+占位卡肉眼+PWA 主屏）→ 全 feature 合并拍板** |
| 2026-07-10 | **T7 真机校准六轮全收敛（07-06→07-10，修1~修7）+ AC14/15/16 全勾**：修1 `0a6423f` 出站媒体白名单收绝对 URL（take_screenshot 块经 resolveUploadUrl 前缀=Tailscale 环境全拒的真 gap；pathname 过同一 /uploads 单层闸+归一化回相对，host 不授新能力）→ 修2 `a0e4f23` 注入正文附落盘绝对路径（agent 之前对附件是瞎的——contentBlocks 只管 web 渲染，CLI prompt 走 content 文本）→ 修3 `96bae2e` 手机适配（三列布局挤没 390px 主区→<md 抽屉侧栏+状态栏隐藏+h-dvh+16px 输入防 iOS 缩放；playwright 390/1440 双视口验证桌面零回归）→ 修4 `95e5832` 预览私有组网 publicHost（「Load failed」根因=buildPreviewEnv 硬编码 localhost 四址+严格单 CORS 且 spawn `{...process.env, ...env}` 生成值压外层——Tailscale 启动从未生效过；WORKTREE_PREVIEW_PUBLIC_HOST→四址烤组网 IP+CORS 双白名单，未设 deepEqual 钉死原行为）+手机状态面板右抽屉 → 修5 `4d6728b` 群裸媒体 owner 通道（小孙点名「群图只识别我发的」：mention 档媒体+owner 旁路，owner 裸文本仍需 @，非 owner 静默忽略，门序不塌；需「接收群聊中所有消息」权限才可达，未开=fail-closed 原样；+5 测试 17/17）→ 修6 `191beb8` hydration 前不渲染抽屉层（dev 分片慢下载窗口持久化桌面态两抽屉糊屏，真机截图实证）→ 修7 `555aed2` send_file MCP 工具（**出站文件假接通**：管道 file 分支全在但 agent 无产源——take_screenshot 只产 image 块；四层克隆：工具 16 号→/api/callbacks/send-file（≤1MB 413）→prepareAgentFile 纯核（跨平台斩段防穿越/文本白名单外回落 .txt/存储名防覆盖）→file 块挂 lastAssistant+广播）。**真机定论**：私聊图/文件双向✅（agent 真描述内容）；群图 owner 裸发✅×2；出站图✅（飞书 `im:resource:upload` 权限，99991672 日志实锤定位）；出站文件✅（send_file 真机收到）；占位卡变身/sweeper expired 双实证；PWA 主屏+手机可用✅；长回复分段=设计行为（飞书单条上限：首片变身占位卡+余片保序跟发，小孙确认预期）。**平台限制两条（不阻塞）**：①at_msg 订阅不推任何裸消息（三合一 post 实证 0 事件）②全量权限下群裸**文件**入站事件仍不推（0 file 事件而图/文字都在；待细分权限，群文件走私聊/@）。**坑**：Write 落「反斜杠u转义序列」会变真控制字节（文件成 binary）→零转义 charCode 过滤；worktree-preview childEnv 生成值压 process.env；task kill 留孤儿双进程（next dev 活编译当前工作区代码不 stale，API 必须真重启）。**剩：T7 修口七笔真德彪终审 → 小孙拍板合并** |
| 2026-07-10 | **德彪 r7 终审 NEEDS-WORK（1P1+3P2 全真洞）→ 修8~修11 单 commit `25af88d` 红先闭环**：**P1**=send_file 白名单含 .html + 跨源 `<a download>` 失效（双端口天然跨源）+ /uploads 静态服务裸奔——导航打开 agent 产 HTML 在 API origin 执行脚本=存储型 XSS（德彪真 HTTP 实测三头全空）→ **修8** 双层：allowlist 除名 .html/.htm 回落 .txt + `lib/upload-static.ts` 三头硬化（attachment/nosniff/CSP sandbox，同罩 web 上传 svg 与飞书下载历史文件；`<img>` 子资源不受 attachment 影响内联图零回归，真起 fastifyStatic 断言）。**P2①**=预检拒绝后无条件清 `parsed.media`，真门看「无@无媒体」退化 `ignored_no_mention`——owner 裸图打非白名单群丢 rejected_group 审计、打未绑定群丢「还没选房间」回执（德彪 fake connector 复跑实证；既有 gateway 测试直传 attachments 绕过了 mutation）→ **修9** `precheckOk` 先算、仅预检通过才清描述符，预检拒的留原形态给真门复判；connector 层 +3 回归（fake gateway 直证 media 存活+零下载 / 真门 rejected_group 落审计 / unbound 回执到达）。**P2②**=`/uploads/.` `/uploads/..` 过单层正则，basename+resolve 逃出 mediaDir（reader:49 与 connector:291 同病）→ **修10** 新 `lib/upload-path.ts` 共享闸（显式拒 dot-segment + 拒 `:` 防 win32 驱动器相对逃根 + path.relative 复核），reader extractUploadPath / readUploadFile / resolveAttachmentPath 三消费点统一。**P2③**=Fastify 默认 bodyLimit 1MiB 解析层抢跑 413（600KB 换行 JSON 转义后 1.2MB 进不了 handler），路由 1MB 契约永不可达→ **修11** 路由独立 bodyLimit=`AGENT_FILE_MAX_BYTES*6+16384`（JSON 最坏 6× 转义信封数学）+ filename ≤255 闸；+6 路由级测试（401/400/精确 1MiB 过/1MiB+1 路由文案 413/转义密集过/501）。验证：红先 9 处全转绿 → api 489/489 + tsc 0。**教训**：①新写入面（send_file）上线前该自查「字节被谁怎么打开」——扩展名白名单想着「文本无害」，忘了浏览器按 Content-Type 当文档执行；②路由自设上限必须连信封一起算（解析层先于 handler）。**剩：德彪 r8 复审四洞闭合 → 小孙拍板合并** |

## Links

- 调研详情：本文档「调研结论」节（clowder-ai file:line 锚点已内联）
- 设计审 r1 verdict：`.runtime/reviews/` scratch（不入库）
- Plan: [F040 Phase 1 实施计划](../plans/F040-phase1-plan.md)（16 Task · TDD · 终态 schema 先行）
- Plan: [F040 Phase 2 实施计划](../plans/F040-phase2-plan.md)（16 Task · 群桥接 · AC13.5 mini-design 前置门）
- Plan: [F040 Phase 2.5 实施计划](../plans/F040-phase2.5-channel-admin-plan.md)（渠道管理 DB 化 + 管理页 · 单例 store 热生效）
- Plan: [F040 Phase 2.6 实施计划](../plans/F040-phase2.6-plan.md)（飞书指挥面 · 命令面旁路 + enabled 四脸迁移 + /model 复用 session-runtime-config）
- Plan: [F040 Phase 3 实施计划](../plans/F040-phase3-plan.md)（体验强化 · PWA 零插件 + 占位卡状态机 + 图片文件双向，premise 全实测）
- Related: F029 / F037 / F026 / F031

## Evolution

- **Evolved from**: 无（新领域：外部渠道）
- **Blocks**: 无
- **Related**: F029（外发边界）、F037（SafeHttpClient 共享 + 账本哲学对齐）、F026（提及路由复用）
