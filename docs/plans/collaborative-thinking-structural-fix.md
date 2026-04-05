# Collaborative-Thinking 结构化修复计划

**状态**: 待实现
**日期**: 2026-04-05
**负责**: 黄仁勋（Claude）
**关联**: docs/clowder-vs-multiagent-a2a-gap.md、multi-agent-skills/collaborative-thinking/SKILL.md

---

## 1. 背景

当前 A2A 多 @ 路径（≥2 agent）触发 parallel group 后，后端只发一条 status「并行 review 已全部完成」就结束，前端无任何扇入卡、无聚合消息，3 个 agent 的回复散落在 timeline 上。

根本原因（按 clowder-ai 10 层分层对照）：

| 层 | 缺失/问题 |
|---|---|
| 3 Prompt 层 | `buildSkillHintLine` 在多 @ 场景过度推送 skill 加载指令，导致每个 agent 都想独占 orchestrator 角色 |
| 4 意图层 | 无 `ideate/execute` 判定，所有多 @ 走同一路径 |
| 5 路由层 | 未按意图分叉 |
| 6 隔离层 | 无等价 `thinkingMode=play` 机制（但 `captureSnapshot` 在 enqueue 时冻结快照——需 verify） |
| 9 聚合层 | `notify_originator` 仅发 status 字符串，无 `flushResult` 聚合消息 |
| 10 前端层 | 无 ConnectorBubble 组件 |

Bug：`handleParallelThink` 正常完成路径未调 `selectFanInAndNotify`（仅超时路径调用，message-service.ts:783-789）。

---

## 2. 目标 & 非目标

### 目标
1. 用户 @ ≥2 agent 触发 Mode B 并行独立思考 → 扇入卡弹出供用户选扇入者 → 聚合结果推给选中者。
2. A2A 过程中 agent 调 `parallel_think(callbackTo=X)` → 聚合结果自动推给 X，不弹卡。
3. 并行期间 agent 互不可见（Phase 1 独立性由 server 代码保障，不靠 skill 文案自觉）。
4. `handleParallelThink` 正常完成路径打通。

### 非目标
- Mode A（单 @）路径**不变**。
- `#ideate` / `#execute` tag 支持——暂不做（≥2 @ 永远进 Mode B，足够简单）。
- Mode C（收敛沉淀）自动化——本次不做，保持人工/skill 引导。
- SKILL.md 文档不改。

---

## 3. 决策（已锁定）

| # | 决策 |
|---|---|
| 扇入权分轨 | user-initiated → 弹 `fan_in_selector` card；A2A-initiated → agent `callbackTo` |
| Mode B 触发 | ≥2 @ 自动触发（方案 a） |
| 扇入卡选项 | 只含参与 agent，**不含村长自己** |
| 聚合消息 UI | ConnectorBubble（做完整，不复用 message bubble） |
| Mode A 行为 | 不变 |

---

## 4. 实现分解

按依赖顺序（从底层到上层）：

### 4.1 Intent 判定（新增）
**文件**: `packages/api/src/orchestrator/intent.ts`（新建）

```ts
export type Intent = "ideate" | "execute"
export function parseIntent(mentionCount: number): Intent {
  return mentionCount >= 2 ? "ideate" : "execute"
}
```

纯函数，易测试。未来如支持 tag，在此扩展。

### 4.2 ParallelGroup 数据模型扩展
**文件**: `packages/api/src/orchestrator/parallel-group.ts`

新增字段：
```ts
initiatedBy: "user" | "agent"
participantProviders: Provider[]  // 扇入卡候选，= targetProviders 初值
intent?: "ideate" | "execute"     // 预留
```

`create()` 接受 `initiatedBy` 参数；migration 时默认 `"user"`。

### 4.3 Dispatch 透传 initiatedBy
**文件**: `packages/api/src/orchestrator/dispatch.ts:273`

`createParallelGroup` 回调签名加 `initiatedBy` 参数，由调用方（`handleSendMessage` → "user"、`handleAgentPublicMessage` → "agent"）传入。

**文件**: `packages/api/src/services/message-service.ts:215, 280`

两个 `createParallelGroup` 调用处分别传 `"agent"` / `"user"`。

### 4.4 Mode B prompt 头注入（Layer 3 修复）
**文件**: `packages/api/src/services/message-service.ts:605-629`

