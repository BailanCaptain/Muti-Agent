---
id: B009
title: Agent 进程 turn.completed 后死亡导致已完成响应被错误信息覆盖
related: F005
reporter: 黄仁勋（根因调查）/ 小孙（发现异常）
created: 2026-04-12
severity: P1
status: fixed
commit: 790ff3f
---

# B009 — Agent 进程 turn.completed 后死亡，已完成响应被崩溃错误覆盖

## 1. 报告人 / 发现方式

小孙（产品负责人）在 2026-04-12 12:47 发现范德彪（Codex agent）的 re-review 响应丢失，房间里只显示 `Error: Agent 进程已异常退出`。黄仁勋通过 SQLite `agent_events` 表挖出范德彪实际已完成的 re-review 全文（invocation `94bacafe`，item_50），确认响应是生成了但被覆盖了。

## 2. Bug 现象

范德彪对 F005 做 re-review 时，agent 进程在完成全部工作后崩溃。用户看到的不是 review 结论，而是一条错误信息：

```
Error: Agent 进程已异常退出。最后一次活动时间：2026-04-12T04:52:12.699Z。请重试一次。
```

review 结论（包含 1 个 P2 未放行意见）被错误信息完全覆盖，导致：
- 小孙以为范德彪没给出任何回复
- 黄仁勋以为范德彪进程崩了没产出结论
- 团队在"范德彪到底说了什么"上浪费了多个回合

## 3. 复现步骤

**期望行为**：agent 完成 LLM 回合（`turn.completed`）后，即使进程后续异常退出，已生成的响应应该被保留并正常显示给用户。

**实际行为**：
1. Codex agent 启动 re-review invocation（1.19M input tokens 的大上下文）
2. agent 完成工作，stdout 输出 `{"type":"turn.completed"}`（04:52:12.598 UTC）
3. LLM 回合正常结束（04:52:12.699 UTC）
4. 进程在 cleanup 阶段死亡（04:52:13.541 UTC，exit code: null，距 turn.completed 仅 842ms）
5. `liveness-probe.ts` 检测到进程 dead
6. `base-runtime.ts` close handler 走 reject 路径
7. `message-service.ts` catch 块调用 `overwriteMessage()` 用错误信息覆盖 agent 的真实回复

**触发条件**：
- 大上下文（>1M tokens）的 Codex invocation
- Windows 环境下内存压力可能导致 OOM
- 进程在 turn.completed 后的 cleanup 阶段死亡

## 4. 根因分析

### 调查过程

1. **从 SQLite 追踪事件**：查 `messages` 表和 `agent_events` 表，发现 invocation `94bacafe` 的 item_50 包含完整的 re-review 结论文本
2. **时间线精确到毫秒**：
   - `04:52:12.598` — item_50（review 结论）生成完毕
   - `04:52:12.699` — `turn.completed` 事件
   - `04:52:13.541` — `invocation.failed` — 进程死亡
3. **代码链路追踪**：

```
[Codex 进程在 turn.completed 后 842ms 死亡 (exit code: null)]
  ↓
[liveness-probe.ts:211 — isPidAlive() → false → getState() = "dead"]
  ↓
[base-runtime.ts:438 — probe.getState() === "dead" → deadProcess = true]
  ↓
[base-runtime.ts:406 — close handler 检测到 deadProcess → reject(Error)]
  ↓
[message-service.ts:1106 — catch(error) → overwriteMessage(Error) → 覆盖真实回复]
```

### 根因

**`base-runtime.ts` 的 close handler 不区分"进程在工作中死亡"和"进程完成工作后死亡"**。

`deadProcess === true` 时统一走 reject 路径，不检查 `turn.completed` 是否已收到。这意味着即使 agent 的 LLM 工作已经 100% 完成，只要进程在后续 cleanup 阶段死了（OOM、信号、超时），合法的响应就会被丢弃。

### 排除项

- ❌ 不是网络问题：事件全部在本地 stdout 上完成
- ❌ 不是 LLM 回合未完成：`turn.completed` 明确已发出
- ❌ 不是 F005 代码引入的回归：此 bug 存在于 `base-runtime.ts` 原始逻辑中，与 F005 无关
- ❌ Codex CLI 本身的 post-turn 崩溃是上游问题（Bug A），我们无法修复；但**我们的代码不应该因为上游的 cleanup 崩溃而丢弃已完成的工作**

## 5. 修复方案

**选择的方案**：在 `base-runtime.ts` 中新增 `turnCompleted` 标志，检测 stdout 中的 `{"type":"turn.completed"}` 事件。close handler 中，如果 `deadProcess && turnCompleted`，走 resolve 路径而非 reject。

**修改点（3 处）**：
1. `base-runtime.ts:260` — 新增 `let turnCompleted = false` 状态变量
2. `base-runtime.ts:388-399` — stdout line handler 中解析 JSON，检测 `turn.completed` 事件设置标志
3. `base-runtime.ts:422-432` — close handler 的 `deadProcess` 分支前插入判断：`if (deadProcess && turnCompleted)` → resolve

**放弃的备选方案**：
- ❌ 在 `message-service.ts` catch 块中保留原始回复不覆盖 — 太脆弱，依赖消息层状态；根因在 runtime 层，应在 runtime 层修
- ❌ 给 Codex 进程延长 grace period — 掩盖问题，不解决根因；大上下文下 OOM 不可控
- ❌ 在 liveness-probe 中加"turn 完成后不再检测" — 改变了 probe 的语义，副作用不可控

## 6. 验证方式

**绑定复现步骤验证**：

测试文件：`packages/api/src/runtime/base-runtime.dead-after-turn.test.ts`（4 个测试用例）

| 测试 | 验证点 | 结果 |
|------|--------|------|
| `deadProcess + turnCompleted → resolves` | 进程死亡但 turn 已完成 → resolve 且 stopReason = "complete" | ✅ PASS |
| `deadProcess without turnCompleted → rejects` | 进程死亡且 turn 未完成 → 仍然 reject（不影响原有逻辑） | ✅ PASS |
| `turnCompleted flag ignores non-JSON lines` | stdout 中纯文本包含"turn.completed"字样 → 不误触发标志 | ✅ PASS |
| `timeout/stall without turnCompleted → rejects` | 超时/停滞路径无回归 | ✅ PASS |

**运行命令**：
```bash
npx tsx --test packages/api/src/runtime/base-runtime.dead-after-turn.test.ts
# 4/4 PASS
```

**回归确认**：F005 已有的 20 个测试（AuthorizationRuleStore 9 + ApprovalManager 11）全部通过，B009 修复未引入回归。

---

**注**：本 bug 实际包含两层问题：
- **Bug A（上游）**：Codex CLI 在大上下文（1.19M tokens）的 turn.completed 后 cleanup 阶段崩溃（exit code: null）。这是 Codex CLI 的问题，我们无法直接修复，已知在 Windows + 大上下文场景下偶发。
- **Bug B（已修）**：我们的 `base-runtime.ts` 不区分 pre-turn 和 post-turn 的进程死亡，统一丢弃响应。commit `790ff3f` 修复了 Bug B，使 post-turn 崩溃不再导致响应丢失。
