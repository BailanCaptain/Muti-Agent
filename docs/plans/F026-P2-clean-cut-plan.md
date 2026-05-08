---
plan: F026-P2-clean-cut
feature: F026
status: in-progress
created: 2026-05-01
supersedes:
  - F026-phase2-plan.md
  - F026-finishing-line-plan.md（双轨条款部分）
---

# F026 P2 Clean-Cut Plan — Worklist 续推单轨直切 + collaborative-thinking 配套定制全删

> **触发**：2026-05-01 R-080 实证「黄仁勋 [Call: @桂芬] → 桂芬答完无人续推黄仁勋整合 reply」+ 全代码库 grep `planWorklistAdvance` 0 个生产引用，揭示 P2「worklist 续推」**根本没接通主干**。同时 P5 「DiscussionCoordinator / Phase 2 / 协助 header / a2a_handoff 卡片」是 F003 时代为 collaborative-thinking skill 做的**配套定制**，跟 F026 北极星「durable work item · clowder 骨架」相悖。
>
> 小孙拍板（2026-05-01 13:31 / 13:49 / 14:23）：
> 1. F003 旧 return-path 删；不要双轨
> 2. collaborative-thinking 的**配套定制全删**（SKILL.md 本体保留）
> 3. "XXX 请求 XXX 协助" 折叠 header（红框）删
> 4. **删除时同步更新所有以前的文档**

## 北极星（不变）

> **A2A = 一次有身份、有寿命、有上下文、有边界、有对账能力的 durable work item。骨架抄 clowder。**

R-080 实证显示这个北极星在 directTurn 路径上**根本没活**。本 plan 一次性接通 + 删干净。

## 三个拍板事项（2026-05-01 14:23 锁定）

| 事项 | 选项 | 锁定 | 理由 |
|---|---|---|---|
| Q1 · DB `messages.group_id/group_role` 列 | [A] 列保留允许 NULL / [B] migration drop | **[A]** | Iron Law #1 数据神圣 + drop column 不必要 + 前端 fallback 已能正确渲染 |
| Q2 · `a2a_handoff/_mcp` MessageType union | [A] 完全删 / [B] union 保留只删产出 | **[B]** | 24+ 房间历史不破坏 + titler-hook 改用内容判定 |
| Q3 · F002 SettlementDetector 信号源 | [A] 保留 stub `()=>false` / [B] 改 SettlementDetector 两 AND | **[A]** | 最小变更面 + F002 done feature 不动代码 + B004 历史教训保护 |

红框确认：commit `6ddd3f6` `collapsible-group.tsx` "fromAlias 请求 toAlias 协助" header（4-06 落地，比 P5 早 19 天）。

## Definition of Done（plan 级）

DoD-A 代码：
- [ ] `planWorklistAdvance` 在 `message-service.ts` directTurn 路径生产引用 ≥ 1
- [ ] R-080 风格 chain 实测：`user @ 黄仁勋 帮我叫桂芬评价X` → 桂芬 done → 黄仁勋整合 reply 给 user（worktree preview 实测，DB 证据 `a2a_calls.parent_call_id` 接通率 100%）
- [ ] `grep -r "planReturnPathDispatchWithFlag\|isCallTreeEnabled" packages/` = 0
- [ ] `grep -r "parallel_think\|parallel-group\|hasActiveParallelGroup" packages/api/src/services packages/api/src/orchestrator packages/api/src/mcp` = 0（除 F002 stub）
- [ ] `grep -r "discussion-coordinator\|discussion-recorder\|phase1-header\|phase2-header\|collapsible-group" packages apps` = 0
- [ ] 全测试绿（`pnpm test` + worktree preview vitest）

DoD-B 文档同步：
- [ ] F026 spec 主文件按 §文档同步清单 改完
- [ ] F002/F019/F020/F023 spec 按清单改完
- [ ] SKILL.md / manifest.yaml / shared-rules.md / CLAUDE.md / GEMINI.md / AGENTS.md 按清单改完
- [ ] 历史 plan 文件加 obsoleted 标注或更新条款
- [ ] grep 旧概念词在 docs/ 下不应再有"未来要做"的活描述（历史记述保留 OK）

