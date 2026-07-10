# F040 Phase 2 — 飞书群桥接·多人参与 Implementation Plan

**Feature:** F040 — `docs/features/F040-im-channel-gateway.md`
**Goal:** 飞书群成员（小孙拉白的群 + 点名放行的成员）@机器人 说话 → 消息带归因进绑定 room → agent 回复回群；私聊/群互不串扰；多人连发保序；同 root 协作链按房间顺序投递。
**Acceptance Criteria（照抄 feature doc）:**
- AC10: 群入站门 fail-closed：`chat_id ∈ 群白名单 AND sender_open_id ∈ 成员白名单` 且 @bot 才进 room；非白名单群 / 非白名单成员 / 未 @ 一律拒 + 审计 + 群内回执；participant 角色触发特权命令面被拒（owner-only）
- AC11: 发送者归因合同：归因文本不进派发解析行（前缀独立成行）+ 昵称剥 `@`/`[Call:` + `@bot` 剥离保行首；回归三样例全过：昵称含 `@` / 正文行首 `@范德彪` / `@bot @范德彪 …` 混排；正式路径=sender 持久化 + 替换 session-service.ts:689 硬编码（schema migration）
- AC12: 群内多人快速连发 → 复用 D12 FIFO（binding 粒度=群）保序全入库零丢失；queued ack 带原 sender 昵称 + 队列位置
- AC13: 出站溯源：群触发的 finals 只回群、私聊触发的只回私聊（rootMessageId→binding 正反例）；无外部来源的 room 内 final 不投任何 IM 绑定
- AC13.5: 顺序投递（07-04 真机反馈提级）：同 root 协作链的 finals 按房间消息创建序投递；per-binding 按 root 链排队 + `invocation.failed`/超时释放防卡队。**新增 AC 未过原 Design Gate → T13 mini-design 先过德彪再动工**

**Architecture:** 复用 Phase 1 渠道无关 ChannelGateway（channel_bindings 已有 chat_kind 列，群绑定=同表新行）。变更集中四处：① config 加群三元组（群白名单/成员白名单含昵称/群绑定种子）② parser 支持 group 消息 + mentions 提取 + @bot 剥离 ③ gateway 门升级 `p2p ∪ (群∧成员∧@bot)` + 归因前缀注入 + queued ack ④ AC11 正式级 sender 持久化（messages 加列 + :689 替换）。AC13.5 独立小设计。
**Tech Stack:** 既有栈零新依赖（@larksuiteoapi/node-sdk WS + SafeHttpClient REST + better-sqlite3/drizzle + node:test）。

---

## 前提实测（2026-07-04，[[feedback-plan-premise-verify-state]]）

| 断言 | 实测 | 结果 |
|------|------|------|
| session-service.ts:689 user 硬编码村长 | grep `:689 alias: role === "user" ? "村长" : thread.alias` | ✅ 在 |
| classifyMention 行首 walk-left 判 gray | mention-router.ts:255-262 亲读 | ✅ 在（归因前缀必须独立成行的依据） |
| messages 表无 sender 列 | pragma_table_info 亲查（id,thread_id,role,content,…,a2a_call_id） | ✅ 无（AC11 正式级要加列+migration） |
| channel_bindings 有 chat_kind 列 | Phase 1 建表 DDL + 真机 p2p binding 行 | ✅ 群绑定零 schema 改动 |

## 实现决策（plan 级，不推翻已拍 D 项）

1. **成员白名单直接带昵称**：`FEISHU_GROUP_MEMBERS=ou_x:小李,ou_y:老王`。归因昵称由 owner（小孙）配置时命名——不调飞书通讯录 API（零新权限）、昵称不是用户自报（注入面消失，剥 `@`/`[Call:` 仍保留防手滑）。owner 判定 = open_id ∈ FEISHU_ALLOWED_OPEN_IDS（Phase 1 既有）；owner 在群里说话归因用 FEISHU_GROUP_MEMBERS 里的名字，没配则「村长」。
2. **群白名单/绑定种子**：`FEISHU_ALLOWED_GROUP_CHATS=oc_a,oc_b` + `FEISHU_GROUP_BINDINGS=oc_a:sg-uuid1,oc_b:sg-uuid2`（bootstrap 播种；SQLite binding 行仍是运行时真相源，D3 语义不变）。chat_id 自举=Phase 1 同款：非白名单群消息被拒时审计日志给 chat_id。
3. **@bot 判定**：boot 时经 SafeHttpClient GET `/open-apis/bot/v3/info` 拿机器人自身 open_id 缓存（真机已验证该端点可用），入站比对 event mentions[].id.open_id。mentions 字段结构**待真机校准**（[[feedback-measure-before-assert]]）→ T4 先抓真实群事件 JSON 冻结成 fixture 再定 parser。
4. **群模式开关 fail-closed**：FEISHU_ALLOWED_GROUP_CHATS 未配 → 群门保持 Phase 1 全拒行为（p2p-only），零回归。
5. **AC12 queued ack 只对群发**：p2p 排队沿用 Phase 1 静默（单人自知）；群内多人才需要「谁的任务排第几」。

