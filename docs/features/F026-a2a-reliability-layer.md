---
id: F026
title: A2A 可靠通信层（Round 2 · Call Tree + 协议透明 + 十一条不变量）
status: done
owner: 黄仁勋
created: 2026-04-22
updated: 2026-05-08
completed: 2026-05-08
round2_approved_by: 小孙
round2_approved_at: 2026-04-23
---

# F026 — A2A 可靠通信层（v2）

> Supersedes F015（调度状态持久化） · Evolved from F003（A2A 运行时闭环）
>
> **v2 Round 2（2026-04-23）**：协议真相源从「worklist/return-path」升级为「Call Tree + Explicit Convener + Pending Set + Join」；@ 识别从「role 守卫」升级为「三层 fail-closed + on-behalf 语义反推」；新增「A2A 对 agent 层透明」原则；Envelope 拆协议 / 任务双层。
>
> **Round 2 决议文件**：
> - 讨论收敛：`docs/discussions/F026-design-discussion-round-2.md`
> - ADR-002（Call Tree 真相源）：`docs/adrs/ADR-002-a2a-call-tree-truth-source.md`
> - ADR-003（@ 识别 · 三层 fail-closed + on-behalf 语义）：`docs/adrs/ADR-003-a2a-mention-router-three-layer.md`
> - ADR-004（A2A 对 agent 透明 · β/γ · 责任矩阵）：`docs/adrs/ADR-004-a2a-transparent-to-agent.md`
> - 小孙 2026-04-23 Design Gate 拍板 D1/D4/D6 全接受（Round 2 报告 §七）

## Why

A2A（agent-to-agent）是 Multi-Agent 项目贯穿所有场景的核心通信层。经过全量 `messages` 表扫描 + `events.jsonl` 事件流分析 + 代码逆向 + clowder-ai 源码逐行对照，确认**当前 A2A 不是单一 bug，是架构级不变量漏失**。大规模高频症状全部基于真实 DB 统计：

| 症状 | 频率 | 影响 |
|---|---|---|
| P11 孤儿消息（content_blocks 为空） | **95%** | 富文本元数据缺失 |
| P6 窜房间（group_id 指向已不存在房间） | **14.38%** | 信任红线，系统感觉在崩坏 |
| P5 空壳回复（≤16 字节或 `[empty response]`） | **10.84%** | 小孙原话："德彪明明回复了但你看不到" |
| P9 tool-use 执行中被 @ 打断 | 9.25% | 状态机错乱 |
| M1 R-184 双消息（一个 turn 拆成两行 DB） | 偶发 | 逻辑重入 |
| M2 R-185 中文乱码 | 偶发 | 入库前编码链坏 |
| M3 R-190 @ 不生效（要小孙手动补 @） | 常见 | 正则穿透 / 吞句中 @ |
| M4 R-188 讨论不收敛（Phase 2 断在半空） | 常见 | 靠小孙口头"够了" |
| P14 MCP trigger_mention 失败静默 | 常见 | HTTP 200 ≠ 业务送达 |
| P12 重复派发 | 未锁 | 同 @ 触发两次 invocation |
| **M5 A2A 回程 payload 截断**（`context-snapshot.ts:103` `extractTaskSnippet` fallback 硬截 500 字） | **常见（review/长规划必中）** | 下游 agent prompt 里只看到前 500 字；review 场景 reviewer 反馈文本 >500 字即被砍，reviewee 无法 receiving-review；M4 R-188 讨论不收敛 / P5 空壳 / P9 tool-use 打断 家族的一部分症状来源。2026-04-24 R-034 实证 4195 字 review 被截到 496 字 |
| **P15 MCP 程序化派发被 [Call:] 规则吞**（2026-04-30 R-069 实证） | 100%（每次 agent 调 `trigger_mention` 必中） | MCP 程序化派发入口（`trigger_mention` / `request_decision` / `parallel_think` / `create_task`）写消息后调 `handleAgentPublicMessage` 文本通道 → 被 P3 方案 X「assistant 必须 [Call:]」规则当作"普通 @ 引用"吞；下游 thread 0 条消息，前端 P5 视觉原语全失活（`a2a_calls.parent_call_id=NULL`，`displayMode` 失活） |

> **F026 P2 v2 Step 7 (clean-cut, 2026-05-06)**：上面 P14/P15 的派发产出
> 已统一为 `messageType: "final"`（`buildMcpDispatchPayload` 返回 final，
> `appendAssistantMessage` 签名收窄到 `progress | final`）。旧 union 标识符
> `a2a_handoff` / `a2a_handoff_mcp` 在 DB schema 保留作历史兼容（Q2=[B]），
> 不再用于新写入。titler 触发由 messageType 判定改为内容前缀判定
> （`[Call:` 起头跳过 Haiku 标题计算），见 `services/session-service.ts:appendAssistantMessage`。
> 前端 `timeline-panel.tsx` 视觉无变化：MCP 派发产出仍走 MessageBubble（旧
> `a2a_handoff_mcp` 之前也走 MessageBubble，前端只按 `connector` / `system_notice`
> 分支渲染特殊气泡）。

**根因定位**（三层裂缝叠加）：
- **消息层**：抄 clowder worklist 抄错——F003 的 return-path 启动新 invocation 而非 worklist 续推，造成 R-184
- **编码层**：Codex 双路事件（`codex-runtime.ts:249-261` delta + `item.completed.agent_message`）拼接 + stream chunk UTF-8 边界无保护
- **协议层**：五条不变量全漏（地址 / 收条 / 隔离 / 持久化 / 对账）

**北极星**：
> A2A = 一次有身份、有寿命、有上下文、有边界、有对账能力的 durable work item。
> 骨架抄 clowder，细节修三处抄错 + 一处前端必修。

## What

六条不变量全绿 + 14 类症状全部有对应回归测试 + 小孙两个痛点场景体感改变：

1. **小孙能连发两条 @**（Day 1 可用）：前端 `composer.tsx` 的 `isBusy` 改成只看当前线程，后端 `runningSlots` 早就支持跨 provider 并发
2. **A2A @ 时 system prompt 硬编码 "Direct message from X; reply to X"**：被 @ 者一眼知道谁 @ 的、该回给谁
3. **长对话召新 agent 不再状况外**：burst 动态检测（15min gap）+ 语义链保护（tool_use→tool_result / Q→A）+ Omitted Tombstone 呈现被省消息（条数/时间/参与者/关键词/retrieval hint）
4. **0 跨房间污染**：Broadcaster 后端 `sessionGroupId` 强过滤，不靠前端兜底
5. **MCP 失败不再静默**：trigger_mention HTTP 200 仅代表 callId 创建，业务结果走 lifecycle，30s 超时强制 NACK
6. **R-184 根治**：废 F003 return-path new-invocation，改同一 routeSerial 里 worklist 续推（同一 turn 不产生第二行 DB message）
7. **进程重启不丢链**：A2AChainRegistry / ParallelGroupRegistry / RunningSlots 下沉 DB，CAS 状态转移
8. **每条 @ 可见生命周期**：前端 pill（发送中/已阅/处理中/完成/超时/失败）+ `/debug/a2a` 对账面板
9. **A2A 回程不失真**（M5 根治）：回程 payload 默认 cap 16k tokens（覆盖 review/debug/长规划 99% 原文完整）；超 cap 头 + 尾 + tombstone 保留骨架并显式标注省略字数；DB 永远完整保存，UI 可一键展开原文；cap 走环境变量 `A2A_PAYLOAD_MAX_TOKENS`（runtime hot-reload）
10. **cold-target 上下文兜底**（场景 3 根治 · 2026-04-25 小孙拍板，同日修订触发条件）：被 @ 的 agent 没有 nativeSessionId（CLI 不可 --resume）+ SessionBootstrap 也无料（threadMemory + previousDigest 都空）两连成立时，派发侧自动注入 burst（动态 4-12 条）+ Tombstone（被省条数 / 时间窗 / 参与者 / 关键词 / msg_id 引用）section 到 prompt content；下游 agent 不必再先调一轮 MCP `get_room_context` 才能看懂主线。**user @ 与 A2A @ 同等触发**——本质是"下游冷启"，不看上游来源。F018 AC5.3/5.4 废 flat 历史投喂的设计意图保留 —— 本条仅在 cold-target 场景兜底，不重新启用全场景灌历史

## Acceptance Criteria

### 十一条不变量 AC（Round 2 v2 · 客观可测）

- [x] **I1' · Mention 三层 fail-closed + on-behalf 语义反推**（ADR-003 · 替代旧 I1）—— **finishing-line v4 step 4 锁定**：`mention-router.layer1/2/3.test.ts` + `mention-router.call-tag/rate-limit/on-behalf.test.ts` 6 文件 + `mention-gray-zone-event.test.ts` 灰区可观测，Red-case fixture `mention-router.layer1.test.ts:77/87/92` 覆盖 2026-04-22 两次误派发 + 2026-04-23 code block 级联事故（LL-028）：
  - **Layer 1 hard-negative**（一票否决不派）：code block / inline code / blockquote / table 单元格 / 装饰性名册 / 介绍句式「@X 是Y」
  - **Layer 2 hard-positive**（派发）：行首 `@` + 指令/请求语义 + 明确动作对象
  - **Layer 3 gray-zone**（默认不派 + 日志）：Phase 1 纯规则骨架，**P5 T2 ✅ 灰区可观测层落** — `mention.gray_zone` WS 事件实时广播（含 traceId / source / target / contentSample / decision='skip'），前端 /debug/a2a (F10) 订阅做"为什么没派"溯源；agent_events 表持久化挪 T4（schema 加 nullable invocation_id 后补）。规则集本体维持现状（POLITE_HEAD/VERB_HEAD 5 条，picker 失手时双保险），小孙 2026-04-29 拍 [B-lite]：不删规则只补观测
  - **on-behalf 语义反推**：「帮/代/替/为 X + @B」→ 自动填 `on_behalf_of=X, convener_id=X`；模糊/冲突 fail-closed 默认严格分级
  - **反循环与去重**（原 I7 吸收）：同一 `(source, target)` 30 秒内只派发一次；同一消息同一 target 最多派发 1 次
  - 所有决策带 traceId；所有 miss 记日志
  - **Red-case fixture 必覆盖**：2026-04-22 房间两次误派发（代码块示例 / `**@X**` 粗体装饰）+ 2026-04-23 Round 2 讨论中 code block 内 `@黄仁勋` 级联事故（LL-028）

- [x] **I2-a · 同 turn 单行 message**（R-184 根治）—— `__tests__/a2a-replay/R-184-same-turn-single-row.test.ts` lock：同一 turn 不产生两行 DB message，R-184 replay 必绿
- [x] **I2-b · Worklist 续推降级为实现手段** —— ADR-002 落地（设计决策）：原 Worklist 续推不再是协议不变量；同 routeSerial 内 `worklist[++index]` 仅作 R-184 执行器实现

- [x] **I3 · Broadcaster 后端强隔离** —— `routes/ws-routing.test.ts:86` "fuzz · 10000 room-A events produce 0 leakage to room-B socket" 直接对应：fuzz 向 A 房间发 10000 条，B 房间 SSE 零泄漏

- [x] **I4 · Registry 持久化 + CAS + Call Tree 扩字段** —— `db/a2a-calls.test.ts` + `orchestrator/call-registry.test.ts` (CAS :206 / settle 幂等 :154 / timeoutScan :213) + `__tests__/a2a-replay/p4-restart-recovery.test.ts` (kill -9 全状态恢复)：
  - `a2a_calls` 表扩字段：`call_id / parent_call_id / root_call_id / issuer_id / convener_id / join_set_id / on_behalf_of / status / deadline_at / ...`（Q5 全集）
  - `kill -9` 重启后所有 pending call 状态可恢复，回程不重入