DoD-C 验收：
- [ ] worktree preview 实测 5 个场景 chain 接通（见 §验收场景）
- [ ] acceptance-guardian skill 跑过

## 8 步安全删除顺序（顺序锁死）

### Step 1 · 接通 worklist[++index] 续推到 directTurn 主干（**前置**，不删任何东西）

代码：
- `services/message-service.ts:910` directTurn 入口接 worklist：`runThreadTurn` 调用前 `openCall(user→thread.alias)` 建 root call，传 `dispatchedCallId`
- `services/message-service.ts:1873` `invocation.finished` event listener 接 `planWorklistAdvance`
- `kind: "advance"` 时**不开新 invocation**：复用现有 `runThreadTurn` 但传 `continuationContext: { childResult, parentCallId }` 让 agent 基于 child result 续 reply
- agent reply 含 `[Call: @X]` 时注册 worklist item（"等 child 回来续推 parent"）

测试：
- `__tests__/a2a-replay/R-080-style-single-mention-continuation.test.ts`（新加）：
  - user @ A → A reply [Call: @B] → B done → **A 续推整合 reply 给 user**
  - 断言 messages 表：A 有 2 条 reply（一条派发、一条整合）；a2a_calls `parent_call_id` 接通；entry call status=done（不再 timeout）
- `services/message-service.directTurn-worklist.test.ts`（新加）：directTurn 入口建 root call + 透传 dispatchedCallId

文档同步：
- F026 spec line 82 I2-b 改成「Worklist 续推**已接通 directTurn 主干**」（去 `[x]` 状态保持，因为之前是 mock 通过）
- F026 spec line 322-323 P2 改造段，更新成「P2 真接通：directTurn → worklist[++index] 续推；invocation.finished hook → advance」

### Step 2 · 删 A: F003 旧 return-path + isCallTreeEnabled flag

代码删除：
- `packages/api/src/orchestrator/return-path.ts` 整删
- `packages/api/src/orchestrator/return-path-payload.ts` 整删（如有 utility 依赖外部，先迁出再删 file）
- `packages/api/src/orchestrator/return-path.test.ts` 整删
- `packages/api/src/orchestrator/return-path-payload.test.ts` 整删
- `packages/api/src/orchestrator/a2a-feature-flags.ts`：删 `A2A_CALL_TREE_ENABLED_ENV` / `isCallTreeEnabled` 导出（保留 `A2A_PAYLOAD_MAX_TOKENS` 永久 env）
- `packages/api/src/services/message-service.ts:55, 59`：删 import
- `packages/api/src/services/message-service.ts:1883, 1911`：删 `enqueueResultForReturnPath` 变量
- `packages/api/src/services/message-service.ts:1914-1957`：删整个 `// F003/P3: return-path` 合成块
- `packages/api/src/services/message-service.ts:1906-1908`：删 `buildReturnPathExtractSnippet` 调用，改回普通 `extractTaskSnippet`
- `apps/web/src/runtime/worktree-preview.ts:43`：删 `A2A_CALL_TREE_ENABLED=1` 默认
- `__tests__/a2a-replay/R-184-same-turn-single-row.test.ts`：改测 worklist 续推（之前测 return-path 单行，现在直接测 worklist 单行）
- `__tests__/a2a-replay/M5-payload-fuzz.test.ts:10`、`R-034-payload.test.ts:13`：改测 worklist 路径或删

