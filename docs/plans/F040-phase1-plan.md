# F040 Phase 1（飞书私聊 MVP）Implementation Plan

**Feature:** F040 — `docs/features/F040-im-channel-gateway.md`（v5 = `c430c69`，小孙拍板 D1-D16 + 德彪设计审 r1→r4 GO）
**Goal:** 小孙在飞书 App 私聊机器人 = 在绑定 room 里说话（与 web 输入等价），每个 agent final 逐条推回飞书；免公网（WS 长连接）、fail-closed、幂等、不丢消息。
**Acceptance Criteria（Phase 1 全量，抄自 feature doc）:**
- AC1: 配齐 env 后 WS 长连接建立，断线自动重连；缺任一必需 env → connector 不启动、主服务零影响、启动日志明示
- AC2: 小孙飞书私聊发文本 → 绑定 room 出现村长消息 → 正常触发派发（与 web 输入等价）
- AC3: 逐 final 回推：direct final / 消息内 @范德彪 的 A2A finals / worklist continuation final / 错误终态回执，各自独立到达飞书；无空消息、无半截消息（终稿=overwriteMessage 后的内容；依赖 D16 `invocation.finished` payload 扩展）
- AC4: 非白名单 open_id 来信被拒 + 审计留痕不入 room；非 p2p（群/话题）事件一律拒（含白名单用户在群里发言）
- AC5: 幂等：同一 external_message_id 平台重投 + connector 重启重放，均不重复入库、不重复唤醒 agent（入站账本 UNIQUE 生效的正/负例）
- AC6: 出站安全测试面 = SafeHttpClient 合同全量（host pin 负例 / redirect 逐跳 / DNS rebinding / IANA 精确段 / userinfo / 非常规端口 / 流式 body 上限 / timeout+abort）+ 证明 REST 全走 SafeHttpClient、SDK 仅承担 WS；tenant_access_token 过期前自动刷新
- AC7: 排队：turn 进行中连发多条 → 全部持久化、严格按序执行、零丢失；进程中途重启 → 队列恢复继续 drain
- AC8: 出站可靠：final 落库后 connector 崩溃 / 飞书 API 失败 → 重启 reconcile 补投不漏；attempted 结果未知补投一次并标记；账本状态机可审计
- AC9: 小孙手机真机全链路验收：派活 → 收到各 agent 回复

**Architecture:** 渠道无关的 `ChannelGateway`（入站门→账本→FIFO→注入 `handleClientEvent`；出站订阅 eventBus `invocation.finished`→溯源→账本→发送）+ 飞书适配件（WS transport 包装 / event parser / token manager / sender）。出站 REST 全走新建 `SafeHttpClient`（F037 合同，F040 先落地即为共享真相源）。三张 SQLite 表：绑定 / 入站账本（兼 FIFO 队列）/ 出站账本。
**Tech Stack:** `@larksuiteoapi/node-sdk`（仅 WS 长连接）、drizzle + better-sqlite3（现有栈）、node:test + tsx（现有测试栈）、原生 fetch 禁用 —— REST 一律 SafeHttpClient（undici request + 自研校验）。

**不做（Phase 1 明确出界）:** 群聊 / 归因前缀 / 媒体 / 流式占位 / PWA / 企微 / webhook 模式 / 旁听模式。
**真机边界（fixture 诚实合同）:** WS transport 与飞书 REST 在单测里用 fake（接口缝合），**capstone = AC9 小孙真机**；fake 不得比真飞书宽容（错误码/重连/风控延迟按官方 docs 建模，实现前查 open.feishu.cn 文档核对字段名）。

---

## 终态 Schema（先钉死，所有任务围绕它构建）

### DB（drizzle，`packages/api/src/db/schema.ts` 增量 + migration）

