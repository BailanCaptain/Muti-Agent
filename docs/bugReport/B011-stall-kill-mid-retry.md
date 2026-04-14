---
id: B011
title: stall 快杀在 Gemini 429 重试期间误杀 — B010 回归
status: fixed
related: B002, B006, B010, LL-004, LL-006, LL-008
created: 2026-04-13
resolved: 2026-04-13
---

# B011 — stall 快杀在 Gemini 429 重试期间误杀

**症状族**：B002 → B006 → B010 → B011，同一根问题的第四轮修复。
**Created**: 2026-04-13
**Resolved**: 2026-04-13

---

## 1. 报告人

小孙，2026-04-13 报"最新的会话桂芬又停了"。

---

## 2. Bug 现象

桂芬（Gemini）在多轮复杂对话中途停止响应。UI 显示错误：
> Agent 进程看起来已卡住（CPU 空转，无新输出 ≥ 180 秒）

用户直接在终端跑 `gemini -p "你好" --model gemini-3-flash-preview` 完全正常。

---

## 3. DB 证据（决定性）

```
session_group: 632ce59c  thread: f33b2429  invocation: 3c66dae5
status: error    exit_code: null

时间线：
15:50:45  stdout  — tool_result（最后一次 stdout 活动）
15:50:52  stderr  — Attempt 1 failed 429: "No capacity available for model"
15:51:10  stderr  — Attempt 2 failed 429
15:51:31  stderr  — Attempt 3 failed 429
15:52:03  stderr  — Attempt 4 failed 429
15:52:49  stderr  — Attempt 5 failed 429
15:53:30  stderr  — Attempt 6 failed 429
15:53:49  KILLED  — invocation.failed: "CPU 空转，无新输出"
          ↑ 从最后 stdout 算起 184 秒 > livenessStallWarningMs (180s)
```

桂芬正在正常重试（Gemini CLI 内置 10 次 × 5-30s backoff），重试到第 6 次时被我们杀了。

---

## 4. 根因分析

### 信号链（逐跳追踪）

```
① Gemini 遇 429 → CLI 内部 retry，输出 stderr "Attempt N failed..."
② forwardStderr 收到 stderr → 「故意不更新 lastActivityMs」(base-runtime.ts:305)
③ recordStdoutActivity 没被调用 → lastActivityMs 停在 15:50:45
④ heartbeat 定时器每 30s 检查：elapsed = now() - lastActivityMs
⑤ 15:53:49 时 elapsed = 184s > livenessStallWarningMs (180s) → 进入 stall 判定
⑥ probe.canClassifySilentState() → true（B010 改的：Windows 也启用了）
⑦ probe.getState() → "idle-silent"（Gemini CLI 等 API 响应时 CPU 为零）
⑧ 三个条件全部满足 → requestTermination() → 进程被杀
```

### 每一跳的假设和失效点

| 跳 | 假设 | 现实 | 谁引入的 |
|----|------|------|---------|
| ② | stderr = 诊断噪声，不是活动 | **对于 429 重试成立，但和 ⑥ 组合后就不成立了** | base-runtime 初始设计 |
| ⑥ | CPU 采样足以区分 busy vs idle | **对本地计算型 CLI 成立，对网络 I/O 型 CLI 不成立**（等 API = CPU 零） | B010 |
| ②+⑥ | 两个假设各自合理，但**从未被一起验证过** | 组合后 = "stderr 活跃但不算活动 + CPU 平就算 idle" → 误杀 | — |

### 为什么 B010 之前 Windows 没这个问题

B010 之前 `canClassifySilentState()` 在 Windows 返回 `false` → 第 ⑥ 跳不走 → stall 快杀路径整体禁用。B010 打开了这个路径但**没有回溯 ② 的假设是否仍然兼容**。

---

## 5. 修复方案

**策略**：让 stderr 活动参与 stall 快杀判定，但不参与普通 inactivity 超时。

三处改动（`packages/api/src/runtime/base-runtime.ts`）：

```ts
// ① 新增变量
let lastStderrMs = 0;

// ② forwardStderr 中更新
lastStderrMs = now();

// ③ stall 判定：用 stdout 和 stderr 中较晚的那个
const lastAnyMs = Math.max(lastActivityMs, lastStderrMs);
const stallElapsed = now() - lastAnyMs;
// 原来用 elapsed（stdout-only），改用 stallElapsed
```

