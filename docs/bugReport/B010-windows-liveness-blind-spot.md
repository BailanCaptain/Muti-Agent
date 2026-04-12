---
id: B010
title: Windows liveness probe 盲区 — idle-silent 快杀路径失效
related: ~
---

# B010 — Windows liveness probe 盲区 — idle-silent 快杀路径失效

## 1. 报告人

黄仁勋，2026-04-12，由桂芬（Gemini）会话中途冻结现象触发调查。

## 2. Bug 现象

在 Windows 上，Gemini CLI（以及 Claude / Codex CLI）在输出到中途后如果进入长时间静默（例如触发 429 内部重试循环），UI 会呈现"加载中不动"状态，**最长持续 5 分钟**，用户无任何反馈，无法提前中止。

Unix 上同等场景下：liveness probe 在 3 分钟后检测到 idle-silent 并强杀，5 分钟为 busy-silent 兜底。

## 3. 复现步骤

**期望行为**：CLI 进入静默后，~3 分钟内 probe 检测到 idle-silent，触发强杀并返回超时错误提示用户。

**实际行为**：Windows 上等待满 5 分钟 inactivity timeout 才强杀，期间 UI 一动不动。

触发场景：Gemini CLI 命中 429 RESOURCE_EXHAUSTED，内部重试（10× 5-30s backoff），stdout 静默。

## 4. 根因分析

### 查了什么

1. 追踪 `liveness-probe.ts` 的 Windows 分支：

```ts
// liveness-probe.ts:217
if (this.platform === "win32") {
  this.cpuGrowing = false   // ← 永远 false，无法区分"在思考"vs"卡死"
  this.emitSilenceWarnings()
  return
}
```

原因：Unix 用 `ps -o cputime=` 采 CPU 增长，Windows 没有 `ps`，所以提前返回，`cpuGrowing` 锁定为 `false`。

2. `canClassifySilentState()` 依赖 `platform !== "win32"` → Windows 永远返回 `false`。

3. `base-runtime.ts` 的快杀路径有前置条件 `probe.canClassifySilentState()` → Windows 整个分支永远不走：

```ts
if (
  probe &&
  probe.canClassifySilentState() &&  // ← Windows: false → 整段 skip
  elapsed >= lifecycle.livenessStallWarningMs &&
  probe.getState() === "idle-silent"
) {
  stalled = true
  requestTermination()
}
```

4. `shouldExtendTimeout()` 在 Windows 也返回 `false`（`cpuGrowing=false`），
   因此不会延伸超时，只会等满 5 分钟的 `inactivityTimeoutMs` 才 `timedOut`。

### 排除了什么

- 不是 Gemini 专属：base-runtime 层所有 CLI 共享同一 liveness probe，均受影响
- 不是超时配置问题：默认值正确，是 Windows CPU 采样能力缺失导致分类路径失效
- 不是 F004 删 fast-fail 引入的：F004 删的是 stderr fast-fail；此 probe 盲区在 B002 引入 liveness probe 时就存在

## 5. 修复方案

**选择**：用 PowerShell `Get-Process` 为 Windows 补充 CPU 采样，移除 win32 早退分支，让 Windows 和 Unix 走相同的 CPU 分类路径。

```ts
// 新增 Windows CPU 采样器
function defaultSampleCpuTimeWindows(pid: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU`
    ], (err, stdout) => {
      if (err) { reject(err); return }
      const trimmed = stdout.trim()
      if (!trimmed) { reject(new Error(`pid ${pid} not found`)); return }
      resolve(Math.round(parseFloat(trimmed) * 1000))
    })
  })
}
```

构造函数按 platform 选择默认采样器：
```ts
this.sampleCpuTime = deps.sampleCpuTime ??
  (this.platform === "win32" ? defaultSampleCpuTimeWindows : defaultSampleCpuTime)
```

移除 `sampleOnce()` 中 `win32` 早退；`canClassifySilentState()` 改为恒 `true`。

**放弃的备选**：
- 方案 B（缩短 Windows inactivity timeout 到 2 分钟）：一刀切，会误杀正在重试的 Gemini
- `wmic`：已在 Windows 11 中弃用

## 6. 验证方式

**单元测试（`liveness-probe.test.ts`）**：
- 注入 `platform: "win32"` + 递增 CPU 样本 → 期望 `getState()` = `"busy-silent"`
- 注入 `platform: "win32"` + 平坦 CPU 样本 → 期望 `getState()` = `"idle-silent"`
- `canClassifySilentState()` 在 win32 上 → 期望 `true`
- 新增 `parseCpuTimeSeconds` 解析器测试

**集成验证**：
- Windows 上跑 Gemini，人为让其长时间静默（例如极大 prompt），
  确认 ~3 分钟内收到 `suspected_stall` 警告并强杀，而不是等满 5 分钟。

---

## 7. 已知回归

**B011**（2026-04-13）：B010 启用 Windows stall 快杀后，Gemini 在 429 重试期间被误杀。

根因：B010 启用了 `canClassifySilentState()=true`，但 `forwardStderr` 故意不更新 `lastActivityMs`。组合结果 = Gemini 在 stderr 打印 429 重试消息时 stall clock 不重置 → 180s 后被杀。

修复：`base-runtime.ts` 新增 `lastStderrMs`，stall 判定用 `Math.max(lastActivityMs, lastStderrMs)`。

详见 `docs/bugReport/B011-stall-kill-mid-retry.md`。