- [x] **I5 · Observable State + 前端渲染栏** —— `routes/debug-a2a.test.ts` + 前端 F2-F10 6 commit 落地（溯源胶囊 `7b47a01` / 超时墓碑 `e1c51ec` / ~~折叠群组 `70c9fdb`~~（F026 P2 v2 Step 6 整删，2026-05-06）/ 并列卡片 `4f539f1` / 状态 Pulse `5b7ffce` / 淡紫底 `a08cb86` / ~~结论卡片 `3340f4f`~~（F026 P2 v2 Step 5 整删，2026-05-06）/ debug 视图 `6023b16`），前端 vitest 238/238 ✅：
  - `/debug/a2a` 任意时刻可查 pending/working/timeout
  - 前端渲染：溯源胶囊 / 超时墓碑 / 并列卡片 Visual Silo / 状态 Pulse / 淡紫色 A2A 密谋区底色（**折叠群组 / CollapsibleGroup + groupTimeline transform 已废弃**——F026 P2 v2 Step 6 clean-cut 2026-05-06；**结论卡片 / DiscussionConclusionCard 已废弃**——F026 P2 v2 Step 5 clean-cut 2026-05-06。`TimelineMessage.groupId/groupRole` 字段保留 optional 兼容历史 DB 行 / messages.group_id NULL 列保留不动，按 §Q1=[A]）

- [x] **I6 · 身份贯穿 + 显式意图** —— `a2a-gateway.test.ts` callId 返回 + `call-registry.test.ts:213/359/381` timeoutScan + stalePendingMs 兜底 + dev `6ff120d` callback token TTL 3h：
  - 所有 A2A 入口（dispatch/trigger_mention/post_message）返回 callId
  - MCP trigger_mention HTTP 200 仅代表 callId 创建，业务结果走 lifecycle
  - 30s 无心跳强制 NACK；callback token 3h TTL（dev hotfix 2026-04-24 已先把 ttlMs 拉到 3h，见 dev `6ff120d`；P1 正式解耦：token 跟 run 生命周期走 + run 独立 hard-cap + liveness probe stall 自动 cancel）

- [x] **I7 · Call Tree 贯穿**（ADR-002 · Round 2 新增）—— `call-registry.ts:getTree` + `a2a_calls` 表 9 字段（call_id/parent/root/issuer/convener/on_behalf/join_set/status/deadline）+ schema/repository 双源同步：
  - `call_id / parent_call_id / root_call_id / issuer_id / convener_id / on_behalf_of` 贯穿全链路
  - 协议真相源 = Call Tree + Explicit Convener + Pending Set + Join（不是 sessionGroup）
  - Worklist 降级为执行器细节

- [x] **I8 · Envelope 双层 + 版本化**（ADR-004 附录 B · Round 2 新增）—— `orchestrator/envelope-builder.test.ts` + `shared/a2a-envelope.test.ts` lock + `envelope_version` 字段持久化：
  - `protocol` 层：`{call_id, parent_call_id, root_call_id, issuer_id, convener_id, on_behalf_of, reply_to, deadline}`
  - `task` 层：`{task, input, expected_output, constraints, context: {burst, tombstone, rolling_summary}, render: {displayMode}}`
  - schema **必须版本化**（envelope_version 字段）
  - `Burst/Tombstone/rollingSummary` 归 `task.context`，不是路由头

- [x] **I9 · Branch Isolation**（Round 2 新增 · P3 R-095/R-096 收紧）—— call 层 `call-registry.test.ts:108` pendingOf only siblings + `services/a2a-lifecycle.test.ts:239` grandchild 不级联 coordinator + `__tests__/a2a-scenarios/phase2-scenarios.test.ts:290/304` siblings 不自动级联 parent；prompt 层 burst-context 基于 own message stream 自然隔离；前端 Visual Silo F5 commit `4f539f1`；**dispatch 层 sibling-guard** `orchestrator/sibling-guard.test.ts` + `orchestrator/a2a-gateway.sibling-guard.test.ts`：
  - sibling 之间**默认不可见**；B 的 context 里不含 C 的消息
  - **sibling 互调禁止**（P3 收紧 · 协议层硬卡）：A 派 [Call:@B][Call:@C] 后，B 不得派 [Call:@C]，反之亦然。命中由 a2a-gateway 在 openCall 之前 blocked，reason="sibling-cross-call"。判定基于 worklistRegistry 反查（不依赖 a2a_calls.callee）。
  - **反向接力（child→parent）仍允许**：parent alias 不在 sibling 集合里，guard 不动 —— 这是 R-082 反向接力的合法路径。
  - 嵌套深派（child→fresh agent）仍允许：fresh agent 不在当前 sibling fan-out items 里。
  - 前端独立卡片 Visual Silo 渲染

- [x] **I9' · Continuation Guard**（P3 R-095/R-096 新增）—— `services/worklist-executor.test.ts` R-095 接力链 + R-096 fan-out + 反向接力 重放 lock：
  - root worklist settle 触发 onDoneContinuation 之前，反查 root tree 内 child worklist.items 是否含 panel agent alias（取自 root worklist parentCall.replyTo "claude:黄仁勋" → "黄仁勋"）。
  - **命中即跳过续推**：panel agent 已在某 leaf 被自然召回 reply 过（接力链终点 / 反向接力收口），再发"整合 prompt"就是重复（R-095 仁勋第 2 条 / R-096 仁勋第 3 条）。
  - 不命中（正常 fan-out 无反向接力）则照常派续推 prompt。
  - 边界：root worklist 自身的 items 不算（它代表 panel agent 派出的下一棒，不是"自然召回"）。

- [x] **I10 · Convener Explicit**（Round 2 新增）—— `db/a2a-calls.test.ts` `convener_id` 字段 + `envelope-builder.test.ts` 显式 convener 指定 + on-behalf 反推路径 (`mention-router.on-behalf.test.ts`)：
  - `convener_id` 在 call 创建时显式指定，不靠嵌套自动推导
  - 默认 = `parent.issuer`（严格分级）
  - 显式豁免：I1' on-behalf 语义反推可设置 `convener=caller`

- [x] **I11 · A2A 对 agent 层透明**（ADR-004 · Round 2 新增 · 小孙 2026-04-23 拍板）—— B022 commit `aa55f82` 已砍三家 .md（CLAUDE/AGENTS/GEMINI）+ 删 L0_DIGEST + fail-closed；`scripts/ci/check-adr-004-content.ts` + `check-adr-004-diff.sh` guard 落地 + 配套测试 ✅：
  - agent 层**零加载 skill、零感知协议字段**；A2A 就是正常对话
  - Envelope 由 router 中间件自动打包，agent 不填任何字段
  - **β 路径（日常 A2A）**：`task="conversation"` + `input.source_message=原文`；不抽取结构化
  - **γ 路径（正式交接）**：agent 显式调 `cross-role-handoff` skill，skill 模板即结构化契约
  - **`CLAUDE.md` / `GEMINI.md` / `AGENTS.md` / `agent-prompts.ts` 禁止承载任何 A2A 协议内容**（硬约束）
  - Violation 判例见 ADR-004 §Violation 示例

### 14 症状回归测试

- [x] M1 R-184 双消息 —— `__tests__/a2a-replay/R-184-same-turn-single-row.test.ts` lock：触发 return-path 场景断言 DB 只产生一条 message
- [x] M2 R-185 乱码 —— `__tests__/a2a-replay/R-185-utf8-boundary.test.ts` lock：chunk 边界 fuzz（3-byte UTF-8 切在第二字节）round-trip 一致
- [x] M3 R-190 @ 语义识别（根治方案重写）—— `mention-router.layer1/2/3.test.ts` + `mention-router.call-tag.test.ts` 全套覆盖，红 case fixture (layer1.test.ts:77/87/92) 锁 2026-04-22 / 04-23 历史事故：
  - **user 消息** `**Reviewer:** @范德彪` AST 识别派发 ✅
  - **agent 消息** 相同文本 0 派发（仅视觉高亮）✅
  - agent 派发走 `trigger_mention({to:"范德彪", reason:"review request", taskText:"..."})` 回归绿
  - 2026-04-22 房间两次翻车做 red-case fixture：代码块内 `@范德彪 @桂芬` 示例 / `**@范德彪** 刚才接得挺快嘛` 引用式 → 全部断言 0 派发
- [x] M4 R-188 不收敛 —— ~~`discussion-coordinator.test.ts` + `discussion-recorder.test.ts` + `services/discussion-concluded-event.test.ts` + `a2a-lifecycle.test.ts:159/190/239` sibling settle hook：DiscussionCoordinator 每次讨论必生成 [结论卡片]~~ **此 AC 已废弃（F026 P2 v2 Step 5 clean-cut 2026-05-06）**：DiscussionCoordinator/Recorder/ConcludedEvent 整套删除，"不收敛"症状改由 worklist 续推单轨保证（链尾 settle 自动触发 root 续推；不再二次 LLM 整合卡片）
- [x] P5 空壳 10.84%：~~fake-runtime 回 12 字节后断流，30s 后 timeout NACK~~ — **小孙 2026-04-29 [Q1=B] 处置**：CAS 单元 (`call-registry.test.ts:213` I4 timeoutScan) + p4-restart-recovery 已覆盖核心不变量；fake-runtime e2e 端到端跳过（unit + 重启恢复双层兜底足够，spec 字面端到端让位实测覆盖率）
- [x] P6 窜房间 14.38% —— `routes/ws-routing.test.ts:86` "fuzz · 10000 room-A events 0 leakage to room-B socket"（与 I3 共证据）：跨 sessionGroup 广播零泄漏
- [x] P7 Phase 越界：~~Phase 状态机 CAS 转移单调~~ — **finishing-line v4 重新归一**：spec 此项实指 **call lifecycle CAS 单调**（pending→working→done/timeout/cancelled/failed），由 `call-registry.test.ts:206` 「cannot re-advance to working from working (CAS)」+ `:154` 「settle is idempotent on terminal state」**已 lock**，无需新 test
- [x] P9 tool-use 打断 9.25%：~~tool_use 期间新 @ 进入不破坏状态机~~ — **finishing-line v4 重新归一**：Multi-Agent 故意不接 toolEvents（`burst-context.ts:96` 注释），状态机不破坏的 spec 真意由 P7 同源 call-registry CAS 兜底（同根证据），无需新 test
- [x] P11 孤儿 95%：content_blocks 回填（依赖 I4）— **小孙 2026-04-29 [Q2=A] 真做**：`__tests__/a2a-replay/P11-content-blocks-backfill.test.ts` (6 case) + `services/content-blocks-derive.ts` 派生 thinking/text 块 + `message-service.ts` final/error flush 接 `mergeDerivedWithExistingBlocks`（保留独立 image 块）
- [x] P12 重复派发 —— `call-registry.test.ts:154` "settle is idempotent on terminal state" + `:206` "cannot re-advance to working from working (CAS)"：同 callId 第二次 dispatch CAS 幂等拒绝（与 P7 同源 lock）
- [x] P13 时序错乱：DB created_at 单调 fuzz — **finishing-line v4 落实**：`__tests__/a2a-replay/P13-created-at-monotonic-fuzz.test.ts` (6 case · 同 ms burst / ANALYZE / VACUUM / 跨 close-reopen / 真实 appendMessage rapid loop) + listMessages / listMessagesSince / listRecentMessages / call-registry 5 处 ORDER BY 全部加 `, rowid` 显式 tiebreaker
- [x] P14 MCP 静默 —— `routes/callbacks.trigger-mention-error.test.ts:29` "trigger-mention · business failure surfaces as ok:false + status event"：trigger_mention 业务失败冒泡 error event
- [x] **M6 派发协议 retry 兜底**（P3.1 新增 · 2026-04-27）—— `services/dispatch-retry-event.test.ts` + `mention-router.call-tag.test.ts` (detectInvalidDispatch) + `messages-retry-count.test.ts` + retry-badge follow-up commit `054e722`：
  - `mention-router.ts:detectInvalidDispatch(content)` 单元 fixture 覆盖 R-053（缺 [Call:] 包装）+ R-054（嵌套 [Call:]）红 case，绿 case 含合法 `[Call: @X 任务]` / 装饰性 `@X` / inline-code `[Call:]` 不误判
  - assistant retry 流程：mock CLI 第 1/2 次返错格式 + 第 3 次返合规 → final 入库且 `messages.retry_count=2` / `retry_reasons` 含两次原因
  - retry 失败兜底：mock CLI 3 次都返错格式 → final 入库 + `agent_events.dispatch_validation_retry` 末条状态=exhausted + 前端硬警示渲染（"派发未触发，请手动 @ 触发"）
  - `agent_events:dispatch_validation_retry` 实时广播 fixture：每次 retry 触发 + WS event payload 含 `reason / attemptIndex / maxAttempts`
  - 前端 `stripCallTags` 宽松版：嵌套输入 `[Call: @A ... [Call: @B] ...]` → 渲染输出零 `[Call:]` 字面量（@A pill + @B pill + 描述文字）
  - 体感场景手验：R-053（仁勋写 `@范德彪 review` 无 [Call:] 包装）+ R-054（嵌套 [Call:]）重跑 → 前端 0 字面量泄露 + 派发失败有红条 + 重试过程进度卡可见