文档同步：
- F026 spec line 201 Design Decision: "B 双轨上线" → **"A 直接删，单轨直切"**
- F026 spec line 289 "双轨 feature flag" 段整删
- F026 spec line 419-424 "双轨上线 risk" + "flag 永久化 risk" 整删
- F026 spec line 443-469 DoD-2 "双轨观察期通过" + DoD-3 "Flag + 旧路径必须删除" → **改成单轨 DoD：worklist 续推接通 + chain 实测 100%**
- F026 spec line 248 `return-path.ts:30-63` 引用 → "本 feature 已删除（2026-05-01 P2 clean-cut）"
- F026 spec line 130 M1 R-184 → "改 worklist 单行断言"
- `docs/plans/F026-phase2-plan.md`：标记 superseded by F026-P2-clean-cut-plan
- `docs/features/F003-a2a-convergence.md`（done feature）：在末尾加 "**2026-05-01：return-path new-invocation 已被 F026 P2 worklist 续推取代**" 注解
- ADR-002: 保留作为历史决策记录，不动

### Step 3 · 删 D2: parallel-group.ts + F002 stub 兼容

代码删除：
- `packages/api/src/orchestrator/parallel-group.ts` + `.test.ts` 整删
- `packages/api/src/services/message-service.ts:1640-1737` mode B fan-out 派发逻辑（用户多 @ 走 Phase 1 的 fan-out）
- `packages/api/src/services/dispatch.ts`：删 `parallelGroupId` / `createParallelGroup` 参数
- `packages/api/src/services/message-service.ts`: `hasActiveParallelGroupInSession` 改成 stub `() => false`（保留导出名以兼容 F002 SettlementDetector 信号 1）
- 用户多 @ 路径改走：分别为每个 mention 建独立 call → mention-router 派发 → 各自走 worklist 续推；不再 fan-out 进 ParallelGroup 状态机

测试：
- `__tests__/a2a-scenarios/phase2-scenarios.test.ts`：调整或拆，保留 sibling 不级联部分（I9）
- `services/a2a-lifecycle.test.ts:159/190/239`：保留 sibling settle hook（不依赖 ParallelGroup）

文档同步：
- F026 spec line 110 I9 "phase2-scenarios.test.ts:290/304" → 调整测试引用
- F002 spec：F002 SettlementDetector 信号 1 注释改成 "stub 永远 false（F026 P2 删 ParallelGroup 后兼容）"
- B004 bug report：保留历史描述（"aggregating 非终态"），加注 "P2 clean-cut 后 hasActiveParallelGroup 永远 false，B004 风险路径已不存在"

### Step 4 · 删 D1+D3+D4: parallel_think tool/route/handler/phase1-header

代码删除：
- `packages/api/src/mcp/server.ts`：删 `parallel_think` tool 定义（line 406-673 范围）
- `packages/api/src/routes/callbacks.ts`：删 `parallel-think` callback route + `parallelThink` option
- `packages/api/src/server.ts`：删 callback 注册分支
- `packages/api/src/services/message-service.ts`：删 `handleParallelThink` + `handleParallelGroupAllDone`（line 1934-2300 范围）
- `packages/api/src/orchestrator/phase1-header.ts` + `.test.ts` 整删
- `packages/api/src/orchestrator/context-assembler.ts`：删 `phase1HeaderText` 字段 + policy
- `packages/api/src/orchestrator/context-assembler.test.ts`：删 phase1HeaderText 相关测试

文档同步：
- F019 spec line 44 AC7：`phase1HeaderText → assembled content` → 改成 "**已废弃（F026 P2 clean-cut 删 phase1-header.ts），AC7 仅保留 sopStageHint transport**"
- F019 spec line 18：保留 bug 起源描述（历史记录）
- F023 spec line 23, 86：MCP tool 列表 `parallel_think` → 划线删除并标注 "removed by F026 P2 clean-cut 2026-05-01"
- `multi-agent-skills/collaborative-thinking/SKILL.md` line 46/66/117：删 `parallel_think` MCP tool 调用提示，改成 prompt 引导"村长分别 @ 各 agent 并强调先独立思考"
- `multi-agent-skills/manifest.yaml` line 49: 删 `requires_mcp: ["parallel_think"]` 字段
- `docs/plans/F019-skill-bulletin-board-plan.md:1288`：parallel_think 注册模式引用 → 改文档 reference 或加注释
- `docs/features/F002-decision-board.md:254`：例子 `parallel_think` → 改成普通 dispatch 例子
- `mcp/server.ts` 推荐链 / `services/session-titler/build-title-prompt.ts` discussion 相关 hint：清理

