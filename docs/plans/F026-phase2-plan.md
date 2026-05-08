# F026 Phase 2 — Return-path → Worklist 执行器改造（R-184 根治 · Gateway Wire · ADR-004 清理）

> **⚠️ SUPERSEDED · 2026-05-06**
> 本 Phase 2 plan（ParallelGroup 状态机 + DiscussionCoordinator + Phase1/2 header）
> 被 **F026 P2 Clean-Cut**（`docs/plans/F026-P2-clean-cut-plan.md`）整套取代并删除：
> Step 3+4 (`bc99441`) 删 ParallelGroup + parallel_think + phase1-header；
> Step 5 (`040e3c1`) 删 phase2-header + DiscussionCoordinator + 结论卡片。
> 留 stub `hasActiveParallelGroupInSession() => false` 保留 F002 SettlementDetector
> 导出名兼容（信号 1 退化为常 false）。本文档仅作历史参考。

**Feature:** F026 — `docs/features/F026-a2a-reliability-layer.md` (v2)
**Goal:** 废 F003 `return-path` new-invocation 改为同 routeSerial worklist 续推（R-184 根治 · I2-a）；把 Phase 1 的 `A2AGateway` 接入 `dispatch.ts` happy path（flag-gated 双轨）；强化 ADR-004 硬约束不被破坏。
**Architecture:**
- 新增 `planWorklistAdvance`（纯函数）替代 `planReturnPathDispatch` 的 new-invocation 路径
- `message-service.ts` 新增 `runWorklist(routeSerial, startIndex)` 执行器 — 同一 routeSerial 内 `worklist[++index]` 续推不产生第二行 DB message
- `dispatch.ts` happy path 入口按 `A2A_CALL_TREE_ENABLED` flag 分流到 `A2AGateway.planBetaDispatch` 或旧 mention-router
- `a2a-chain.ts` 补 `senderAlias + triggerMessageId` 渲染字段（兼容旧数据 optional）
- `scripts/ci/check-adr-004-diff.sh` 扩展内容层 grep（禁词 `Direct message from / a2aFrom`），不仅看 diff size
- `packages/api/src/__tests__/a2a-replay/R-184.test.ts` 新建 replay harness

**Tech Stack:** TypeScript · node:test · node:sqlite · drizzle-orm · zod
**Phase Dependencies:** P1 已落（12 commit · 1058/1058 API 测试绿 · 77/77 前端绿 · typecheck 绿）
**Phase 下游**：P3（Context 改造）依赖 P2 worklist 续推 · P4（DB 下沉）依赖 P2 Gateway wire · P5（前端栏）依赖 Envelope 全链路通透

---

## Out of Scope（明确 · 防 scope 漂移）

- ❌ Burst / Tombstone / rollingSummary 生成（P3）
- ❌ 前端溯源胶囊 / 折叠群组 / 并列卡片 / 淡紫色（P5）
- ❌ `a2a-chain.ts` 的内存 Map 下沉 SQLite（P4 · Phase 2 仅扩字段）
- ❌ `context-snapshot.ts` / `context-assembler.ts` 重写（P3）
- ❌ `/debug/a2a` UI（P5）
- ❌ 灰区 Layer 3 LLM 分类器（P5）
- ❌ 旧 `planReturnPathDispatch` 代码删除（P2 合并 + 2 周观测期后在 P2.5 清理）
- ❌ MCP `trigger_mention` / `post_message` 返回 callId（Phase 1 Task F 已部分接入 gateway；完全替换 P4）

---

## Acceptance Criteria（Phase 2）

覆盖 F026 spec I2-a / I2-b / I11（加强 · diff 门禁升级为内容 grep）+ 部分 I6（dispatch 入口返回 callId）。

### I2-a · 同 turn 单行 DB message（R-184 根治）

- [ ] `planWorklistAdvance(input)` 纯函数：给定 childInvocation 完成结果 + 当前 worklist 状态，返回 `{ nextIndex, nextItem }` 或 `null`（全部完成）
- [ ] `runWorklist` 执行器在同一 routeSerial 内推进，不调用 `createInvocation` / `insertMessage` 第二次
- [ ] R-184 replay fixture：模拟「@A → A 调 B → B 返回 → A 继续同一 turn」，断言 DB `messages` 表只有 1 条 A 的 assistant 消息 + 1 条 B 的 assistant 消息（**不是** A 两条拆行）
- [ ] replay 在 flag on 路径必绿；flag off 路径保留旧行为用作回归基线