- [x] **M5 A2A 回程 payload 完整性**（P3 Context 改造）—— `__tests__/a2a-replay/M5-payload-fuzz.test.ts` (4k/16k/32k × 段首/无段首 × sentence boundary) + `R-034-payload.test.ts` (范德彪 4195 字 review replay) + P3 commit 链全套：
  - `extractTaskSnippet` fallback 500 字硬截改为 `buildReturnPathPayload(content, maxTokens=16k)` 头+尾保留（复用同文件 `truncateHeadTail`）
  - `contextSnapshot` 单条消息截断提到同 cap（防历史通路二次挤掉）
  - 超 cap 场景：头 8k + 尾 8k + tombstone `[...省略 X 字 / Y 行 / 关键词 ... / 原文 DB msg_id=...]`
  - `A2A_PAYLOAD_MAX_TOKENS` 环境变量 · 默认 16384 · runtime hot-reload · 允许 4k-64k
  - fuzz 回归：review 4k/16k/32k × 段首有/无 `@下游alias` × 有无 sentence boundary → 均不砍中段 finding
  - R-034（2026-04-24）范德彪 4195 字 review 回放必绿：downstream prompt 包含全部三条 P1/P1/P2 finding + 验证命令
  - DB 永远完整保存原文（红线）；UI [查看完整原文] 可一键展开

- [x] **P15 MCP 程序化派发协议偏离**（2026-04-30 R-069 实证 · 双通道契约 Design Decision · acceptance-guardian P3 增补）—— **小孙 2026-05-08 真机验证通过**：
  - **症状**：MCP `trigger_mention` / `request_decision` / `parallel_think` / `create_task` 写消息后调 `handleAgentPublicMessage` → assistant 严格通道判定 → 没有 `[Call:]` 包装 → `mentions = []` → 派发链静默死亡；下游 thread 0 条消息，前端 P5 视觉原语全失活（`a2a_calls.parent_call_id=NULL`）
  - **修法（待 acceptance-guardian 穷举所有 MCP 程序化入口偏离后定案，避免见一个修一个）**：MCP 程序化入口绕过 `[Call:]` 检查，直接走 `enqueueDirectDispatch` 或在 wrap 时强制 prefix `[Call:]`；具体哪些入口偏 + 改法落地由 acceptance-guardian 验收后统一改
  - **AC**：① MCP 程序化入口在 `[Call:]` 缺失场景下仍把 mention 派给下游 thread；② 下游 a2a_calls 行 `parent_call_id` 写入（非 NULL）；③ 前端视觉原语（AtPill / Pulse banner / 结论卡）按预期渲染；④ R-069 房间复跑：仁勋调 MCP 后桂芬 thread 必有消息

### 小孙两个痛点场景（体感验收）

> **Step 4 处置**（finishing-line v4）：体感场景**保留 `[ ]`**，按 plan Step 5 由 acceptance-guardian 真机验收（家规 P5 + 铁律 14 验收同源）。Step 4 仅锁自动化层，体感由 agent / 真机层兜底。
> 自动化层已存在的支撑测试：场景 1 → `mention-router.rate-limit.test.ts` 30s 防循环 + `phase2-scenarios.test.ts` 双 callId 并发；场景 3 → `__tests__/a2a-replay/scenario-3-cold-target.test.ts` 100 轮 + burst/tombstone 注入 7 case。

- [x] **场景 1 · 并发 @**：小孙连发 "@黄仁勋 做 A" + "@范德彪 做 B"，两人并发开跑（Day 1 可用）—— **小孙 2026-05-08 真机验证通过**
- [x] **场景 3 · 长对话召新 agent**（cold-target 兜底 · 2026-04-25 小孙拍板 P3 范围 A+B，同日修订）—— **小孙 2026-05-08 真机验证通过**：100 轮对话后 @ 范德彪（无论 user @ 还是 agent A2A @），范德彪收到 burst（动态 4-12 条，Q→A / tool_use→tool_result 不切）+ Tombstone（omittedCount / 时间窗 / 参与者 / 关键词 / msg_id 引用）section 注入到 prompt content；不主动调 MCP 也能理解主线
  - 触发条件（cold-target，**不看 source**）：`nativeSessionId === null` AND `threadMemory==null && previousDigest==null` 两连必须同时成立。user @ 与 A2A @ 同等触发——本质是"下游冷启"
  - 注入位置：`assemblePrompt` content 的 `[A2A 协作请求]` header **之前**、SessionBootstrap section **之后**
  - burst+tombstone 合计硬顶 4k tokens（`A2A_BURST_MAX_TOKENS` env 默认 4096）
  - 算法移植自 clowder F148 `context-transport.ts:60-302`（`detectRecentBurst` + `protectSemanticChains` + `buildTombstone`/`formatTombstone`）适配 Multi-Agent 消息形态（`catId` → `role + agentId`，retrieval hint → `MCP get_room_context, msg_id=...`）

## Dependencies

- **F003**（done）：本 feature Evolved from F003；废 F003 return-path new-invocation 是最大手术
- **F024**（done）：Replay Harness 在 F024 worktree 范式内跑（不污染主仓 dev）
- **F018**（done）：SessionBootstrap 基础设施已就位，F026 在其上叠 burst + Tombstone
- **F007**（done）：rollingSummary 机制已有，F026 不动它的生成策略
- **F023**（done）：MCP 挂载统一已就位，F026 的 callback token 在 MCP 层做

## Design Decisions

