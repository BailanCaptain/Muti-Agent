---
plan: F026 P1 Wiring Debt 收尾
spec: docs/features/F026-a2a-reliability-layer.md (line 267-282)
worktree: .worktrees/F026-p0  (branch: feat/F026-p0-a2a-stabilize)
created: 2026-04-26
owner: 黄仁勋
status: drafted, awaiting 小孙 sign-off
merge-policy: 不合 dev — worktree 内 P0+P1+P3 一起验完再统一合
---

# F026 P1 Wiring Debt 收尾计划

## Why（为什么现在做）

spec line 267-282 写明：`call-registry` (`openCall / settle / pendingOf / getTree`) 库写完 + 单测绿，
但生产代码 `grep openCall|settle|pendingOf` 的命中数 = 0（已坐实）。
**协议层是孤岛**，pendingOf 永远拿不到真实数据 → P5 体感层（DiscussionCoordinator/Pulse/折叠/墓碑）将拿到空表。
spec 第 281 行写 "P4 持久化前提是 registry 不再是孤岛" → P4 启动前必补。

## 真实缺口审视（rehydrate 实证）

| 接线点 | 现状 | 证据 |
|---|---|---|
| **dispatch openCall** | ✅ 已接（gateway 路径） | `a2a-gateway.ts:153/201/265` 三处 `deps.registry.openCall` |
| **MCP `trigger_mention` openCall** | ✅ 已接（透传） | `mcp/server.ts:574` 走 HTTP → 进 dispatch → gateway 入口 |
| **dispatch openCall · classic 路径** | ⚠️ 未接 | `dispatch.ts:246` `useGateway` 条件不成立时走 `resolveMentions` 老路，**没有** registry 写入 |
| **return-path settle** | ❌ 未接 | `return-path.ts:86` flag=1 直接 `return null`，没人调 settle；全代码 grep `registry.settle\|callRegistry.settle` = 0 |
| **timeout scan 接入 cron** | ❌ 未接 | `call-registry.ts` 有 `scanTimeouts` 但 server.ts 启动时没注册定时任务 |
| **pendingOf 消费方** | ❌ 未接 | P5 体感层未启动，但 P1 应至少在 `/debug/a2a` 暴露一个 GET endpoint，证明数据可读 |

## What（本次范围 · 三件事）

> **不在范围内**（明确划走）：
> - P5 体感层（DiscussionCoordinator/Pulse/折叠/墓碑/溯源胶囊）— spec 标的 P5
> - P4 持久化下沉（CAS / kill -9 恢复）— spec 标的 P4
> - 撤 classic 路径（双轨 flag 切换）— spec line 263 写"2 周后切"，本次不动
> - 任何 `agent-prompts.ts / CLAUDE.md / GEMINI.md` 改动（ADR-004 硬约束）

### T1 · settle 接线（**主菜**）

**触发点**：被 @ 的 agent 完成本 turn 最终回复并入库时，settle 它的 callId 为 `done`。

**TDD red**：
- `packages/api/src/orchestrator/__tests__/settle-wiring.test.ts`（新建）
  - red-1: agent 完成 turn 后 `a2a_calls` 该行 `status='done', updated_at >= turn 完成时间`
  - red-2: agent failed/timeout 时 `status` 走对应分支（`failed` / `timed_out`）
  - red-3: 同 callId 重复 settle 走 CAS noop（不抛错、不重写时间戳）
  - red-4: 当 flag=0（classic 路径）时，没人调 settle 也不报错（向后兼容）

**实现位置候选**（待确认，写 plan 时不下死结论）：
- 候选 A: `message-service.ts` 在 final assistant message 入库 hook 处调 settle
- 候选 B: `dispatch.ts` 在 envelope `replyTo` 兑现处调 settle
- 候选 C: 抽 `services/a2a-lifecycle.ts` 统一管理 settle 触发（推荐 — 单一真相点）

**决策点**：候选 C 是 spec line 262「Lifecycle 状态机 CAS 转移」的自然落点，但要新建文件。
**我倾向 C** — 把 settle/timeout/pending 三件事集中，避免散落在 message-service 各处。

### T2 · classic 路径决策

**问题**：`dispatch.ts:246` useGateway 条件不成立时走老路，没接 registry。

**两个走法**：
- [A] **保留 classic 兜底**：在 classic 路径也调 `openCall` + `settle`（双轨并行，flag 切换不丢观测）
- [B] **声明 classic 即将废弃**：本次不接，spec line 263 "2 周后切" 的 deadline 标在 P4 启动前

**我倾向 [B]** — 双轨观测代码会让生命周期判定逻辑变成 if/else 林立的怪物，且 worktree preview 已默认 flag=1，
classic 路径在 dev/prod 实际不会走到。但这条要小孙拍。

### T3 · timeout scan 启动 + `/debug/a2a` GET endpoint

**timeout scan**：
- `server.ts` 启动时注册 `setInterval(callRegistry.scanTimeouts, 30_000)`
- 关闭时 `clearInterval`（test 不漏 timer）
- **TDD red**：测试 mock clock，过 deadline 后 status 自动转 `timed_out`

**`/debug/a2a` GET endpoint**：
- 返回 `{ pending: pendingOf(rootCallId), tree: getTree(rootCallId) }`
- 用途：P5 启动前 dev 自查 + 接下来六场景验证时人眼可看
- 不做 UI（P5 范围），只做 JSON

