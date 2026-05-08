# F026 收尾线 Plan · 2026-04-29 v1

> **⚠️ DoD-2 双轨观察期已 OBSOLETED · 2026-05-06**
> DoD-2 写于 P3 方案 X 实现前，假设走「flag 默认关 → 双轨 2 周 → flag 删」路径。
> 实际后续演化：F026 P3 Round 2 → P3.1 retry-guard → P2 Clean-Cut（v1 plan
> `docs/plans/F026-P2-clean-cut-plan.md` Step 1-7）已直接删除 `A2A_CALL_TREE_ENABLED`
> flag + return-path 旧路径（`c0f2792`），单轨直切，跳过双轨观察阶段。
> grep `A2A_CALL_TREE_ENABLED` 命中数 = 0。
> 本 plan 中 DoD-2/3 章节仅作历史参考，cleanup 子任务已并入 P2 Clean-Cut。

> **来源**：
> - 小孙 14:30 — "我们目前 feature 已经做完，我们偏离愿景了吗？你审视了没有（不仅仅是考虑 P4/P5，你要审视整个 feature）"
> - 黄仁勋 14:30 — quality-gate 愿景对照（结论：方向没偏 + 5 条 drift）
> - 小孙 14:34 — 拍 [A] 诚实路径
> - 小孙 14:45 — 修正：「**A 10 和 11 可以不用了 不合 dev，然后我们做完 达到愿景了，不会双轨，会把之前的删掉**」
>
> **范围**：F026 整 feature 收尾 — spec DoD 真实合规 + 14 症状回归补齐 + P1 wiring debt 孤岛审视 + 愿景实测 + spec DoD-3 旧路径清除。
>
> **Worktree**：`.worktrees/F026-p0` · branch `feat/F026-p0-a2a-stabilize` · 109 commits ahead of dev · **不合 dev**（小孙 14:45 明示）。

---

## Why · 5 条 drift（14:30 愿景对照已查）

| Drift | 内容 | 状态 |
|---|---|---|
| 1 | 14 症状回归测试只有 6/14 有专项 replay test（P5/P7/P9/P13 真空白） | 本 plan Step 2 |
| 2 | spec 所有 AC 仍 `[ ]` 未勾（quality-gate skill 没正式跑过） | 本 plan Step 4 |
| 3 | spec DoD-1「全 feature 代码孤岛审视」未做 — R-051/053/054/065/066 持续暴露的根因 | 本 plan Step 3 |
| 4 | 体感场景定义太窄 — spec 字面 AC 绿但日常错乱率没归零 | 本 plan Step 5 |
| 5 | P3 方案 X + P3.1 retry guard 真相 | ✅ 已写进 spec（追认完成） |

---

## 收尾 6 件大事（按依赖顺序）· 砍掉合 dev / 双轨

| Step | 任务 | 估时 | spec 锚点 |
|---|---|---|---|
| 1 | 写本 plan 落盘 | 本轮 | — |
| 2 | 补 P5/P7/P9/P11/P13 **五条** replay test（含 P11 孤儿消息 95% 最高频） | ~2.5d | spec line 408 DoD-1 |
| 3 | P1 Wiring Debt 孤岛审视 | ~1d | spec line 279-294 + 414-419 |
| 4 | quality-gate 全 AC 正式勾选 | ~0.5d | spec line 408-419 整章 |
| 5 | acceptance-guardian 实测愿景（含 R-051/053/054/065/066） | ~0.5d | spec line 408 + 家规铁律 14 |
| 6 | **老路径删除**（spec DoD-3） | ~0.5d | spec line 428-444 |
| ~~7~~ | ~~merge dev~~ | — | **❌ 小孙 14:45 明示砍** |
| ~~8~~ | ~~双轨 2 周观察期（DoD-2）~~ | — | **❌ 小孙 14:45 明示砍** |

**累计 ~3 工作日 + 3 条 spec drift 待小孙裁决**（v3 实测后修正）

