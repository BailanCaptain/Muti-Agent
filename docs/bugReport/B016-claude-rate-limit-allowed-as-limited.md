---
B-ID: B016
title: Claude runtime 把 rate_limit_event(status:allowed) 配额心跳错翻成"[rate limited]"假警报
status: fixed
related: F012 (frontend hardening redesign — 推理区渲染链路)
reporter: 小孙
created: 2026-04-18
fixed: 2026-04-18
---

# B016 — Claude runtime 把配额心跳当限流告警

## 1. 报告人

小孙（真人）报告：「为什么你的推理过程没了？显示的全是[rate limited]」。

## 2. Bug 现象

Claude agent（黄仁勋）正常响应时，前端推理面板被一排排 `[rate limited]` placeholder 淹没，真 thinking 内容被夹在其中几乎不可见。**实际没有触发任何限流**。

## 3. 复现步骤

**期望**：thinking_delta 累积为一段完整推理文本，渲染在推理面板；无限流时不出现任何 "[rate limited]" 字样。

**实际**：每次 Claude CLI 响应都在推理面板里反复刷出 `[rate limited]`，原始 thinking 被淹没。

- Claude Code CLI 使用 `--include-partial-messages --output-format stream-json`（`claude-runtime.ts:85`）
- CLI 在每次请求期间都会发 `rate_limit_event`（**配额心跳**，不是异常告警）
- 当前配额状态正常（`status: "allowed"`），却被全部渲染为 `[rate limited]`

## 4. 根因分析（8 栏诊断胶囊）

### 现象

`parseActivityLine` 把"配额心跳事件"（`status: allowed`）一律返回字符串 `"[rate limited]"`，该字符串随 activity 管道推到前端的 thinking/推理流。

### 证据

**关键文件**：

- `packages/api/src/runtime/claude-runtime.ts:180`
  ```ts
  if (event.type === "rate_limit_event") return "[rate limited]";
  ```
  —— 命中即返回，**不看 `status` 字段**，不看任何子字段。

- `packages/api/src/runtime/claude-runtime.test.ts:69-72`
  ```ts
  it("handles rate_limit_event", () => {
    const result = runtime.parseActivityLine({ type: "rate_limit_event" });
    assert.equal(result, "[rate limited]");
  });
  ```
  —— 测试用**空 payload** 固化了错误行为，掩盖 bug。

- `data/store.json:580-587`（历史数据，真实 payload 形状证据）
  ```json
  "quotaSignal": {
    "source": "rate_limit_event",
    "status": "allowed",
    "windowType": "five_hour",
    "resetsAt": "2026-03-14T11:00:00.000Z",
    "isUsingOverage": false,
    "overageStatus": "rejected"
  }
  ```
  —— Claude Code CLI 的 `rate_limit_event` 带 `status` 字段，`"allowed"` 表示配额正常、不是限流。其他可能值（`approaching` / `blocked` / `exceeded`）才代表真限流。

**其他相关**：
- `grep quotaSignal` 只在 `store.json` 有命中，**代码里没有任何解析路径** —— 历史版本曾经正确分类过，在某次重构后只剩误映射。

### 假设

**根因**：`rate_limit_event` 是 Claude Code CLI 的周期性配额心跳（每次请求都发），`status` 字段才区分正常/限流。`claude-runtime.ts:180` 把 type 当唯一判据直接输出固定字符串，等于把"配额正常"翻译成"被限流"。

**为什么之前没有爆发**：
- Claude Code CLI 升级后 `--include-partial-messages` 下事件频率提升
- F012 把推理/活动流搬到独立折叠卡片（`message-bubble.tsx` 重构），放大了 placeholder 的视觉占比
- 两者叠加使假警报在 UI 上压倒性显现

### 诊断策略

1. 读 `parseActivityLine` 全部分支 ✅
2. 在代码库全局 grep `rate_limit_event` / `quotaSignal` ✅ —— 仅一处处理，证实这是唯一路径
3. 从 `store.json` 恢复真实 payload 结构 ✅

### 超时策略

N/A —— 路径单一、证据确凿、变更面小。

### 预警策略

- 新增测试覆盖 `status: "allowed"` / `status: "approaching"` / `status: "exceeded"` 三种分支
- 配额相关分支统一走"显式允许"策略：未知 status 默认 `null`（不进推理流），只有明确异常值才发可见 placeholder

### 用户可见修正

修复后：
- `status: "allowed"` → 推理面板不再出现 `[rate limited]`
- `status` 异常（`approaching` / `blocked` / `exceeded`）→ 显示 `[quota: <status>]` 精确告警
- 真 thinking 文本恢复可见

### 复现验收

- 触发一次 Claude agent 对话 → 推理面板无 `[rate limited]` 字样
- Mock `rate_limit_event` with `status: "exceeded"` → 渲染 `[quota: exceeded]`

## 5. 修复方案

将 `claude-runtime.ts:180` 改为：

```ts
if (event.type === "rate_limit_event") {
  const rl = (event as Record<string, unknown>).rate_limit as Record<string, unknown> | undefined;
  const status = (rl?.status ?? (event as Record<string, unknown>).status) as string | undefined;
  if (!status || status === "allowed") return null;
  return `[quota: ${status}]`;
}
```

同步更新 `claude-runtime.test.ts:69-72` 覆盖三种 status 分支。

**放弃的备选**：
- **直接 drop 整个事件**（always return null）—— 丢失真正限流时的用户可见提示，不采用。
- **完整路由到状态通道**（新 runtime-event 类型）—— 产品改动更大、需要前端同步，留给 F017/F020 做。本次只最小止血。

## 6. 验证方式

**绑定复现步骤**：

1. **旧 bug 现象消失**：`status: "allowed"` 或无 status 字段 → `parseActivityLine` 返回 `null`，推理流不再接收 `[rate limited]` 字样
2. **保留有效告警**：`status: "exceeded"` / `"blocked"` / `"approaching"` → 返回 `[quota: <status>]`
3. **回归防护**：
   - `npx tsx --test packages/api/src/runtime/claude-runtime.test.ts` → 20/20 绿（含 B016 4 个新测试）
   - `pnpm typecheck` → 绿
   - `pnpm test` → 765 个测试中仅 1 失败（`buildPhase1Header mentions not loading full skill`），与本 bug 无关（对应小孙未 commit 的 phase1-header.ts 删行，独立问题）

### 实际执行证据（2026-04-18）

- 新增 4 个 B016 测试：`rate_limit_event with status=allowed is a quota heartbeat — drop` / `without status field is treated as heartbeat — drop` / `with non-allowed status surfaces precise placeholder` / `status at top level is also honored`
- Red 阶段：旧代码下 `status=exceeded` 测试失败，打印 `[rate limited]` 而非期望的 `[quota: exceeded]`
- Green 阶段：修改 `claude-runtime.ts:180-188`，引入 `status` 字段检查（支持 `event.rate_limit.status` 和 `event.status` 两处）
- 验收：claude-runtime 套件 20/20 通过

## 7. 遗留事项（不在本次修复范围）

- **配额状态产品化**：当前只做最小止血（非 allowed 时显示 `[quota: <status>]`）。更完整的"跨房间配额感知"属产品改动，可在 F017 或独立 feature 立项：把 quotaSignal 送独立 runtime-event 通道，UI 在 ChatHeader 用小角标展示。
- **`phase1-header.ts` 删行未 commit**：小孙在 dev 分支删除 `"不要加载全文"` 行但未 commit、也未同步 `phase1-header.test.ts`。独立问题，需小孙决策（恢复 / 或更新测试 + commit）。