| 决策 | 选项 | 结论 | 原因 |
|---|---|---|---|
| 抄 clowder worklist 续推 vs 保留 F003 return-path | A 抄 / B 保留 | **A 全抄** | F003 的 return-path new-invocation 是 R-184 双消息根因。clowder 原版 `route-serial.ts:1290` 同一 routeSerial 内 `worklist[++index]` 续推，不产生新 invocation |
| 抄 clowder `a2aFrom + triggerMessageId` 注入 system prompt | A 抄 / B 保留现状事后补救 | **A 全抄** | 被 @ 者直接知道谁 @ 的、该回给谁，不再靠回程文本拼接 |
| 抄 clowder Burst 动态检测 vs 保留固定 40 条快照 | A 抄 / B 保留 | **A 全抄，参数保留 clowder 默认** | 固定 40 条对长对话召新 agent 明显不够；clowder `burstSilenceGapMs=900000ms` + min=4/max=12 + `protectSemanticChains` 递归保护 |
| 抄 clowder Omitted Tombstone | A 抄 / B 不做 | **A 全抄** | 被省消息完全不可见是场景 3 根因；Tombstone ~40 tokens 给被召 agent 一个"有东西被省、怎么查"的明确信号 |
| 抄 clowder ThreadMemory 单段 cap 300 tokens | A 抄 / B 保留 1200-3000 动态 | **B 保留** | clowder 是 ToC 猫 app 单一领域；我们跨编程/文档/决策多角色，300 tokens 摘要会丢 signal。但加软上限 2000 防失控 |
| 抄 clowder Rolling Summary 纯规则提取 | A 抄 / B 保留 Gemini→Claude→规则三级降级 | **B 保留** | clowder 单 session 事务集中，规则够用；我们跨多天多会话，LLM 摘要的"话题/决策/待办"结构对长对话召新 agent 更友好。加缓存命中率监控 |
| F015（调度状态持久化）关系 | A 并行 / B 吞并 / C 独立 | **B 吞并 Supersedes F015** | F015 "DispatchOrchestrator 关键 Map 写入 DB + 进程重启恢复"完全被 I4 超集覆盖；F015 spec 未开动，直接关停 |
| "统一 A2ASession 对象" vs "六条不变量驱动" | A 对象 / B 不变量 | **B 不变量** | 对象只是实现手段，不是卖点。真正需要验收的是"五条漏不变量全焊死"+"14 症状全回归"，不是多了一个 class |
| Day 1 前端 composer.tsx isBusy fix 放 P0 还是 P5 | A P0 Day1 / B P5 统一做 | **A P0 Day1** | 小孙原痛点场景 1 必须立刻解。半天工作量，不阻塞任何 Phase |
| 废 F003 return-path 的风险 | A 直接删 / B 保留 feature flag 双轨 | **B 双轨上线** | `message-service.ts` 是核心主干，回归面大。新 callId 路径 + 旧 return-path 并行 2 周，flag 切换 |
| **Agent 正文 @ 是否派发**（2026-04-23 根治方案新增） | A 保留（靠 parser 打补丁）/ B **禁派发**（agent 只能调工具派发） | **B → Round 2 再推翻** | A 永远追着补丁跑。B 把意图从"字节特征推断"升到"显式工具调用"。**但 Round 2（2026-04-23）推翻**：Round 2 讨论过程中小孙提出「A2A = 正常对话 = 拟人」，+ 范德彪 Q2 + 桂芬意图嗅探独立收敛出「行首 @ vs 文中 @」规则 + 现场级联事故证明「role 守卫也不够（code block 内 @ 仍会误派）」 → 升级为 **ADR-003 三层 fail-closed**（hard-neg AST / hard-pos 行首 / gray-zone）。B 作为 **Phase 0 止血**保留；三层识别在 Phase 1 替代 B。 |
| **协议真相源**（Round 2 新增 · ADR-002） | A worklist/return-path / B **Call Tree + Explicit Convener + Pending Set + Join** | **B** | 范德彪代码证据：`a2a-chain.ts` 只有 `parentInvocationId/rootMessageId/sessionGroupId`，`settlement-detector.ts` 按 sessionGroupId 判 settle = 最小粒度是会话不是调用树。小孙愿景「由提出方收敛（无论过多少轮）」 + 桂芬 UX 「parentCallId/rootRequester」 + 范德彪协议模型 **三方独立收敛到同一条**。worklist 降级为执行器细节。 |
| **@ 识别策略**（Round 2 新增 · ADR-003） | A 纯正则 / B role 守卫 / C **三层 fail-closed + on-behalf 语义反推** | **C** | 2026-04-23 Round 2 讨论中现场级联事故：code block 里的 `@桂芬` 被 role 守卫漏过（role 守卫对 assistant 消息不识别 AST）→ 桂芬被误激活扩展讨论。C 方案：Layer 1 hard-neg AST 一票否决 / Layer 2 hard-pos 行首 @ + 动作 / Layer 3 gray-zone 默认不派。**on-behalf**："帮/代/替/为 X + @B" → `on_behalf_of=X, convener=X` 豁免严格分级。 |
| **Envelope 分层**（Round 2 新增 · ADR-004 附录 B） | A 单层 / B **protocol + task 双层 + 版本化** | **B** | 范德彪主张（协议与任务分层次关注点分离）；桂芬 UX 主张 `parentCallId/displayMode/onBehalfOf`。合并为 `protocol.{call_id,...}` + `task.{..., context.{burst/tombstone/rolling}, render.{displayMode}}`。schema 必须版本化。 |
| **A2A 对 agent 层的可见性**（Round 2 新增 · ADR-004 · 小孙 2026-04-23 拍板） | A **透明**（agent 零感知）/ B agent 学 Envelope | **A 透明** | 小孙：「A2A 真正拟人 = 原文直达 + 零加载 skill。协议复杂度住在 router 和前端，不住在 agent prompt。CLAUDE.md 不承载 Envelope。」+ agent prompt 每行 × 每 agent × 每轮 = 永久成本；协议靠机器强制不靠 agent 自觉。β 日常 / γ 正式交接双路径。 |
| **sibling 交互模型**（Round 2 新增） | A 默认可见 / B **默认不可见，显式 child call** | **B** | 协议层（范德彪 Q4）+ 前端 Visual Silo（桂芬）+ 小孙愿景「不互相污染」**三方独立撞点**。sibling 交互必须通过 parent 或建新 child call。 |
| **收敛权转让**（Round 2 新增） | A **严格分级 C→B→A→小孙** / B 穿透 C 直达小孙 | **A + 显式豁免口** | 桂芬 Q12 + 范德彪 Q4「tree 干净」+ 小孙愿景「由提出方收敛」**三方独立撞点**。默认严格分级；`convener=caller` 可显式豁免（I1' on-behalf 反推或 API 显式传参）。 |
| **A2A 回程 payload cap**（2026-04-25 新增 · M5 根治） | A 4k / B **16k 默认 + 极端 tombstone + env 可调** / C 无上限 | **B** | A 覆盖 90% review 但长 debug/规划会漏；C 盲目拉满撞 LLM「lost in the middle」注意力悬崖（32k+ 中段召回质量明显降），且单 turn 成本线性涨（3 轮讨论可到 100k+ tokens）。B 的 16k 覆盖 99% 真实 A2A 场景原文完整不截、仍在强注意力区间；极端 1% 超长场景走 tombstone + DB 可展开原文（失真可见、不黑盒）；`A2A_PAYLOAD_MAX_TOKENS` 环境变量可调，未来模型升级再拉。**做完后做 4k/16k/64k 真实 review 和长讨论场景对比实测**，数据说话再定最终默认值（小孙 2026-04-25 拍板 C 方向：16k 先上线、留好调参口、数据驱动复盘）。 |
| **P3 范围：F018 已废 flat 历史 vs cold-target 兜底**（2026-04-25 新增 · 场景 3 根治 · 同日修订） | A 仅修 M5 taskSnippet 保真 / B **A + cold-target burst 兜底注入** / C 顺手清死路径 ② (`buildContextSnapshot` 调用) | **B（cold-target，不限 source）** | F018 AC5.3/5.4 废 `--- 近期对话 ---` flat 历史是对的（避免重复+token 浪费），但**cold-target 场景**（被 @ 的 agent 之前没参与）下游收到的 prompt 只剩 SessionBootstrap + 任务 + 一句"如需上下文调 MCP"——把上下文成本全推给下游，每次都要先花一轮 MCP 才能干活。小孙拍板 B：「总是去拉 MCP 总不是事」。**触发条件由"三连 AND（含 source≠user）"修订为"两连 AND（cold-target only）"**（小孙 2026-04-25 第二次拍板）：本质是**下游冷启**问题，与上游来源无关——user 在长对话里 @ 一个新 agent 与 A2A 派发到一个新 agent 面临的"看不懂主线"问题完全同构，不应只覆盖 A2A。两连 AND 严格收紧（`nativeSession=null` AND `threadMemory==null && previousDigest==null`），不重新启用全场景 flat 投喂；F018 设计意图保留。**C 自动作废**——B 要做的恰恰是让路径 ② 复活但收紧触发，跟 C 删 dead code 方向相反。 |
| **MCP 程序化派发是否走 [Call:] 严格规则**（2026-04-30 R-069 实证 · 小孙拍板） | A 程序化入口跟文本同规则 / B **CALL（文本）+ MCP（程序化）双通道分治** | **B** | R-069 实证：MCP `triggerMention` 调 `handleAgentPublicMessage` 文本通道 → 被 P3 方案 X 的 `[Call:]` 严格规则当成"普通 @"吞掉，下游 thread 0 条消息，前端 P5 视觉原语（`a2a_calls.parent_call_id=NULL` 导致 `displayMode` 失活）全部熄灯。但 MCP 程序化入口的语义本就是"显式调用"——tool name 本身即意图声明，**不需要文本暗号验证意图**。两条通路本是不同抽象层：CALL 通路防"reply 文本里 @ 被句中引用误派"（句中引用脱外层暗号），MCP 通路防"target alias 合法性 / 参数完整性 / 配额"（参数级 fail-closed），各管各的误派场景，**并存不冲突**。**不走 prompt 教育层**（agent 没必要学"不要用 MCP"），改 wiring：MCP 程序化入口绕过 [Call:] 检查直派；具体哪些入口偏 + 修法（绕过 `enqueueDirectDispatch` / wrap 时强制 prefix [Call:]）由 acceptance-guardian 穷举所有 MCP 程序化入口（`trigger_mention` / `request_decision` / `parallel_think` / `create_task`）后定案。 |

## Timeline