**效果矩阵**：

| 场景 | stall 快杀 (180s) | inactivity 超时 (5min) |
|------|------------------|----------------------|
| 429 重试中（stderr 活跃） | **不触发**（stderr 重置 stall clock） | 触发（stdout 仍然计时） |
| 真卡死（全静默） | 触发（两个时钟都过期） | 触发 |
| 正常工作（stdout 活跃） | 不触发 | 不触发 |

**没改的**：
- `inactivityTimeoutMs` 仍然只看 stdout → 5 分钟兜底不变
- probe 的 CPU 采样逻辑不变
- `canClassifySilentState()` 不变

---

## 6. 验证方式

### 自动化

新增测试 `base-runtime.test.ts`：
- **"stall fast-kill deferred while stderr is active (B010-fix: 429 retry protection)"**
  - stdout 写一次后沉默
  - stderr 持续输出（模拟 429 重试）
  - 等待超过 stall 阈值
  - 发 `turn_complete` + close
  - **断言 exitCode=0**（没被杀）

全套 13/13 测试通过（含新测试）。

### 实测验证

```bash
# Gemini CLI stdout vs stderr 分离实测
gemini -p "你好" --model gemini-3-flash-preview --output-format stream-json \
  1>/tmp/stdout.txt 2>/tmp/stderr.txt

# stdout: init, message, tool_use, tool_result, result（全部结构化内容）
# stderr: YOLO提示, Skill conflict 警告（纯诊断噪声）
```

确认 `--output-format stream-json` 模式下所有实质内容走 stdout，stderr 只有诊断信息。

---

## 7. 完整症状族回顾

B002 → B006 → B010 → B011 是**同一根问题的四轮修复**："怎么处理 Gemini CLI 的 429 重试"。

| 轮次 | 修了什么 | 层 | 策略 | 引入的新问题 |
|------|---------|---|------|------------|
| B002 (04-10) | 429 后卡死 | classifier | 429 stderr → fast-fail 杀进程 | 把可恢复的也杀了 |
| B006/F004 (04-11) | fast-fail 误杀 | stderr fast-fail | 删 fast-fail，信任 CLI retry | 真卡死等 5 分钟 |
| B010 (04-12) | Windows 检测盲区 | liveness probe | PowerShell CPU 采样 + 启用 stall 快杀 | stderr 不算 activity → 重试中被误杀 |
| **B011** (04-13) | stall 误杀 | stall 判定 | stderr 参与 stall 计时 | — |

**每一轮都解决了上一轮的问题，同时引入了新的问题。** 根本原因见 §8。

---

## 8. 为什么改了四轮

### 技术根因

三个独立设计决策各自合理，但从未被组合验证：

1. **"stderr = 噪声"**（base-runtime 初始设计）— 合理，因为 Gemini 429 重试会刷 stderr
2. **"CPU 平 = 卡死"**（liveness probe 设计）— 对本地 CLI 合理，对网络 I/O 型 CLI 不成立
3. **"Windows 也启用 stall 快杀"**（B010）— 合理，填补了 Windows 检测盲区

三个决策的组合 = "stderr 活跃但不算活动 + CPU 平就算卡死 + 现在 Windows 也开始判定" → 误杀。

### 流程根因

1. **没有端到端信号链追踪**：B010 改 probe 时只验证了 probe 本身（"CPU 采样准不准"），没有从 stderr 进入到进程被杀走完整条链路。一走就能发现第 ② 跳和第 ⑥ 跳的假设冲突。

2. **没有跨组件集成测试**：每轮都只写了单元测试。从来没有一个测试是"stdout 沉默 + stderr 活跃（429 重试）→ 验证不被杀"。

3. **改动只看自己那一层的假设**：B010 的验证是"Windows 上 idle-silent 能检测到了吗？能 → 通过"。没问"idle-silent 触发后，stall 判定的其他前置条件（activity timer）在 Windows 上和 Unix 上行为一致吗？"

**一句话**：每次只修了链路上的一个跳，没有端到端验证整条链路。见 LL-008。
