# B004 — SettlementDetector 在 Phase 2 期间过早 flush DecisionBoard

Related: F002 (Decision Board)

## 诊断胶囊

| # | 栏位 | 内容 |
|---|------|------|
| 1 | **现象** | (A) 串行讨论 Phase 2 未结束时，DecisionBoard flush 弹出决策卡片，用户点击后拉起范德彪进入 feat-lifecycle，打断讨论流程。(B) 收敛阶段黄仁勋有 [拍板] 选项，但没有弹出决策卡片。 |
| 2 | **证据** | 小孙现场反馈，讨论和 feat-lifecycle 在时间线上交叉出现。 |
| 3 | **假设** | **H1（确认）**: SettlementDetector 在 Phase 2 turn 间隙判断 `isSettledNow=true`（group 已 `done` + 无 dispatch slot），2s 后 premature flush。H2: premature flush 派发范德彪占用 slot → 黄仁勋综合完成后 `hasRunningTurn=true` → 二次 settle 被阻塞 → 综合者的 [拍板] 永远不弹。 |
| 4 | **诊断策略** | 逆向追踪数据流：Phase 1 完成 → group.status="done" → Phase 2 runThreadTurn → collectDecisionsIntoBoard → notifyStateChange → isSettledNow 三信号全 false → settle fires。 |
| 5 | **超时策略** | N/A（已定位） |
| 6 | **预警策略** | 影响所有用户发起的并行思考讨论流程，高优。 |
| 7 | **用户可见修正** | 无 |
| 8 | **验收** | (1) 新增测试覆盖 Phase 2 期间 settle 不触发 (2) 新增测试覆盖 synthesizer 完成后 settle 正确触发 (3) `pnpm test` 全通过 |

---

## Bug Report 五件套

### 1. 报告人
小孙（产品/CVO），在使用并行思考讨论流程时发现。

### 2. 复现步骤

**期望行为**：
- Phase 2 串行讨论完整结束 → fan-in 卡片选综合者 → 综合者回复（含 [拍板]）→ DecisionBoard flush → 用户决策

**实际行为**：
- Phase 2 第 1 轮某 agent 完成后，DecisionBoard 提前 flush，弹出决策卡片
- 用户点击后范德彪被拉起做 feat-lifecycle，Phase 2 仍在继续（并行执行）
- 综合者完成后的 [拍板] 不弹卡片

### 3. 根因分析

**根因链条**：

```
Phase 1 all done
  → markCompleted() → group.status = "done" (terminal)
  → handleParallelGroupAllDone() → runPhase2SerialDiscussion()
    → Phase 2 Turn N 完成 → runThreadTurn 内部调用:
      ├─ collectDecisionsIntoBoard() → [拍板] 加入 board
      └─ notifyStateChange() → isSettledNow() 检查三个信号:
          ├─ hasActiveParallelGroup → false (group 是 "done"，terminal)
          ├─ hasQueuedDispatches   → false
          └─ hasRunningTurn        → false (Phase 2 不走 dispatch 队列，无 slot)
      → isSettledNow = true → 2s debounce → SETTLE → flushDecisionBoard!
```

**问题 1**：group 在 Phase 1 完成时就变成 `done`（terminal），但 Phase 2 / 综合者仍在同一个逻辑管线里运行。`hasActiveParallelGroup` 对 terminal 状态返回 `false`，让 SettlementDetector 以为一切结束。

**问题 2**：Phase 2 和 synthesizer 的 turn 直接调用 `runThreadTurn`，不经过 dispatch 队列，因此不 acquire slot。`hasRunningTurn` 基于 slot 状态，对这些 turn 始终返回 `false`。

**问题 3**：`runSynthesizerTurn` 是 fire-and-forget（不 await），导致 `handleParallelGroupAllDone` 提前返回，group 被 remove，综合者仍在后台运行。

**Bug B 是 Bug A 的因果后果**：premature flush 派发范德彪（有 slot），占住 `hasRunningTurn=true`，阻止综合者完成后的二次 settle。

### 4. 修复方案

**方案**：在并行 group 状态机中增加 `"aggregating"` 非终态，让 SettlementDetector 在整个 Phase 2 → synthesizer 管线期间保持 `hasActiveParallelGroup=true`。

具体改动：
1. `parallel-group.ts`：新增 `aggregating` 状态（非终态），Phase 1 全完成时 user-initiated group 进入 `aggregating` 而非 `done`
2. `parallel-group.ts`：新增 `markAggregationDone()` 方法，从 `aggregating → done`
3. `message-service.ts`：`runSynthesizerTurn` 改为 async + await
4. `message-service.ts`：`selectFanInAndNotify` await synthesizer
5. `message-service.ts`：`handleParallelGroupAllDone` 返回前调用 `markAggregationDone`
6. 调用 `notifyStateChange` 确保 settle 在管线结束后正确触发

**放弃的备选**：
- 给 `runThreadTurn` 加 `suppressSettlement` flag → 侵入性大，每个 call site 都要记住传参
- 在 `handleParallelGroupAllDone` 开头 cancel settlement → 不彻底，synthesizer fire-and-forget 导致 cancel 时机不对

### 5. 验证方式
- 单元测试：Phase 2 期间 settle 不触发
- 单元测试：synthesizer 完成后 settle 正确触发
- 单元测试：user-initiated group Phase 1 完成后状态为 aggregating
- `pnpm test` 全通过
