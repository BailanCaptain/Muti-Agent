# F026 Phase 1 — A2A L1 协议地基（Round 2 v2 · 小孙 2026-04-23 拍板）

**Feature:** F026 — `docs/features/F026-a2a-reliability-layer.md` (v2)
**Round 2 决议**：`docs/discussions/F026-design-discussion-round-2.md`（approved）+ ADR-002/003/004
**前置**：Phase 0（原 `F026-p0-plan.md`）的四条止血补丁（composer isBusy / ws broadcaster / replay harness / trigger_mention 冒泡 / Task 6 role 守卫）
**Goal**：落地 Round 2 协议真地基 —— **Call Tree + Envelope 双层 + mention-router 三层 + on-behalf 反推 + A2A 对 agent 透明**。2 周工作量。
**Output**：
- 新模块 `call-registry.ts` / `envelope-builder.ts`
- 升级 `mention-router.ts` 到三层 fail-closed + on-behalf 反推 + 反循环去重
- `a2a_calls` 表扩 Round 2 全字段（Q5）
- 双轨 feature flag：新 callId 路径 + 旧路径并行 2 周

## Acceptance Criteria（Phase 1）

覆盖 F026 spec 中 I1' / I4 / I6 / I7 / I8 / I10 / I11 七条（I2 留 Phase 2；I3 已 Phase 0 落；I5 Phase 5；I9 Phase 1 协议层埋点 + Phase 5 前端；I2-a R-184 Phase 2）。

### I1' · Mention 三层 fail-closed + on-behalf（ADR-003）

- [ ] Markdown-AST 集成：code block / inline code / blockquote / table 单元格 / strong/em 装饰性 全识别
- [ ] Layer 1 hard-negative 7 场景测试全绿（含 2026-04-22 × 2 + 2026-04-23 LL-028 红案）
- [ ] Layer 2 hard-positive（行首 @ + 动作词）测试绿
- [ ] Layer 3 gray-zone 默认不派 + debug 日志
- [ ] on-behalf 反推词典（外挂 JSON/YAML）：「帮/代/替/为 X + @B」→ `on_behalf_of=X, convener=X`
- [ ] 反循环：同 `(source, target)` 30s 内第二次派发 blocked
- [ ] 单消息内同 target 仅派发一次
- [ ] 所有决策带 traceId

### I4 · Registry 持久化 + CAS + Call Tree 扩字段（ADR-002）

- [ ] `a2a_calls` 表 drizzle migration：扩 `call_id / parent_call_id / root_call_id / issuer_id / convener_id / join_set_id / on_behalf_of / status / deadline_at / envelope_version / reply_to / created_at / updated_at`
- [ ] `call-registry.ts` API：
  - `openCall({parent_call_id, issuer_id, convener_id, on_behalf_of, deadline}) → call_id`
  - `getTree(root_call_id) → Call[]`
  - `pendingOf(parent_call_id) → Call[]`
  - `settle(call_id, result)` + CAS 状态转移
  - `timeoutScan()` 扫描过期 working call
- [ ] CAS：状态机只允许 `pending → working → {done|failed|timeout|cancelled}`，不可逆转

### I6 · 身份贯穿

- [ ] 所有 A2A 入口（`dispatch / trigger_mention / post_message`）返回 `call_id`
- [ ] callback token 2h TTL
- [ ] 30s 无心跳强制 NACK

### I7 · Call Tree 贯穿（ADR-002）

- [ ] `call_id / parent_call_id / root_call_id / issuer_id / convener_id / on_behalf_of` 贯穿全链路
- [ ] fuzz：1000 层嵌套 call tree 构建无崩溃；pendingOf / settle 并发安全

### I8 · Envelope 双层 + 版本化（ADR-004 附录 B）