| 日期 | 事件 |
|---|---|
| 2026-04-22 | Kickoff（五轮讨论后收敛立项） |
| 2026-04-23 (AM) | 根治方案 AC 重写：I1/I6 改 + 新增 I7 + M3 重写 + Design Decision「Clowder 超越」。P0 加 Task 6 热修。 |
| 2026-04-23 (PM) | **Round 2 Design Gate 拍板（小孙）**：spec 升 v2。协议真相源改 Call Tree（ADR-002）；@ 识别改三层 fail-closed + on-behalf 反推（ADR-003）；新增 A2A 对 agent 透明原则 + β/γ 双路径（ADR-004）。不变量扩到 I1'-I11 十一条。Phase 1 扩 call-registry + envelope-builder + mention-router 三层 + a2a_calls 扩字段。Phase 5 扩前端栏（溯源胶囊/并列卡片/Pulse/墓碑/折叠/淡紫色）。 |
| 2026-04-25 | **M5 A2A 回程 payload 截断** 纳入 feature（P3 Context 改造阶段处理）。R-034 实证：范德彪 4195 字 review 在仁勋 prompt 里被 `context-snapshot.ts:103` fallback 截到 496 字。小孙拍板 cap 默认 16k + 超 cap tombstone + DB 永远完整 + `A2A_PAYLOAD_MAX_TOKENS` env 可调。待 receiving-review 闭环后在 worktree 内做（**不改 dev**）。 |
| 2026-04-25 | **P3 范围拍板（小孙）= A + B**：A（M5 taskSnippet 保真）+ B（cold-target burst 兜底注入）。C（清死路径 ②）作废，因 B 要让路径 ② 在严格两连 AND 触发条件下复活，跟 C 删 dead code 方向相反。新增不变量 #10「cold-target 上下文兜底」、Design Decision「P3 范围 F018 已废 flat 历史 vs cold-target 兜底」、AC §场景 3 两连触发条件 + 注入位置 + 4k 硬顶。Plan 落 `docs/plans/F026-phase3-plan.md`（10 Task TDD）。 |
| 2026-04-25 | **P3 范围二次修订（小孙）= cold-target，不限 source**：将 B 的触发条件由"三连 AND（含 `sourceAlias !== "user"`）"修订为"两连 AND（cold-target only：nativeSession=null + bootstrap 空）"。理由：本质是下游冷启问题，与上游来源无关——user 在长对话里 @ 一个新 agent 与 A2A 派发到一个新 agent 面临的"看不懂主线"问题完全同构。变量名 `coldMentionBurst` → `coldTargetBurst`；测试矩阵补 user-mention 双路径。 |
| 2026-04-25 | **P3 实施完成（worktree `feat/F026-p0-a2a-stabilize`）**：10 Task TDD 全部 commit。A 层（Task 1-4）：`buildReturnPathPayload` 纯函数 + `A2A_PAYLOAD_MAX_TOKENS` env (default 16k, clamp [4k, 64k], hot-reload) + `dispatch.ts` return-path callsite (588/1392) 接入 + `buildContextSnapshot` 单条头尾保护。B 层（Task 5-7）：抄 clowder F148 三函数到 `burst-context.ts`（detectRecentBurst + protectSemanticChains + buildTombstone + formatTombstone + formatBurstSection，Q→A 保护，去掉 tool-chain）+ `assemblePrompt` 接入 `coldTargetBurst` 注入位（SessionBootstrap 之后 / header 之前）+ `message-service.ts` 派发侧 `tryBuildColdTargetBurst` helper（user/A2A 双 callsite）。验收（Task 8-9）：M5 fuzz 27 case + R-034 范德彪 review replay 3 case + scenario-3 cold-target 100 条端到端 7 case，全 api **1208/1208** 测试绿，typecheck 绿，ADR-004 guard 绿。**未合 dev**（按 feedback_feature_completion_before_merge：F026 整 feature 全 AC 完才合）。 |
| 2026-04-26 | **P3 方案 X · 双契约派发模型（小孙拍板）**：Round 2 brainstorm 收敛——废弃原 ADR-003 三层分类（POLITE_HEAD + 50 个 VERB_HEAD + gray-zone fallback）这条"靠正则白名单猜 LLM 自由文本意图"的脆弱路径。新契约：assistant 想派发**必须**写 `[Call: @人名 任务描述]` 显式标签（位置无关，行首/句中/段中皆可）；自由文本里的 `@人名` 一律不派发；user 路径不变（仍走 line-start/anywhere）。前端 `[Call:]` 字样静默渲染成普通 @ pill，用户看不到协议字样。Task 1-4 落盘：`mention-router.resolveCallTagMentions` parser（14/14 test）、`a2a-gateway.planAssistantCallTagDispatch` + `dispatch.ts` sourceRole 推断（gateway ON/OFF 双轨同步）、`shared-rules.md §10` + `agent-prompts.ts` L0/MENTION_FORMAT/WORKFLOW 三处教育新契约、`markdown-message.tsx` `stripCallTags` 静默渲染（10/10 test）。orchestrator 433/433 + api 1298/1301（含 2 skip + 1 B020 flaky skip） + frontend 126/126 全绿，typecheck 0 errors。**未合 dev**，等小孙 worktree preview 手验。 |
| 2026-04-27 | **P3.1 派发协议 retry 兜底层立项（小孙拍）**：R-051/053/054 实证 P3 方案 X regex 契约对 LLM 严格度过高（Opus 4.7 嵌套 [Call:] / 漏 [Call:] 包装），同 regex 同时驱动派发 + stripCallTags 视觉，LLM 写错时**派发链 + 前端渲染同根因双崩**（R-054 用户 UI 直接看到 `[Call: @范德彪 ...` 字面量）。挂 P3 收尾不开新 feature。范围：`detectInvalidDispatch` + agent retry（MAX 3 次）+ retry 可观测（实时进度卡 + 历史 badge + 失败红条 / 提前实现 P5 失败分支）+ 前端 stripCallTags 解耦后端 regex（永远脱干净）。预估 3-4 天 TDD + 整体验证 P3+P1 遗漏。挂 P3 不开新 feature 理由：retry 是方案 X 健壮性补丁，spec 同章节内沉淀更紧凑；P4/P5 评估 0 阻塞（详见 P3.1 段）。 |
| 2026-04-27 | **P3.1 实施完成（worktree `feat/F026-p0-a2a-stabilize`，未合 dev）**：7 task TDD 全部 commit。Task 1：`detectInvalidDispatch` 纯函数 13/13（嵌套 [Call:] / 段首 @ 含派发动词 / hard-negative 屏蔽 / 与 resolveCallTagMentions 行为对齐）。Task 2：`messages.retry_count` + `retry_reasons` migration 双源同步（sqlite.ts + drizzle-instance.ts）3/3 + 老 DB ALTER 兼容。Task 3：`agent_events:dispatch_validation_retry` schema 8/8（type guard / parse / build helpers / RealtimeServerEvent union 扩成员）。Task 4 logic：`dispatch-retry-coordinator` 决策状态机 8/8（accept / retry / exhaust 三态 + buildCorrectionPrompt + env A2A_MAX_DISPATCH_RETRIES 可调）。Task 5：`buildResumeWithCorrectionInput` helper 5/5（注入 NATIVE_SESSION_ID + 替换 prompt + immutable env）。Task 4 wiring：`message-service` accumulatedContent 已知点接 retry-coordinator + spawn 重试（仅 claude provider；codex/gemini fail-closed 一次即兜底）+ 持久化 retry_count/retry_reasons + 命中 exhaust → skip enqueuePublicMentions + skip return-path（用户手动 @ 接力）。Task 6+7：前端 stripCallTags 多 pass loose 版本（嵌套零字面量）+ MessageBubble retry badge（amber ⚠️ for 1-2 / red banner for ≥3） + DispatchValidationRetryReason 中文 label。**API 1355/1355 + frontend 128/128 全绿**，typecheck 0 errors。**未做**（plan AC-14 实时进度卡）：WS dispatch.validation_retry 实时订阅未接（需找 ws hook + UI state；后续增强；当前已通过 retry_count 历史 badge 提供事后可见性）。**未做**（plan AC-19/20 真机手验）：等 worktree preview 重启后 R-053/R-054 重跑。 |
| 2026-04-28 | **P3.1 AC-14 实时进度卡补完（worktree 未合 dev）**：把昨天 7 task commit 留下的「实时进度卡未接」补齐——新增 `useDispatchRetryStore`（按 `messageId` 索引 retry payload；status="exhausted" 自清让 banner 接管）+ `DispatchRetryProgressCard`（订阅 store，渲染「🔄 派发格式不合契约，正在重写...（第 N 次 / 最多 M 次）· 原因：嵌套 [Call:] / 段首 @ 缺包装」，role=status live-region）+ `app/page.tsx` onMessage 加 `dispatch.validation_retry` 分支写入 store 且 `message.created` 时按 messageId 兜底 clearRetry + `message-bubble.tsx` 在 header 与 banner 之间挂载进度卡。Store 6 case + Card 6 case 共 12/12 绿；**API 1355/1355 + frontend 140/140 全绿**，typecheck 0 errors。剩：AC-19/20 真机手验等 preview 重启 R-053/R-054 重跑。 |
| 2026-04-28 | **P3.1 retry-guard 删白名单收紧（小孙拍 [A]，worktree 未合 dev）**：R-053 重跑实证暴露 `naked_at_with_dispatch_intent` 白名单太弱——派发动词词表（review/帮/看下/做/写/...）对装饰句（"@桂芬 也帮过我"、"@范德彪 写过 review"）误触发面过广。小孙拍板方案 A「删白名单不替补」：`detectInvalidDispatch` 只保留 `nested_call_tag` 结构判定（R-054 嵌套 [Call:] 仍 retry，因为派发链 + 视觉双崩）；裸 `@X` 一律装饰，**不派发也不 retry**——LLM 漏写 [Call:] = 该轮不派发，agent 自负，对齐家规 §10「行首 @ + [Call:] 强契约」prompt 教学。改动面：`mention-router.ts` 删 `DISPATCH_INTENT_VERBS` 词表 + `DISPATCH_INTENT_LOOKAHEAD` + naked_at 整段（line 622-710）；`shared/realtime.ts` `DispatchValidationRetryReason` 收紧为单 reason；`dispatch-retry-event.ts` `VALID_REASONS` Set + parseError 同步收紧；`dispatch-retry-coordinator.ts` `buildCorrectionPrompt` 单 case；前端 `REASON_LABEL`×2 字典收紧；测试同步：`detect-invalid-dispatch.test` AC-2 改成「裸 @ + 派发动词不再 retry」回归保护、`dispatch-retry-coordinator.test` 删 naked_at correction prompt 测试 + 新增 AC-19 删白名单回归测试、`progress-card.test` 删 naked_at label。 |
| 2026-04-26 | **「谁发起谁收敛」进度对齐 + P1 Wiring Debt 发现（小孙问、黄仁勋复盘）**：小孙问"谁发起谁收敛是否做完"。grep 实测：`call-registry` 库 + `a2a-gateway` convener 算法 + on-behalf 反推已写完且测试绿，但 `convenerId` / `openCall` / `settle` / `pendingOf` 在生产代码（非 .test.ts）中**命中数 = 0**——库是孤岛，dispatch 没接、回程没 settle、没人写进 a2a_calls 表。结论：协议层只完成 50%（建模 + 算法），剩下 50%（接线 + 落库 + 消费）成欠账。接线分三段：① **P1 收尾欠账**（dispatch/return-path/MCP 三入口接 openCall/settle，spec 第 259 行 I6 已要求但未做满）② **P4 持久化**（registry 真正下沉 DB，前提是 P1 接线完成）③ **P5 体感**（DiscussionCoordinator + 结论卡片 + Pending Pulse + 折叠 + 墓碑 + 溯源胶囊，依赖 pendingOf/getTree 真实数据）。spec 增补：P1 章节追加 `#### P1 Wiring Debt` 段（缺口三项 + Phase 边界关系）+ DoD-1 增条「全 feature 代码孤岛审视」（feature 体量大易留接线欠账，整 feature 合 dev 前必须 grep 每个新模块/API/字段的生产调用方，命中 0 要么补接线要么删除）。 |
| 2026-04-30 | **finishing-line v4 step 2 落地（小孙拍 BA · worktree `feat/F026-p0-a2a-stabilize`，未合 dev）**：14 症状回归测试 6/14 → **9/14 显式锁定 + 5 项标注外延**。**P11 真做（[Q2=A]）**：`__tests__/a2a-replay/P11-content-blocks-backfill.test.ts` 6 case + 新建 `services/content-blocks-derive.ts`（thinking + text 派生 + image 块 merge 不丢）+ `message-service.ts` final flush（L1842）+ error flush（L2057）接 `mergeDerivedWithExistingBlocks` + `session-service.getContentBlocksJson` / `session-repository(-drizzle).getContentBlocksJson` 双源同步 + `session-repository-drizzle.ts` 的 listMessages/listMessagesSince/listRecentMessages 已带 rowid tiebreaker。**P13 落实**：`__tests__/a2a-replay/P13-created-at-monotonic-fuzz.test.ts` 6 case（同 ms burst / ANALYZE / VACUUM / 跨 close-reopen / appendMessage rapid loop / 显式 rowid）+ `session-repository.ts` 3 处 `ORDER BY m.created_at` 加 `, m.rowid` 显式 tiebreaker + `call-registry.ts` 5 处 `ORDER BY created_at` 加 `, rowid` tiebreaker（pendingOf / getTree / findByStatus / getSessionTrees / computePendingSet）。**P5 跳 e2e（[Q1=B]）**：spec 标注 CAS 单元 (`call-registry.test.ts:213` I4 timeoutScan) + p4-restart-recovery 双层兜底已覆盖核心不变量。**P7/P9 归一处置**：spec 14 症状表追加注解，P7 = call lifecycle CAS 已 lock（`call-registry.test.ts:206/154`），P9 = Multi-Agent 故意不接 toolEvents，由 P7 同源 CAS 兜底。**Step 2 验收**：`pnpm test:api` **1036/1036 全绿**，typecheck 0 errors。剩 P12 / P14 / P6 / M1-M4 / M5-M6 是已有专项 test 维护级，不属本次 finishing-line 范围。 |
| 2026-04-30 | **finishing-line v5 Step 4 quality-gate 全 AC 勾选落地（worktree `feat/F026-p0-a2a-stabilize`，未合 dev）**：11 条不变量（I1' / I2-a / I2-b / I3 / I4 / I5 / I6 / I7 / I8 / I9 / I10 / I11）全部 `[x]` + 每条 evidence 注解；14 症状回归测试新增勾 9 条（M1 / M2 / M3 / M4 / P6 / P12 / P14 / M5 / M6），加上 step 2 已勾的 P5 / P7 / P9 / P11 / P13 ⇒ **14/14 全勾**；体感 2 场景（场景 1 并发 @ / 场景 3 长对话召新 agent）按 plan 留 `[ ]` 注解 Step 5 acceptance-guardian 真机验收（家规 P5 + 铁律 14）；DoD-1 五项：① 11 不变量 ✅ ② 14 症状 ✅ ③ 体感 2 场景 → Step 5 真机 ④ ADR-002/003/004 三 guard 脚本 → 仅 ADR-004 落地，002/003 真欠账，等小孙拍 [A] 立刻补 / [B] Step 5 后另立 cleanup 子任务做 ⑤ 全 feature 代码孤岛审视 ✅（Step 3 落地）。**Step 4 验收命令**：`pnpm typecheck` 0 errors ✅；`pnpm vitest run` 31/31 文件 + 238/238 测试 ✅；`pnpm test:api` 1469/1476 pass + 1 timing flake（`base-runtime.test.ts` 25ms heartbeat 紧时序，隔离重跑 13/13 全绿，非回归）+ 6 skip。**未合 dev**。 |
| 2026-04-30 | **finishing-line v5 Step 3 P1 Wiring Debt 孤岛审视落地（小孙拍 #1 撤销 / #2 = B · worktree `feat/F026-p0-a2a-stabilize`，未合 dev）**：4 关键符号生产命中实证（`convenerId` 6 处 / `openCall` 3 处 / `settle` 11 处 / `pendingOf` 3 处，**全过 ≥1**）；spec 第 286-289 行三项 wiring 实证勾选——① dispatch 通过 `useGateway` 接 `a2a-gateway.ts:218/266/330` 三处 `openCall` ✅；② return-path 由 `message-service.ts:1024/1036/1676/2063` 直调 `a2aLifecycle.settleDone/Timeout/Failed/advance` ✅；③ MCP `trigger_mention` / `post_message` 入口**改追认为 spec drift 共用 dispatch 接线**（避免双 openCall 路径 + 双源同步 bug；callId 贯穿仍由 dispatch → a2a-gateway 单点保证）；3 模块审视：`envelope-builder` / `burst-context` / `return-path-payload` / `a2a_calls` 表 8 字段全部生产命中 ≥1，0 孤岛。**#1 A2A_CALL_TREE_ENABLED 默认值分歧点撤销**——14:45 plan 已锁「worktree 验通 → DoD-3 删 flag + 旧路径 + 不双轨」，flag 默认值与 DoD-3 冲突自动消解。 |
| 2026-04-30 | **R-069 P15 增补 + 双通道派发契约 Design Decision（小孙拍 [B] · worktree `feat/F026-p0-a2a-stabilize`，未合 dev）**：R-069 实证 MCP `triggerMention` 派发被 P3 方案 X `[Call:]` 严格规则吞（仁勋调 MCP 后桂芬 thread 0 条消息，仁勋 thread 多了一条 a2a_handoff 但 `a2a_call_id=NULL`）。根因：MCP 程序化入口写消息后调 `handleAgentPublicMessage` 文本通道，被 assistant 严格通道判定（无 `[Call:]` 包装）→ `mentions=[]` → 派发链静默死亡。spec drift：14 症状全部假设"agent reply 文本写行首 @"，**完全没考虑 MCP 程序化入口**这条路径——它本就是绕过文本规则的"程序化调度"，但实现里又复用了文本通道，于是被同一条规则吞了。处置：① Why 段症状频率表追加 P15 行（`trigger_mention` / `request_decision` / `parallel_think` / `create_task` 同款偏离）② Acceptance Criteria 14 症状回归测试段新增 P15 AC（待 acceptance-guardian 穷举完所有 MCP 程序化入口偏离后立 test 定案）③ Design Decisions 表新增「MCP 程序化派发是否走 [Call:] 严格规则」拍板 B（CALL 文本 + MCP 程序化双通道分治，并存不冲突）。具体哪些 MCP 入口偏 + 改法（绕过 `enqueueDirectDispatch` / wrap 时强制 prefix `[Call:]`）由 acceptance-guardian 穷举后定案，避免见一个修一个。 |
| 2026-05-06 | **P2 Clean-Cut Step 1-7 全部落盘（worktree `feat/F026-p0-a2a-stabilize`，未合 dev）**：v1 plan `docs/plans/F026-P2-clean-cut-plan.md` 7 步删除清单经 reset → v2 树形 worklist 改造（`docs/plans/F026-P2-v2-tree-worklist-plan.md`）后落地。**Step 1** v2 Task 6/7 已等价完成（worklist 续推接通 directTurn）。**Step 2** (`c0f2792`) 删 F003 return-path + `isCallTreeEnabled` flag — 单轨直切。**Step 3+4** (`bc99441`，按 [C] 合并) 删 ParallelGroup 状态机 + `parallel_think` MCP tool/route/handler + phase1-header (-2767 行 / 21 文件)，F002 SettlementDetector 信号 1 退化为 stub `() => false` 保留导出兼容。**Step 5** (`040e3c1`) 删 phase2-header + DiscussionCoordinator 套件 + 结论卡片 (-2276 行 / 12 文件整删)。**Step 6** (`5a63b65`) 删 collapsible-group + groupTimeline + group-level fold (-258 行)。**Step 7** (`462f26b`) MCP 派发产出 messageType `a2a_handoff_mcp` → `final`（`buildMcpDispatchPayload` 返回 final，`appendAssistantMessage` 签名收窄到 `progress \| final`）+ titler 触发改内容前缀判定（`[Call:` 起头跳过 Haiku 标题计算）。DB schema MessageType union 仍保留 `a2a_handoff` / `a2a_handoff_mcp` 标识符兼容历史行（Q2=[B]）；前端 `timeline-panel.tsx` 0 视觉变化（旧 `a2a_handoff_mcp` 之前已走 MessageBubble，前端只按 `connector` / `system_notice` 分支特殊渲染）。**Step 8** (本次同 commit) skill / 路由 / spec 文档收尾：`multi-agent-skills/manifest.yaml` 删 `requires_mcp: ["parallel_think"]`、`collaborative-thinking/SKILL.md` 三处 `parallel_think` 引用改 prompt 引导、`docs/plans/collaborative-thinking-structural-fix.md` 整文件标 obsoleted、`F026-phase2-plan.md` / `F026-phase5-plan.md` / `F026-finishing-line-plan.md` 加 superseded by P2 Clean-Cut 头注。**未做**（剩 spec line-modify 类，等小孙浏览器手验通过后批量补）：F002 spec L254 / F019 spec L44 / F020 spec L143 / F023 spec L23,86 parallel_think 标 removed / 各 plan grep 命中清理。**测试**：`pnpm test:api` 1432/1440 PASS / 0 fail / 8 skipped · `pnpm test:components` 232/232 · typecheck 0 errors。**未合 dev**（按 feedback_feature_completion_before_merge）。下一步：worktree preview 重启让小孙浏览器手验场景 1-5。 |
| 2026-05-08 | **F026 closing — DoD 全绿，整 feature done · squash merge 进 dev**：① 体感场景 1 并发 @ + 场景 3 长对话召新 agent **真机验证通过**（小孙 worktree preview `:3102` 手验，铁律 14 验收同源 ✅）。② DoD-3 cleanup 实质完成（`A2A_CALL_TREE_ENABLED` flag + return-path 旧路径已被 `c0f2792` 单轨直切，packages/ 源码 0 命中），不再单独 tag。③ ADR 收尾：ADR-003 / ADR-004 加 Implementation Note + frontmatter `status: Amended` 追认（小孙拍「改 ADR 不改实现」 ）；ADR guard 仅保留 ADR-004 diff guard，ADR-003 的 50 动词白名单已被方案 X · `[Call:]` 强契约取代失去对象，ADR-002 字段保护降级单测覆盖（`a76cde1`）。④ `.gitignore` 收纳 `*.log` + `.env.development.local.backup-by-preview`。⑤ `1fe7b10` dev → feat 预同步合并（解 4 冲突 + typecheck/test:api 1208/1208 全绿）。⑥ frontmatter `status: in-progress` → `done` + `completed: 2026-05-08`，spec closing 闭环。**149 commits squash merge feat/F026-p0-a2a-stabilize → dev**（314 files / +33527/-7825），feat 分支远端+本地清理 + worktree `.worktrees/F026-p0` 销毁。Supersedes F015 / Evolved from F003 / Blocks 无；下游影响：F018 burst-context 注入位接口、F020 决策卡片挂载点、F023 MCP callback token 层均已在 P3/P5 落地点对接。F026 整 feature **done**。 |