---

## Tasks

### T1: config 群三元组解析 + fail-closed
- Files: Modify `packages/api/src/connectors/channel-config.ts` / Test `channel-config.test.ts`
- 失败测试先行：`FeishuChannelConfig` enabled 分支加 `allowedGroupChats: string[]`、`groupMembers: Record<openId, {name, role: "owner"|"participant"}>`、`groupBindings: Record<chatId, sessionGroupId>`；三者全缺省 = 群模式关（空数组/空对象，p2p 行为零变化）；`FEISHU_GROUP_MEMBERS` 格式错（缺冒号/空昵称）→ disabled + reason 点名；owner 角色=open_id ∈ allowedOpenIds。
- Run: `npx tsx --test packages/api/src/connectors/channel-config.test.ts` → RED → 实现 → GREEN → commit `feat(F040-P2): T1 config 群三元组 [黄仁勋]`

### T2: channel-types 群扩展
- Files: Modify `packages/api/src/connectors/channel-types.ts`
- `InboundChannelMessage` 加 `senderName: string | null`（白名单昵称，p2p=null）+ `mentionsBot: boolean`（p2p 恒 true）；`ChannelGatewayConfig` 加群三元组。纯类型 + 既有测试保绿。与 T1 同 commit 亦可。

### T3: gateway 群门（AC10 核心）
- Files: Modify `packages/api/src/connectors/channel-gateway.ts` / Test 新建 `channel-gateway.group-gate.test.ts`
- 失败测试矩阵：群消息 chat∉白名单 → `rejected_group` + audit（含 chatId 供自举）+ **不回执**（未知群不回话，防探测）；chat∈白名单 sender∉成员 → 拒 + audit + **群内回执**（sender.sendText 到该群）；未 @bot → 静默忽略（`ignored_no_mention`，不审计不回执——群里正常聊天不是对 bot 说话）；全过门 → 建群 binding（chat_kind=group，session_group_id 取 groupBindings 种子，缺种子 → 拒+回执「群未绑定房间」）→ 入账本。
- Run: RED → 实现 → GREEN → commit

### T4: 真机群事件校准（Spike，限时 0.5h，产出=fixture）
- 起预览（带群 env）→ 小孙建测试群拉 bot + 发 `@bot 测试` → 抓 raw event JSON（parser 入口临时 debug log）→ 冻结 `packages/api/src/connectors/feishu/__fixtures__/group-message-event.json`。**产出是 fixture + mentions 结构结论**，不是代码。（依赖小孙人工件：建群、发一条消息。）

### T5: parser 群消息支持
- Files: Modify `packages/api/src/connectors/feishu/feishu-event-parser.ts` / Test `feishu-event-parser.test.ts`
- 失败测试（基于 T4 fixture）：chat_type=group → chatKind=group + mentions 提取 + `mentionsBot`（比对注入的 botOpenId）+ **@bot 字面剥离保行首**（`@_user_1` 占位替换规则按 fixture 实测定）；p2p 路径零回归。
- Run: RED → GREEN → commit

### T6: 归因前缀注入（AC11 MVP 级）
- Files: Modify `packages/api/src/connectors/channel-gateway.ts`（inject 处）/ Test `channel-gateway.attribution.test.ts`
- 失败测试＝AC11 三回归样例：群消息注入 content = `[飞书·<昵称>]\n<原文>`（前缀独立成行）；昵称剥 `@`/`[Call:` 字面量；`@bot @范德彪 …` 混排 → 剥 @bot 后 `@范德彪` 仍在正文行首（派发不被杀）；p2p 消息不加前缀（零回归）。断言注入到 handleClientEvent 的最终 content 字符串。
- Run: RED → GREEN → commit

### T7: boot 接线（config→connector→gateway 贯通）
- Files: Modify `packages/api/src/connectors/feishu/feishu-connector.ts`（wireFeishuConnector 拿 bot open_id + 传群配置）+ `server.ts`（零改动预期，config 已传对象）/ Test `feishu-connector.test.ts` 补群路径
- bot/v3/info 失败（网络/权限）→ 群模式降级关闭 + 显式 log（p2p 不受影响，fail-closed）。
- Run: RED → GREEN → commit

