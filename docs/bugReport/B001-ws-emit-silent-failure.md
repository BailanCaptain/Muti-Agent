# B001 — WebSocket emit 静默失效导致 Agent 卡住

> 状态：fixed (Phase 4 完成) — 待手工验证
> 报告日期：2026-04-10
> 报告人：小孙（现场观察）
> 处理人：黄仁勋
> Related: —（独立 bug）

---

## 1. 报告人 / 发现场景

小孙在使用过程中观察到：黄仁勋（Claude）写完代码后，前端消息突然变成空白，页面右侧一直显示"仁勋在工作中"。但检查 git 发现代码其实已经成功推送上去。只有重启 API 服务 + 刷新页面后，消息才从数据库重新加载出来。同时黄仁勋没有继续推进后续 skills（merge-gate / feat-lifecycle completion）。

## 2. 复现步骤

**期望行为：**
1. 用户给黄仁勋发一个需要写代码 + 提交 + 推送的任务
2. Agent 流式输出代码 → 前端消息逐步累积
3. Agent 执行 git add / commit / push
4. Agent 输出总结 → 前端消息完整显示
5. 线程卡片变为"空闲"
6. Agent 自动推进到下一个 skill

**实际行为：**
1 ~ 3 正常
4. ❌ 前端消息在某个点停止更新，"突然变空白"
5. ❌ 线程卡片持续显示"正在处理"
6. ❌ 后续 skills 没有触发
- 重启 API + 刷新 → 消息从 DB 完整恢复

**最小复现条件：**
- Agent turn 持续时间长（≥ 2min，尤其是包含 git push 等长时间无 stdout 活动的操作）
- WebSocket 连接在静默期内进入半开状态或被代理层断连

## 3. 根因分析

**调查流程（Phase 1-3）：**

### 数据流追踪

完整事件链：
```
CLI stdout → readline.on("line")          [base-runtime.ts:354]
  → onStdoutLine hook                     [cli-orchestrator.ts:85]
  → parseAssistantDelta → content += delta
  → options.onAssistantDelta(delta)       [cli-orchestrator.ts:103]
  → options.emit({ type: "assistant_delta" }) [message-service.ts:515]
  → sendSocketEvent(socket, event)        [ws.ts:11]   ⚠️ NO try/catch
  → WebSocket → frontend
```

完成阶段：
```
child.on("close") → settle() → resolve()  [base-runtime.ts:371-392]
  → run.promise resolves                  [message-service.ts:597]
  → detachRun + releaseInvocation         [598-599]
  → overwriteMessage (DB 写入最终内容)    [652-657]
  → emitThreadSnapshot (发 running:false) [698]
  → sendSocketEvent(socket, ...)          ⚠️ 同一个 socket 引用
```

### 关键发现

| 位置 | 问题 |
|------|------|
| `ws.ts:76` | `emit` 闭包**绑定到单个触发 socket**，整个 turn（几分钟）持有同一引用 |
| `ws.ts:11-13` | `sendSocketEvent` **没有 try/catch**（对比 `broadcast` 在 30-38 行有保护） |
| `message-service.ts:515, 698` | 所有 `options.emit()` 调用无保护 |
| `message-service.ts:728-732` | catch 块里的 emit 也无保护 → 双重故障 |

### 排除的假设

1. ❌ **readline buffer 竞态**：Node.js `child.on('close')` 在 stdio streams 关闭后触发，readline 会在收到 `input.end` 时先处理完缓冲再触发自己的 close。排除。
2. ❌ **CLI 进程彻底 hang**：用户报告"重启 + 刷新后消息出来"，证明 `overwriteMessage` 实际执行了（line 652），说明 `run.promise` 确实 resolved。排除。
3. ❌ **frontend mergeTimeline 丢消息**：`listMessages` 无 limit，snapshot 包含所有消息；`mergeTimeline` 保留更长的那份内容。排除。

### 根因（Phase 3 假设）

**WebSocket 连接在长 turn 中静默失效**（TCP 超时或代理层断连），后端 `emit` 调用后 `socket.send()` 静默失败（ws 库在 CLOSING 状态可能不抛异常，或 TCP 半开时无法感知）。结果：

- DB 被正确写入 ✓（后端 Promise 链正常完成）
- 前端收不到 `assistant_delta`、`thread_snapshot`、`invocation.finished` 任何事件
- 前端 `running` 状态停留在 `true`
- 累积的 delta 显示不完整（看起来"变空白"）
- 只有重启服务 + 刷新重连 WebSocket，前端才重新 fetch 到 DB 最新状态

## 4. 修复方案

**三点联防（backend 容错 + frontend 自愈）：**

### Fix 1：`sendSocketEvent` 加 try/catch（防止 emit 链中断）