## Links

- Discussion: 五轮迭代在 room R-190 对话记录（Phase 1-3 + 自我翻案 + Clowder 源码逆向）
- Plan: 见下方 Phase 拆分（writing-plans 阶段补 `docs/plans/F026-*.md`）
- Clowder 源码证据：`/c/Users/-/Desktop/cafe/clowder-ai`
  - WorklistRegistry: `packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts:26-208`
  - context-transport (Burst + Tombstone + protectSemanticChains): `context-transport.ts:60-302`
  - SessionPromptBuilder (a2aFrom 注入): `SystemPromptBuilder.ts:480-483`
  - InvocationRegistry (callback token TTL): `InvocationRegistry.ts:37-199`
  - InvocationQueue (STALE 阈值): `InvocationQueue.ts:430-545`
- 当前实现关键位置：
  - `packages/api/src/orchestrator/mention-router.ts:21-80`
  - `packages/api/src/orchestrator/dispatch.ts:59-362`
  - `packages/api/src/orchestrator/return-path.ts:30-63`（本 feature 将废除）
  - `packages/api/src/orchestrator/a2a-chain.ts:14-34`
  - `packages/api/src/services/message-service.ts:841/895/1402-1435`
  - `packages/api/src/runtime/codex-runtime.ts:240-266`
  - `packages/api/src/orchestrator/context-snapshot.ts`
  - `packages/api/src/orchestrator/context-assembler.ts`
  - `packages/api/src/orchestrator/session-bootstrap.ts`
  - `packages/api/src/ws.ts:50-58`
  - `apps/web/components/chat/composer.tsx:84-85`

## Evolution

- **Evolved from**: F003（A2A 运行时闭环 — StopReason 续写 + 回程派发 + SOP 强制交接）
- **Supersedes**: F015（调度状态持久化 — 被 I4 吞并）
- **Blocks**: 无
- **Related**: F020（决策卡片挂载矩阵 — Coordinator 触发点）、F023（MCP 挂载统一 — callback token 层）、F007（上下文压缩 — rollingSummary 复用）、F018（SessionBootstrap — burst + Tombstone 叠加）

## Phase 拆分（6 周，依赖严格）

### P0 · 证据与 Day 1 Fix（3 天）

- **Day 1**：M3 `composer.tsx:84-85` isBusy 修掉（小孙场景 1 并发 @ 立即可用）
- **Day 2**：M4 `ws.ts:50-58` Broadcaster 加 `sessionGroupId` 过滤（P6 窜房间 14.38% 归零）
- **Day 3**：Replay Harness 骨架（`packages/api/src/__tests__/a2a-replay/`）+ R-185 chunk 边界 fuzz 用例 + `callbacks.ts:398-407` 业务失败冒泡短补丁

### P1 · L1 地基（2 周，Round 2 扩内容，无依赖）

**Round 2 扩展**（ADR-002/003/004 落地）：

- `a2a_calls` 表 + drizzle migration：扩 Q5 全字段（`call_id / parent_call_id / root_call_id / issuer_id / convener_id / join_set_id / on_behalf_of / status / deadline_at / envelope_version / reply_to / created_at / updated_at`）
- **`call-registry.ts`**（新建）：Call Tree 真相源。API：`openCall(parent, issuer, convener, on_behalf_of) → call_id` / `getTree(root) → 完整链` / `pendingOf(parent) → 未完成子集` / `settle(call_id)` / `timeout scan`
- **`envelope-builder.ts`**（新建）：消息出站钩子。从 call-registry + 发送者 context 自动填 Envelope 两层全字段；β 路径默认 `task="conversation"` + `input.source_message=原文`；γ 路径从 `cross-role-handoff` skill 入口拿结构化 task
- **`mention-router.ts`** 升级为三层 fail-closed（ADR-003）：
  - Layer 1 hard-negative AST 识别（Markdown-AST 过 code block / inline code / blockquote / table / 装饰性名册 / 介绍句式）
  - Layer 2 hard-positive（行首 `@` + 动作词）
  - Layer 3 gray-zone（纯规则 fail-closed，**P5 T2 ✅**：可观测层 — gray 命中 → broadcaster.broadcast(`mention.gray_zone`) 含 traceId / source / target / contentSample，DB 持久化挪 T4 invocation_id nullable migration）
  - **on-behalf 语义反推词典**（外挂配置，「帮/代/替/为 X」→ `on_behalf_of=X, convener=X`）
  - **反循环与去重**（原 I7 吸收）：`(source, target)` 30s sliding window + 单消息内同 target dedup