### I2-b · Worklist 续推降级为执行器细节

- [ ] 新代码里 `worklist[++index]` 推进仅作为实现手段，**不**在 Call Tree 真相源（`call-registry`）里记录 worklist 状态
- [ ] `a2a_calls` 表不引入 `worklist_index` 字段（保护 Call Tree 纯度）

### I11 · A2A 对 agent 透明（加强）

- [ ] `check-adr-004-diff.sh` 升级：除 diff 行数检查外，扫描 `packages/api/src/runtime/agent-prompts.ts` 内容不得包含 `/Direct message from|a2aFrom|triggerMessage/i`
- [ ] `a2a-chain.ts` 新字段 `senderAlias + triggerMessageId` 仅供**前端渲染**读取；不写入 agent system prompt
- [ ] Phase 2 diff 自动校验：`git diff dev -- CLAUDE.md GEMINI.md packages/api/src/runtime/agent-prompts.ts` 为空或仅删除

### I6 · callId 贯穿 dispatch 入口（局部）

- [ ] `dispatch.ts` happy path flag-on 分支返回 `{ callId, dispatched: boolean }`
- [ ] 旧路径不改返回签名（兼容）

### Gateway Wire

- [ ] `dispatch.ts` 的 mention dispatch 点当 `A2A_CALL_TREE_ENABLED=true` 时委派给 `planBetaDispatch`
- [ ] 集成测试：flag on 时 `call-registry` 的 `a2a_calls` 表有对应记录 + Envelope 结构校验通过
- [ ] 集成测试：flag off 时走旧路径，`a2a_calls` 表无记录（回归基线）

### a2a-chain 渲染字段扩展

- [ ] `A2AChainEntry` 类型补 `senderAlias?: string` + `triggerMessageId?: string`
- [ ] 现有 `register()` 调用点全部传入（grep 审计 + 补齐）

---

## 架构与模块

### 新模块 / 新建文件

```
packages/api/src/orchestrator/
  worklist-advance.ts                       # planWorklistAdvance 纯函数
  __tests__/worklist-advance.test.ts

packages/api/src/__tests__/a2a-replay/
  R-184-same-turn-single-row.test.ts        # R-184 replay harness（I2-a）
  fixtures/
    R-184-child-return.json                 # 固定场景：A→B→A 续推
```

### 修改模块

```
packages/api/src/orchestrator/
  return-path.ts                            # 加 flag 分支 — flag on 返回 null 让 worklist 接管
  a2a-chain.ts                              # 扩 senderAlias + triggerMessageId 字段
  dispatch.ts                               # happy path 接入 A2AGateway（flag-gated）

packages/api/src/services/
  message-service.ts                        # 新增 runWorklist 执行器；现有 flow 走 flag 分支

scripts/ci/
  check-adr-004-diff.sh                     # 加内容 grep 禁词检查
```

### 禁动文件（ADR-004 硬约束 · Phase 2 继续守）

```
CLAUDE.md
GEMINI.md
AGENTS.md (如存在)
packages/api/src/runtime/agent-prompts.ts   # 继续零 diff + 内容层 grep 禁词
```

---

## Task 拆分（TDD · 每 Task 独立 Red/Green commit）

### Task A · `a2a-chain.ts` 扩 senderAlias + triggerMessageId（0.5 天）

**Why first**：下游 Task C/D 依赖该字段；独立纯结构扩展，风险最低，先落。

**Files:**
- Modify: `packages/api/src/orchestrator/a2a-chain.ts`
- Test: `packages/api/src/orchestrator/a2a-chain.test.ts`（可能不存在，新建）

**Step A.1 Red**: 写测试 — 注册一条 entry 带 senderAlias + triggerMessageId，读出原值

**Step A.2 Run**: `pnpm --filter @multi-agent/api test -- a2a-chain` → FAIL (字段不存在 / 类型错)

**Step A.3 Green**: `A2AChainEntry` 加两个 optional 字段；`register` 保持同参数签名

**Step A.4 Run**: 同上 → PASS