### T8: AC12 queued ack（群粒度）
- Files: Modify `channel-gateway.ts`（handleInbound 入队后：binding 忙 → sender 回 `已排队｜<昵称> 第 N 位`）/ Test `channel-gateway.group-queue.test.ts`
- 失败测试：群 binding 忙时两人连发 → 各收 ack 带自己昵称+位置；FIFO 顺序注入（复用 Phase 1 drain，断言 seq）；p2p 排队不发 ack（零回归）。
- Run: RED → GREEN → commit

### T9: AC13 溯源正反例测试面
- Files: Test `channel-gateway.provenance.test.ts`（主要是测试；发现洞才改实现）
- 同 room 双绑定（p2p + 群）：p2p 触发的 final 只投 p2p、群触发的只投群；web 发起（无入站行）→ 零投递；群 A 触发不会投到群 B。
- Run: 期望大体 GREEN（Phase 1 provenance 已按 binding 溯源）；红则修。commit

### T10: AC11 正式级 — messages.sender_display_name 加列 + migration
- Files: Modify `packages/api/src/db/sqlite.ts`（migrate 加 `ALTER TABLE messages ADD COLUMN sender_display_name TEXT`，幂等守卫）+ `packages/api/src/db/schema.ts`（drizzle 镜像）/ Test `drizzle-instance.test.ts` 补列断言
- [[feedback-test-schema-faithful-to-prod]]：测试 mock DB 必须同步加列。
- Run: RED → GREEN → commit

### T11: AC11 正式级 — 写入 + timeline 真名
- Files: Modify `channel-gateway.ts`（inject 后回填 sender_display_name）+ `packages/api/src/services/session-service.ts:689`（`alias: role === "user" ? (m.senderDisplayName ?? "村长") : thread.alias`，具体字段名按 repository 读取链）/ Test session-service timeline 测试补两例（有名→真名；无名→村长，全量历史消息零回归）
- 影响主 UI timeline，跑 `pnpm run test:components` 全量确认前端快照零回归。
- Run: RED → GREEN → commit

### T12: E2E 群链路种子
- Files: Modify `packages/api/src/connectors/__tests__/feishu-e2e.test.ts` 或新建 group e2e
- 全链：群事件 → 门 → 归因注入 → finished → 回群（含署名卡片 opts 断言）+ 私聊回归种子保绿。
- Run: GREEN → commit

### T13: AC13.5 mini-design → 德彪确认（Design Gate 补课，动工前置）
- 产出：feature doc 增补「顺序投递设计」小节（root 链 settle 语义 / hold 队列 / failed+超时释放 / 与 reconcile 交互）→ `.runtime/reviews/` 派德彪 → GO 后才进 T14。
- 设计草案方向：outbound 登记时记 message `created_at`；同 binding 投递前查同 root 链是否存在「更早 created 且未终态」的 outbound 行或 running invocation；hold 的行由后续 finished/failed 事件或 60s 超时 sweeper 释放（B025/r2-P1-new 教训：释放路径必须 finally 级兜底）。
- 注意：**这是德彪 review 的必答题**，不裸奔。

### T14: AC13.5 实现（按 T13 定稿）
- Files: Modify `channel-gateway.ts` / Test `channel-gateway.ordered-delivery.test.ts`
- 失败测试：同 root 双 final 乱序 finished → 按 created_at 序投；先 final 的 agent 卡死 → 60s 超时释放后投（不永久卡）；invocation.failed 释放；跨 root 不互等。
- Run: RED → GREEN → commit

### T15: quality-gate + acceptance-guardian + 德彪 Phase 2 code review
- quality-gate 自检（AC10-13.5 逐条 + 全量验证命令）→ 零上下文 guardian → 派真德彪 review（NEEDS-WORK 全接收敛）。

### T16: 真机验收（小孙人工件）
- 小孙：建测试群 + 拉 bot + `.env`/env 注入群三元组（预览走我注环境变量）→ 群内 @bot 派活 → agent 回群（署名卡片）→ 多人场景（小孙双号或拉一人）连发验 AC12 → AC13 私聊/群互不串真机对照。全绿 → **Phase 3 或合并拍板由小孙定**。

## 风险与依赖

- T4/T16 依赖小孙人工件（建群、发消息）；T4 之前 T5 无法定稿 fixture——顺序按 T1→T3 先行，T4 卡则 T5 用文档假设+真机后校准（标注待验）。
- 群事件若飞书要求额外权限（群消息读取 scope），T4 时会暴露 → 小孙后台加权限+发版（Phase 1 已练过）。
- AC11 正式级动 session-service 主链路 → T11 单独 commit + 组件全量回归，出问题可独立 revert。
- 负载 flake：门禁期间停预览（07-04 实锤：预览进程抢 CPU 挂全量测试）。
