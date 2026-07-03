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
- agent 的最终回复自动推回飞书私聊（长文本分片）
- 未配置凭证时 connector 静默不启动，绝不影响主服务

**「iOS 应用」的解法 = 三阶段路线**（原生 App 需 Apple 开发者账号 $99/年 + Mac 构建链 + 签名分发，收益对单用户场景增量很小，clowder-ai 也没做原生）：

| 阶段 | 载体 | 开发量 | 得到什么 |
|------|------|--------|---------|
| 1（本 feature Phase 1） | 飞书 App 即客户端 | 仅后端 connector | 手机对话、推送、语音输入（飞书自带）|
| 2（本 feature Phase 2+） | PWA：现有 web UI 加 manifest/图标/apple meta | 前端小改 | Safari「添加到主屏幕」，全功能 UI（LAN/Tailscale 访问）|
| 3（按需另立项） | Capacitor 原生壳 | 中 | App Store 分发（仅当 1+2 不满足再议）|

## 调研结论（2026-07-03，clowder-ai 对照 + 本仓链路实测）

### clowder-ai connector 架构（参考仓：`C:\Users\-\Desktop\cafe-multi-agent\clowder-ai`）

7 IM 渠道统一网关（`packages/api/src/infrastructure/connectors/`，注册表 `packages/shared/src/types/connector.ts:202-251`）：

| 渠道 | 入站模式 | 需公网？ | 对我们的含义 |
|------|---------|---------|-------------|
| 飞书 | webhook **或** WS 长连接（`FEISHU_CONNECTION_MODE=websocket`，`lark.WSClient`） | **长连接免公网** | ✅ 首选：本机 Windows 直接跑 |
| 企微智能机器人 | WS 长连接（`@wecom/aibot-node-sdk`） | 免 | 微信生态备选（要企业主体，免费可注册）|
| 微信个人号 | iLink Bot 长轮询 + 扫码登录 | 免 | 非公开常规渠道，账号风险 + 会话过期运维重，不推荐 MVP |
| 企微自建应用 | HTTP AES 回调 | **要** | 后置 |
| 钉钉 / Telegram / 小艺 | 长连接/长轮询 | 免 | 不在需求内 |

可抄的关键机制：统一 `ConnectorRouter`（外部会话 ↔ 内部 thread 绑定 + 群白名单）、`InboundMessageDedup`（connectorId:chatId:messageId LRU 防重投）、`FeishuTokenManager`（tenant_access_token 提前 5 分钟刷新）、出站 `OutboundDeliveryHook`（终稿投递）与流式占位卡分离。**要改进的弱点**：clowder 飞书 verification token 未配置时跳过校验（`FeishuAdapter.ts:122`）—— 我们必须 fail-closed。

移动端结论：clowder-ai **没有原生 iOS/RN/Capacitor**；= 可安装 PWA（manifest + apple-touch-icon + `@ducanh2912/next-pwa`，API NetworkOnly 不做离线）+ 响应式 web + **官方主推飞书/Telegram 当手机入口**。

### 本仓挂载点（实测锚点）

- **入站权威入口**：WS client 事件 `{type:"send_message", payload:{threadId, provider, content, alias, contentBlocks?, clientMessageId?}}` → `MessageService.handleClientEvent`（`packages/api/src/services/message-service.ts:1112`，ws.ts:161 接线）。`clientMessageId` 幂等键现成，正好承接飞书 message_id 去重。**connector 以进程内 headless client 身份复用同一入口，不开第二条写路径。**
- **出站回流**：`handleClientEvent(event, emit)` 的 per-turn emit 回调把该轮全部事件（含 final）直接给调用方 —— adapter 注入消息时天然拿到回流，无需订阅全局 broadcast（`RealtimeBroadcaster.broadcast` 咽喉在 ws.ts:65，F031 seq/epoch，留作 Phase 2 全房间旁听可选项）。
- **安全边界**：F029 外发边界代码**未合 dev**（在 F029 worktree）；F037 设计合同 v2 已确立 SafeHttpClient 出站合同。F040 出站 REST（发消息/传媒体/刷 token）域名 pin `open.feishu.cn`，按同一合同实现，**F037/F040 谁先落地谁把 SafeHttpClient 抽成共享模块，另一个复用**。
- **绑定存储**：本仓无 Redis（clowder 用 Redis Hash）→ SQLite 表 + drizzle migration。
- **配置**：`packages/api/src/config.ts` 读 env；凭证由小孙手填 `.env`（铁律 3）。