### Step 5 · 删 D5+D6: phase2-header / aggregate-result Phase2 部分 / discussion-coordinator 套件

代码删除：
- `packages/api/src/orchestrator/phase2-header.ts` + `.test.ts` 整删
- `packages/api/src/orchestrator/aggregate-result.ts`：**只删 Phase 2 相关 export**，保留 `extractDecisionItems()` + `extractWithdrawals()`（F002 done 在用，§红线 2）
- `packages/api/src/orchestrator/discussion-coordinator.ts` + `.test.ts` 整删
- `packages/api/src/orchestrator/discussion-recorder.ts` + `.test.ts` 整删
- `packages/api/src/orchestrator/thread-id-lookup.ts` 整删（仅供 discussion-coordinator）
- `packages/api/src/services/discussion-concluded-event.ts` + `.test.ts` 整删
- `packages/api/src/services/a2a-lifecycle.ts`：删 DiscussionCoordinator 钩子
- `packages/api/src/services/a2a-lifecycle.test.ts`：删 DiscussionCoordinator 相关测试
- `apps/web/src/components/chat/discussion-conclusion-card.tsx` + `.test.tsx` 整删
- `packages/api/src/shared/realtime.ts:48`：`raisedInPhase: "phase1" | "phase2" | "normal"` → `"normal"` only（DB 历史读出 fallback "normal"）
- `packages/api/src/db/agent-events-nullable-migration.test.ts`：删 discussion_concluded 相关
- `packages/api/src/db/agent-events.ts`：保留 `discussion_concluded` event type union（DB 历史兼容），删 emit 路径

文档同步：
- F026 spec line 137 M4 R-188 "DiscussionCoordinator 每次讨论必生成 [结论卡片]" → **删此 AC**
- F026 spec line 192 P5 "DiscussionCoordinator + [结论卡片] 渲染" → **删此 AC**
- F026 spec line 90 I5 P5 体感原语清单："折叠群组 / 结论卡片 / 并列卡片" → 改成"折叠群组 / 结论卡片 / 并列卡片 已删（F026 P2 clean-cut 2026-05-01），保留 Pulse / 墓碑 / 溯源胶囊 / 淡紫底 / debug 视图"
- F026 spec line 316 P5 体感层依赖 → 删 DiscussionCoordinator 提及
- F020 spec line 143：`F026 的 DiscussionCoordinator 是本 feature 触发源` → **改成 "由 worklist 续推后发起 agent 整合时触发；DiscussionCoordinator 已废弃（F026 P2 clean-cut 2026-05-01）"**
- `docs/plans/F026-phase5-plan.md`：DiscussionCoordinator/Phase2 相关 AC 描述 → 标记 obsolete

### Step 6 · 删 D7: collapsible-group + groupTimeline + 协助 header（红框）

代码删除：
- `apps/web/src/components/chat/collapsible-group.tsx` + 测试 整删
- `apps/web/src/components/chat/timeline-panel.tsx`：删 `groupTimeline` transform + `<CollapsibleGroup>` 渲染分支
- `apps/web/src/store/fold-store.ts`：删 group-level fold 状态（保留 message-level）
- `packages/api/src/shared/realtime.ts:91-92`：`TimelineMessage.groupId / groupRole` 字段 → 改成 `optional?` 或删字段（按 §Q1 决议保留 union 兼容）
- DB schema `messages.group_id` / `messages.group_role` 列：**保留允许 NULL**（按 Q1=[A]，不做 migration drop）

文档同步：
- F026 spec line 90 I5 "折叠群组 `70c9fdb`" → 标 "已删除"
- commit `6ddd3f6` 历史描述：保留（历史 commit 不动）
- 任何 plan 文件提及 "协助 header" / "折叠分组" / "groupTimeline" → 加 obsolete 注