> **v1 → v2 → v3 修正记录**（2026-04-29 多轮实测）：
> - v1（plan 落盘）：估 3.5d 基于"P5/P7/P9/P13 4 条"
> - v2（症状盘点）：发现写漏 P11（95% 最高频），改 5 条 + 估时 +1.5d → 5d
> - **v3（深核实现）**：5 条里只 **2 条**（P5/P13）是 TDD 闭环可做；**3 条**（P7/P9/P11）是 **spec 描述与代码 by-design 冲突的 spec drift**，必须小孙拍方向
>
> ### 5 条深核结果
>
> | 症状 | 实现状态 | 处理 | 估时 |
> |---|---|---|---|
> | **P5 空壳 10.84%** | ✅ CallRegistry deadline_at + STALE 双档 + onTimeout cb 已实现（call-registry.ts:227-241） | TDD：fake-runtime 12 字节断流 → assert deadline 后 onTimeout 触发 NACK | ~0.5d |
> | **P7 Phase 越界** | ❌ "Phase 状态机" 抽象在 F026 代码里**根本不存在**（grep 0 命中） | **spec drift**：spec line 139 P7 描述是 P0 时代 placeholder，整个 feature 范围内 Phase 状态机没设计 | 待裁决 |
> | **P9 tool-use 打断 9.25%** | ❌ `burst-context.ts:96` 注释明说「Multi-Agent 没有 toolEvents，跳过 clowder 的 tool_use→tool_result 保护」 | **spec drift**：spec line 140 P9 AC 与代码 by-design 冲突 | 待裁决 |
> | **P11 孤儿 95% 🔥** | ❌ `appendContentBlock` 只服务 image block (screenshot)，LLM stream 不写 contentBlocks，95% 是 text-only message 的 by-design | **spec drift**：spec line 141 P11 "content_blocks 回填（依赖 I4）"未在 I4 实施 | 待裁决 |
> | **P13 时序错乱** | ⚠️ SQLite created_at 自动 ISO 写入但无单调守护；同毫秒并发 INSERT 可能 ordering 不确定 | TDD：并发 dispatch fuzz → assert created_at 单调（如失败需补 sequence 字段） | ~0.5d |
>
> ### 3 条 spec drift 待小孙拍方向
>
> #### P7 Phase 越界
> - **A** · 删 P7 from 14 症状（spec drift 是 placeholder 残留）→ 14 症状缩为 **13 类**
> - **B** · 重新定义 P7 = thread-id-lookup 边界守护（已有相关实现）→ 改 spec line 139 描述 + 加 replay test
> - **C** · 真做 Phase 状态机（大改造，1+ 周工作量）
>
> 倾向 **B**——thread-id-lookup 测试已存在（tnead-id-lookup.test.ts），只需改 spec 描述使其指向已有实现即可。
>
> #### P9 tool-use 打断
> - **A** · 改 spec 描述「Multi-Agent 不做 tool_use 保护，由 burst Q→A 链保护替代」→ 加 replay test 断言 Q→A 链保护生效
> - **B** · 真接 toolEvents 做 tool_use→tool_result 保护（中型改造，3-5d）
> - **C** · 删 P9 from 14 症状
>
> 倾向 **A**——burst-context.ts:94-96 已经有 Q→A 链保护，是 Multi-Agent 的语义化替代方案，应该让 spec 反映这个设计决策。
>
> #### P11 孤儿 95%
> - **A** · 改 spec 描述「text-only message 95% content_blocks=[] 是 by-design；只在富文本附件（image / structured tool_use）时写入」→ 加 contract test 断言 image block 路径写入
> - **B** · 真做 LLM stream 写入回填（assistant final 时把 content 派生成 text block 写入 content_blocks）→ 中型改造（影响主写入路径），需考虑下游兼容
> - **C** · 删 P11 from 14 症状
>
> 倾向 **A**——95% 是 text-only message 的本性，"孤儿"称呼是 spec 过度敏感；前端 fallback 已经在 content 字段上正确渲染，没体感影响。
>
> ### 修正后真欠账
>
> - **TDD 闭环可做**：P5 / P13（共 1d）
> - **spec drift 决策**：P7 / P9 / P11（小孙拍后批量修 spec + 加简化 test）
> - 修正后预计：spec 改 +0.5d / 5 条 test 落 +1d / 总 Step 2 = ~1.5d（比 v2 的 2.5d 反而少 1d）

---

## Step 1 · 写 Plan 落盘 · 本轮

- 产物：本文件
- 退出条件：plan 落盘 + 小孙不否决（默认通过）

---

## Step 2 · 补 P5/P7/P9/P11/P13 五条 replay test · ~2.5d

**Why**：spec line 408 DoD-1 自列「14 症状全部有对应回归测试」。

**真实审计结果**（2026-04-29 实测 grep + 文件深核）：

