# B002 — 桂芬（Gemini）触发 RESOURCE_EXHAUSTED 后"再也起不来"

> 状态：fixed（Phase 4 落地完成，等小孙现场复验）
> 报告日期：2026-04-10
> 报告人：小孙（现场观察）
> 处理人：黄仁勋
> Related: B001（WebSocket emit 静默失效，handoff 通路前置保护）

---

## 1. 报告人 / 发现场景

小孙在串行讨论中观察到：桂芬的会话报错
> `Agent CLI 触发已知的致命错误（Google API RESOURCE_EXHAUSTED（配额/容量耗尽）），已提前终止避免陷入长时间重试循环。请重试一次。`

之后**桂芬就再也没起来过**，后续对话无法继续向她派发任务。

---

## 2. 诊断胶囊（8 栏工作模板）

### 现象
- 桂芬先成功回复 → 触发 429 / RESOURCE_EXHAUSTED → 前端显示上述致命错误 status → 后续所有 @桂芬 派发都"没有效果"
- "再也没起来过" 的精确含义**尚未确认**，需要小孙澄清（见 §7）

### 证据（已收集）
- 错误字符串来源：`packages/api/src/runtime/base-runtime.ts:120` (`formatFastFailMessage`)
- 匹配模式来源：`packages/api/src/runtime/gemini-runtime.ts:48-53` (`GEMINI_FAST_FAIL_PATTERNS`)
  - 命中 `/RESOURCE_EXHAUSTED/i` → reason = "Google API RESOURCE_EXHAUSTED（配额/容量耗尽）"
- 触发路径：`base-runtime.ts:278-290` `forwardStderr` → `requestTermination` → SIGTERM → close → `reject(new Error(formatFastFailMessage(...)))`
- 接住路径：`message-service.ts:701-734` catch 块
  - `classifyFailure("", message)` → 消息含 `RESOURCE_EXHAUSTED` → `rate_limited` 分类
  - `rate_limited.shouldClearSession = false` → **session 被保留**
  - `safeToRetry = false` → userMessage: "上游限流了..."
  - 正确调用 `detachRun` + `releaseInvocation` ✓
  - 正确 emit `invocation.failed` + `status` + `thread_snapshot` ✓
  - `flushDispatchQueue` 被调用 ✓
- 无熔断/黑名单机制：grep `circuit|blockProvider|disabledProvider|cooldown` → 无匹配
- 前端无 `invocation.failed` 特殊处理：grep components/ → 无匹配
- 新用户消息会清除取消标记：`dispatch.ts:89` `registerUserRoot` → `cancelledSessionGroups.delete(sessionGroupId)`
- dispatch loop 在 finally 块释放 slot：`message-service.ts:854-858`

### 假设（按可能性排序）

**H1（最可能）— Gemini 日配额真的耗尽，每次重试都撞同一堵墙**
- 触发条件：小孙用的是免费额度或者刚好今日配额用完
- 预期观察：每次 @桂芬，她启动后 **立刻** 再次报同样的错误；thread snapshot 正确显示她 idle；error message 重复
- 根因：不是 bug，是 UX 问题 —— 我们把 daily quota exhaustion 和 transient RPS limit 当成同一类处理，都告诉用户"等 1-2 分钟再试"，但 daily quota 等一整天才解除
- 修复方向：区分 transient vs daily，在 status 消息里给出"今日配额已用完，明天再试"或者"暂时被限流，1-2 分钟后重试"

**H2 — 保留的 nativeSessionId 已损坏，resume 必败**
- 触发条件：fast-fail 发生在 `--resume <sessionId>` 路径；Gemini CLI 侧的 session 状态因进程被 SIGTERM 打断而半写入磁盘
- 预期观察：每次 @桂芬，CLI 启动后立即报一个 **不是 RESOURCE_EXHAUSTED** 的其他错误（session 相关），或者在 resume 阶段 hang 掉被 liveness probe 杀死
- 根因：`rate_limited.shouldClearSession = false` 的决策不够严谨 —— 在 fast-fail 场景下，进程被中断时 session 文件可能处于不一致状态
- 修复方向：fast-fail 路径强制 clear session（而非依赖 classifier 分类）；或者引入第二次 retry 策略：第一次带 resume，失败后无条件 clear session 再试

**H3 — 日常配额 + 保留 session 的组合：每次 resume 复用同一上下文导致立刻复现配额错误**
- 触发条件：Gemini 服务端对**同一 session**计数上下文长度，长 session 每次 resume 都重新累计 token，正好压在配额阈值
- 预期观察：同 H1，但表现为"只有 @桂芬起不来，如果新开一个 sessionGroup（新 session）她又能起来"
- 根因：把 session seal 策略的阈值调太松；或者说 RESOURCE_EXHAUSTED 分类的 shouldClearSession 应该视具体子原因而定
- 修复方向：RESOURCE_EXHAUSTED fast-fail 附带 clear session（放弃老 session 的重资源）