- I6 callId 贯穿所有 A2A 入口（dispatch / trigger_mention / post_message）
- callback token 与 run 生命周期解耦（当前 dev 是 ttlMs=3h 的耦合兜底版，见 dev `6ff120d`；P1 正式方案：token 跟 run 走 + run 独立 hard-cap + liveness stall 自动 cancel）
- Lifecycle 状态机 CAS 转移
- 双轨 feature flag：新 callId 路径 + 旧路径并行（2 周后切）
- **硬约束（ADR-004）**：P1 实施**不得**往 `CLAUDE.md / GEMINI.md / AGENTS.md / agent-prompts.ts` 添加任何 A2A 协议内容 · P1 完结前 diff 检查该文件保持当前尺寸
- **`cross-role-handoff` skill**：微调参数表对齐 γ 路径 Envelope.task 字段（不强制改 skill 逻辑）

#### P1 Wiring Debt · 收尾欠账（2026-04-26 发现 · P4 启动前必补）

**症状**：`call-registry.ts` (`openCall / settle / pendingOf / getTree`) + `a2a-gateway.ts` 的 `convenerId` 计算 + on-behalf 反推**全部写完且测试绿**，但 `grep "convenerId|convener_id" packages/api/src --exclude=*.test.ts` 命中数 = 0；`grep "openCall|settle|pendingOf"` 在生产代码（非 .test.ts）中命中数 = 0。

**结论**：协议层是孤岛——库写好了 + 单测绿，但生产 dispatch / 回程 / MCP 入口都没接进去，convener_id 算出来也没人写进 `a2a_calls` 表，pendingOf 也没人消费。"谁发起谁收敛"在协议字段层只完成 50%（建模 + 算法），剩下 50%（接线 + 落库 + 消费）成了欠账。

**接线缺口三处**（P4 启动前必补）—— **finishing-line v5 Step 3 实证落地** (2026-04-30)：

- [x] dispatch.ts 派发时调 `call-registry.openCall(...)` 写入 `a2a_calls` 表（含 `convenerId`）
  - 实证：`dispatch.ts:246` `useGateway` gate → `a2a-gateway.ts:218/266/330` 三处 `deps.registry.openCall(...)` 直调；`a2a_calls` 表 8 字段（`convenerId / on_behalf_of / parent_call_id / root_call_id / join_set_id / deadline_at / envelope_version / reply_to`）11 处生产文件均有写入路径
- [x] return-path / worklist 完成时调 `call-registry.settle(call_id)` 关闭 call
  - 实证：`message-service.ts:1024/1036/1676/2063` 四处直调 `a2aLifecycle?.settleDone / settleTimeout / settleFailed / advance`；`a2a-lifecycle.ts:67` 实现层 + 11 处生产命中
- [x] MCP `trigger_mention` / `post_message` 入口同样接 `openCall`（spec 第 259 行 I6 callId 贯穿口径）
  - **spec drift 追认**（finishing-line Step 3 · 小孙 2026-04-30 决议 #2 = B）：MCP 入口 (`mcp/server.ts:868` `callPostMessage`) 与 callbacks 入口 (`routes/callbacks.ts:254` `onPublicMessage`) 与 UI HTTP 入口**共用同一 dispatch → a2a-gateway → openCall 接线**，**避免双 openCall 路径** + 双源同步 bug。callId 贯穿仍由 dispatch 链路统一保证（`a2a-gateway.ts` 三处 openCall 是唯一调用点），spec 字面"MCP 入口直调"不予满足，改追认为"MCP 入口共用 dispatch 接线（all entry → single openCall site）"。
  - 三条入口路径对照：
    1. **真人 UI @** : HTTP POST → `message-service.postMessage` → dispatch → a2a-gateway → openCall ✅
    2. **agent callback @**（回程续推 / 同 turn 链推进）: `callbacks.ts:254` `onPublicMessage` → dispatch → a2a-gateway → openCall ✅
    3. **agent MCP 工具 @**（`trigger_mention` / `post_message`）: `mcp/server.ts:868` `callPostMessage` → message-service → dispatch → a2a-gateway → openCall ✅

**与 Phase 边界关系**：
- 接线本属 P1 范围（spec 第 259 行 I6 / 第 261 行 Lifecycle CAS 已写要求）
- P0 Day7 + P3 方案 X 两次"提前热修"把 P1 拆碎，导致接线没收口
- **P4 持久化前提是 registry 不再是孤岛**——否则 P4 下沉 DB 没数据可下沉
- **P5 体感层（~~DiscussionCoordinator~~ ✗ 已废 / Pulse / 折叠 / 墓碑 / 溯源胶囊）依赖 pendingOf / getTree 真实数据**——接线没补完，P5 就只能拿到空表（DiscussionCoordinator 已于 F026 P2 v2 Step 5 整删，2026-05-06）

### P2 · Return-path → Worklist 执行器改造（1.5 周，依赖 P1）

**Round 2 改名**：原「Worklist 续推」是协议中心；Round 2 降级为执行器细节（I2-b）。协议中心已在 P1 用 Call Tree 建立（I7）。

- 废 F003 `return-path.ts` new-invocation 逻辑
- 实现同一 routeSerial 内 `worklist[++index]` 续推（**仅作 R-184 同 turn 单行 message 的执行手段**，不是协议真相源）
- `a2a-chain.ts` 补 `senderAlias + triggerMessageId` 字段（渲染用，非协议字段）
- **注意（ADR-004）**：system prompt 不能再硬编码「Direct message from X; reply to X」—— 这违反「A2A 对 agent 透明」。改为 router 在 Envelope 里 `on_behalf_of` 字段透传，前端渲染成溯源胶囊。Phase 2 若发现旧实现中有 agent-prompts.ts 注入该类提示，**一律清理**
- R-184 回归测试必绿（I2-a）

### P3 · Context 改造（1 周，依赖 P1）

**Plan**：`docs/plans/F026-phase3-plan.md`（10 Task · TDD）
**范围拍板（2026-04-25 小孙）**：A（M5 保真）+ B（cold-target burst 兜底，user/agent 触发同等覆盖）；C（清死路径 ②）作废

**A · M5 A2A 回程 payload 完整性**：
- 新增 `packages/api/src/orchestrator/return-path-payload.ts:buildReturnPathPayload(content, {maxTokens, dbMsgId})` — 复用 `truncateHeadTail` 头 60% + 尾 30% + 省略标记 + msg_id 引用
- `extractTaskSnippet` 保留行为不变（≤500 字 sentence boundary），仍服务 MCP `trigger_mention.taskSnippet` 短摘
- `dispatch.ts:297` 前向派发保留 `extractTaskSnippet`；`dispatch.ts:359` 回程续写改 `buildReturnPathPayload`
- `buildContextSnapshot` 单条 content 超 cap 也走 `truncateHeadTail`（防历史通路二次挤掉）
- `A2A_PAYLOAD_MAX_TOKENS` env 默认 16384 · runtime hot-reload · 允许 [4096, 65536] 越界 fallback + 启动告警

**B · cold-target burst 兜底注入**（场景 3 根治）：
- 新增 `packages/api/src/orchestrator/burst-context.ts` —— 移植 clowder `context-transport.ts:60-302` 三函数到 Multi-Agent 消息形态
  - `detectRecentBurst(messages, { burstSilenceGapMs: 15min, min: 4, max: 12 })`
  - `protectSemanticChains` (Q→A user→assistant 递归保护；Multi-Agent 没有 toolEvents 概念，跳过 clowder 的 tool_use→tool_result 链保护)
  - `buildTombstone` + `formatTombstone` —— 参与者用 alias，retrieval hint 改 `MCP get_room_context, msg_id=<head>~<tail>`
- `context-assembler.ts:assemblePrompt` 增加 `coldTargetBurst` 入参；触发判定 `nativeSessionId === null` AND `threadMemory==null && previousDigest==null` 两连 AND 才注入（**不看 sourceAlias**，user @ 与 A2A @ 同等触发）
- 注入位置：SessionBootstrap section 之后、`[A2A 协作请求]` header 之前
- `message-service.ts` dispatch 路径（user @ 与 A2A @ 共用入口）在调 `assemblePrompt` 前判定 cold-target 并组装 `coldTargetBurst`
- burst 体积控制：`formatBurstSection` 单条 content 默认 1500 chars cap（防失控）+ burst 数量 max=12（DEFAULT_BURST_CONFIG）→ 实测 ≤ 18k chars ≈ 4500 tokens；P5 调参实战后再视需求引入 `A2A_BURST_MAX_TOKENS` 总硬顶（当前未实现，由 max/single-cap 双重约束兜底）

**测试 / 验收**：
- M5 AC 7 子项 fuzz + R-034 4195 字 replay 必绿
- 场景 3 AC 5 子项 100 轮长对话 cold-target 集成测试必绿（user @ 与 A2A @ 双路径都覆盖）
- ADR-004 guard 绿（不向 `agent-prompts.ts` / `CLAUDE.md` / `GEMINI.md` 添加任何 A2A 协议字段；burst 直接拼进 content）

### P3.1 · 派发协议 retry 兜底层（3-4 天，依赖 P3）

**Why**：方案 X（P3）落地后 R-051/053/054 实证暴露——LLM（特别是 Opus 4.7）在复杂派发场景下不稳定遵守 `[Call: @人 任务]` 契约：
- R-053：assistant 段首 `@X` 漏 `[Call:]` 包装 → assistant 路径不派 → 用户看到 @ pill 但目标 agent 不起来
- R-054：嵌套 `[Call: @A ... [Call: @B] ...]` → mention-router 外层失配只派内层 + `stripCallTags` 同 regex 同步失配 → **前端直接显示 `[Call:]` 字面量**
- 共同根因：方案 X 的 regex 同时驱动派发逻辑 / 视觉渲染 / 嵌套检测，LLM 写错时**派发链 + 前端渲染同时露馅**

**改法**（机制兜底，不补正则、不扩 prompt 教育——shared-rules.md §10 + agent-prompts.ts MENTION_FORMAT_RULES 已写齐）：

1. **派发预检 + agent retry（核心）**
   - `mention-router.ts:detectInvalidDispatch(content)` 检测：① 嵌套 `[Call:]` ② 段首/段中 `@X` 无 `[Call:]` 包装且看似派发意图（含动词 / 任务关键词）
   - `message-service.ts` assistant final 入库前调 `detectInvalidDispatch`；命中 → 拒收 + 触发 agent retry（最多 `MAX_DISPATCH_RETRIES=3` 次）
   - retry 通过续 prompt 给 CLI（`claude --resume <session>` + 新 user message：「上轮派发格式不合契约：<原因>，请重写」）

2. **retry 可观测（小孙明确要求：「重发了我得知道」）**
   - `agent_events` 加事件类型 `dispatch_validation_retry`（payload: `{ reason, attemptIndex, maxAttempts, originalText }`）+ WS 实时广播
   - `messages` 表加 `retry_count INTEGER NOT NULL DEFAULT 0` + `retry_reasons TEXT NOT NULL DEFAULT '[]'`（migration）
   - 前端实时进度卡：订阅 `dispatch_validation_retry` 渲染「🔄 黄仁勋 派发格式不合契约，正在重写...（第 N 次 / 最多 3 次）+ 原因」
   - 前端历史 badge：`retry_count > 0` 时气泡顶部贴「⚠️ 此回复自动重写 N 次（展开详情）」

