---
plan: F026 Phase 5 — 体感层 + 对账面板（后端 4 模块 + 前端 10 原语 · 黄仁勋单人全做）
spec: docs/features/F026-a2a-reliability-layer.md (line 376-391 P5 段 + I1' Layer 3 / I5 / M4 R-188)
worktree: .worktrees/F026-p0  (branch: feat/F026-p0-a2a-stabilize)
created: 2026-04-29
status_note: SUPERSEDED (in-part) — 2026-05-06 · DiscussionCoordinator / Phase2 串行讨论 / 结论卡片 等 AC 已被 F026 P2 Clean-Cut Step 5 (commit 040e3c1) 整套删除（5 件套结构化讨论模型废弃，改 prompt 引导）。其他 P5 体感原语（溯源胶囊 / 并列卡片 / Pending Pulse / 墓碑 / 折叠 / 淡紫色）由 P5 T0/T1/T2 落地完成。
revised: 2026-04-29 (小孙 04:48 拍板 [A] 串行单人 / 14:xx 拍板 [A-full] 前端 10 原语全做 + T0 数据通路前置)
owner: 黄仁勋（后端 T1-T4 → T0 数据通路 → 前端 F1-F10 · 串行 · 单人全做）
status: **OBSOLETE** — F026 P2 v2 Step 5 clean-cut 2026-05-06：DiscussionCoordinator 套件 + 结论卡片 / Phase2 / phase2-header 整删，体感原语收敛到 worklist 续推单轨。AC-P5-2 / AC-P5-13 / Task 4 discussion_concluded emit 等不再适用
merge-policy: 不合 dev — F026 整 feature（P0+P1+P3+P3.1+P4+P5）验完一起合
---

> ⚠️ **本 plan 已 obsolete（F026 P2 v2 Step 5 clean-cut 2026-05-06）**：DiscussionCoordinator / DiscussionRecorder / discussion-concluded-event / phase2-header / DiscussionConclusionCard 全套删除，AC-P5-2 (M4 R-188 结论卡片) / AC-P5-4 (discussion_concluded WS 广播) / AC-P5-13 (结论卡片渲染) / Task 4 (WS 事件 emit) 中 discussion_concluded 部分已废，仅保留 pending_change / mention.gray_zone / 其他体感原语（F1 @ pill / F6 ListeningPulse / F10 /debug/a2a 等）作 follow-up 参考。

# F026 Phase 5 Implementation Plan

**Feature:** F026 — `docs/features/F026-a2a-reliability-layer.md`
**Goal:** 体感层落地 + DiscussionCoordinator 收敛 + Layer 3 灰区分类器 — 用户可见 A2A 全生命周期，对账面板裸眼可查，多 agent 讨论必收敛到 [结论卡片]
**Architecture:**
- **后端三模块 + 事件 emit**（先做 · T1-T4）：DiscussionCoordinator（新建）+ Layer 3 灰区分类器（P1 已打桩补实现）+ /debug/a2a 扩展（P2 已建骨架补 status/timeout/tree-viz）+ WS 事件 emit 补丁
- **前端十原语**（后做 · F1-F10）：@ pill 状态机 / 溯源胶囊 / 超时墓碑 / 折叠群组 / 并列卡片 Visual Silo / 状态 Pulse / 淡紫底色 / display_mode 渲染 / 结论卡片 / /debug/a2a 视图
- **执行模型**：**黄仁勋单人前后端全做 · T1-T4 全绿后切 F1-F10**（小孙 04:48 拍板 [A]，本 phase **不外协桂芬 / 范德彪**）
- **依赖**：P1 wiring（callId 接线 / on_behalf_of / parent_call_id 入库）+ P4 持久化（registry 跨重启不丢）已完成；P3.1 retry 前端 dispatch-retry-progress-card 已落，F1 整合而非重写

**Tech Stack:** Next.js 14 (app router) · React · Zustand (`thread-store`) · WebSocket (`components/ws`) · vitest (frontend tests) · node:test (backend) · Tailwind

---

## Acceptance Criteria（spec line 89-91 I5 + line 65-72 I1' + line 136 M4 + line 376-391 P5 段）

### 后端 AC

- [ ] **AC-P5-1**（I5 + spec line 90 + line 380）：`GET /debug/a2a` 扩展三种查询形态：
  - `?root=<callId>` → call tree（已落）
  - `?parent=<callId>` → pendingOf（已落）
  - `?status=pending|working|timeout` → 全表过滤（**新增 P5**）
  - `?session=<groupId>&view=tree` → 该房间全部 root call 树聚合（**新增 P5**，前端 /debug/a2a 视图依赖）
- [ ] **AC-P5-2**（M4 R-188 + spec line 136 + line 389）：`DiscussionCoordinator` 新模块，触发条件 = 同一 root_call_id 下 ≥2 个 sibling settle 完成 OR 全部 timeout；触发后调 LLM 生成 `[结论卡片]` 写入 messages 表 + `agent_events:discussion_concluded` WS 广播
- [ ] **AC-P5-3**（I1' Layer 3 + spec line 74 + line 269）：`mention-router.ts` Layer 3 灰区分类器从打桩升级为规则实现 — 不命中 Layer 1/2 时默认不派 + 写 `agent_events:mention_gray_zone` 日志（含 traceId / 命中规则 / fail-closed 决策）
- [ ] **AC-P5-4**（前后端 contract）：`agent_events` 新增两类事件 WS 广播 — `pending_change`（rootCallId / parentCallId / pendingSet alias[]）+ `discussion_concluded`（rootCallId / conclusionMsgId / participants）

### 前端 AC（黄仁勋自做，T1-T4 全绿后启动）

- [ ] **AC-P5-5**（spec line 381 + I5）：@ pill 状态机六态全实现（发送中/已阅/处理中/完成/超时/失败）+ 失败重发按钮；P3.1 已落 dispatch-retry-progress-card 整合进 pill 完成态而非并存
- [ ] **AC-P5-6**（spec line 382）：**溯源胶囊** — 任何带 `on_behalf_of` 字段的消息气泡上方渲染「{convener} 正在征询 / {target} (为 {convener}) 正在征询」
- [ ] **AC-P5-7**（spec line 383）：**超时墓碑** — `a2a_calls.status='timeout'` 时在原 pill 位置渲染「@{target} 响应超时，{issuer} 请继续」
- [ ] **AC-P5-8**（spec line 384）：**折叠群组** — 带 `parent_call_id` 的消息默认半透明缩进（opacity 0.6 / margin-left 32px），点击 hover 展开切换 opacity=1
- [ ] **AC-P5-9**（spec line 385 + ADR-004 envelope）：**并列卡片 Visual Silo** — `display_mode=nested` 的 sibling messages 渲染成独立卡片（不串到主流），branch isolation
- [ ] **AC-P5-10**（spec line 386）：**状态 Pulse** — 订阅 `pending_change` 事件，pending set 非空时主流底部固定 banner 渲染「👂 正在听取 @X @Y」
- [ ] **AC-P5-11**（spec line 387 D6 拍板）：A2A 密谋区底色 `bg-purple-50/30`（淡紫色 30% alpha · Tailwind）覆盖在折叠群组容器
- [ ] **AC-P5-12**（spec line 388 + ADR-004）：Envelope `display_mode` 三态自动渲染 — `inline`（默认嵌入主流）/ `nested`（卡片）/ `background`（不渲染气泡，仅 pill 状态变化）
- [ ] **AC-P5-13**（spec line 389 + AC-P5-2）：**结论卡片渲染** — 收到 `discussion_concluded` 事件后从 messages 表读 conclusionMsgId 内容，渲染「📋 讨论结论」标题块 + 参与者列表 + 内容
- [ ] **AC-P5-14**（spec line 380）：**`/debug/a2a` 视图本体** — 新页面 `/debug/a2a` 路由，显示 status filter（pending/working/timeout）+ session 树结构可视化（递归气泡 + 状态色）

### 体感场景手验（DoD-1 spec line 410）

- [ ] **AC-P5-15**（场景 1 并发 @）：浏览器手验同一消息 `@范德彪 @桂芬`，二人独立卡片渲染，pending Pulse 显示「正在听取 @范德彪 @桂芬」，全部回完触发 DiscussionCoordinator 生成结论卡片
- [ ] **AC-P5-16**（场景 3 长对话召新 agent）：浏览器手验长对话中 @ 一个未参与过的 agent（cold-target），溯源胶囊显示，cold-target burst 兜底 prompt 注入（P3 已落），下游不需要先调 MCP 即看懂主线

---

## Out of Scope（明确）

- ❌ **Trace-ID 溯源图**（spec line 391 标 optional · P5 后段 · 不在 P5 必做范围，留 F026 后续 Phase 或独立 feature）
- ❌ **双轨 flag 删除**（`A2A_CALL_TREE_ENABLED` cleanup 归 DoD-3 收尾 commit · 不在 P5）
- ❌ **回填 P0-P4 已落范围**（callId 接线 / on_behalf_of 入库 / registry 持久化 / kill -9 e2e 在前 phase 已绿）
- ❌ **F018 SessionBootstrap 重写**（cold-target burst 已在 P3 兜底，P5 仅渲染胶囊不改后端 bootstrap）
- ❌ **更换 WS 协议**（用现有 `agent_events` channel 加事件类型即可，不动 transport）
- ❌ **改 `mention-router` Layer 1/2**（已稳定，仅在 Layer 3 增灰区规则）

---

## P0/P1/P3/P3.1/P4 修订对 P5 影响评估

| 上游修订 | 影响面 | P5 结论 |
|---|---|---|
| P0/P1 callId 接线 + a2a_calls 表全字段 | P5 前端 7+ 原语全部读这些字段 | **必须**：所有原语 schema 真实可用 |
| P3 cold-target burst 兜底 | 场景 3 体感链路 | AC-P5-16 手验受益，0 改后端 |
| P3.1 dispatch_validation_retry 事件 | F1 @ pill 失败状态分支 | F1 整合而非重写：retry-card 嵌入 pill expanded view |
| P3.1 retry exhausted 红条 | F1 失败态视觉 | 复用红条样式做 pill timeout 视觉一致 |
| P4 ParallelGroupRegistry 持久化 | DiscussionCoordinator 触发判定可读 group state | T1 直接读 `parallelGroups.findByRootCallId(...)` 不重建 state |
| P4 rehydrate timer | 重启后 pending_change 仍能触发 | 0 改：T4 emit 跟 P4 timer 走 |

**结论**：上游全绿，P5 0 阻塞。黄仁勋立刻进 T1.1 TDD（DiscussionCoordinator 第一个失败测试）。

---

## 前后端 Contract（单人串行依赖锁定）

### WS 事件新增（T4 后端 emit · F1/F6/F9 前端订阅 · 同一人开发但仍锁 schema）

```typescript
// agent_events 频道现有事件之外新增两类
type PendingChangeEvent = {
  type: 'pending_change'
  threadId: string
  rootCallId: string
  parentCallId: string
  pendingSet: Array<{ alias: string; callId: string; status: 'pending' | 'working' }>
  emittedAt: string  // ISO
}

type DiscussionConcludedEvent = {
  type: 'discussion_concluded'
  threadId: string
  rootCallId: string
  conclusionMsgId: string  // messages.id
  participants: Array<{ alias: string; callId: string; status: 'done' | 'timeout' | 'error' }>
  emittedAt: string
}
```

**Emit 时机：**
- `pending_change` — `CallRegistry.openCall / advance / settle / handleTimeout` 任一 mutation 后；frontend 即时更新 Pulse
- `discussion_concluded` — `DiscussionCoordinator.tryConclude(rootCallId)` 成功生成 conclusion 后

### 后端 schema 状态（实证 04-29 修订）

| 字段 | 表 | 前端原语 | 状态 |
|---|---|---|---|
| `on_behalf_of` | a2a_calls | F2 溯源胶囊 | P1 已落 |
| `convener_id` | a2a_calls | F2 溯源胶囊 | P1 已落 |
| `parent_call_id` / `root_call_id` | a2a_calls | F4 折叠 | P1 已落 |
| `status` (pending/working/done/timeout) | a2a_calls | F1 pill / F3 墓碑 | P1 已落 |
| `deadline_at` | a2a_calls | F3 墓碑 | P1 已落 |
| `pendingProviders / completedResults` | parallel_groups | F6 Pulse 同步 | P4 已落 |
| ⚠ `display_mode` (envelope.task.render.displayMode) | **未持久化**（仅在 envelope 临时 JSON） | F5 / F8 | **T0 补：a2a_calls 加 display_mode 列** |
| ⚠ `messages.a2a_call_id` 关联键 | **缺失** | 全部前端原语 | **T0 补：messages 加 a2a_call_id 列 + 派发处写回** |

**⚠ 实证发现（04-29 进 plan 时摸清）**：原 plan 写「前端可直接读」不准。`messages` 表与 `a2a_calls` 表当前**没有 PK 关联**——a2a connector message 落库时 `appendConnectorMessage` 不传 callId。前端需要的字段在 `a2a_calls` 表里，但拿不到对应 message 的 a2a_call_id 就 JOIN 不了。`display_mode` 协议字段虽在 envelope JSON 里定义，但 envelope 是临时构造的 — 数据库里只存了 `envelope_version="v1"` 字符串，**displayMode 真值丢了**。

→ 引入 **T0 数据通路前置 task**（schema migration + 接线 + LEFT JOIN）。

### 前端原语执行顺序（T1-T4 全绿后串行启动）

**Wave 1 · 不依赖后端事件 emit**（F1 阶段后段也可做）：F2 溯源胶囊 / F3 超时墓碑 / F4 折叠群组 / F5 并列卡片 / F7 淡紫底色 / F8 display_mode 渲染

**Wave 2 · 依赖后端 T3+T4**：F1 @ pill 状态机（订阅 pending_change）/ F6 状态 Pulse（订阅 pending_change）/ F9 结论卡片渲染（订阅 discussion_concluded）/ F10 /debug/a2a 视图（依赖 T3 status filter API）

**单人串行节奏建议（v3 修订）**：
1. T1-T4 后端全绿（≈ 4 工作日）✅ 已完成
2. **T0 数据通路扩展**（schema migration + LEFT JOIN + TimelineMessage 字段）（≈ 1.5 工作日）
3. Wave 1 六项独立原语（≈ 3-4 工作日）
4. Wave 2 四项依赖原语（≈ 2-3 工作日）
5. 体感场景手验 + DoD 自检 + L2 staging 合 dev（≈ 1.5-2 工作日）

---

## Task 1（后端）· DiscussionCoordinator 模块（M4 R-188 根治）

**Files:**
- Create: `packages/api/src/orchestrator/discussion-coordinator.ts`
- Create: `packages/api/src/orchestrator/discussion-coordinator.test.ts`
- Modify: `packages/api/src/services/message-service.ts`（settle / handleTimeout 后调用 coordinator.tryConclude）
- Modify: `packages/api/src/server.ts`（实例化 coordinator + 注入）

### Step 1.1 · 写失败测试 — 多 sibling 全 settle 后触发结论

```typescript
test("F026 P5 T1: ≥2 siblings all settle → coordinator emits conclusion", async () => {
  // 1. openCall root + 2 sibling children (A→B, A→C)
  // 2. settle B done + settle C done
  // 3. coordinator.tryConclude(rootCallId)
  // 4. assert messages 表多一行 role='system' content like '[讨论结论] ...'
  // 5. assert agent_events 一行 type='discussion_concluded'
})

test("F026 P5 T1: all siblings timeout → coordinator emits tombstone-style conclusion", () => {
  // 全 timeout → 仍触发 coordinator，结论文案带「全部超时」标记
})

test("F026 P5 T1: only 1 sibling settled → coordinator does NOT fire", () => {
  // 单边回 ≠ 讨论收敛
})

test("F026 P5 T1: idempotent — second tryConclude on same root is no-op", () => {
  // CAS 防重入：同 rootCallId 已有 conclusion 则跳过
})
```

### Step 1.2 · 实现 DiscussionCoordinator（最小骨架）

```typescript
export class DiscussionCoordinator {
  constructor(deps: {
    callRegistry: CallRegistry
    messageRepo: MessageRepo
    agentEvents: AgentEventEmitter
    llm: { generate(prompt: string): Promise<string> }
    threadIdLookup: (rootCallId: string) => string | null
  }) {}

  async tryConclude(rootCallId: string): Promise<{ concluded: boolean; reason?: string }> {
    // 1. const tree = callRegistry.getTree(rootCallId)
    // 2. siblings = tree.filter(c => c.parent_call_id === rootCallId)
    // 3. if siblings.length < 2 → { concluded: false, reason: 'lt_2_siblings' }
    // 4. if any sibling status in [pending, working] → { concluded: false, reason: 'still_pending' }
    // 5. CAS check: getConclusion(rootCallId) → 已有 → { concluded: false, reason: 'already_concluded' }
    // 6. const summary = await llm.generate(buildSummaryPrompt(siblings))
    // 7. messageRepo.insert({ role: 'system', content: '[讨论结论]\n' + summary, ... })
    // 8. agentEvents.emit('discussion_concluded', { rootCallId, conclusionMsgId, participants })
    // 9. return { concluded: true }
  }
}
```

### Step 1.3 · message-service.ts 接入

`settle()` / `handleTimeout()` / `markAggregationDone()` 末尾追加：
```typescript
if (call.parentCallId === call.rootCallId) {
  // sibling level — 检查兄弟是否都收敛
  this.coordinator.tryConclude(call.rootCallId).catch(err => log.warn('discussion_coordinator_fail', { err }))
}
```

### Step 1.4 · server.ts wire

```typescript
const coordinator = new DiscussionCoordinator({ callRegistry, messageRepo, agentEvents, llm: defaultLLM, threadIdLookup })
const messages = new MessageService(..., coordinator)  // 第 7 个参数
```

**Definition of Done T1:**
- [ ] 4 case TDD 全绿
- [ ] 不破坏 message-service 现有 1378+ 测试
- [ ] commit 消息：`feat(F026-P5 T1): DiscussionCoordinator — M4 R-188 multi-agent 讨论必收敛 [结论卡片]`

---

## Task 2（后端）· I1' Layer 3 灰区分类器实现

**Files:**
- Modify: `packages/api/src/orchestrator/mention-router.ts`（Layer 3 实现）
- Modify: `packages/api/src/orchestrator/mention-router.test.ts`（新增 4 case）

### Step 2.1 · 当前打桩位置确认

P1 已写：Layer 1 hard-neg AST 一票否决 / Layer 2 hard-pos 行首 + 动作词。Layer 3 当前 stub 直接 fail-closed return null。

### Step 2.2 · 写失败测试 — 灰区规则集

```typescript
test("F026 P5 T2: gray zone — '@X 怎么看' 含问号 → 派发", () => {})
test("F026 P5 T2: gray zone — '@X 这个不行' 无动作词 → 不派发 + 日志", () => {})
test("F026 P5 T2: gray zone — 行尾 @X → 不派发 + 日志", () => {})
test("F026 P5 T2: gray zone — emit agent_events:mention_gray_zone with traceId + decision", () => {})
```

### Step 2.3 · 实现 Layer 3 规则集（外挂配置 + fail-closed 默认）

```typescript
// gray-zone-classifier.ts (new helper)
export type GrayZoneRule = {
  name: string
  predicate: (ctx: MentionContext) => boolean
  decision: 'dispatch' | 'skip'
}

export const DEFAULT_GRAY_ZONE_RULES: GrayZoneRule[] = [
  { name: 'question_mark_after_at', predicate: c => /[?？]/.test(c.tailText), decision: 'dispatch' },
  // ... 2-3 条经验规则
]

// mention-router.ts Layer 3
function layer3(content, target): Decision {
  for (const rule of DEFAULT_GRAY_ZONE_RULES) {
    if (rule.predicate(ctx)) {
      log.info('mention_gray_zone', { rule: rule.name, decision: rule.decision, traceId })
      return { dispatch: rule.decision === 'dispatch', via: `gray:${rule.name}` }
    }
  }
  // 无规则命中 → fail-closed 默认不派
  log.info('mention_gray_zone', { rule: 'fail_closed_default', decision: 'skip', traceId })
  agentEvents.emit('mention_gray_zone', { traceId, content, target, decision: 'skip' })
  return { dispatch: false, via: 'gray:fail_closed' }
}
```

**Definition of Done T2:**
- [ ] 4 case TDD 全绿
- [ ] 旧 Layer 1/2 测试零回归
- [ ] commit 消息：`feat(F026-P5 T2): mention-router Layer 3 灰区分类器 — 规则集 + fail-closed 默认 + 日志`

---

## Task 3（后端）· /debug/a2a 扩展

**Files:**
- Modify: `packages/api/src/routes/debug-a2a.ts`（扩 status / session+tree 两种查询形态）
- Create: `packages/api/src/routes/debug-a2a.test.ts`
- Modify: `packages/api/src/orchestrator/call-registry.ts`（新增 `findByStatus(status)` / `getSessionTrees(sessionGroupId)`）

### Step 3.1 · 写失败测试

```typescript
test("F026 P5 T3: GET /debug/a2a?status=pending returns all pending across sessions", () => {})
test("F026 P5 T3: GET /debug/a2a?status=timeout returns timeout calls", () => {})
test("F026 P5 T3: GET /debug/a2a?session=g1&view=tree returns nested call trees", () => {})
test("F026 P5 T3: backward-compat — ?root= and ?parent= still work as P1", () => {})
```

### Step 3.2 · 实现新 query handlers

```typescript
if (status) {
  return { kind: 'status', status, calls: deps.callRegistry.findByStatus(status) }
}
if (session && view === 'tree') {
  return { kind: 'session_trees', sessionGroupId: session, trees: deps.callRegistry.getSessionTrees(session) }
}
```

**Definition of Done T3:**
- [ ] 4 case TDD 全绿
- [ ] curl 手验：preview 上跑 `curl localhost:8800/debug/a2a?status=pending` 返回有数据
- [ ] commit 消息：`feat(F026-P5 T3): /debug/a2a 扩 status filter + session-trees 视图`

---

## Task 4（后端）· WS 事件 emit 补丁（pending_change + discussion_concluded）

**Files:**
- Modify: `packages/api/src/orchestrator/call-registry.ts`（mutation 后 emit pending_change）
- Modify: `packages/api/src/orchestrator/discussion-coordinator.ts`（T1 已写，本步补 emit 接线）
- Modify: `packages/api/src/services/agent-events.ts`（新事件类型注册）

### Step 4.1 · 写失败测试

```typescript
test("F026 P5 T4: openCall emits pending_change with full pendingSet", () => {})
test("F026 P5 T4: settle emits pending_change with reduced pendingSet", () => {})
test("F026 P5 T4: discussion_concluded event payload schema 严格", () => {})
```

### Step 4.2 · 实现

CallRegistry constructor 接 `agentEvents` 可选 dep；每次 mutation 末尾 emit pending_change（throttle 100ms 防 burst）。

**Definition of Done T4:**
- [ ] 3 case TDD 全绿
- [ ] preview 上 WS 客户端能收到事件（手验）
- [ ] commit 消息：`feat(F026-P5 T4): WS 事件 emit — pending_change + discussion_concluded`

---

## Task T0（前置 · 数据通路扩展）· messages ↔ a2a_calls 关联键

> **本 task 是 v3 修订追加项** — 实证 04-29 摸清前端 10 原语依赖字段后发现 `messages` 表与 `a2a_calls` 表无 PK 关联。Wave 1/2 全部依赖此 task 落地。
>
> **进一步简化（v3.1 修订）**：实证 envelope-builder.ts:30 `displayMode = parentCallId ? "nested" : "inline"` 是 derived value，**不需要持久化**。原计划"a2a_calls 加 display_mode 列"取消。T0 工作量从 1.5 天压到 0.8 天。

**Files:**
- Modify: `packages/api/src/db/schema.ts`（messages 加 `a2a_call_id`）
- Modify: `packages/api/src/db/sqlite.ts`（runAlterMigrations 加一条 ALTER TABLE）
- Modify: `packages/api/src/db/repositories/session-repository.ts`（appendMessage 接 `a2aCallId` opt + listMessages 改 LEFT JOIN）
- Modify: `packages/api/src/services/session-service.ts`（appendConnectorMessage / mapTimelineMessage）
- Modify: `packages/api/src/services/message-service.ts`（line 733 派发处把 callId 写回 message）
- Modify: `packages/shared/src/realtime.ts`（TimelineMessage 加 7 新字段，含 derived displayMode）
- Test: 新增 `session-repository.a2a-join.test.ts` + 扩 `message-service.test.ts`

### Step T0.1 · Schema migration 失败测试 → 实现

```typescript
test("F026 P5 T0: messages 表 a2a_call_id 列存在且 nullable", () => {})
test("F026 P5 T0: 老库（无新列）启动后 migration 自动加列、老数据 0 损失", () => {})
```

实现：在 `runAlterMigrations` 队列追加 `ALTER TABLE messages ADD COLUMN a2a_call_id TEXT`（duplicate-column-name 异常已被现有 catch 处理 → 幂等）。

### Step T0.2 · appendConnectorMessage 接 a2aCallId

```typescript
appendConnectorMessage(threadId, content, connectorSource, groupId, groupRole, a2aCallId?: string)
  → repository.appendMessage(..., a2aCallId)
```

`appendMessage` SQL 改 INSERT 时把 a2a_call_id 列写入。老调用方传 undefined → null。

### Step T0.3 · listMessages LEFT JOIN

```sql
SELECT
  m.id, m.thread_id as threadId, ...原列...,
  m.a2a_call_id as a2aCallId,
  c.parent_call_id as a2aParentCallId,
  c.root_call_id as a2aRootCallId,
  c.on_behalf_of as a2aOnBehalfOf,
  c.convener_id as a2aConvenerId,
  c.status as a2aCallStatus,
  c.deadline_at as a2aDeadlineAt,
  c.display_mode as a2aDisplayMode
FROM messages m
LEFT JOIN a2a_calls c ON c.call_id = m.a2a_call_id
WHERE m.thread_id = ?
ORDER BY m.created_at ASC
```

### Step T0.4 · TimelineMessage 字段扩展

```typescript
export type TimelineMessage = {
  ...原字段...
  // F026 P5 T0 · A2A 协议字段（LEFT JOIN a2a_calls）
  a2aCallId?: string
  a2aParentCallId?: string | null
  a2aRootCallId?: string
  a2aOnBehalfOf?: string | null
  a2aConvenerId?: string
  a2aCallStatus?: 'pending' | 'working' | 'done' | 'failed' | 'timeout' | 'cancelled'
  a2aDeadlineAt?: string
  a2aDisplayMode?: 'inline' | 'nested' | 'background'
}
```

### Step T0.5 · 派发处接线 — message-service.ts:733 写回 callId + display_mode

```typescript
const a2aConnector = this.sessions.appendConnectorMessage(
  targetThread.id, "",
  a2aConnectorSource,
  entry.id,
  "header",
  entry.callId,   // ← T0 新增：把 a2a callId 写回 message
)
```

`a2a-gateway.ts` `planBetaDispatch` 把 envelope 里 `task.render.displayMode` 存到 `a2a_calls.display_mode`（call-registry.ts openCall 接 displayMode 参数）。

**Definition of Done T0:**
- [ ] schema 两列 + migration 测试全绿
- [ ] LEFT JOIN listMessages 测试覆盖（有 a2a 派发的 message 拿到字段、无派发的 message null fallback）
- [ ] message-service.test.ts 派发后查 timeline 验证字段填充
- [ ] **`pnpm test:api` 全套零回归**（关键：listMessages 是核心 SQL，不破现有 1456 测试）
- [ ] commit 消息：`feat(F026-P5 T0): messages.a2a_call_id + a2a_calls.display_mode + LEFT JOIN — 数据通路前置`

---

## Task F1-F10（前端 · 黄仁勋自做）· 原语清单

> **执行顺序**：T1-T4 后端全绿后启动；先 Wave 1（F2/F3/F4/F5/F7/F8）独立原语，再 Wave 2（F1/F6/F9/F10）依赖原语
> **本 phase 不外协**：桂芬 / 范德彪不接前端任务（小孙 04:48 拍板 [A] · 全部黄仁勋单人做）
> **依赖 T0**：所有前端原语读 TimelineMessage 新字段，T0 不绿前端无法启动

### F1 · @ pill 状态机六态 + 失败重发（依赖 T4）

**Files:** `components/chat/at-pill.tsx`（new）+ `components/chat/dispatch-retry-progress-card.tsx`（整合，不并存）+ `components/stores/thread-store.ts`（pillStates Map）
**State machine:** `sending → ack → working → done | timeout | error`
**测试:** `at-pill.test.tsx` 覆盖六态渲染 + retry click handler

### F2 · 溯源胶囊（不依赖 T1-T4）

**Files:** `components/chat/origin-capsule.tsx`（new）
**Render:** message bubble 上方 `<div className="text-xs text-purple-700">📨 {convener} 正在征询 {target}</div>`
**条件:** `message.metadata.onBehalfOf` 非空时显示

### F3 · 超时墓碑（不依赖 T1-T4）

**Files:** `components/chat/timeout-tombstone.tsx`（new）
**Render:** `<div className="bg-red-50 text-red-800 italic">⏱️ @{target} 响应超时，{issuer} 请继续</div>` 替代原 pending pill 位置
**条件:** `a2a_call.status === 'timeout'`

### F4 · 折叠群组（不依赖 T1-T4）

**Files:** `components/chat/collapsible-a2a-group.tsx`（new）+ `components/chat/message-bubble.tsx` 改造
**视觉:** `parent_call_id` 非空 → `opacity-60 ml-8 hover:opacity-100 cursor-pointer`
**交互:** click 整组 toggle expanded（zustand `expandedGroups` Set）

### F5 · 并列卡片 Visual Silo（不依赖 T1-T4）

**Files:** `components/chat/parallel-card-silo.tsx`（new）
**Render:** `display_mode === 'nested'` 的 sibling messages 抽出主流，渲染成 grid `grid-cols-2 gap-4`，每张卡片独立标题（agent name + status pill）

### F6 · 状态 Pulse（依赖 T4）

**Files:** `components/chat/listening-pulse.tsx`（new）
**Render:** thread 底部 fixed banner，`pendingSet.length > 0` 时显示「👂 正在听取 {pendingSet.map(p => '@' + p.alias).join(' ')}」
**实现:** WS handler `pending_change` → `thread-store.setPendingSet(rootCallId, pendingSet)`

### F7 · 淡紫底色（不依赖 T1-T4）

**Files:** 修改 `collapsible-a2a-group.tsx`（F4 容器加 `bg-purple-50/30`）
**说明:** 一行 Tailwind 改动，与 F4 同 commit

### F8 · Envelope display_mode 自动渲染（不依赖 T1-T4）

**Files:** `components/chat/message-renderer.tsx`（new dispatcher）
**Logic:** 读 `message.envelope.displayMode`：
- `inline` → 走默认 message-bubble
- `nested` → 走 F5 parallel-card-silo
- `background` → 不渲染气泡，仅触发 pill 状态变化（F1）

### F9 · 结论卡片渲染（依赖 T1+T4）

**Files:** `components/chat/discussion-conclusion-card.tsx`（new）
**Render:** WS `discussion_concluded` → 拉对应 messageId → 渲染 `<div className="border-l-4 border-amber-500 bg-amber-50 p-4"><h3>📋 讨论结论</h3>...{participants.map(...)}</div>`
**位置:** 主流插入到最后一个 sibling 之后

### F10 · /debug/a2a 视图本体（依赖 T3）

**Files:** `app/debug/a2a/page.tsx`（new）+ `components/debug/a2a-tree-view.tsx`（new）
**功能:**
- Filter tabs：pending / working / timeout / all
- Session selector：dropdown 列出当前 sessionGroups
- Tree visualization：递归渲染 call tree（box + 状态色 + 状态文本）
- Refresh button：手动 refetch（不订阅 WS，避免首版复杂度）

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 单人串行总工期拉长（vs 并行） | 高 | 中 | 接受额外 1-1.5 周 · 小孙 04:48 拍 [A] · 单人节奏更可控、上下文不切换损耗 |
| DiscussionCoordinator 触发 LLM 阻塞主流 | 中 | 高 | tryConclude 走 promise.catch 不阻塞 settle / handleTimeout 调用方；超 30s LLM 响应记录但不重试 |
| Layer 3 灰区规则误判过激 | 中 | 低 | 默认 fail-closed 不派 + 全部决策日志 + 规则集外挂可改 · 先 ship 再调 |
| 前端 10 原语单人时长压不下 | 中 | 中 | Wave 1/2 划分 · Wave 1 六项各 ≤ 0.5 工作日 · Wave 2 复用 Wave 1 thread-store 类型 |
| /debug/a2a 视图 P1 未做认证 | 低 | 低 | dev/preview only · 上线时若需要再加 auth · 当前继承 P1 决策 |
| pending_change 事件高频抖动 | 低 | 中 | T4 throttle 100ms · 测试覆盖 burst 场景 |
| 结论卡片 LLM 抽象失真 | 中 | 低 | prompt 模板严格（参与者列表 + 关键发言点 + 结论分类）· 失败时降级为「【自动汇总】+ 全文拼接」 |
| 长 session 上下文挂（前手稿 04:48 即翻车） | 中 | 高 | 每 commit 后 git log 留证；任务边界清晰（T1-T4 / F1-F10）便于跨 session rehydrate |

---

## Definition of Done（P5 整 phase）

### DoD-P5-A · 后端绿

- [ ] T1-T4 四个 task 全部 commit
- [ ] `pnpm test:api` 全绿（含新增 ~15 case）
- [ ] `pnpm typecheck` 0 error
- [ ] `curl localhost:8800/debug/a2a?status=pending` 返回结构化数据（手验）

### DoD-P5-B · 前端绿

- [ ] F1-F10 十个原语全部 commit（黄仁勋单人）
- [ ] `pnpm test:components` 全绿（vitest 覆盖每个新组件）
- [ ] preview 上 `/debug/a2a` 页面可访问且 tree 可视化正常
- [ ] 体感场景 1（并发 @ 二人）+ 场景 3（cold-target 召新 agent）浏览器手验通过

### DoD-P5-C · 不变量回归

- [ ] **I5** AC 全绿（/debug/a2a 可查 + 7+ 原语全渲染）
- [ ] **I1' Layer 3** AC 全绿（灰区分类器实现 + 日志）
- [ ] **M4 R-188** 回归测试：fake-runtime 多 agent 讨论 → 必生成结论卡片
- [ ] **M3 R-190** 回归零退化（mention-router 改 Layer 3 不破 Layer 1/2）
- [ ] P0/P1/P3/P3.1/P4 现有 1378+ 测试零退化

### DoD-P5-D · 文档同步

- [ ] spec line 376-391 P5 段勾选全部 checkbox
- [ ] feature 文件 Decision Log 追加 P5 完成 entry
- [ ] 本 plan status 改 done + 收尾 entry

---

## Timeline 估算（黄仁勋单人串行）

| Day | 任务 | 备注 |
|---|---|---|
| Day 1 | T1.1 + T1.2 DiscussionCoordinator 失败测试 + 实现 | TDD red→green ✅ `e17e656` |
| Day 2 | T1.3 + T1.4 接入 message-service + server.ts wire | + 4 case 全绿 ✅ `5a3008c` |
| Day 3 | T2 Layer 3 灰区分类器（红→绿+测试覆盖） | mention-router 不破 Layer 1/2 ✅ `946cb7f` |
| Day 4 | T3 /debug/a2a 扩 status filter + session-trees | curl 手验 ✅ `5e72807` |
| Day 5 | T4 WS pending_change + discussion_concluded emit | preview WS 客户端手验 ✅ `74c24f0` |
| **Day 6a** | **T0 schema migration + repo LEFT JOIN + TimelineMessage 字段（v3 新增）** | **T0 数据通路前置 · 1.5 工作日** |
| Day 6b | F2 溯源胶囊 + F3 超时墓碑（Wave 1 起手） | 纯渲染 · 各 ≤ 0.5d |
| Day 7 | F4 折叠群组 + F7 淡紫底色（同 commit） | F7 一行 Tailwind |
| Day 8 | F5 并列卡片 Visual Silo + F8 display_mode 渲染 | dispatcher 复用 |
| Day 9 | F1 @ pill 状态机六态 + 失败重发整合 P3.1 retry-card | Wave 2 起手 |
| Day 10 | F6 状态 Pulse（订阅 pending_change） | thread-store pendingSet |
| Day 11 | F9 结论卡片渲染（订阅 discussion_concluded） | + F10 起手 |
| Day 12 | F10 /debug/a2a 视图本体（依赖 T3） | filter tabs + tree viz |
| Day 13 | 体感场景 1 / 3 浏览器手验 + bugfix | 黄仁勋自跑 |
| Day 14 | DoD-A/B/C/D 自检 + quality-gate + spec checkbox 同步 | F026 整 feature 合 dev 准备 |

**总工期：** 14-15 工作日 ≈ 3 自然周（含 v3 修订追加 T0 1.5 工作日）

**v3 修订原因**：摸清前端依赖后发现 messages ↔ a2a_calls 无 PK 关联、display_mode 协议字段未持久化。原 plan 写「前端可直接读」不准。T0 不前置则 Wave 1 全部 6 项原语全部空 props 渲染（用户看不到任何 a2a 体感）。

---

## 启动检查（plan 落盘后立刻执行）

- [x] 此 plan 提交 commit 进 worktree（`8491199` 初版 · 后续修订 commit 单独追加）
- [x] room 通报小孙 plan 落盘 + 修订（**不 ping 桂芬** · 小孙 04:48 拍 [A] 全部黄仁勋做）
- [ ] 黄仁勋切 T1.1 进 TDD（writing-plans → tdd skill 链）：DiscussionCoordinator 第一个失败测试