## 架构设计（草案，待 Design Gate）

```
飞书开放平台 ←—— WS 长连接（lark.WSClient，出站连接，免公网，自动重连）
     │  im.message.receive_v1
     ▼
FeishuConnector（packages/api 进程内）
     │ 1. 来源校验 fail-closed：仅 FEISHU_ALLOWED_OPEN_IDS 白名单内的 open_id；
     │    其余拒绝 + 审计日志（不入 room）
     │ 2. 幂等：feishu message_id → clientMessageId（复用现有去重）
     │ 3. ChannelBinding 查绑定（SQLite）：external_chat_id → session_group + 默认 thread
     ▼
MessageService.handleClientEvent({type:"send_message", alias:"村长", ...})   ← 与 web 同一入口
     │ 正常派发/唤醒/@路由（F026 机制原样生效）
     ▼ per-turn emit 回流（final 事件）
OutboundGate（host pin open.feishu.cn；对齐 F037 SafeHttpClient 合同）
     │ tenant_access_token 提前刷新；长文本分片；失败有界重试 + 审计
     ▼
飞书 im.message.create → 小孙手机
```

防回环：入站只收白名单 open_id 的人发的消息；飞书 bot 不会收到自己发出的 DM 事件；群模式（后置）仅处理 @bot。
并发语义：同绑定串行注入（一轮未结束时新消息排队），细节在 writing-plans 拍。

## Design Decisions

| # | 决策 | 选项 | 结论 | 原因 |
|---|------|------|------|------|
| D1 | 首发渠道 | 飞书 / 微信个人号 / 企微 | **推荐飞书，待小孙拍板** | 官方 API 完整、长连接免公网、多端 App 体验好；个人微信无官方 bot 接口（iLink 属非常规渠道，封号险）；企微要企业主体 |
| D2 | 飞书接入模式 | webhook / WS 长连接 | **WS 长连接（拍死）** | 免公网 IP/域名/隧道，本机 Windows 直接跑；官方 SDK `@larksuiteoapi/node-sdk` 原生支持 |
| D3 | 会话绑定粒度 | 固定绑一个 room / 支持 /bind 切换 | **MVP 固定绑定**（env 指定 session_group + 默认 provider 黄仁勋），待小孙拍板 | 最小闭环；@范德彪 等提及在消息内容里照常路由，不需要切房间也能派活；/bind 命令 Phase 2 再议 |
| D4 | 出站范围 | 仅本轮派发链 final / 全房间消息 | **MVP 仅 per-turn final** | 防噪（房间 a2a 闲聊/progress 不推手机）；全房间旁听走 broadcaster 留 Phase 2 开关 |
| D5 | 入站安全 | 全放行 / open_id 白名单 | **白名单 fail-closed（拍死）** | 修正 clowder 弱点；未配白名单 = connector 不启动；拒绝事件记审计 |
| D6 | 手机端路线 | 原生 App / PWA / 飞书即客户端 | **三阶段（见 What），待小孙拍板期待值** | 阶段 1 零前端开发即可手机对话；原生壳投入产出比最差放最后 |
| D7 | 微信生态 | 个人微信 / 企微机器人 / 不做 | **MVP 不做，二渠道推荐企微智能机器人，待小孙拍板** | 企微 WS 长连接同样免公网；个人微信风险不可控 |
| D8 | 绑定存储 | Redis / SQLite | **SQLite + drizzle（拍死）** | 本仓无 Redis，不为此引基础设施 |
| D9 | 出站安全 | 裸 fetch / SafeHttpClient 合同 | **对齐 F037 合同，域名 pin（拍死）** | F029 未合 dev，合同先行；共享模块谁先落地谁抽 |