```typescript
// channel_bindings — D3/D8：env bootstrap 播种，SQLite 为运行时真相源
export const channelBindings = sqliteTable("channel_bindings", {
  id: text("id").primaryKey(),                      // nanoid
  connectorId: text("connector_id").notNull(),      // "feishu"
  externalChatId: text("external_chat_id").notNull(),
  chatKind: text("chat_kind").notNull(),            // "p2p"（Phase 2 加 "group"）
  sessionGroupId: text("session_group_id").notNull(),
  defaultProvider: text("default_provider").notNull(), // "claude"
  createdAt: text("created_at").notNull(),
}, (t) => [uniqueIndex("ux_binding_ext").on(t.connectorId, t.externalChatId)])

// channel_inbound_ledger — D10 幂等 + D12 FIFO 双职责：state=queued 的行按 seq 就是队列
export const channelInboundLedger = sqliteTable("channel_inbound_ledger", {
  id: text("id").primaryKey(),
  connectorId: text("connector_id").notNull(),
  externalChatId: text("external_chat_id").notNull(),
  externalMessageId: text("external_message_id").notNull(),
  bindingId: text("binding_id").notNull(),
  senderOpenId: text("sender_open_id").notNull(),
  content: text("content").notNull(),
  seq: integer("seq").notNull(),                    // AUTOINCREMENT 语义：按到达序 drain
  state: text("state").notNull(),                   // queued | injected | rejected
  rootMessageId: text("root_message_id"),           // 注入后回填 —— D15 溯源锚
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("ux_inbound_ext").on(t.connectorId, t.externalChatId, t.externalMessageId)])

// channel_outbound_ledger — D11 at-least-once 状态机
export const channelOutboundLedger = sqliteTable("channel_outbound_ledger", {
  id: text("id").primaryKey(),
  bindingId: text("binding_id").notNull(),
  internalMessageId: text("internal_message_id").notNull(),
  state: text("state").notNull(),                   // pending | attempted | sent | failed_terminal
  attempts: integer("attempts").notNull().default(0),
  possibleDuplicate: integer("possible_duplicate").notNull().default(0), // reconcile 补投标记
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [uniqueIndex("ux_outbound_msg").on(t.bindingId, t.internalMessageId)])
```

### 事件扩展（D16，加法）

```typescript
// packages/api/src/events/event-types.ts — invocation.finished payload 增两字段
{
  type: "invocation.finished"
  payload: {
    invocationId: string
    threadId: string
    agentId: string
    exitCode: number
    assistantMessageId: string | null   // 新增：终稿 message id（错误终态也有占位 id）
    rootMessageId: string | null        // 新增：所属 root（user 消息 id）
  }
}
```

### 模块接口（`packages/api/src/connectors/`）

```typescript
// channel-types.ts
export type InboundChannelMessage = {
  connectorId: string; externalChatId: string; externalMessageId: string
  senderOpenId: string; chatKind: "p2p" | "group"; text: string
}
export type ChannelSender = {                        // feishu-sender 实现；测试用 fake
  sendText(externalChatId: string, text: string): Promise<{ ok: true } | { ok: false; error: string; terminal: boolean }>
}
export type MessageInjector = {                      // MessageService 的最小缝合面
  handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void): void
  getBusyStatus(threadId: string, sessionGroupId: string): string | null
}
// channel-gateway.ts —— 渠道无关核心（Phase 2 企微/群复用）
export class ChannelGateway {
  handleInbound(msg: InboundChannelMessage): Promise<"queued" | "rejected_allowlist" | "rejected_chatkind" | "duplicate">
  drainIfIdle(bindingId: string): Promise<void>      // invocation.finished / 启动时触发
  onInvocationFinished(payload: InvocationFinishedPayload): Promise<void>   // 出站入口
  reconcileOnBoot(): Promise<void>                   // AC7 队列恢复 + AC8 出站补投
}
```

### 出站溯源规则（D15，Phase 1 即生效）

final 可投递 ⇔ `rootMessageId` 能在 `channel_inbound_ledger` 找到 `state=injected` 的行（root_message_id 匹配）→ 投到该行 binding。查不到（web 发起 / 后台产物）→ 不投任何 IM，仅 debug 日志。

### env（channel-config.ts；小孙手填 `.env`，铁律 3）

`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ALLOWED_OPEN_IDS`（逗号分隔，≥1）/ `FEISHU_BIND_SESSION_GROUP`（sessionGroupId）/ `FEISHU_DEFAULT_PROVIDER`（可选，默认 `claude`）。任一必填缺失或校验失败 → `{ enabled: false, reason }`，connector 不启动（AC1）。

---

## Tasks（TDD 纪律：每 Task = 失败测试 → 确认 FAIL → 最小实现 → 确认 PASS → commit）

> 测试命令统一：`pnpm --filter @multi-agent/api test`（或全量 `tsx --test "packages/api/src/connectors/**/*.test.ts"` 加速单模块迭代）。commit 一律 pathspec 精确路径 + `[黄仁勋]` 签名。所有测试用临时 SQLite（`:memory:` 或 tmpdir 文件），铁律 1。

### Task 1: SafeHttpClient（AC6 核心，F037 合同先落地）

**Files:** Create `packages/api/src/net/safe-http-client.ts` + `safe-http-client.test.ts`