**H4 — 前端 thread snapshot 没正确更新，桂芬显示在"工作中"被卡住**
- 触发条件：类似 B001 但出现在 Gemini 路径 —— emit 链某一步失败
- 预期观察：线程卡片一直 running=true；后端 DB 里 invocation 实际已 failed
- 根因：已被 B001 Fix 1 覆盖（sendSocketEvent 吞异常）。如果仍然出现，说明 B001 只修了外层闭包，message-service 内部某处还有 emit 没被保护
- 修复方向：追 emit 链，补漏

### 诊断策略
1. **向小孙问 1 个精准澄清**（见 §7）→ 锁定 H1 / H2 / H3 / H4
2. 如果 H1：不做代码改动，改 user message 文案 + 可选地加"daily quota detected"的启发式
3. 如果 H2/H3：加诊断桩记录 fast-fail 时的 sessionId / stderr 全文 / 下一次 turn 的 stderr → 对比验证
4. 如果 H4：按 B001 的套路继续补 emit try/catch

### 超时策略
- 诊断阶段 budget：1 次澄清 + 最多 6 次 shell/读文件 → 若未收敛则写中期报告找小孙讨论
- Phase 4 实现 budget：< 30 行代码修改（文案 + 分类细化）

### 预警策略
- 若发现要改 `base-runtime.ts` 的 fast-fail 核心逻辑 → stop，这是高风险路径，先找小孙对齐
- 若发现改动会影响 B001 刚加的 `sendSocketEvent` 返回值契约 → stop，先列出影响面

### 用户可见修正（可选）
- 澄清文案：`"Gemini 上游配额/容量耗尽。如果是免费额度，通常次日恢复；如果是 RPS 限流，1-2 分钟后可重试。"`
- 如果最终确认 H1，可在前端给 Gemini 卡片加一个"配额受限"徽章，持续一段时间

### 验收
- 小孙能复述清楚根因属于 H1/H2/H3/H4 哪一类
- 修复 landing 后，小孙再现场复现时能确认桂芬恢复正常
- （如果是 H1）用户收到的错误消息不再误导"1-2 分钟后重试"

---

## 3. 根因分析

### 核心结论（DB 证据确认）

**Classifier 误分类 → handoff 通路从未触发。**

`failure-classifier.ts` 的 `PATTERNS` 把 `resource_exhausted | model_capacity_exhausted | quota_exceeded` 和 `too many requests | rpm_exceeded` 全部塞进同一个 `rate_limited` 桶：

```ts
// 修复前
match: /(429|resource[_ ]exhausted|model[_ ]capacity[_ ]exhausted|rate[_ ]?limit|quota[_ ]exceeded|too many requests|rpm.{0,10}exceeded)/i,
cls: "rate_limited"
```

而 `resolve("rate_limited")` 的决策是 `shouldClearSession: false` —— 理由是"RPS 限流不是 session 问题，保留 session 等解除限流"。

**DB 证据（`data/multi-agent.sqlite` 现场）**：
- 线程 `25de2b3a-081b-4ff1-8d25-1126b6009a52`（sessionGroup `92e7409a`）
  - 16:44:19 invocation `0e658860`：exit=0，Phase 1 正常回复
  - 16:49:10 invocation `dd8e407e`：exit=null，Phase 2 串行讨论命中 RESOURCE_EXHAUSTED
  - **事后 `threads.native_session_id` 仍为 `fd66ec33-2358-4904-b...`**（未清空）→ classifier 没触发 clear

**H1/H2/H3/H4 哪个中？** 兼具 H1 + H3 特征：
- 现场读 2 组失败线程，一组是 session 复用导致上下文累积（capacity 类），另一组是账号级日配额（account 类）
- 两种都从 `formatFastFailMessage` 出来时字符串一模一样：`Google API RESOURCE_EXHAUSTED（配额/容量耗尽）`
- **从错误字符串无法分辨** capacity vs account — 所以修复逻辑走"更安全 = 清 session"路径：清了能救 capacity 类，对 account 类也只是无害 no-op

### 为什么"重启/改 key 就恢复"的感知是错的

DB 一查：小孙感知的"恢复"其实是**换了 sessionGroup**（17:02:40 有新 sessionGroup 的活动，话题不同），跟重启/改 key 无关。SQLite 持久化保证"重启不会自愈 DB 里 stuck 的 native_session_id"。

### 为什么 clowder-ai 看着复杂、我们的修复这么小

核对 `reference-code/clowder-ai/packages/api/src/domains/cats/services/agents/providers/GeminiAgentService.ts:106,119-130` 和 `SessionSealer.ts` 后发现：**核心 handoff 机制（清 sessionId → 不加 --resume → fresh CLI → systemPrompt 注入摘要）和我们同构**。他们多出来的 state machine / transcript / circuit breaker 是韧性加成，不涉及本 bug 的数据流。我们的 handoff 通路早就通的（`memory-service.generateRollingSummary` → `context-assembler.assembleDirectTurnPrompt` 注入 `## 本房间摘要` → `gemini-runtime.ts:73-86` 分支），**唯一缺的是让 classifier 不拦**。