**Step A.5 调用点审计**: grep `chainRegistry.register\(` 全仓补字段（若旧 call-site 无该信息则传 `undefined`，保持向后兼容）

**Step A.6 全量回归**: `pnpm --filter @multi-agent/api test` → 1058+ PASS

**Step A.7 Commit**: `feat(F026-P2 Task A): a2a-chain senderAlias + triggerMessageId render fields [黄仁勋/Opus-47 🐾]`

---

### Task B · `planWorklistAdvance` 纯函数（1 天）

**Files:**
- Create: `packages/api/src/orchestrator/worklist-advance.ts`
- Create: `packages/api/src/orchestrator/__tests__/worklist-advance.test.ts`

**Contract**:
```ts
export type WorklistItem = {
  invocationId: string
  alias: string
  status: "pending" | "running" | "done" | "failed"
}

export type WorklistAdvanceInput = {
  routeSerial: string
  items: WorklistItem[]      // 当前 worklist 快照
  completedIndex: number     // 刚完成的 index
  childResult: { ok: boolean; content: string }
}

export type WorklistAdvanceResult =
  | { kind: "advance"; nextIndex: number; nextItem: WorklistItem }
  | { kind: "done"; finalIndex: number }       // 全部完成
  | { kind: "halt"; reason: string }           // 失败 / 无后续
```

**Step B.1 Red · advance**: worklist 有 3 项 [A,B,C]，completedIndex=0，ok=true → `{kind:"advance",nextIndex:1,nextItem:B}`

**Step B.2 Red · done**: completedIndex=2（末尾），ok=true → `{kind:"done",finalIndex:2}`

**Step B.3 Red · halt on failure**: completedIndex=0，ok=false → `{kind:"halt",reason:"child-failed"}`

**Step B.4 Red · halt on empty content**: ok=true 但 content 空 → `{kind:"halt",reason:"empty-content"}`

**Step B.5 Red · index out of range**: completedIndex=5（越界） → `{kind:"halt",reason:"index-oob"}`

**Step B.6 Run**: FAIL (函数不存在)

**Step B.7 Green**: 最小实现 — switch 分支

**Step B.8 Run**: PASS（5/5）

**Step B.9 Commit**: `feat(F026-P2 Task B): planWorklistAdvance pure function (I2-b) [黄仁勋/Opus-47 🐾]`

---

### Task C · `dispatch.ts` 接入 `A2AGateway` 双轨 flag（1.5 天）

**Files:**
- Modify: `packages/api/src/orchestrator/dispatch.ts`
- Create: `packages/api/src/orchestrator/__tests__/dispatch.gateway-wire.test.ts`

**Step C.1 Red · flag on wire**: mock `A2A_CALL_TREE_ENABLED=true`，调 dispatch 带 `@黄仁勋 帮小孙 review` → `a2a_calls` 表 1 条记录（issuer=当前，convener=小孙，on_behalf_of=小孙），返回值含 callId

**Step C.2 Red · flag off bypass**: flag=false → 走旧 mention-router，`a2a_calls` 无新记录（或数量不变），返回旧签名

**Step C.3 Red · blocked by rate-limit**: 同 source/target 30s 内二次派发 → dispatched=0, blocked=1

**Step C.4 Red · gray-zone**: 「@黄仁勋 是个好同事」装饰句 → dispatched=0, grayZone 记录

**Step C.5 Run**: FAIL (未接 gateway)

**Step C.6 Green**: 在 dispatch 的 mention 派发点加 flag 分支，on 时调 `planBetaDispatch`；把结果转成原 dispatch 返回形态

**Step C.7 Run**: PASS（4/4）

**Step C.8 全量回归**: `pnpm --filter @multi-agent/api test` → 所有历史测试无回归

**Step C.9 Commit**: `feat(F026-P2 Task C): wire A2AGateway into dispatch happy path (flag-gated) [黄仁勋/Opus-47 🐾]`

---

### Task D · `message-service.ts` `runWorklist` 执行器（2 天）

**关键点**：同一 routeSerial 内 `worklist[++index]` 不产生第二行 DB message。

**Files:**
- Modify: `packages/api/src/services/message-service.ts`
- Create: `packages/api/src/services/__tests__/message-service.worklist.test.ts`