### Step 7 · 删 B 产出路径: a2a_handoff/_mcp 改产出方为 final

代码改动：
- `packages/api/src/server.ts:60-72` `buildMcpDispatchPayload` → 删函数或改 `messageType: "final"`
- `packages/api/src/services/session-service.ts:399, 639-640`：`appendAssistantMessage` 签名改，删 messageType=`a2a_handoff` 分支
- `packages/api/src/services/session-service.titler-hook.test.ts:74-88`：删 a2a_handoff 跳过 titler 测试，改成 "内容判定 [Call: 起头跳过 titler"
- `packages/api/src/services/session-titler.ts`：titler-hook 用内容判定（看 `[Call:` 起头跳过）
- `packages/api/src/server.mcp-dispatch.test.ts`：改测 final 通道
- `packages/api/src/db/sqlite.ts:23-24`：MessageType union **保留 a2a_handoff/_mcp 标识符**（按 Q2=[B]，DB 历史兼容）
- `packages/api/src/services/session-service.test.ts:25`：type union 改

文档同步：
- F026 spec line 39/42 P14/P15 描述：a2a_handoff 派发现状 → 加 "P2 clean-cut 后产出统一为 `messageType: final`，旧 union 标识符仅作 DB 历史兼容"
- B016 bug report：保留历史描述
- `docs/features/F023-mcp-unified-mounting.md`：MCP 程序化派发出口写消息 → 加 "messageType=final" 备注

### Step 8 · skill / 路由文档收尾

文档改动：
- `multi-agent-skills/refs/shared-rules.md` line 112: `brainstorm → collaborative-thinking` 路由 **保留**（SKILL.md 本体不删）
- `multi-agent-skills/collaborative-thinking/SKILL.md` line 46/66/117: 删 `parallel_think` MCP tool 调用，改成 prompt 引导（已在 Step 4 列）
- `multi-agent-skills/manifest.yaml` line 49: 删 `requires_mcp: ["parallel_think"]` 字段（已在 Step 4 列）
- `multi-agent-skills/feat-lifecycle/SKILL.md` / `multi-agent-skills/self-evolution/SKILL.md` / `multi-agent-skills/writing-skills/SKILL.md` / `multi-agent-skills/cross-role-handoff/SKILL.md`：grep 命中检查，仅删除 parallel_think tool 调用引用，不删 brainstorm/collaborative-thinking skill 名引用
- `CLAUDE.md` / `GEMINI.md` / `AGENTS.md`：保留 brainstorm 路由
- `multi-agent-skills/BOOTSTRAP.md`：grep 检查 parallel_think 引用，删除
- `docs/plans/collaborative-thinking-structural-fix.md`：整文件标记 obsoleted（superseded by F026 P2 clean-cut）
- `ROADMAP.md`（如有）：F026 P2 状态同步
- `docs/features/F026-a2a-reliability-layer.md` Timeline 末尾加 "2026-05-01 · P2 Clean-Cut · worklist 续推接通 + return-path 删 + collaborative-thinking 配套定制全删"

## 文档同步清单（一次性总览 · 30+ 点）

### 主 spec
| 文件 | 处理 |
|---|---|
| F026-a2a-reliability-layer.md | ~10 处 line 改写（详 Step 2/4/5/6/7） |
| F002-decision-board.md | line 254 例子改 + SettlementDetector 信号 1 注释 |
| F003-a2a-convergence.md（done） | 末尾加 P2 取代注解 |
| F019-skill-bulletin-board.md | line 44 AC7 改写 |
| F020-decision-card-mounting-matrix.md | line 143 触发源改写 |
| F023-mcp-unified-mounting.md | line 23, 86 parallel_think 标 removed |