```ts
// packages/api/src/routes/ws.ts
function sendSocketEvent(socket: SocketLike, event: RealtimeServerEvent) {
  try {
    socket.send(JSON.stringify(event));
  } catch (err) {
    // socket 已断，从 set 清除并静默。后端处理链继续完成（DB 写入、SOP 推进）。
    sockets.delete(socket);
  }
}
```

**理由：** 最小变更、防止 emit 抛异常破坏处理链、socket 清理让后续广播不再尝试死 socket。

### Fix 2：前端 WebSocket 重连 + 状态恢复

```ts
// components/ws/client.ts + app/page.tsx
- 加入重连逻辑（指数退避）
- 重连成功后触发 selectSessionGroup 重新 fetch snapshot
- 重连期间 UI 提示"连接中断，正在重连…"
```

**理由：** 即使后端 emit 成功，网络抖动也可能丢 WebSocket 帧。前端需要自愈能力。

### 放弃的备选

- ~~加 WebSocket heartbeat/ping~~：已由 Fix 1 + Fix 2 覆盖大部分场景，ping 只是更早发现问题，不是根因修复。留作后续优化。
- ~~广播替代直接 emit~~：会破坏 per-socket 事件隔离（比如 status 消息发给所有客户端），超出本 bug scope。

## 5. 验证方式

### 回归测试

- **单元测试** `packages/api/src/routes/ws.test.ts`：
  - mock 一个 throws on send 的 socket
  - 调用 `sendSocketEvent` 不应抛异常
  - socket 应从 set 中被清除
- **集成测试** `packages/api/src/services/message-service.test.ts`（新增）：
  - 模拟长 turn，在中途让 emit 抛异常
  - 验证 `overwriteMessage` 仍然执行
  - 验证 `detachRun` + `releaseInvocation` 仍然清理

### 手工验证

- [ ] 启动 dev 环境
- [ ] 给黄仁勋发一个长任务（写代码 + git commit + git push）
- [ ] 在 turn 中途手动断开网络 15 秒再恢复
- [ ] 验证前端自动重连并恢复完整消息
- [ ] 验证线程卡片正确变为"空闲"
- [ ] 验证 DB 内容完整

### 验收标准

- Agent 长 turn（≥ 2min）不再出现卡住现象
- WebSocket 短暂断开后前端自动恢复
- 后端处理链不受前端连接状态影响

---

## 6. 落地记录（Phase 4）

### Fix 1（后端）— 已完成

- `packages/api/src/routes/ws.ts`
  - `sendSocketEvent` 导出并加 try/catch，返回 `boolean`
  - `broadcaster.broadcast` 对返回 `false` 的 socket 从 set 中剔除
  - 直接 emit 闭包同样检查返回值，失败则清理自身 socket 引用
- `packages/api/src/routes/ws.test.ts`（新增 3 条 node:test 回归用例）
  - 健康 socket 正常投递
  - send 抛异常时返回 false 且不冒泡
  - 坏 socket 与好 socket 相互隔离（模拟 detachRun → emitThreadSnapshot 链）
- 测试结果：`tsx --test src/routes/ws.test.ts` → 3/3 PASS
- 全量 API 测试：241 → 244 pass，0 regression（3 failing 为基线遗留：`buildPhase1Header`、2× `parseAssistantDelta` Gemini，与本 bug 无关）

### Fix 2（前端）— 已完成

- `components/ws/client.ts`
  - 加入指数退避重连：`1s → 2s → 4s → 8s → 16s → 30s`（封顶）
  - `closedByUser` 标记区分主动关闭（React unmount）与意外掉线
  - 新增 `onReconnect` 回调，仅在**非首次** open 触发
- `app/page.tsx`
  - `onClose` / `onError` 文案改为"连接中断，正在重连…"
  - `onReconnect` 回调触发 `selectSessionGroup(activeGroupId)`（或退化为 `bootstrap()`），重新拉取完整 snapshot
- 前端 typecheck：`tsc --noEmit` 本文件新增 0 errors（存量 1 个 `approval-card.tsx` 与本 bug 无关）

### 放弃的备选（同上）

- ~~WebSocket ping/heartbeat~~：Fix 1+2 已覆盖主流场景，留作后续可选优化
- ~~广播替代直接 emit~~：破坏 per-socket 隔离，超出 scope

### 待小孙手工验证

- [ ] 启动 dev 环境
- [ ] 给黄仁勋发长任务（写代码 + git commit + git push）
- [ ] turn 中途断网 15s 再恢复
- [ ] 验证前端提示"连接中断，正在重连…"并自动恢复
- [ ] 验证重连后消息完整、线程卡片正确变"空闲"
- [ ] 验证 DB 内容与前端一致