**Step D.1 Red · 同 routeSerial 续推不双写**:
- 构造 A→B 场景：A 生成 worklist=[B, continue]，B 完成回来
- 断言：DB `messages` 表 A 的 assistant message 只有 1 行（`routeSerial` 字段相同）
- 旧行为（flag off）对照：预期产生 2 行（或 new invocation）

**Step D.2 Red · worklist done 收尾**:
- worklist 最后一项完成 → A 的 content 应在原 message 上 append（或新 message 但不算 double-row bug，以 clowder 原版为准）
- 断言：routeSerial chain 完整，无孤儿

**Step D.3 Red · child 失败 halt**:
- B 返回失败 → `planWorklistAdvance` 返回 halt → A 不继续，不新 invocation

**Step D.4 Run**: FAIL (runWorklist 不存在)

**Step D.5 Green**: 实现 `runWorklist(routeSerial, startIndex)`：
- 查 worklist 状态（内存 Map · P4 下沉 DB）
- 调 `planWorklistAdvance` 决定 next
- next 为 advance → 复用同一 routeSerial 的执行 slot 推进（不 createInvocation）
- next 为 done → 标记 worklist 完成，触发 return-path 已废路径的替代（直接结算 call-registry）

**Step D.6 Run**: PASS（3/3）

**Step D.7 `return-path.ts` flag 分支**:
- flag on 时 `planReturnPathDispatch` 直接返回 null（让 worklist 接管）
- flag off 保留旧行为

**Step D.8 全量回归**: `pnpm --filter @multi-agent/api test` → 绿

**Step D.9 Commit**: `feat(F026-P2 Task D): runWorklist executor + return-path flag-off bridge (I2-a) [黄仁勋/Opus-47 🐾]`

---

### Task E · R-184 Replay Harness（1 天）

**Files:**
- Create: `packages/api/src/__tests__/a2a-replay/R-184-same-turn-single-row.test.ts`
- Create: `packages/api/src/__tests__/a2a-replay/fixtures/R-184-child-return.json`

**Step E.1 Red · fixture 模拟**:
- 读 fixture（预设 A→B→A 回程事件流）
- flag on + 完整 dispatch → runtime → runWorklist pipeline
- 断言 DB `messages` 表：
  - A 的 assistant message 恰好 1 条
  - B 的 assistant message 恰好 1 条
  - A 的 `content` 包含 B 回来后续推的自然语言（不是新 invocation prompt）
  - `routeSerial` 单调 — 所有消息同一 routeSerial

**Step E.2 Red · flag off 对照（regression baseline）**:
- 同 fixture，flag=false
- 记录当前行为（可能产生 2 行 A · R-184 原 bug），仅作 baseline 不断言绿（用 `it.todo` 或显式标注 known bug）

**Step E.3 Run**: FAIL (fixture 未建 / assert 未通过)

**Step E.4 Green**: 调 Task D 的 `runWorklist` + Phase 1 gateway → 串联跑通

**Step E.5 Run**: PASS（I2-a AC 绿）

**Step E.6 Commit**: `test(F026-P2 Task E): R-184 replay harness — same-turn single row (I2-a) [黄仁勋/Opus-47 🐾]`

---

### Task F · ADR-004 diff guard 升级（内容层 grep）（0.5 天）

**Files:**
- Modify: `scripts/ci/check-adr-004-diff.sh`
- Create: `scripts/ci/__tests__/check-adr-004-diff.negative.spec.sh`

**Step F.1 Red · negative case**:
- 临时在 `agent-prompts.ts` 加 `// Direct message from` 注释
- 跑脚本 → 预期退出非零 + 报错指向禁词
- 验完恢复

**Step F.2 Run**: FAIL (原脚本只看 diff 大小)

**Step F.3 Green**: 脚本末尾加：
```bash
FORBIDDEN_GREP_TARGETS=(
  "packages/api/src/runtime/agent-prompts.ts"
  "CLAUDE.md"
  "GEMINI.md"
)
FORBIDDEN_PATTERNS='Direct message from|a2aFrom|triggerMessage'
for f in "${FORBIDDEN_GREP_TARGETS[@]}"; do
  [[ -f "$f" ]] || continue
  if grep -iE "$FORBIDDEN_PATTERNS" "$f"; then
    echo "❌ ADR-004 violation: $f contains A2A protocol leakage"
    exit 1
  fi
done
```