### 已 lock 9/14 — 追认 ✅

| 症状 | spec AC line | 命中测试 |
|---|---|---|
| M1 R-184 双消息 | 129 | `__tests__/a2a-replay/R-184-same-turn-single-row.test.ts` |
| M2 R-185 乱码 | 130 | `__tests__/a2a-replay/R-185-utf8-boundary.test.ts` |
| M3 R-190 @ 不生效 | 131 | `mention-router.{layer1,layer2,layer3,call-tag,role-guard,on-behalf,rate-limit,detect-invalid-dispatch}.test.ts`（7 文件 fail-closed 全覆盖） |
| M4 R-188 不收敛 | 136 | `discussion-coordinator.test.ts` + `discussion-concluded-event.test.ts` + `discussion-recorder.test.ts` |
| M5 payload | 153 | `__tests__/a2a-replay/M5-payload-fuzz.test.ts` + `R-034-payload.test.ts` |
| M6 retry 兜底 | 145 | `dispatch-retry-coordinator.test.ts` + `dispatch-retry-event.test.ts` + `messages-retry-count.test.ts` |
| **P6 窜房间 14.38%** | 138 | `ws-routing.test.ts:86` fuzz 10000 events 0 leakage to room-B |
| P12 重复派发 | 142 | `callbacks.post-message-lockout.test.ts` + `post-message-dedup.test.ts` |
| P14 MCP 静默 | 144 | `callbacks.trigger-mention-error.test.ts` |

### 真欠账 5/14 — 必补

| 症状 | spec AC | 已有兜底实现 | 缺什么 |
|---|---|---|---|
| **P5 空壳 10.84%** | line 137：fake-runtime 12 字节断流 30s NACK | post-final lockout + dedup gate（dispatch 路径未覆盖 timeout 死循环） | replay test：fake-runtime 注入 12 字节 + 断流 → assert 30s NACK |
| **P7 Phase 越界** | line 139：Phase 状态机 CAS 转移单调 | 不确定有无（grep 0 命中） | 先实测查实现 → 再写 replay |
| **P9 tool-use 打断 9.25%** | line 140：tool_use 期间新 @ 不破坏状态机 | burst-context 接力（无 tool_use interrupt 专项） | replay test：tool_use 中插入 @ → assert 状态机不破坏 |
| **P11 孤儿消息 95% 🔥** | line 141：content_blocks 回填（依赖 I4） | 不确定有无（grep 0 命中） | 先实测查实现 → 再写 replay |
| **P13 时序错乱** | line 143：DB created_at 单调 fuzz | a2a_calls deadline_at（一般 ordering 测试缺） | replay test：并发 dispatch fuzz → assert created_at 单调 |

**TDD**：每条先 grep/读现有兜底 → 没实现就先实现 → 写最小复现 case → 失败（红）→ 跑兜底 → 绿。

**P11 优先级最高**（95% 频率 + grep 0 命中 = 可能根本没实现），先做。

**退出条件**：
- 5 条新 test 文件落盘 `__tests__/a2a-replay/P{5,7,9,11,13}-*.test.ts`
- `pnpm test:api` 全绿
- 14 症状专项覆盖率从 9/14 → **14/14**

---

### v4 修订（2026-04-29 15:47 · 小孙拍 BA · 跨 session 重审实证后）

**重审用 worktree 实证替代 dev 全局 grep（v3 用了错的搜索范围，v4 修正）**：

| 症状 | v3 判定 | v4 worktree 实证 | v4 处置 |
|---|---|---|---|
| **P5 空壳 10.84%** | TDD 闭环 ~0.5d | `call-registry.test.ts:213` I4 timeoutScan + `p4-restart-recovery.test.ts:108-110` 重启清扫已绿；fake-runtime e2e 缺 | **小孙 [Q1=B] 跳 e2e** — unit + 重启恢复已覆盖核心不变量 |
| **P7 Phase 越界** | spec drift / 不存在 | `call-registry.test.ts:206` 「cannot re-advance to working from working (CAS)」+ `:154` 「settle is idempotent on terminal state」**已 lock** | spec 改写明：P7 = call lifecycle CAS 单调 = 已 lock，不补新 test |
| **P9 tool-use 打断 9.25%** | spec drift / by-design | `burst-context.ts:96` 注释明说「Multi-Agent 没 toolEvents 跳过 clowder tool_use 保护」，spec 真意 = 状态机不破坏，由 call-registry CAS 兜底 | spec 改写明：P9 由 CAS 兜底（同 P7 同源）= 已 lock，不补新 test |
| **P11 孤儿 95% 🔥** | spec drift / by-design | schema `content_blocks` + repo `appendContentBlock` 已实现服务 image block；`message-service.ts:808` LLM 文本流写入硬编码 `'[]'` **没回填** | **小孙 [Q2=A] 真做** — 改 LLM stream 主写入路径回填 content_blocks |
| **P13 时序错乱** | TDD 闭环 ~0.5d | F026 改动 grep 0 个 created_at 单调 fuzz test | 真欠账，TDD 写 fuzz test |