合同（F037 设计合同 v2 P1-1 全量）：仅 https；host ∈ 显式白名单（完整枚举，Phase 1 = `open.feishu.cn`）；禁 userinfo；仅 443；每次请求前 `lookup` 全部 A/AAAA 按 IANA special-use 精确段拒（loopback/private/link-local/CGN/multicast/reserved/IPv4-mapped IPv6/ULA），resolver 可注入（DNS rebinding 测试面）；`redirect: "error"`（跳数上限 0，飞书 API 无重定向）；响应流式读取 + 解压后大小上限（默认 2 MiB）+ 超时 abort（默认 15s）；连接固定到已校验 IP（undici `connect.lookup` 钉 IP，防 TOCTOU 二次解析漂移）。

测试矩阵（每条合同 ≥1 用例，全部离线 —— resolver/dispatcher 注入 fake）：http 拒 / 非白名单 host 拒 / userinfo 拒 / 非 443 拒 / resolver 返 127.0.0.1、10.x、169.254.x、::ffff:10.0.0.1、fc00:: 各拒 / redirect 响应 → error / body 超限中断 / 超时 abort / 白名单 + 公网 IP 放行（fake dispatcher 返 200）。

### Task 2: drizzle schema + migration（三表）

**Files:** Modify `packages/api/src/db/schema.ts`；Create migration（跟仓内既有 migration 机制走，先 `ls packages/api/drizzle*` / `grep -r "migrations" packages/api/src/db` 确认真实机制再动手——测试 schema 忠实生产，含 UNIQUE 约束）；Test `packages/api/src/db/channel-tables.test.ts`

测试：三表可写读；`ux_inbound_ext` 重复插入抛 UNIQUE 错（AC5 的地基）；`ux_binding_ext`、`ux_outbound_msg` 同理。

### Task 3: channel-config 加载器（AC1 fail-closed 前半）

**Files:** Create `packages/api/src/connectors/channel-config.ts` + `.test.ts`

测试：全配齐 → enabled + 解析出 allowlist 数组；缺 APP_ID / SECRET / ALLOWED_OPEN_IDS / BIND_SESSION_GROUP 各 → `{enabled:false, reason}`（枚举到具体缺哪个）；ALLOWED_OPEN_IDS 空串/纯逗号 → disabled（白名单不得为空，D5）；DEFAULT_PROVIDER 缺省 = "claude"。**不读全局 process.env，入参注入**（可测性 + 不碰 .env）。

### Task 4: feishu-event-parser（p2p 判定 + 文本提取）

**Files:** Create `packages/api/src/connectors/feishu/feishu-event-parser.ts` + `.test.ts`

输入 = `im.message.receive_v1` 事件 JSON（fixture 按官方 schema 手抄：`event.message.chat_type ("p2p"|"group")`、`message_type ("text")`、`content ('{"text":"..."}')`、`event.sender.sender_id.open_id`、`message.message_id`）。输出 `InboundChannelMessage | { skip: reason }`。测试：p2p text 正常解析 / group → chatKind=group（门在 gateway 拒，parser 只标注）/ 非 text 类型 → skip（Phase 1）/ content JSON 破损 → skip 不抛 / 缺 open_id → skip。

### Task 5: ChannelGateway 入站门（AC4）

**Files:** Create `packages/api/src/connectors/channel-gateway.ts` + `channel-gateway.inbound.test.ts`

`handleInbound`：① chatKind ≠ p2p → `rejected_chatkind` + 审计日志（结构化 `[F040:inbound-reject]`）不落账本正文（防垃圾膨胀，只记 meta）；② senderOpenId ∉ allowlist → `rejected_allowlist` + 审计；③ 过门 → Task 6 账本。测试：白名单 p2p 过 / 白名单 group 拒（AC4 负例原文：白名单用户在群里发言）/ 非白名单 p2p 拒 / 拒绝不产生 room 消息（injector spy 零调用）。

### Task 6: 入站账本幂等（AC5）

**Files:** Modify `channel-gateway.ts`；Create `channel-gateway.idempotency.test.ts`

INSERT UNIQUE 先登记（state=queued, seq 递增）后处理；UNIQUE 冲突 → `duplicate`，injector 零调用。测试：同 external_message_id 二投 → 第一次 queued 第二次 duplicate / 重启重放（新 gateway 实例同一 DB）同样 duplicate / 不同 chat 同 message_id 不冲突（三元组语义）。

### Task 7: FIFO drain（AC7 核心）