`buildA2APrompt` 特判：如果 `entry.parallelGroupId` 存在且对应 group 是 ideate，**替换** `skillHintLine` 为固定 Phase 1 硬规则头：

```
[当前模式：并行独立思考 · Phase 1]
你是 3 个 agent 中的 1 个，各自独立回答，互不可见。

规则：
- 独立给出你自己的观点，不预测其他 agent 会怎么说
- 展示推理链（不只结论）
- 标注不确定性（区分确信结论和猜测）
- 回复格式：证据 → 分析 → 结论 → 置信度
- 只回答本问题，不要规划后续阶段，不要替村长做综合决策

参考 skill：collaborative-thinking（不要加载全文，按本 header 执行）
```

如果不是 ideate，保持现有 `skillHintLine` 机制。

需要 dispatch.QueueEntry 携带 parallelGroupId → message-service 可查询 group → 判 intent。QueueEntry 已有 `parallelGroupId` 字段。

### 4.5 Isolation 验证 + 文档化（Layer 6）
**文件**: `packages/api/src/services/message-service.ts:671 captureSnapshot`

行为审计：

1. `enqueuePublicMentions` 在所有 agent 入队前**同步**调 `buildSnapshot()` 一次（dispatch.ts:261）——已冻结于 enqueue 时刻。
2. `buildA2APrompt` 用 `entry.contextSnapshot` 构造 prompt——已从冻结的 snapshot 取。
3. 但每个 agent 的 CLI 进程**本身**会读自己 thread 的历史——each provider 有独立 thread，所以 provider X 的 thread 不含 provider Y 的回复。✓

**结论**：Layer 6 在首轮独立思考阶段**已由 thread-per-provider + enqueue-time snapshot freeze 保障**，无需额外代码。

写验证测试：模拟 3 agent 并行，agent A 回复后 agent B/C 的 `buildA2APrompt` snapshot 中不含 A 的回复。

测试文件：`packages/api/src/services/message-service.isolation.test.ts`（新建）

### 4.6 聚合消息生成（Layer 9）
**文件**: `packages/api/src/services/message-service.ts:575-591`（替换当前 allDone 分支）

替换 `notify_originator` 分支为 `generateAggregatedResult(group)`：

```ts
function generateAggregatedResult(group: ParallelGroup): string {
  const lines = ["## 并行思考结果汇总", ""]
  if (group.question) lines.push(`**问题**: ${group.question}`, "")
  for (const [provider, result] of group.completedResults) {
    lines.push(`### ${PROVIDER_ALIASES[provider]}`)
    lines.push(result.content || "(空回答)")
    lines.push("")
  }
  return lines.join("\n")
}
```

Timeout 场景：已在 `handleTimeout` 里 fill 占位 `[timeout: ...]`，复用即可。

### 4.7 ConnectorMessage 类型 + 持久化
**文件**: `packages/shared/src/realtime.ts`

新增 TimelineMessage 子类型 `ConnectorMessage`：
```ts
kind: "connector"
connectorSource: {
  kind: "multi_mention_result"
  label: "并行思考结果"
  initiator?: Provider  // 若 A2A 发起
  targets: Provider[]
}
content: string  // markdown
```

session store 持久化这类消息。

### 4.8 allDone 分叉：user vs agent 发起
**文件**: `packages/api/src/services/message-service.ts`

```
allDone 到达:
  1. 生成聚合 markdown
  2. 作为 ConnectorMessage 追加到原发起 thread，emit message.created
  3. 分叉：
     - initiatedBy === "user" → 调 selectFanInAndNotify → 弹 fan_in_selector card
       - 用户选中 X → 将聚合消息送到 X 的 thread，runThreadTurn
     - initiatedBy === "agent" → 从 group.callbackTo 取目标 → 直接送给该 agent