**v4 收尾真账**（替代 v3 的"5 条全补"）：

| 任务 | 工作量 | 优先级 |
|---|---|---|
| **P11 LLM 文本流回填 content_blocks**（动 message-service 主写入路径 + contract test） | ~0.5-1d | 🔥 95% 频率最高 |
| **P13 created_at 单调 fuzz test**（同毫秒并发 dispatch 不乱序） | ~0.5d | 独立、无风险 |
| **spec 改写明 P5/P7/P9 处置** | 0.1d | 顺手 |

**Step 2 估时 v4：~1.5d**（v3 原 ~2.5d，省 1d）。

**执行顺序**：先 P13（独立、低风险、~0.5d）→ 再 P11（动主写入路径，需跑全回归，~0.5-1d）→ 再 spec 改写。

**P11 实施步骤（TDD）**：
1. 红：写 contract test `__tests__/a2a-replay/P11-content-blocks-backfill.test.ts` — 模拟 LLM 文本响应 → assert DB 中 `content_blocks` 不为 `[]`
2. 绿：改 `message-service.ts:appendAssistantMessage` 接收 contentBlocks 参数 + LLM stream 收到 text block 时 push 到 contentBlocks 数组 + 写库时序列化
3. 重构：检查 `appendContentBlock`（image block 独立路径）是否需要协调
4. 全回归：`pnpm test:api` + `pnpm vitest run` + 手验现有 assistant 消息渲染没坏

### v4 Step 2 落地（2026-04-30 · 全绿） ✅

**P13 done**（独立 / 低风险）：
- ✅ `__tests__/a2a-replay/P13-created-at-monotonic-fuzz.test.ts` — 6 case（I1 / I1-stress ANALYZE / I2 多读稳定 / I3 跨 close-reopen / I4 真实 burst / I5 ANALYZE+PRAGMA optimize）
- ✅ `session-repository.ts` 3 处 `ORDER BY m.created_at` 加 `, m.rowid` 显式 tiebreaker（listMessages / listMessagesSince / listRecentMessages）
- ✅ `session-repository-drizzle.ts` 同 3 处加 `sql\`rowid ASC/DESC\``
- ✅ `call-registry.ts` 5 处加 `, rowid ASC` tiebreaker（computePendingSet / pendingOf / getTree / findByStatus / getSessionTrees）
- 实证：测试始终绿（SQLite 隐式 rowid 契约成立），但 `CREATE TABLE ... AS SELECT ORDER BY id` 这类 migration 会破 rowid 顺序；显式 tiebreaker 把契约硬化

**P11 done**（动主写入路径 · 真做）：
- ✅ `__tests__/a2a-replay/P11-content-blocks-backfill.test.ts` — 6 case（I1 单 text / I2 thinking+text / I3 与 image 块 merge / I4 空内容→空数组 / I4-edge null/损坏 JSON 兜底 / I5 端到端 round-trip）
- ✅ 新建 `services/content-blocks-derive.ts` — `deriveContentBlocks` + `mergeDerivedWithExistingBlocks` 两个纯函数
- ✅ `message-service.ts` final flush (L1842) + error flush (L2057) 接派生 + merge（保留独立 image 块）
- ✅ `session-service.getContentBlocksJson` + `session-repository(-drizzle).getContentBlocksJson` 双源同步 helper

**全回归**：`pnpm test:api` **1036/1036 绿** · typecheck 0 errors。

**spec 改写完**：`F026-a2a-reliability-layer.md` 14 症状表 P5/P7/P9/P11/P13 五条勾选 + 注释处置 + Timeline 落 2026-04-30 一行。

---

## Step 3 · P1 Wiring Debt 孤岛审视 · ~1d