**Files:** Modify `channel-gateway.ts`；Create `channel-gateway.fifo.test.ts`

`drainIfIdle(bindingId)`：取该 binding 最老 `state=queued` 行 → `getBusyStatus(defaultThread, sessionGroup)` 非空则 return（等下一次 finished 再试）→ 空则注入（Task 8）→ state=injected + 回填 rootMessageId → 继续取下一条直到 busy 或队空。**串行锁：per-binding in-flight flag，防重入**。测试：三连发按 seq 序注入 / busy 时不注入（fake injector busy）→ 解除后 drain 继续 / drain 重入保护（并发调用只跑一份）/ 新实例同 DB 启动 `reconcileOnBoot` 把 queued 续 drain（AC7 重启恢复）。

### Task 8: 注入适配（AC2）

**Files:** Modify `channel-gateway.ts`；Create `channel-gateway.inject.test.ts`

组 `{type:"send_message", payload:{threadId: binding 解析的 defaultProvider thread, provider, content: 原文, alias:"村长"}}` → `injector.handleClientEvent(event, captureEmit)`；`captureEmit` 捕获 `message.created`（user）拿 `userMessage.id` 作 rootMessageId 回填；捕获 `status` 事件（archived 等 sendable 拒绝）→ 该行 state=rejected + error 记 status 文本 + 通过 sender 回执给飞书用户（fail-closed 不静默，设计合同 #7）。threadId 解析：boot 时从 sessionGroup 的 threads 里找 provider 匹配（缝合面 `resolveThread(sessionGroupId, provider)` 注入，生产接 session repository，测试 fake）。测试：注入产生正确 payload（alias 村长 / content 原样）/ rootMessageId 回填 = emit 的 user message id / archived status → rejected + 回执调用。

### Task 9: `invocation.finished` payload 扩展（D16，AC3 地基）

**Files:** Modify `packages/api/src/events/event-types.ts` + `packages/api/src/services/message-service.ts`（emit 站点，:2533 主路径 + 错误终态路径逐一核对——8 处 overwriteMessage 终态附近谁 emit finished 谁补字段）；Test `packages/api/src/services/message-service.invocation-finished-payload.test.ts`

加法扩展：`assistantMessageId`（该 invocation 的 assistant 占位/终稿 id）+ `rootMessageId`（dispatch.registerUserRoot 的 root）。**先 grep `emit.*invocation.finished` 定位全部发射点**，逐点补；类型收紧后 typecheck 会揪出漏网。测试：直接派发路径 finished 事件带两 id；错误终态（provider 抛错）也带 assistantMessageId。**回归**：现有 server.ts:582 订阅者不受影响（加法字段）。

### Task 10: 出站 hook + 溯源 + 账本（AC3/AC8 前半 + D15）

**Files:** Modify `channel-gateway.ts`；Create `channel-gateway.outbound.test.ts`

`onInvocationFinished(payload)`：rootMessageId 查 inbound ledger `state=injected` → miss 则 debug 日志 return（D15 负例：web 发起的 final 不投）→ hit 则读 assistant 终稿（缝合面 `readFinalMessage(assistantMessageId)` 返回 content，生产接 repository）→ 空 content 跳过（防空消息，AC3）→ 出站账本 UNIQUE(binding, internalMessageId) INSERT pending（重复 finished 幂等）→ attempted → `sender.sendText` → sent | 非 terminal 失败留 attempted（reconcile 补）| terminal 失败 failed_terminal。测试：injected root 的 final 投递 + 账本走完状态机 / 无 root 的 final 不投 / 同 final 二次事件不重复投（UNIQUE）/ sender 失败留 attempted / A2A 场景：同 root 两个 invocation（黄仁勋 + 范德彪）各投一条（AC3 multi-final）。

### Task 11: 启动 reconcile（AC8 后半）

**Files:** Modify `channel-gateway.ts`；Create `channel-gateway.reconcile.test.ts`

`reconcileOnBoot`：出站 `pending` → 直接走投递；`attempted` → 补投一次 + `possibleDuplicate=1`（at-least-once 哲学，宁重勿漏）+ attempts≥3 → failed_terminal + 结构化告警日志；入站 queued → 续 drain（Task 7 已测，这里测联动）。测试：pending 恢复投 / attempted 补投带标记 / attempts 超限转 terminal / 双账本同时恢复顺序（先入站 drain 后出站？——**定死：先出站补投再入站 drain**，避免旧 final 排在新回复后）。

### Task 12: FeishuTokenManager（AC6 后半）

