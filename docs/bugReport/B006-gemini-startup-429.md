---
id: B006
title: 桂芬起手 RESOURCE_EXHAUSTED — 我们的 fast-fail 和 Gemini CLI 的 retry 抢同一个语义
status: fixed
related: F004, LL-006
created: 2026-04-11
resolved: 2026-04-11
---

# B006 — 桂芬起手 RESOURCE_EXHAUSTED

**Related**: F004 上下文记忆权威化 · LL-006 同层反复打补丁的终极教训
**Status**: fixed（F004 AC5 第三版修复）
**Created**: 2026-04-11
**Resolved**: 2026-04-11

## 诊断胶囊（8 栏工作模板）

### 1. 现象

小孙新建会话后 @ 桂芬，桂芬一句话没说就报：
> Error: Agent CLI 触发已知的致命错误（Google API RESOURCE_EXHAUSTED（配额/容量耗尽）），已提前终止避免陷入长时间重试循环。请重试一次。

### 2. 证据

- `packages/api/src/runtime/gemini-runtime.ts:41-46`（已删除）原 `GEMINI_FAST_FAIL_PATTERNS`：stderr 看到 RESOURCE_EXHAUSTED / MODEL_CAPACITY_EXHAUSTED / quota exceeded / 429 就返回 classification，触发 fast-fail
- `packages/api/src/runtime/base-runtime.ts:284-307` 的 fast-fail 实现：runtime 返回非空 classification 即 `requestTermination()` 砍进程
- 小孙是订阅制（OAuth 登录），`GEMINI_API_KEY` 没设，`callGeminiSummarizer` 直接 `return extractive` —— **摘要服务从未打过 Google API**
- 小孙手动验证 v2（threshold=2）**仍然 2 次 @ 桂芬都崩**
- **Codex 实测决定性证据**（2026-04-11）：
  ```
  gemini -p "只回复 OK" --model gemini-3.1-pro-preview --output-format stream-json --approval-mode yolo
  ```
  连跑 6 次 → 6/6 最终成功返回 OK。其中 3/6 中途真实打印 `No capacity available for model gemini-3.1-pro-preview on the server`，第 4 次 **连续 2 次 Attempt failed with status 429 之后还恢复成功**
- stderr 实物（小孙贴的失败现场）显示 Gemini CLI 内部 `retryWithBackoff` 已经在跑 Attempt 1/2，但在 Attempt 3 之前我们的 fast-fail 已经砍了进程

### 3. 假设演进

- **v1（立项假设，错）**：摘要服务和 CLI 抢同一个 API key 配额。→ 订阅制无 key，不成立。
- **v2（实施期假设，错）**：Gemini CLI 起手首次 transient 429，threshold=2 给一次 self-retry 窗口就够。→ 小孙手动验证失败，Codex 实测证明连续 2+ 次 429 仍可恢复，任何有限 threshold 都错杀。
- **v3（最终根因）**：**我们的 fast-fail 和 Gemini CLI 自己的 retry 循环在抢同一个语义**。Gemini CLI 的 retry 是 10 次 × 5-30s ≈ 4 分钟，可以跨越 2+ 次连续 429 自行恢复。任何有限 threshold（1/2/N）都会把本可恢复的请求提前砍掉。上一层的修复不是调阈值，是**删除 fast-fail 这条错误启发式本身**，相信 CLI 的 retry 循环。

### 4. 诊断策略

Phase 1 代码静态分析 → v1 假设 → v2 修完仍失败 → Phase 3 要求 Codex 独立在 PowerShell 裸跑 CLI 观察 → 获得 6/6 决定性反例 → v3 根因锁定。

**关键教训**：如果 v1 修完之后就立项 AC8 手动验证，能更早发现 v2 也是错的。同层反复打补丁的陷阱只能用独立的外部实测打破，不能靠内部逻辑推演。

### 5. 超时策略

v3 删除 fast-fail 后，Gemini 偶发 transient 429 由 CLI 自己处理（~4 分钟 retry 窗口）；如果 CLI 真正卡死不退，由 `ProcessLivenessProbe` 的 stall window 兜底（同阶 ~4 分钟）。两个窗口同阶是刻意的 —— B002 当时加 fast-fail 想"加速失败"本身就是错的假设。

### 6. 预警策略