**Why**：spec line 279-294 自列；R-051/053/054/065/066 持续暴露的根因 = 孤岛代码（库写完没接生产）。

### 3.1 · grep 4 个关键符号生产命中

```bash
# 在 worktree 里跑（packages/api/src 排除 .test.ts / __tests__）
grep -rn 'convenerId\|convener_id' packages/api/src --include='*.ts' \
  --exclude='*.test.ts' --exclude-dir=__tests__
grep -rn 'openCall' packages/api/src --include='*.ts' \
  --exclude='*.test.ts' --exclude-dir=__tests__
grep -rn 'settle\b' packages/api/src --include='*.ts' \
  --exclude='*.test.ts' --exclude-dir=__tests__
grep -rn 'pendingOf' packages/api/src --include='*.ts' \
  --exclude='*.test.ts' --exclude-dir=__tests__
```

**预期**：每个符号生产命中 ≥1（命中 0 = 孤岛，必须接线或删）。

### 3.2 · spec line 286-289 列出的 3 项 wiring（未勾）

- [ ] `dispatch.ts` 派发时调 `call-registry.openCall(...)` 写入 `a2a_calls` 表（含 `convenerId`）
- [ ] 回程 settle（target final 时把 callId 标 done + 触发 convener 收敛）
- [ ] MCP `trigger_mention` / `post_message` 入口同样接 `openCall`（spec 第 259 行 I6 callId 贯穿口径）

### 3.3 · 审视范围扩到全 feature 新模块（spec line 417 列出）

| 模块 | 检查点 |
|---|---|
| `call-registry.ts` | `openCall` / `settle` / `pendingOf` / `getTree` 在生产代码有调用 |
| `envelope-builder.ts` | Envelope v1 字段（reply_to / parent_call_id / on_behalf_of）真在 dispatch 写库 |
| `burst-context.ts` | 冷启动 burst 注入真在 prompt 组装链路 |
| `return-path-payload.ts` | M5 cap 16k 真在 final 入库前生效 |
| `a2a_calls` 表 | 所有字段（convenerId / on_behalf_of / parent_call_id / root_call_id / join_set_id / deadline_at / envelope_version / reply_to）真有写入路径 |

**退出条件**：
- 4 个符号生产命中 ≥1（或落入「已废弃路径删除清单」给 Step 6 用）
- spec line 417-419 审计结果落 Timeline 一行
- 发现的接线缺口 → 立即补接线（仍属于 Step 3）或登记到 Step 6 删除清单

### v5 Step 3 落地（2026-04-30 · 小孙拍 #1 撤销 / #2 = B） ✅

**4 关键符号生产命中**（worktree 实证，排除 .test.ts / __tests__）：

| 符号 | 命中数 | 调用点 |
|---|---|---|
| `convenerId` / `convener_id` | 6 处 | `call-registry.ts` / `envelope-builder.ts` / `sqlite.ts` / `schema.ts` / `a2a-gateway.ts` / `session-repository.ts` |
| `openCall` | 3 处 | `a2a-gateway.ts:218/266/330`（dispatch path 唯一调用点） |
| `settle\b` | 11 处 | `a2a-lifecycle.ts:67` 实现层 + `message-service.ts:1024/1036/1676/2063` 直调 settleDone/Timeout/Failed/advance |
| `pendingOf` | 3 处 | `call-registry.ts` / `message-service.ts` / `routes/debug-a2a.ts` |

**全部 ≥1，0 孤岛**。

**spec line 286-289 三项 wiring 实证勾选**：

| Wiring | 实证状态 | 调用链 |
|---|---|---|
| dispatch.ts 调 `openCall` | ✅ 间接接通 | `dispatch.ts:246` `useGateway` gate → `a2a-gateway.ts:218/266/330` `deps.registry.openCall(...)` |
| 回程 `settle` | ✅ 直接接 | `message-service.ts:1024/1036/1676/2063` `a2aLifecycle?.settleDone/Timeout/Failed/advance` |
| MCP 入口 `openCall` | ⚠️ **改 spec drift 追认（#2 = B）** | `mcp/server.ts:868` `callPostMessage` → message-service → dispatch → a2a-gateway → openCall（共用 dispatch 接线） |