- [ ] `packages/shared/src/a2a-envelope.ts` TypeScript 类型定义（`EnvelopeV1` discriminated union）
- [ ] `envelope-builder.ts`：出站钩子，从 call-registry + mention-router + 总线上下文服务 三处取字段一次封装
- [ ] `envelope_version` 字段必填（`"v1"` 初版）
- [ ] `task.context.{burst, tombstone, rolling_summary}` 挂 task 层，不是 protocol 层

### I10 · Convener Explicit（ADR-002）

- [ ] `convener_id` 在 openCall 时显式指定；**不**靠嵌套自动推导
- [ ] 默认规则：`convener_id = parent.issuer`（严格分级）
- [ ] 豁免规则：mention-router on-behalf 反推 → `convener_id = on_behalf_of`

### I11 · A2A 对 agent 层透明（ADR-004 · 硬约束）

- [ ] **diff 门禁**：CI 检查 `CLAUDE.md / GEMINI.md / AGENTS.md / packages/api/src/runtime/agent-prompts.ts` 四个文件行数相对 `main` 差为 ≤ 0
- [ ] **β 路径**：普通 A2A outbound 消息 Envelope.task.task === `"conversation"` + task.input.source_message === 原文整段
- [ ] **γ 路径**：`cross-role-handoff` skill 调用产出 Envelope.task.task !== `"conversation"`，结构化字段全填
- [ ] agent fixture 测试：模拟 agent 写「@B 帮小孙 review」→ envelope.protocol.convener_id === `"小孙"`（agent 不感知也不填 convener 字段）

---

## 架构与模块

### 新模块

```
packages/api/src/orchestrator/
  call-registry.ts         # Call Tree 持久化 + API（ADR-002）
  envelope-builder.ts      # 消息出站钩子（ADR-004 附录 B）
  mention-router.ts        # 升级（ADR-003）
    - md-ast.ts            # Markdown-AST hard-negative 检测
    - on-behalf.ts         # 词典反推
    - rate-limit.ts        # 30s 反循环 + 单消息去重
  on-behalf-dictionary.yaml  # 外挂词典

packages/shared/src/
  a2a-envelope.ts          # Envelope TypeScript 类型（ADR-004）
```

### 修改模块

```
packages/api/src/orchestrator/
  dispatch.ts              # 调用 call-registry.openCall 替代旧直派
  return-path.ts           # 双轨 flag（P2 完全下线）
  a2a-chain.ts             # 字段升级到 Call Tree

packages/api/src/db/
  migrations/NNNN_f026_a2a_calls_call_tree.sql
  schema.ts                # drizzle 表结构扩字段

packages/api/src/mcp/
  server.ts                # trigger_mention / post_message 入口返回 call_id
```

### 禁动文件（ADR-004 diff 门禁）

```
CLAUDE.md
GEMINI.md
AGENTS.md (如存在)
packages/api/src/runtime/agent-prompts.ts
```

Phase 1 完结前 `git diff main -- <这四个文件>` 必须为空或仅删除。

---

## Task 拆分（TDD · 每个 Task = 一对 Red/Green commit）

### Task A · `a2a-envelope.ts` 类型定义（0.5 天）

**Files**：
- Create: `packages/shared/src/a2a-envelope.ts`
- Test: `packages/shared/src/__tests__/a2a-envelope.test.ts`

**Step A.1 Red**：写一个编译期类型测试 + runtime shape assert
```ts
// envelope 必有 protocol + task 两层
// protocol 必含 8 字段；task 必含 4 字段 + context + render
// envelope_version 必填
```

**Step A.2 Green**：写 `EnvelopeV1` discriminated union + zod schema

**Step A.3 Commit**：`feat(F026-P1): Envelope v1 schema (ADR-004)`

---

### Task B · `a2a_calls` 表扩字段 migration（0.5 天）

**Files**：
- Create: `packages/api/src/db/migrations/NNNN_f026_a2a_calls_call_tree.sql`
- Modify: `packages/api/src/db/schema.ts`
- Test: `packages/api/src/db/__tests__/migration-roundtrip.test.ts`