F004 落地后的回归测试：
- `gemini-runtime.test.ts` 四条 `classifyStderrChunk` 测试：RESOURCE_EXHAUSTED / MODEL_CAPACITY_EXHAUSTED / 429 Too Many Requests / benign 一律返回 `null`（语义翻转为"不触发 fast-fail"的守护网）
- `base-runtime.test.ts` 既有 `FastFailRuntime` 两条测试继续保持绿：framework 本身能用，未来有 runtime 需要时可按需覆写 `classifyStderrChunk`
- **删除了** v2 的两条 `fast-fail respects getFastFailMatchThreshold` / `fast-fail kills on second match when threshold is 2`（它们守护的是 v2 错误方案）

### 7. 用户可见修正

修复后用户视角：新会话 @ 桂芬，如果 Gemini CLI 遇到 transient 429，**CLI 自己内部 retry 循环会处理**，大概率在几秒到几十秒内恢复并返回正常答复。不再出现"一句话没说就崩"。真正罕见的 genuine 配额打满场景会等到 CLI 自己放弃（~4 分钟）后返回错误，代价可接受。

### 8. 验收

- Codex 独立 6/6 手动实测（裸 PowerShell 跑同 model）→ 证明 Gemini CLI 自恢复能力
- F004 测试矩阵 77/77 绿（含 v3 翻转后的 4 条 `classifyStderrChunk` 测试）
- 小孙新会话 @ 桂芬能否正常对话（小孙亲验 —— **v3 code 已就位，等重启后验证**）

## 五件套存档

### 报告人

小孙，2026-04-11 发现新会话桂芬起手即崩。小孙和 Codex 联合实测锁定 v3 根因（6/6 决定性证据）。

### 复现步骤

**v3 前（错误行为）**：
1. 新建会话
2. @ 桂芬（任意消息）
3. 立即报 "Agent CLI 触发已知的致命错误（Google API RESOURCE_EXHAUSTED）"

**v3 后（预期行为）**：
1. 新建会话
2. @ 桂芬
3. 桂芬正常回复；如果 Gemini CLI 遇到 transient 429，CLI 自己 retry 后返回正常答复（几秒到几十秒）

### 根因分析

**三版根因演进**：
- **v1（错）**：摘要服务抢 CLI 的 API key 配额 → 订阅制没 key，假设错
- **v2（错）**：threshold=2 给 CLI 一次 self-retry → 实测证明 CLI 能跨越 2+ 次 429 恢复
- **v3（真）**：我们的 fast-fail 和 Gemini CLI 的 retry 在抢同一个语义 —— CLI 的 retry 循环（10 次 × 5-30s）设计上就能自恢复大部分 transient 情况；我们的 fast-fail 把本可恢复的请求提前砍掉

**上一层的错误假设**：B002 当时加 fast-fail 基于"RESOURCE_EXHAUSTED 不可恢复，要提前失败省时间"，这个假设本身就是错的。F004/B006 实测证伪并一并纠正。

### 修复方案

F004 AC5 v3 实现：

1. `packages/api/src/runtime/gemini-runtime.ts`：**删除** `GEMINI_FAST_FAIL_PATTERNS` 数组 + `classifyStderrChunk` 覆写 + `getFastFailMatchThreshold` 覆写，整段不再对 Gemini stderr 做 fast-fail
2. `packages/api/src/runtime/base-runtime.ts`：回退 `getFastFailMatchThreshold` 虚方法 + `fastFailMatchCount` 计数器，回到"一次命中即杀"的简单形态（framework 保留，供未来 runtime 按需启用）
3. `packages/api/src/runtime/gemini-runtime.test.ts`：四条 `classifyStderrChunk` 测试语义翻转 —— 所有 RESOURCE_EXHAUSTED / 429 stderr 一律 `assert.equal(..., null)`
4. `packages/api/src/runtime/base-runtime.test.ts`：删除 v2 的两条 threshold 测试
5. `memory-service.ts` **不改**（v1 的 MEMORY_SUMMARY_API_KEY 方案早已撤掉）

### 验证方式

**自动化**：
- `npx tsx --test packages/api/src/runtime/base-runtime.test.ts packages/api/src/runtime/gemini-runtime.test.ts` → 14/16 绿（2 条 `parseAssistantDelta` 失败是 F004 之前就存在的，不相关）
- F004 完整矩阵 77/77 绿

**手动**：
- Codex 独立 6/6 PowerShell 裸跑 → 已完成
- 小孙新会话 @ 桂芬 → 待重启 API 后验证

**决定性证据**：Codex 手动实测的 6/6 结果就是 v3 根因的直接证据，v3 代码改动只是让 Multi-Agent 不再妨碍 CLI 自己的恢复能力。