**#2 = B 决议**：MCP `trigger_mention` / `post_message` 入口**不直调** openCall——改 spec line 289 追认为「共用 dispatch → a2a-gateway 单点接线」，避免双 openCall 路径 + 双源同步 bug。callId 贯穿仍由 dispatch 链路统一保证。三条入口路径（真人 UI @ / agent callback @ / agent MCP 工具 @）全汇到同一个 `a2a-gateway.openCall` 调用点。

**3.3 全模块审视** ✅ 4 模块全部生产命中 ≥1：
- `envelope-builder.ts` (EnvelopeV1 / buildBetaEnvelope)：`a2a-gateway.ts` 用 ✅
- `burst-context.ts`：`message-service.ts` 用 ✅
- `return-path-payload.ts` (M5 16k cap)：`message-service.ts` 用 ✅
- `a2a_calls` 表 8 字段（convenerId / on_behalf_of / parent_call_id / root_call_id / join_set_id / deadline_at / envelope_version / reply_to）：11 处生产文件均有写入路径 ✅

**#1 A2A_CALL_TREE_ENABLED 默认值分歧点撤销**：14:45 plan 已锁「worktree 验通 → DoD-3 删 flag + 旧路径 + 不双轨」，flag 默认值与 DoD-3 冲突自动消解，无需拍。

**Step 3 退出条件全过**：
- ✅ 4 符号生产命中 ≥1（无孤岛、无删除清单）
- ✅ spec line 417-419 全模块审视已落 Timeline 2026-04-30 一行（"P1 Wiring Debt 孤岛审视落地"）
- ✅ 接线缺口 0 真欠账（line 289 spec drift 追认入 spec）

**Step 3 改动**（仅 doc）：
- `docs/features/F026-a2a-reliability-layer.md` line 286-289 P1 Wiring Debt 三项实证勾选 + 第三项 spec drift 追认 + 三入口路径对照
- `docs/features/F026-a2a-reliability-layer.md` Timeline 加 2026-04-30 step 3 一行
- `docs/plans/F026-finishing-line-plan.md` Step 3 v5 落地段（本段）

**下一轮起进 Step 4 · quality-gate 全 AC 勾选**。

---

## Step 4 · quality-gate 全 AC 勾选 · ~0.5d

**Why**：spec 所有 AC 现在仍 `[ ]`，必须正式触发 skill 把 11 不变量 + 14 症状 + 8 体感 + 2 场景 + DoD-1 全部勾选。

**触发 quality-gate skill**，按 skill SOP 走完三步：愿景对照 / spec 合规 / 验证命令输出。

**退出条件**：
- spec 全 AC `[x]`
- `pnpm test:api` 全绿
- `pnpm vitest run`（前端）全绿
- `pnpm typecheck` 0 error
- pre-commit 4 关全过

### v5 Step 4 落地（2026-04-30）

| 子项 | 状态 | Evidence |
|---|---|---|
| 11 不变量勾选 | ✅ 12 条全勾 | spec line 71-125 每条加 evidence 注解 |
| 14 症状勾选 | ✅ 14/14 全勾 | spec line 129-160（Step 2 勾 5 + Step 4 勾 9） |
| 2 体感场景 | ⚠️ 留 `[ ]` | 按家规 P5 + 铁律 14 → Step 5 acceptance-guardian 真机 |
| DoD-1 第 4 条 ADR guard | ❌ **欠账** | 仅 ADR-004 落地，ADR-002/003 guard 脚本未做 → 抛分歧点 |
| DoD-1 第 5 条孤岛审视 | ✅ | Step 3 commit `39623eb` |

**验收命令实测**：
- `pnpm typecheck` → exit 0 ✅
- `pnpm vitest run` → 31/31 files · 238/238 tests pass ✅
- `pnpm test:api` → 1469/1476 pass · 1 timing flake (`base-runtime.test.ts` 25ms heartbeat, 隔离重跑 13/13 全绿，非回归) · 6 skip

**Step 4 改动**（doc 仅）：
- `docs/features/F026-a2a-reliability-layer.md`：11 不变量 / 14 症状 / DoD-1 / Timeline 行
- `docs/plans/F026-finishing-line-plan.md`：本段

**Step 4 退出**：
- ✅ 4/5 子项过；DoD-1 第 4 条 ADR-002/003 guard 留 [分歧点] 等小孙拍
- 下一轮起进 Step 5 · 由**范德彪 (Codex) 来做愿景守护**（小孙 04-30 拍板：quality 之后让德彪做 acceptance-guardian）

---

## Step 5 · acceptance-guardian 实测愿景 · ~0.5d