3. **retry 失败兜底**
   - 3 次耗尽 → final 入库（不再阻挡 user） + 气泡红色硬警示「❌ 派发协议反复写错（已重试 N 次）— 派发未触发，请手动 @ 触发」+ @ pill 加红色斜杠图标
   - 该机制提前实现 P5「前端 @ pill 状态：失败 + 失败重发按钮」AC 的失败分支

4. **前端 `stripCallTags` 解耦后端 regex**
   - `markdown-message.tsx:stripCallTags` 改宽松版：嵌套时也尽量脱外层 `[Call: @X` 字面量
   - 后端 `resolveCallTagMentions` 继续 fail-closed（不动派发协议）
   - 视觉契约：用户**永远看不到 `[Call:]` 字面量**；派发结果通过 retry badge / @ pill 状态徽章传达

**测试 / 验收**：
- `detectInvalidDispatch` 单元 fixture 必覆盖 R-053（缺包装）+ R-054（嵌套）红 case
- assistant retry 流程集成测试：mock CLI 第 1/2 次返错格式、第 3 次返合规 → 必入库且 `retry_count=2`
- retry 失败兜底：mock CLI 3 次都返错格式 → final 入库 + agent_event 写"派发未触发" + 前端硬警示渲染
- `stripCallTags` 宽松版前端 fixture：嵌套输入 → 渲染输出零 `[Call:]` 字面量
- R-053 + R-054 重跑必绿（手验）

### P4 · 持久化（1 周，依赖 P1+P2）

- A2AChainRegistry / ParallelGroupRegistry / RunningSlots 下沉 DB
- CAS 转移 + "return-path 已消费"标记
- STALE 阈值扫描任务（60s queued / 10min processing）
- `kill -9` 重启恢复测试

### P5 · 对账与体验 · Round 2 前端栏（1.5 周，依赖 P1+P4）

**Round 2 扩内容**（桂芬前端原语全量落地）：

- `/debug/a2a` 视图（show pending/working/timeout + call tree 可视化）
- 前端 @ pill 状态（发送中/已阅/处理中/完成/超时/失败）+ 失败重发按钮
- **溯源胶囊**：B 的消息气泡上方显示「A 正在征询 / B (为 A) 正在征询」（读 `on_behalf_of`）
- **超时墓碑**：「@B 响应超时，A 请继续」（读 `deadline` + `tombstone` 状态机）
- **折叠群组**：A2A 子消息默认半透明缩进，点击展开（读 `parent_call_id`）
- **并列卡片 Visual Silo**：sibling 独立卡片渲染（读 `display_mode=nested` + branch isolation）
- **状态 Pulse**：「👂 正在听取 @B @C」（读 `pending_set`）
- **淡紫色 A2A 密谋区底色**（D6 小孙 2026-04-23 拍板）
- **Envelope `display_mode` 自动渲染**：inline / nested / background 三态（ADR-004）
- ~~DiscussionCoordinator + [结论卡片] 渲染~~（F026 P2 v2 Step 5 整删，2026-05-06；走 worklist 续推单轨后不再需要二次收敛卡片）
- I1' Layer 3 灰区可观测（**P5 T2 ✅**：emit `mention.gray_zone` WS · 规则集本体维持 [B-lite]）
- Trace-ID 溯源图（可选，P5 后段）

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| P2 改造 `message-service.ts` 主干回归面大 | 高 | 核心 | **双轨上线**：新 callId 路径 + 旧 return-path 并行 2 周，flag 切换 |
| P4 DB 写入成瓶颈 | 中 | 性能 | callId 转移走异步队列，CAS 失败自动重试 |
| P4 回程 race 未修净 | 中 | 数据 | shadow-mode：写 DB 但仍以内存为准，对账一致后切 |
| Phase 2 超时触发误杀长思考 | 低 | 体验 | `deadline_at` 按 agent/skill 分档（默认 30s，tdd 类 180s） |
| 双轨 flag 切换期间状态不一致 | 中 | 数据 | 切换窗口内禁止新 A2A，等所有在飞 call 完成再切 |
| **`A2A_CALL_TREE_ENABLED` flag 永久化变成隐性技术债** | 中 | 维护 | 写入下方 DoD：双轨观察期满后**强制删除 flag + 旧路径**，未删则 feature 不算完成（见 `## Definition of Done`） |

## Definition of Done

F026 整 feature 完成 = 下面三段全部满足。任意一段缺失，feature 不算 done，不进 ROADMAP 完成列。

### DoD-1 · 不变量与症状全绿

- [x] 11 条不变量 AC（I1' / I2-a / I2-b / I3 / I4 / I5 / I6 / I7 / I8 / I9 / I10 / I11）全绿 —— **finishing-line v4 step 4 锁定**（每条 evidence 见上文 line 71-125）
- [x] 14 类症状回归测试（M1-M5 / P5-P14）全绿 —— **step 4 锁定**（每条 evidence 见 line 129-160）
- [x] 两个体感场景（场景 1 并发 @ / 场景 3 长对话召新 agent）通过浏览器手验 —— **小孙 2026-05-08 真机验证通过**（家规 P5 + 铁律 14）
- [x] ADR guard 脚本 —— **2026-05-08 小孙拍板「改 ADR 不改实现」**：ADR-004 guard 已落地（`scripts/ci/check-adr-004-{diff.sh,content.ts}` + 测试 ✅）；ADR-003 Layer 2 已被「方案 X · `[Call: @名 描述]`」取代 → 原 50 动词白名单 guard 失去对象，不补；ADR-002 Call Tree 字段保护降级为单元测试覆盖（`call-registry.test.ts` / `worklist-registry.test.ts` / `phase2-scenarios.test.ts`），不补 CI guard。两份 ADR 已在 `docs/adrs/ADR-003-...md` / `docs/adrs/ADR-004-...md` 加 `## Implementation Note · 2026-05-08 追认` 章节 + frontmatter `status: Amended`。后续若需补 CI 强约束，另开 feature。
- [x] **全 feature 代码孤岛审视**（feature 体量大 · 跨 6 周 · 易留接线欠账）—— Step 3 落地（commit `39623eb`），4 关键符号生产命中 ≥1：convenerId 6 / openCall 3 / settle 11 / pendingOf 3，0 孤岛。3 模块审视：envelope-builder / burst-context / return-path-payload / a2a_calls 8 字段全过：
  - feature 整体合 dev 前必须做一次"未接入代码全仓审计"
  - 对 F026 引入的每个新模块 / 新 API / 新字段 grep 生产调用方（必须排除 `*.test.ts`）
  - 重点核：`call-registry.ts` (openCall/settle/pendingOf/getTree) · `envelope-builder.ts` · `a2a_calls` 表所有字段（convenerId / on_behalf_of / parent_call_id / root_call_id / join_set_id / deadline_at / envelope_version / reply_to）· `burst-context.ts` · `return-path-payload.ts` · 任何 ADR-002/003/004 落地的新建模块
  - 任一模块 / API / 字段在生产代码命中 = 0，要么补接线，要么删除（不允许"测试绿但生产没人调"的孤岛代码进 dev）
  - 审计结果落入 `## Timeline` 一行 + 把待补接线项加入对应 Phase 的 Wiring Debt 段

### DoD-2 · 双轨观察期通过 ~~OBSOLETED~~

> **⚠️ DoD-2 整段已 OBSOLETED · 2026-05-06 小孙 14:45 拍板**「不会双轨，会把之前的删掉」
> 砍掉双轨 2 周观察期，直接执行 DoD-3。详见 `docs/plans/F026-finishing-line-plan.md` 头部 OBSOLETED 告示。
> 下列 4 条仅作历史参考，不作完成度判定。

- [ ] ~~feature 合 dev 后跑双轨观察 ≥ **2 周**（spec Design Decisions 约定）~~
- [ ] ~~观察期内 `A2A_CALL_TREE_ENABLED=1`（新路径）跑过 ≥ 30 个真实房间，0 双消息 / 0 callId 漏写 / 0 回程错位~~
- [ ] ~~`/debug/a2a` 对账面板显示新旧路径 0 状态分歧~~
- [ ] ~~期间任何 P0/P1 级回归 → 立刻关 flag 回旧路径，feature 重新进 receiving-review，DoD 重置~~

### DoD-3 · Flag + 旧路径必须删除（核心 · 防永久双轨债）

双轨观察期通过后，**必须立刻起一个 cleanup 子任务**完成下列删除。子任务合 dev 之前 F026 不算完成。

- [x] 删除 `packages/api/src/orchestrator/a2a-feature-flags.ts` 中 `A2A_CALL_TREE_ENABLED_ENV` / `isCallTreeEnabled` 导出（保留 `A2A_PAYLOAD_MAX_TOKENS` 相关导出，那是 P3 永久 env）—— **c0f2792 实质做掉**
- [x] 删除所有调用方的 `if (isCallTreeEnabled(...))` 分支：保留 `then`（新路径），删除 `else`（旧路径）—— **c0f2792 实质做掉**
  - `packages/api/src/orchestrator/a2a-gateway-bootstrap.ts`
  - `packages/api/src/orchestrator/dispatch.ts`
  - `packages/api/src/orchestrator/return-path.ts`（整个 new-invocation 旧分支删除）
  - 其他 grep `isCallTreeEnabled` 命中点
- [x] 删除 `packages/api/src/orchestrator/a2a-feature-flags.test.ts` 中"defaults to false / truthy / falsy"三组旧 flag 行为测试 —— **c0f2792 实质做掉**
- [x] 删除 `scripts/worktree-preview.ts` 中 `A2A_CALL_TREE_ENABLED: "1"` 默认值（worktree-preview 不再需要传，因为没有旧路径可走了）—— **c0f2792 实质做掉**（实证 2026-05-08：grep `A2A_CALL_TREE_ENABLED scripts/worktree-preview.ts` = 0）
- [x] grep 全仓 `A2A_CALL_TREE_ENABLED` 命中数 = 0（除 git history 外）—— **实证 2026-05-08**：packages/ 源码 0 命中（仅剩 `message-service.ts:949` 历史注释 + dist/ 编译产物在 .gitignore 排除）
- [x] 全套测试 + 手验场景 1/3 复跑，再次绿 —— **小孙 2026-05-08 真机验证通过** + 5/7 `pnpm test:api` 1441/1441 全绿
- [x] cleanup commit 用 `chore(F026 DoD-3): 删除 A2A_CALL_TREE_ENABLED flag + return-path 旧路径` tag，合 dev —— **实质由 c0f2792 完成**（tag 用的是 `refactor(F026 P2 v2 Step2): 删 F003 return-path + isCallTreeEnabled flag — 单轨直切`，内容等同 DoD-3 cleanup；P2 v2 路线下 DoD-2 双轨观察期已 OBSOLETED，所以 cleanup 不再单独 tag）

> **为什么 DoD-3 必须做**：双轨 flag 是过渡性脚手架，spec Design Decisions 第 11 行明确"并行 2 周，flag 切换"。如果 flag 永久保留，则：
> 1. 两条路径长期并存 → 任何后续修改都要改两次 → 隐性回归面翻倍
> 2. 默认值是 false（见 `a2a-feature-flags.test.ts:13`），任何忘传 flag 的环境（CI 子任务 / 临时手动重启 / 新 worktree）都会偷偷退回旧路径，**P2 R-184 修复事实失效**（已发生过：2026-04-26 R-044 房间，黄仁勋手动重启 worktree API 时漏传 flag → 整轮传话游戏复现 R-184 双消息）
> 3. 长期不删 = 把"双轨"从风险缓解措施变成永久技术债