```

### 4.9 Fan-in 卡选项修正
**文件**: `packages/api/src/services/message-service.ts:840-871 selectFanInAndNotify`

当前 options 用 `PROVIDERS`（所有 provider），修为 `group.participantProviders`（仅本次参与 agent）。不含"村长"选项。

### 4.10 handleParallelThink 正常完成路径修复
**文件**: `packages/api/src/services/message-service.ts:731-816`

`handleParallelThink` 创建 group 时 `initiatedBy = "agent"`, `callbackTo = params.callbackTo`。

正常完成路径复用 4.8 的 allDone 分叉逻辑（走 agent 分支，直接送 callbackTo）——无需单独超时处理路径调 `selectFanInAndNotify`（那是 user 分支的事）。

超时路径同样走 allDone 分叉（agent initiated → 直接送 callbackTo 收到带 timeout 占位的聚合消息）。

移除当前 `startTimeout(() => selectFanInAndNotify(...))` 的特殊路径，统一由 `markCompleted` / `handleTimeout` 后的 allDone 分叉处理。

### 4.11 前端 ConnectorBubble 组件
**文件**: `components/chat/connector-bubble.tsx`（新建）

UI：markdown 渲染 + 左侧 "users" 图标 + "并行思考结果"标题 + 参与者 avatar 横排 + 发起者 avatar（若有）。

**文件**: `components/chat/timeline-panel.tsx` + `components/chat/message-bubble.tsx`

根据 `message.kind === "connector"` 渲染 ConnectorBubble 而非 MessageBubble。

**文件**: `components/stores/thread-store.ts`

handle ConnectorMessage 追加到 timeline。

### 4.12 Skill triggers 调整（可选但建议）
**文件**: `multi-agent-skills/collaborative-thinking/SKILL.md` frontmatter

保持不变。Mode B 路径下 server 注入硬规则头替代 skillHint，Mode A 路径保持 skillHint 推送。

---

## 5. 测试计划

| 测试 | 文件 | 验证点 |
|------|------|--------|
| parseIntent 单元 | `intent.test.ts` | mentionCount 阈值 |
| ParallelGroup.initiatedBy 字段 | `parallel-group.test.ts` | create/markCompleted 透传 |
| 隔离性 | `message-service.isolation.test.ts` | agent B 的 snapshot 不含 agent A 的回复 |
| Mode B prompt 注入 | `message-service.prompt.test.ts` | parallelGroupId+ideate → Phase 1 header；否则 skillHint |
| 聚合消息生成 | `message-service.aggregation.test.ts` | allDone → ConnectorMessage appended |
| User 发起 fan-in | e2e 或 integration | user @A@B → allDone → fan_in card → 选 A → 聚合送 A thread |
| Agent 发起直达 callbackTo | integration | parallel_think(callbackTo=X) → allDone → 聚合送 X，无 card |
| handleParallelThink 正常完成 | regression | 3 agent 都完成 → 送 callbackTo（原 bug 修复） |
| ConnectorBubble 渲染 | UI snapshot | kind=connector → 正确 UI |

---

## 6. 风险 & 缓解

| 风险 | 缓解 |
|------|------|
| CLI agent 不守 Phase 1 header 规则，依然抢戏 | Phase 1 header 写得足够明确；隔离层保证它看不到 peers，演戏成本高就自然收敛 |
| ConnectorMessage 新类型破坏历史消息兼容 | timeline 渲染 fallback：未知 kind 降级为 MessageBubble |
| markCompleted allDone 分叉竞态（两条路径都触发聚合） | group 状态机 `done` 是 terminal，重复调用幂等 |
| Mode B 误触发（用户随口 @ 两人） | 可接受，用户不会频繁@多人；若频繁再补 `#execute` tag |

---

## 7. 实现顺序（commit 建议）

1. `feat(orchestrator): parseIntent + ParallelGroup.initiatedBy`（layer 4 + 数据模型）
2. `feat(orchestrator): A2A prompt Mode B Phase 1 header`（layer 3）
3. `test(orchestrator): verify Phase 1 snapshot isolation`（layer 6 验证）
4. `feat(message-service): aggregate result + ConnectorMessage`（layer 9）
5. `feat(shared): ConnectorMessage type + persistence`（layer 10 backend）
6. `feat(message-service): user/agent allDone split + fan-in card`（layer 9 完成）
7. `fix(message-service): handleParallelThink normal-complete path`（bug 修复）
8. `feat(web): ConnectorBubble component + timeline wire-up`（layer 10 frontend）
9. `fix(message-service): fan-in options = participants only`（扇入卡选项修正）

每个 commit 含对应单测；最后 e2e 验收。

---

## 8. Out of Scope / 后续

- `#ideate` / `#execute` 显式 tag
- Mode C 三件套自动沉淀 nudge
- Mode B Phase 2 分歧触发串行讨论
- 扇入卡加"村长综合"选项（用户已否决）
- `thinkingMode=play` 显式开关（当前用 thread-per-provider + snapshot freeze 等价实现）