**Files:** Create `packages/api/src/connectors/feishu/feishu-token-manager.ts` + `.test.ts`

`tenant_access_token/internal` 经 SafeHttpClient POST；缓存 + 提前 300s 刷新（注入 clock）；并发请求单飞（in-flight promise 复用）；`code≠0` 抛结构化错；发送遇 token 失效错误码（99991663 等，实现前查官方 docs 核对）→ invalidate + 重试一次。测试：首取 / 缓存命中不重复请求 / 过期前 300s 刷新 / 并发单飞 / 失效重试一次成功 / 二次仍失败上抛。

### Task 13: FeishuSender（分片 + 发送）

**Files:** Create `packages/api/src/connectors/feishu/feishu-sender.ts` + `.test.ts`

`im/v1/messages?receive_id_type=chat_id` 经 SafeHttpClient；文本按 **2000 字符**分片（P3-1 拍死：飞书 text 上限 150KiB 远超，2000 为可读性值；分片带 `(i/n)` 尾标；逐片顺序发送，单片失败即停返回失败=重试粒度单条 final —— 账本层 attempted 兜）；HTTP 4xx 业务错映射 terminal（白名单外错误码非 terminal）。测试：短文单片 / 5000 字三片带尾标顺序 / 中片失败停发返回非 terminal / token 注入正确 header。

### Task 14: WS transport 包装 + connector 生命周期 + boot 接线（AC1）

**Files:** Create `packages/api/src/connectors/feishu/feishu-connector.ts` + `.test.ts`；Modify `packages/api/src/server.ts`（config gate 后构建 gateway + eventBus.on("invocation.finished", gateway.onInvocationFinished) + 启动 connector + reconcileOnBoot；`registerMessageRoutes` 空壳不动）；Modify `packages/api/package.json`（加 `@larksuiteoapi/node-sdk`）

`FeishuWsTransport` 接口包 `lark.WSClient`（`start(onEvent)` / `stop()`；SDK 自带重连，包装层记录断连日志 `[F040:ws-reconnect]`）；connector = transport + parser + gateway 粘合。server.ts：config disabled → 只打一行启动日志，零对象构建（AC1 主服务零影响）。测试：fake transport 事件流 → gateway 全链路（联 Task 15 harness）/ disabled config 不启动（spy 零调用）/ transport 抛错不击穿 boot（try-catch + 告警日志）。**SDK 真连接不进单测**（fixture 诚实：AC9 真机 capstone）。

### Task 15: 端到端集成测试（AC2/3/5/7 合训）

**Files:** Create `packages/api/src/connectors/__tests__/feishu-e2e.test.ts`

真 SQLite（tmp 文件）+ 真 gateway + fake transport/sender/injector-with-scripted-turns：脚本化「入站事件 → 村长消息 → finished(带 id) → 出站 sent」全链；连发 3 条含重投 1 条 → 账本 3 行唯一 + 按序 + sender 收到 3 条；模拟 crash（新 gateway 实例同 DB）→ reconcile 续投。此 harness 即 quality-gate 的证据源。

### Task 16: 收尾门禁 + 文档同步

quality-gate：`pnpm typecheck` + 全量 test + grep 违禁（`fetch(` 直连 open.feishu.cn 之外 / process.env 越权读）；feature doc AC1-8 勾（AC9 留待小孙真机）+ Timeline 落档；plan 文档勾任务；memory 更新；worktree 内 Phase 级 commit 留存（Feature Completion Before Merge：**AC9 真机过前不合 dev**）。→ acceptance-guardian（AC1-8 可零上下文验证）→ requesting-review 派德彪代码审 r1。

---

## 风险与依赖备注

- **飞书官方字段名/错误码**：Task 4/12/13 动手前先查 open.feishu.cn 官方 docs 核对（Measure Before Assert）；SDK 事件 envelope 与裸 webhook JSON 有差异（SDK 已解 challenge/解密），以 SDK `EventDispatcher` 出参为准。
- **`getBusyStatus` 是 private**：Task 7 缝合面若无法直取，走「注入探测函数」由 server.ts 闭包提供（`(threadId, groupId) => messageService 内部判定`）——boot 接线时用 MessageService 公开面能拿到的等价信号，实现时定，禁 hack 私有字段。
- **F037 撞车**：SafeHttpClient 双方都要 —— F040 先落地 `packages/api/src/net/`，F037 复用（已在两 feature doc 声明）。
- **新依赖主仓 pnpm install**：合并后提醒小孙（LL-017 教训）。