**Step B.1 Red**：migration roundtrip 测试 — 新字段可写可读；旧数据迁移保留

**Step B.2 Green**：写 SQL migration + 更新 drizzle schema（扩字段按 Phase 1 AC I4 清单）

**Step B.3 Commit**：`feat(F026-P1): a2a_calls Call Tree migration (ADR-002)`

---

### Task C · `call-registry.ts` 核心（2 天）

**Files**：
- Create: `packages/api/src/orchestrator/call-registry.ts`
- Test: `packages/api/src/orchestrator/__tests__/call-registry.test.ts`

**Step C.1 Red**：
- `openCall` 返回 call_id，并写 a2a_calls 表
- `getTree(root)` 返回完整链
- `pendingOf(parent)` 返回未完成子集
- `settle(call_id)` + CAS 状态转移（并发两次 settle 只有一次成功）
- `timeoutScan()` 超 deadline 的 working call 强 timeout
- fuzz：1000 层嵌套无崩溃

**Step C.2 Green**：最小实现（drizzle query + `UPDATE ... WHERE status=?` CAS）

**Step C.3 Refactor**：抽 `CallStatus` state machine 类型、抽 query helper

**Step C.4 Commit**：`feat(F026-P1): call-registry with Call Tree + CAS (ADR-002)`

---

### Task D · `mention-router.ts` 三层 fail-closed + on-behalf（3 天）

**Files**：
- Modify: `packages/api/src/orchestrator/mention-router.ts`
- Create: `packages/api/src/orchestrator/mention-router/md-ast.ts`
- Create: `packages/api/src/orchestrator/mention-router/on-behalf.ts`
- Create: `packages/api/src/orchestrator/mention-router/rate-limit.ts`
- Create: `packages/api/src/orchestrator/on-behalf-dictionary.yaml`
- Test: `packages/api/src/orchestrator/__tests__/mention-router.layer1.test.ts`（hard-neg · 7 场景 × 多 fixture）
- Test: `packages/api/src/orchestrator/__tests__/mention-router.layer2.test.ts`（hard-pos）
- Test: `packages/api/src/orchestrator/__tests__/mention-router.layer3.test.ts`（gray-zone）
- Test: `packages/api/src/orchestrator/__tests__/mention-router.on-behalf.test.ts`
- Test: `packages/api/src/orchestrator/__tests__/mention-router.rate-limit.test.ts`
- Test: `packages/api/src/orchestrator/__tests__/mention-router.red-cases.test.ts`（历史事故）

**Step D.1 Red · Layer 1 hard-negative（7 场景）**：
- code block 内 @X → 0 派发
- inline code `@X` → 0 派发
- blockquote `> @X` → 0 派发
- table 单元格 `| @X |` → 0 派发
- `**@X**` / `*@X*` 装饰性 → 0 派发
- `@X 是 Y` / `与 @X 讨论` 介绍句式 → 0 派发
- `at X` 英文代词 → 0 派发
- **2026-04-22 15:30 代码块示例翻车 red-case fixture**
- **2026-04-22 16:05 `**@范德彪**` 翻车 red-case fixture**
- **2026-04-23 Round 2 讨论 LL-028 级联事故 red-case fixture**

**Step D.2 Green · Layer 1**：Markdown-AST 集成（remark-parse）+ 介绍句式规则 + 英文代词词典

**Step D.3 Red · Layer 2 hard-positive**：
- 行首 `@X + 动词`（看/帮/做/写/review/...）→ 派发
- 行首 `@X?` / `@X？` 问句 → 派发
- 行首 `@X + 任务描述` → 派发
- 非行首 `@X`（句中）→ 不派发（降级 Layer 3）

**Step D.4 Green · Layer 2**：行首正则 + 动词词典

**Step D.5 Red · Layer 3 gray-zone**：
- 灰区消息默认不派 + 记 debug 日志
- 带 `@X` 但无动作上下文 → gray-zone