## Acceptance Criteria

### Phase 1 — 飞书 MVP（私聊闭环）

- [ ] AC1: 配齐 env 后 WS 长连接建立，断线自动重连；缺任一必需 env → connector 不启动、主服务零影响、启动日志明示
- [ ] AC2: 小孙飞书私聊发文本 → 绑定 room 出现村长消息 → 正常触发派发（与 web 输入等价）
- [ ] AC3: 本轮 agent final 回推飞书私聊，长文本正确分片，含 @提及场景（消息内 @范德彪 → A2A 照常 → 各 final 依次回推）
- [ ] AC4: 非白名单 open_id 来信被拒 + 审计日志留痕，不产生 room 消息
- [ ] AC5: 同一 message_id 重投不重复入库（幂等）
- [ ] AC6: 出站仅能命中 open.feishu.cn（域名 pin 生效的负例测试）；tenant_access_token 过期前自动刷新
- [ ] AC7: 全链路在小孙手机上真机验收：派活 → 收到回复

### Phase 2 — 体验强化（拍板后细化）

- [ ] AC8: PWA：manifest + 图标 + apple meta，iPhone Safari 可添加到主屏（LAN/Tailscale 访问说明落 docs）
- [ ] AC9: 流式占位卡（发送中→编辑成终稿）或等效体验
- [ ] AC10: 图片/文件收发（复用 ContentBlock）

### Phase 3 — 二渠道/部署扩展（按需）

- [ ] 企微智能机器人 或 飞书 webhook 模式（公网部署时）

## 需小孙人工操作（铁律 3：我不碰 .env）

1. [飞书开放平台](https://open.feishu.cn/) → 创建**企业自建应用**（个人可免费建飞书团队）
2. 应用能力添加**机器人**；权限开通 `im:message`、`im:message:send_as_bot`（Phase 2 媒体再加 `im:resource`）
3. 事件订阅：订阅 `im.message.receive_v1`，连接方式选**长连接**（不用填回调 URL）
4. 「凭证与基础信息」拿 App ID / App Secret；发布应用版本并通过（自建应用秒过）
5. 获取自己的 open_id（应用发布后机器人私聊页可查，或开发者后台 API 调试台）
6. 填 `.env`（变量名以实施为准，预计）：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ALLOWED_OPEN_IDS`（逗号分隔）/ `FEISHU_BIND_SESSION_GROUP`（绑定房间）
7. 重启运行时（start-project）

## Dependencies

- F037 SafeHttpClient 出站合同（共享模块，谁先落地谁抽）；F029 外发边界（设计对齐，代码未合 dev，不硬阻塞）
- F026 A2A 提及路由、F031 WS 可靠层（已在 dev，直接复用）
- 外部：飞书开放平台应用（小孙人工）、`@larksuiteoapi/node-sdk` 新依赖（合并后主仓需 pnpm install）

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-07-03 | Kickoff：clowder-ai 对照调研 + 本仓挂载点实测 + 架构草案 + D1-D9 决策表（黄仁勋，夜间自主批） |

## Links

- 调研详情：本文档「调研结论」节（clowder-ai file:line 锚点已内联）
- Plan: 待 Design Gate 通过后走 writing-plans
- Related: F029 / F037 / F026 / F031

## Evolution

- **Evolved from**: 无（新领域：外部渠道）
- **Blocks**: 无
- **Related**: F029（外发边界）、F037（SafeHttpClient 共享）、F026（提及路由复用）