### Plans
| 文件 | 处理 |
|---|---|
| F026-phase2-plan.md | superseded 标记 |
| F026-phase5-plan.md | DiscussionCoordinator/Phase2 AC 标 obsolete |
| F026-finishing-line-plan.md | 双轨条款标 obsolete |
| F026-p3.1-retry-guard-plan.md | 关联清理（grep 命中） |
| F019-skill-bulletin-board-plan.md | line 1288 parallel_think 引用清理 |
| F002-decision-board-plan.md | grep 命中清理 |
| F003-a2a-convergence-plan.md | grep 命中清理 |
| collaborative-thinking-structural-fix.md | 整文件 obsoleted |

### Skills / 入口
| 文件 | 处理 |
|---|---|
| multi-agent-skills/collaborative-thinking/SKILL.md | line 46/66/117 删 parallel_think tool 调用，改 prompt 引导 |
| multi-agent-skills/manifest.yaml | line 49 删 requires_mcp |
| multi-agent-skills/refs/shared-rules.md | brainstorm 路由 line 112 保留 |
| CLAUDE.md / GEMINI.md / AGENTS.md | 保留 brainstorm 路由 |
| 其他 SKILL.md（feat-lifecycle/self-evolution 等） | grep 命中检查，仅清 parallel_think |

### Bug reports / ADRs / Discussions
| 文件 | 处理 |
|---|---|
| B003 / B004 / B016 | 保留历史描述（不改 root cause），加 obsolete 注释 |
| ADR-002（A2A Call Tree truth source） | 保留 |
| F026-design-discussion-round-2.md | 保留（历史） |

## 验收场景（worktree preview 实测）

| # | 场景 | 期望 |
|---|---|---|
| 1 | R-080 风格：`@黄仁勋 帮我叫桂芬评价我爱你这三个字` | 黄仁勋 [Call: @桂芬] → 桂芬答 → 黄仁勋整合 reply 给 user |
| 2 | 用户单 @：`@桂芬 看视觉` | 桂芬接 + 答（无续推需求） |
| 3 | 用户多 @：`@桂芬 @范德彪 各自看下方案` | 两人独立 reply（不走 Phase 1 fan-out，不出"协助"header） |
| 4 | 接力：`@黄仁勋 找范德彪 review 后让桂芬出图` | 黄仁勋 → 范德彪 → 黄仁勋 → 桂芬 → 黄仁勋整合 reply 给 user |
| 5 | 进程重启：场景 1 发出后 kill API → 重启 | 黄仁勋续推恢复 |

## 红线与风险（再次提醒）

1. **顺序锁死**：Step 1 必须先做 + 实测过 chain 接通，再删 Step 2 的 return-path。中间窗口期一旦 worklist 续推没接管，所有 child→parent 续推全断。
2. **F002 红线**：F002 done feature 的 SettlementDetector 依赖 `hasActiveParallelGroupInSession`，删 ParallelGroup 后必须保留 stub `() => false`。
3. **groupId 命名陷阱**：删 D7 时 grep `groupId` 会扫到 sessionGroup（左侧栏）和 message group（折叠分组）两套——必须按文件/上下文严格区分，不能凭 grep 随手改。
4. **DB 历史兼容**：`messages.group_id` 列保留允许 NULL；MessageType union `a2a_handoff/_mcp` 保留兼容历史。
5. **测试改写**：删除大量测试时务必先看测试覆盖什么，能改的改成新路径测试，不能改的整删。

## 工时预估

| Step | 预估 |
|---|---|
| Step 1（worklist 续推接通） | 1.5-2 周（核心工作） |
| Step 2（删 return-path） | 1-2 天 |
| Step 3（删 parallel-group + F002 stub） | 2-3 天 |
| Step 4（删 parallel_think + phase1-header） | 2-3 天 |
| Step 5（删 phase2-header + discussion 套件） | 3-4 天 |
| Step 6（删 collapsible-group） | 1-2 天 |
| Step 7（改 a2a_handoff 产出路径） | 1 天 |
| Step 8（文档收尾） | 1-2 天 |
| **总计** | **~3-4 周** |

## 下一步

进 Step 1：在 worktree `F026-p0` 内 TDD 接通 worklist 续推到 directTurn。