**Step D.6 Green · Layer 3**：fail-closed 默认分支 + 日志

**Step D.7 Red · on-behalf 反推**：
- 「@B **帮**小孙 review」→ `on_behalf_of=小孙, convener_id=小孙`
- 「@B **代**我问问」→ `on_behalf_of=caller, convener_id=caller`
- 「@B（仅 X 参考）」→ `on_behalf_of=X, convener_id=A`（不豁免）
- 无信号 → `on_behalf_of=null, convener_id=parent.issuer`
- 冲突信号（「帮 X 和 Y」）→ fail-closed `on_behalf_of=null`

**Step D.8 Green · on-behalf**：外挂 YAML 词典 + 规则 parser

**Step D.9 Red · 反循环 & 去重**：
- 同 `(source, target)` 31 秒内第二次派发 blocked + 记日志
- 单消息内 3 次 `@X` → 1 次派发

**Step D.10 Green · rate-limit**：DB `last_dispatch_at` + 单消息 dedup Set

**Step D.11 Commit（分多个小 commit，每 layer 一个）**：
- `feat(F026-P1): mention-router Layer 1 hard-negative (ADR-003)`
- `feat(F026-P1): mention-router Layer 2 hard-positive (ADR-003)`
- `feat(F026-P1): mention-router Layer 3 gray-zone fail-closed (ADR-003)`
- `feat(F026-P1): mention-router on-behalf semantic inference (ADR-003)`
- `feat(F026-P1): mention-router anti-loop 30s + single-message dedup (ADR-003)`

---

### Task E · `envelope-builder.ts` 出站钩子（1.5 天）

**Files**：
- Create: `packages/api/src/orchestrator/envelope-builder.ts`
- Test: `packages/api/src/orchestrator/__tests__/envelope-builder.test.ts`

**Step E.1 Red**：
- 给定 agent A 当前 call stack + mention-router 输出 + 消息原文 → 返回完整 Envelope v1
- protocol 层 8 字段全填；task.task === "conversation"；task.input.source_message === 原文；render.displayMode === "nested"（有 parent）/ "inline"（无 parent）
- `envelope_version === "v1"`
- β 路径测试：不抽取 task.input（除 source_message 以外全 null）

**Step E.2 Green**：最小实现（查 call-registry + 查总线 + 组装 Envelope）

**Step E.3 Red · γ 路径集成**：
- `cross-role-handoff` skill 调用 → envelope-builder 收到 skill task 参数 → 透传到 envelope.task
- γ 路径 envelope.task.task !== "conversation"

**Step E.4 Green · γ 路径**：skill 参数 → envelope.task 映射

**Step E.5 Commit**：`feat(F026-P1): envelope-builder β/γ dual path (ADR-004)`

---

### Task F · 入口接入（1 天）

**Files**：
- Modify: `packages/api/src/orchestrator/dispatch.ts`（调用 call-registry.openCall + envelope-builder）
- Modify: `packages/api/src/mcp/server.ts`（`trigger_mention` / `post_message` 入口返回 call_id）
- Test: `packages/api/src/orchestrator/__tests__/dispatch.call-registry-integration.test.ts`

**Step F.1 Red**：
- `dispatch.ts` 集成后，每次派发返回 call_id 可在 call-registry 查到
- trigger_mention MCP 返回 `{ call_id }`
- post_message 返回 `{ call_id }`

**Step F.2 Green**：dispatch / MCP 接 call-registry + envelope-builder

**Step F.3 Commit**：`feat(F026-P1): wire call-registry into dispatch + MCP entries`

---

### Task G · 双轨 feature flag（0.5 天）

**Files**：
- Modify: `packages/api/src/config/feature-flags.ts`（新增 `A2A_CALL_TREE_ENABLED` flag）
- Modify: `packages/api/src/orchestrator/dispatch.ts`（flag 分支）