**Why**：自动化测试 ≠ 真机验收。家规 P5「UX/前端验证必须打开浏览器实际操作」+ 铁律 14（验收同源）。日常错乱（R-051/053/054/065/066）必须真机覆盖才算愿景达成。

### 5.1 · 新增体感 AC（spec 增补 — 体感场景定义扩面）

| 真实房间 | 现象 | 应有兜底 | 增补 AC |
|---|---|---|---|
| **R-051** | 仁勋首轮退化（只起头不真做） | prompt 教育 + 行首裸 @ 兜底 | 第一棒禁空回 / 禁仅起头 |
| **R-053** | final + post_message 双发 | dedup gate + post-final lockout | 同 thread 同段话不重写 |
| **R-054** | 嵌套 `[Call:]` 重写 | retry-guard 三轮 + 进度卡 | 嵌套必触发琥珀进度卡 |
| **R-065** | 多轮接力第二轮断链 | gemini resume race 兜底 | resume 失败清空 native_session_id 重建 |
| **R-066** | collaborative-thinking 收敛断链 | DiscussionCoordinator 扩 connector 协议 | parallel_think 完成后必出收敛 final |

### 5.2 · 触发 acceptance-guardian skill

按家规「测试基础设施类 feature 可跳过 acceptance-guardian」**反之**——本 feature 是核心协议层 + 体感重灾区，**必须跑**真机验收。

**退出条件**：acceptance-guardian agent 出 ✅ PASS 报告，5 条新增体感 AC 真机全过。

### 5.3 · in-flight bug fix · 2026-05-07 · LLM 主链路 connector header 写入（R-100~R-104 反证）

**Why · 反证**（小孙 acceptance-guardian 跑 G1 时 R-104 timeline.json 实证）：4/4 message 全 `messageType=final`，**0 条 connector**——前端 ConnectorBubble / AtPill / OriginCapsule 三组件无载体 → 黄色 banner 一个孤魂、connector 卡 + amber pill 全无。

**根因**：`appendConnectorMessage` 唯一生产 call site 在 `services/message-service.ts:797-833` `handleAgentPublicMessage`（MCP `trigger_mention` + agent CLI `onPublicMessage` hook 两个旁路才走）。**LLM 主链路 `runThreadTurn` final flush :1962 `enqueuePublicMentions` 不经过它** → LLM agent 自己写 `[Call: @X]` 派发时永远不写 connector header。两条派发入口的 connector 写入逻辑历史不对称。

**修法**（小孙拍 [B] 抽函数）：

1. 抽 module-level `writeConnectorHeadersForQueue(sessions, enqueueResult, emit)` pure function（`message-service.ts` 顶部 export）
2. `:797` MCP/CLI hook 路径改调 helper（删 28 行 inline）
3. `:1962` LLM 主链路 final flush 在 `emitBlockedDispatches` 后追加 helper 调用

**v6 落地 · 2026-05-07** ✅

| 子项 | 状态 | Evidence |
|---|---|---|
| TDD RED | ✅ 5/5 fail | `connector-header.test.ts` import 报 `is not a function` |
| TDD GREEN | ✅ 5/5 pass | helper 抽出 + `:797`/`:1962` 双调 |
| 邻接回归 | ✅ 1437/1445 (8 skip) 0 fail | `pnpm test:api` 全套 |
| Typecheck | ✅ 0 error | `pnpm typecheck` 全栈 |
| 手验 | ⏳ 等小孙 :3100 起房间 G1 跑一次 | 必看：connector 卡 + amber AtPill「⏳ @桂芬 处理中」+ 派发完成切 emerald「已完成」 |

**测试覆盖**（5 条契约）：1 queued → 1 emit (header role + callId 透传) / 0 queued → 0 emits / 2 queued → 2 emits with distinct callIds / target thread 缺失 → skip 不抛 / `entry.callId` undefined → `a2aCallId` 传 null。

**未触及**：本 in-flight bug fix **只修「LLM 主链路 connector message 落库」**——R-100/R-103 同 parent 双 call（前端双气泡）+ R-100 桂芬 [Call:] 复述 + root call 永远 timeout 是另外三条独立 bug，等 5.3 落地后真机重测看是否仍存。

---

## Step 6 · 老路径删除 · spec DoD-3 · ~0.5d