---

## 4. 修复方案

### 4.1 Classifier 拆桶 —— `packages/api/src/runtime/failure-classifier.ts`

把 capacity/quota 从 `rate_limited` 拆出来，归入 `context_exhausted`（`shouldClearSession: true`）：

```ts
// Capacity / quota / context — checked BEFORE rate_limited: capacity wins over RPS,
// clearing session is strictly safer. Intentionally no naked "429" — ambiguous.
{
  match: /(resource[_ ]exhausted|model[_ ]capacity[_ ]exhausted|capacity[_ ]exhausted|quota[_ ](exceeded|exhausted)|context[_ ](window|length)[^\n]{0,40}(exceed|limit|full|too)|token[_ ]limit[^\n]{0,20}exceed|prompt is too long)/i,
  cls: "context_exhausted"
},
// ...auth_failed, session_corrupt...
// True account-level RPS: session-agnostic, runs AFTER context_exhausted.
{
  match: /(too many requests|rpm.{0,10}exceeded|rate[_ ]?limit(?!.*exhausted))/i,
  cls: "rate_limited"
}
```

顺序关键：当 raw stderr 同时含 `429 too many requests` + `RESOURCE_EXHAUSTED`，capacity 必须先匹配，否则退化回老 bug。

同步改 `context_exhausted` 的 userMessage（现在承载更广语义）：
> "上游报告容量/配额耗尽（可能是 session 上下文过长，也可能是 Gemini 日配额）。已清空 session，下一轮开新房间带摘要继续；如果仍然失败，通常是日配额，次日恢复。"

### 4.2 摘要模型升级 —— `packages/api/src/services/memory-service.ts:135`

`gemini-2.5-flash-preview` → `gemini-3.1-pro-preview`。原因：handoff 通路现在会真的被频繁触发（seal 不再被 classifier 拦），摘要质量直接决定 fresh session 能否衔接上原对话。用 Pro 换更稳的长文档理解。

### 4.3 不改的东西

- `base-runtime.ts` fast-fail 核心逻辑 —— 高风险，且不是根因
- `computeSealDecision` 阈值 —— clowder-ai 同值
- Codex 上下文窗口 fallback（gpt-5.4 / gpt-5-mini）—— 另一个独立问题，需要独立证据
- State machine / transcript artifact —— 韧性加成，scope 外

---

## 5. 验证方式

### 5.1 单测（Red → Green）

`packages/api/src/runtime/failure-classifier.test.ts` 新增/更新 4 条：

1. **B002 回归测试**（用 DB 里原话）：
   ```
   classifyFailure("", "Agent CLI 触发已知的致命错误（Google API RESOURCE_EXHAUSTED（配额/容量耗尽））...")
   → class: "context_exhausted", shouldClearSession: true
   ```
2. **Raw stderr 同时含 429 + MODEL_CAPACITY_EXHAUSTED** → `context_exhausted`（验证顺序）
3. **纯 RPS "HTTP 429: too many requests"** → 保持 `rate_limited`（验证 `?!.*exhausted` 负向 lookahead）
4. **"quota exceeded"** 现在归 `context_exhausted`（从旧 `rate_limited` 搬家）

全套 12 个 classifier 测试 + 相关 37 个测试（memory-service / context-seal / message-service）全绿。

### 5.2 手工复现（等小孙）

1. 开 Gemini 串行讨论，让桂芬喂到 RESOURCE_EXHAUSTED
2. 观察 DB：`SELECT native_session_id FROM threads WHERE id = '<当前 thread>'` 应变为 NULL
3. 再次 @桂芬，CLI 日志应该**没有 `--resume` 参数**，systemPrompt 里能看到 `## 本房间摘要` 段落
4. 回复正常出来 = 修复成功

### 5.3 非 B002 回归点

- 纯 RPS 场景（"Rate Limit Exceeded" / "too many requests"）仍应保持 session（不清）
- 非 Gemini 路径（Claude / Codex）的 classifier 行为不变

---

## 6. 落地记录

- **2026-04-10** 修复落地（当前 session）
  - `packages/api/src/runtime/failure-classifier.ts`：PATTERNS 拆桶 + 顺序重排 + userMessage 更新
  - `packages/api/src/runtime/failure-classifier.test.ts`：红测试 4 条（含 B002 回归）
  - `packages/api/src/services/memory-service.ts:135`：摘要模型换 `gemini-3.1-pro-preview`
  - 本文档 Phase 1-4 同步
- **待小孙现场复验** 后翻 `fixed → closed`
- **后续可选跟进**（不在本次 scope）：
  - Codex gpt-5.4/gpt-5-mini 的 context window fallback 是否准确（独立 bug）
  - 若高频撞日配额，考虑前端给 Gemini 卡片加"配额受限"徽章（UX 层）