**Step G.1**：flag 默认 off；测试时 on

**Step G.2**：旧 return-path 保留；新 call-tree 路径并行（Phase 2 全量切，Phase 2+2 周下线旧）

**Step G.3 Commit**：`feat(F026-P1): A2A_CALL_TREE_ENABLED dual-rail flag`

---

### Task H · Phase 1 diff 门禁 + quality-gate（0.5 天）

**Files**：
- Create: `scripts/ci/check-agent-prompt-diff.sh`（ADR-004 diff 门禁）
- Modify: `.github/workflows/ci.yml`（加 check）

**Step H.1**：脚本对 `CLAUDE.md / GEMINI.md / AGENTS.md / agent-prompts.ts` 四个文件 diff main 检查

**Step H.2**：CI workflow 加 job

**Step H.3**：自己跑一次 `pnpm test --filter @multi-agent/api` + `pnpm typecheck` + `pnpm lint` 全绿

**Step H.4**：进 `quality-gate` skill 自检

**Step H.5 Commit**：`chore(F026-P1): ADR-004 diff guard + quality-gate pass`

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Markdown-AST 引入 remark-parse 包体积大 | 中 | 性能 | 仅 mention-router 加载；前端不引 |
| on-behalf 词典冷启动漏词 | 高 | 语义豁免漏判 | fail-closed 默认严格分级，漏判不产生错误派发；词典持续补 |
| call-registry 并发下 CAS 死锁 | 低 | 数据 | SQLite WAL 模式 + busy_timeout；fuzz 并发测试覆盖 |
| 双轨 flag 切换期间数据不一致 | 中 | 数据 | 切换窗口内禁止新 A2A；等所有在飞 call 完成再切（同 F026 spec 风险表） |
| agent-prompts.ts 被无意触碰 | 中 | ADR 违反 | diff 门禁 CI 卡；Phase 1 reviewer 显式检查 |

---

## Out of Scope（明确）

- ❌ R-184 根治（Phase 2）
- ❌ Burst / Tombstone / rollingSummary 生成器（Phase 3 · Phase 1 envelope-builder 仅**引用**总线上下文，不自己生成）
- ❌ 前端溯源胶囊 / 折叠群组 / 淡紫色（Phase 5）
- ❌ `/debug/a2a` UI（Phase 5）
- ❌ 灰区 Layer 3 LLM 分类器（Phase 5）
- ❌ 推翻 Phase 0 的四条止血补丁（Phase 0 保留）

---

## 工期估算

| Task | 工期 |
|---|---|
| A. Envelope schema | 0.5 天 |
| B. a2a_calls migration | 0.5 天 |
| C. call-registry | 2 天 |
| D. mention-router 三层 + on-behalf + rate-limit | 3 天 |
| E. envelope-builder β/γ | 1.5 天 |
| F. 入口接入 | 1 天 |
| G. 双轨 flag | 0.5 天 |
| H. diff 门禁 + quality-gate | 0.5 天 |
| **缓冲 / 集成 bug** | 0.5-2 天 |
| **合计** | **9.5 - 11 天**（2 周） |

## Completion Gate（Phase 1 完成条件）

1. 上面所有 AC 打勾
2. `pnpm --filter @multi-agent/api test` 全绿（包含所有新增测试）
3. `pnpm typecheck` + `pnpm lint` 全绿
4. `scripts/ci/check-agent-prompt-diff.sh` 在 CI 通过
5. ADR-002 / ADR-003 / ADR-004 标记 Accepted（已做）
6. Phase 1 自检报告入 `.agents/acceptance/F026-phase1/` 本地证据
7. **不 merge dev**（`feedback_feature_completion_before_merge` · Phase 级中间 commit 留 worktree；整个 F026 全 Phase 完 + acceptance-guardian 通过后统一 merge）

— 黄仁勋 [Opus-47 🐾] · 2026-04-23