## 验证（六场景 R-046 仍是出口）

P1 wiring 三件事做完后，**仍要跑** R-046 六场景（小孙手测）+ `/debug/a2a` 数据校验：

| 场景 | 验证点 | 数据校验 |
|---|---|---|
| 1 并发 @ | composer 双模式 | `a2a_calls` 出现两行 `status=open`，结束后两行都 `done` |
| 2 句中 @（行尾装饰） | 不派发 | `a2a_calls` 不增行 |
| 3 cold-target burst | prompt 注入 | burst 命中且 callId 落库 |
| 4 嵌套 @（A→B→A） | parent_call_id 链 | `a2a_calls` 三行，`getTree` 返回完整链 |
| 5 收敛回路 | settle 触发 | 子链全 `done`，parent `pendingOf` 返空 |
| 6 timeout | 自动转态 | deadline 过后 status=`timed_out`，cron 实际跑了 |

## 不合 dev · 验完一起合的理由

- 小孙 2026-04-26 当面拍板：A 选项 = P0+P1+P3 全套接线收口后一起合 dev
- spec line 281: "P4 持久化前提是 registry 不再是孤岛"——孤岛阶段不进主线减少回滚面
- worktree 已 22 commits ahead of dev，再叠 P1 wiring（预估 +6~10 commits）一次性 PR

### T4 · post-message dedup gate（R-205 双消息根因）

**触发点**：R-205 实测证据（worktree-preview DB · 2026-04-26 16:34-16:39 五轮全中）—
LLM 在 CLI final 入库 8-25s 后又调 MCP `post_message` 把同段话重发一遍，服务端没拦截
→ `callbacks.ts:133` `appendMessage(..., "progress")` + `onPublicMessage` 重入派发，
用户看到双消息 + 重复 @ 触发。Prompt 教育（`agent-prompts.ts:99-101`）已写禁令但 LLM
不遵守 → 必须协议层硬拦。

**Dedup 规则**：post-message handler 收到内容时，比对 thread 最近 1 条 assistant message：
- 时间窗 ≤ 60s（覆盖 R-205 观测的 8-25s + 安全余量）
- 前 200 字符（取较短者）精确相等且长度 ≥ 80 字符（避免 "好的"/"收到" 误伤）
- 命中 → 200 noop：不写库、不广播、不重入派发，返回 `{ ok: true, deduped: true, messageId: <existing> }`

**代码位置**：`packages/api/src/routes/callbacks.ts` post-message handler line 196-209
+ `detectPostMessageResend()` helper line 36-61。

## TodoList（进度对账用）

- [x] T1.red：a2a-lifecycle.test.ts 5 条红（含 noop / CAS guard）
- [x] T1.green：services/a2a-lifecycle.ts + message-service runThreadTurn 三出口
      （advance@bind / settleDone@success / settleFailed@catch / settleTimeout@TTL）
      + flushDispatchQueue 把 entry.callId 透到 runThreadTurn
      + server.ts 注入 A2ALifecycleService(callRegistry)
- [x] T2 决策：[B] — 不接 classic registry。理由：
      （1）worktree preview 默认 A2A_CALL_TREE_ENABLED=1，dev/prod 实际不会走 classic；
      （2）双轨写库会让 advance/settle 必须在两条路径同时维护，回归面 ×2；
      （3）spec line 263 已写"2 周后切"，把切轨 deadline 标在 P4 启动前即可。
      — 小孙 Round 2 默认通过（plan line 66 已记理由）。
- [x] T3.timeout-scan：server.ts `setInterval(callRegistry.timeoutScan, 30s)` + onClose clearInterval
- [x] T3.debug-endpoint：`GET /debug/a2a?root=<id>` / `?parent=<id>` 返回 tree / pending
- [x] T4.red：callbacks.post-message-dedup.test.ts 6 条（2 dedup hit + 4 pass-through）
- [x] T4.green：callbacks.ts post-message handler 加 dedup gate（前缀 200 字符 + 60s 窗口 + 80 字符下限）
- [ ] R-046 六场景：worktree preview 跑通 + `/debug/a2a` 数据眼校（小孙手测）
- [ ] R-205 复发回归：preview 重启后再跑传话游戏，确认 5 轮无双消息
- [ ] quality-gate：测试全绿 + spec 合规
- [ ] 一起合 dev（P0+P1+P3+P1-wiring）

## 关键代码位置（review / 验收对账用）

| 接线点 | 文件 : 锚点 |
|---|---|
| Lifecycle 服务 | `packages/api/src/services/a2a-lifecycle.ts`（advance/settleDone/Failed/Timeout/Cancelled） |
| `dispatchedCallId` 入参 | `message-service.ts:858-869` |
| advance @ bindInvocation | `message-service.ts:937-940` |
| settleTimeout @ TTL | `message-service.ts:925-932`（dispatchCleanupTimer） |
| settleDone @ try success | `message-service.ts:1281-1287` |
| settleFailed @ catch | `message-service.ts:1635-1640` |
| flushDispatchQueue 透 callId | `message-service.ts:1801-1812` |
| server 注入 + cron | `server.ts:110-128`（installA2AGateway return.registry → setA2ALifecycle + scanInterval） |
| /debug/a2a route | `routes/debug-a2a.ts` + `server.ts:350` |