**Why**：小孙 14:45 原话「**不会双轨，会把之前的删掉**」= 砍掉 spec DoD-2（双轨 2 周）+ 直接执行 spec DoD-3（line 428-442）。

### 6.1 · spec DoD-3 清单

- [ ] 删除 `A2A_CALL_TREE_ENABLED` flag 全部命中点（grep packages/ + docs/ 应为 0）
- [ ] 删除 return-path 旧路径（target final 不再走老 mention dispatch）
- [ ] 删除 mention-router 已废弃分支（白名单 / `naked_at_with_dispatch_intent` 等历史 case 已在 P3.1 [A] 删过，再核一遍）
- [ ] cleanup commit 用 `chore(F026 DoD-3): 删除 A2A_CALL_TREE_ENABLED flag + 旧路径 [黄仁勋/Opus-47 🐾]`

### 6.2 · 小孙拍板项（Step 6 启动前必须问）

| 项 | 问题 | 默认建议 |
|---|---|---|
| **F1 @ pill 六态** | F027 不做后，pill 是不是死代码？ | **保留** — 仍服务于 [Call:] 派发，pill 显示派发状态机仍有用 |
| **F6 状态 Pulse** | 「正在听取 @」是否仍合用？ | **保留** — pending.change 是 a2a_calls 维度，不依赖 mention router |
| **T2 `mention.gray_zone` 灰区分类器** | mention-router observe-only 模式去留？ | **删** — 协议已切 [Call:] 标签，灰区是 `\[Call:]` 之外的 @，不再有意义 |
| **F10 `/debug/a2a` 视图** | 调试视图是否保留？ | **保留** — call-registry 是 F026 长期产物 |

### 6.3 · 退出条件

- `grep -rn 'A2A_CALL_TREE_ENABLED' packages/ docs/` → 0
- `grep -rn 'naked_at_with_dispatch_intent\|gray_zone' packages/api/src` → 0（如确认删 T2）
- 全套测试零回归（`test:api` + `vitest` + `typecheck`）
- preview 体感不退化（再跑 Step 5 的 5 条体感 AC）
- cleanup commit 落盘 worktree（**不合 dev**）

---

## 不做（小孙 14:45 明示砍）

- ❌ 合 dev — worktree 持续保活
- ❌ 双轨 2 周观察期（spec DoD-2）— 不留旧路径作为兜底
- ❌ flag 灰度切换 — 一次性切

---

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| worktree 不合 dev → 越长越远，dev 上有改动会冲突 | 中 | 每天 `git -C .worktrees/F026-p0 fetch && rebase dev`，发现冲突立即处理 |
| Step 6 删旧路径误删仍在用的代码 | 高 | 删除前先 grep 确认命中 0；删除后 Step 5 体感全跑一遍对比 |
| 不双轨 → 新路径 bug 时无 fallback | 高 | Step 5 acceptance-guardian 必须真机覆盖完所有体感场景，否则不进 Step 6 |
| Step 4 全 AC 勾选时发现新欠账（spec 漏写的 AC） | 中 | 立即 spec 增补 + 回到对应 Step 补做，不强行勾 |
| Step 5 体感场景持续暴露新问题（如 R-067/068...） | 中 | 每个新问题归到对应 spec AC 内修，不另立 B 单（家规「feature in-flight bug no B-id」） |

---

## 验证命令

```bash
# 主验证套件（每步完成后必跑）
cd .worktrees/F026-p0
pnpm test:api          # 后端 1464+ 测试 → Step 2 后 1468+
pnpm vitest run        # 前端 238+ 测试
pnpm typecheck         # 0 error

# 14 症状专项 replay（Step 2 后）
pnpm test:api -- a2a-replay   # 6 → 10 文件

# 生产命中检查（Step 3）
grep -rn 'openCall\|settle\b\|pendingOf\|convenerId' packages/api/src \
  --include='*.ts' --exclude='*.test.ts' --exclude-dir=__tests__

# 旧路径残留检查（Step 6）
grep -rn 'A2A_CALL_TREE_ENABLED' packages/ docs/   # 应为 0
```

---

## 下一步

本 plan 落盘后：
- 等小孙不否决（默认通过）
- 下一轮起进 **Step 2** — 先看 P5/P7/P9/P13 spec 描述 + 已有兜底实现，TDD 写 4 条 replay test
- Step 6 启动前会单独 @ 小孙确认 6.2 拍板项（F1/F6/T2/F10 去留）