**Step F.4 Run**: negative case FAIL；clean tree PASS

**Step F.5 Commit**: `chore(F026-P2 Task F): ADR-004 diff guard content-level grep (禁词 Direct message / a2aFrom / triggerMessage) [黄仁勋/Opus-47 🐾]`

---

### Task G · quality-gate 自检 + Phase 2 完结（0.5 天）

**Step G.1**: `pnpm typecheck` 全仓绿

**Step G.2**: `pnpm --filter @multi-agent/api test` 全绿（含 R-184 replay + gateway-wire + worklist + a2a-chain）

**Step G.3**: `pnpm --filter @multi-agent/web test` 77/77 绿（前端无触碰）

**Step G.4**: `pnpm lint` 无新增 warning

**Step G.5**: `bash scripts/ci/check-adr-004-diff.sh` 绿（diff + 内容 grep 双层）

**Step G.6**: 写 Phase 2 自检报告 `.agents/acceptance/F026-phase2/quality-gate-report.md`（worktree 本地 · 进 .gitignore 不入历史）

**Step G.7**: 进 `quality-gate` skill 正式走一遍

**Step G.8 Commit**: `chore(F026-P2 Task G): Phase 2 quality-gate pass + acceptance report [黄仁勋/Opus-47 🐾]`

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| `message-service.ts` 是主干，改 runWorklist 回归面大 | 高 | 核心路径 | 双轨 flag 默认 off；Phase 2 内新代码仅 flag on 激活；全量测试跑 1058+ |
| worklist 状态丢失（进程重启） | 中 | 数据 | Phase 2 内存 Map（同 a2a-chain 现状）；P4 下沉 DB |
| R-184 replay fixture 构造不准 | 中 | AC 假绿 | 对照 clowder `route-serial.ts:1290` 原版流程逐步对齐；replay 跑 flag off 记录 bug baseline 形成正反对照 |
| `planReturnPathDispatch` flag 改了但调用点没覆盖全 | 中 | 旧路径漏切 | grep `planReturnPathDispatch` / `return-path` 全仓审计；Task D.7 单独审一遍 |
| agent-prompts.ts 禁词 grep 误杀（如注释里提及） | 低 | CI 噪音 | grep 范围限注入字符串区（若有分区）或允许显式 `// allow-a2a-mention` 白名单 pragma |
| Phase 2 内新测试引入 DB 竞态（Phase 1 已遇） | 中 | CI flake | 沿用 Phase 1 策略：pre-commit 重试 / 每测试 fresh sqlite temp file |

---

## Completion Gate（Phase 2 完成条件）

1. 本文件所有 AC 打勾
2. `pnpm --filter @multi-agent/api test` 全绿（含新增 ~25 条测试 · Task A 3 + Task B 5 + Task C 4 + Task D 3 + Task E 2 + gateway integration 8 ≈ 1083/1083）
3. `pnpm typecheck` + `pnpm lint` 全绿
4. `bash scripts/ci/check-adr-004-diff.sh` 双层绿（diff + 禁词）
5. R-184 replay `kind:"advance"` 路径断言单行 DB message 通过
6. `.agents/acceptance/F026-phase2/` 本地自检报告齐全（quality-gate-report.md + typecheck.log + test-api.log）
7. **不 merge dev**（`feedback_feature_completion_before_merge` · Phase 级中间 commit 留 worktree；F026 整体完 + acceptance-guardian 通过后统一 merge）

---

## 工期估算

| Task | 工期 |
|---|---|
| A. a2a-chain 扩字段 | 0.5 天 |
| B. planWorklistAdvance 纯函数 | 1 天 |
| C. dispatch 接入 A2AGateway（flag-gated） | 1.5 天 |
| D. message-service runWorklist 执行器 | 2 天 |
| E. R-184 replay harness | 1 天 |
| F. ADR-004 diff guard 内容 grep | 0.5 天 |
| G. quality-gate 自检 | 0.5 天 |
| **缓冲 / 集成 bug** | 1-2 天 |
| **合计** | **8-9 天（~1.5 周）** |

---

— 黄仁勋 [Opus-47 🐾] · 2026-04-24
