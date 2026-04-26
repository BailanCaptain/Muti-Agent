# F021 Phase 6 — 上下文窗口 + Seal 阈值齿轮可配 + fillRatio 观测

**Feature:** F021 — `docs/features/F021-right-panel-redesign.md` (Phase 6, reopened 2026-04-22)
**Goal:** 把代码硬编码的"模型→窗口表"和"Seal 阈值表"做成齿轮里可配（全局默认 + 会话覆盖 + 代码 fallback 三层），并在 observation-bar 加 fillRatio 实时观测条；让模型升级和长任务防漂移不再需要改代码出 commit。
**Acceptance Criteria:** AC-22 ~ AC-30（见 feature doc Phase 6 段）
**Architecture:**
- 复用 F021 现有两层 override 机制：全局 = `runtime-config.json`，会话 = `session_groups.runtime_config TEXT`，**无需新 ALTER TABLE**
- 扩 `AgentOverride` 类型加 `contextWindow?: number; sealPct?: number` 两字段（前后端 schema 同步）
- 后端三层取值：会话 → 全局 → 代码 fallback（`SEAL_THRESHOLDS_BY_PROVIDER` / `getContextWindowForModel` 保留作为最后兜底）
- 前端齿轮两 Tab 各加两个 Field（最大窗口 + Seal 阈值百分比），observation-bar 加 fillRatio 进度条
**Tech Stack:** TypeScript · zustand · Next.js · `node:test` (后端) + vitest (前端) · Drizzle (会话 JSON 字段，无 schema 改动)

---

## Kickoff Corrigendum（实施前修正）

**AC-22 措辞修正**（feature doc 当前写"global_overrides + session_overrides 各加列"是基于错误代码假设）：

| 原写法 | 实际事实 | 修正后 |
|---|---|---|
| `global_overrides` 表 | 不存在该表，全局是 JSON 文件 `multi-agent.runtime-config.json` | 扩 `AgentOverride` 类型加字段，sanitize 同步扩；JSON 自动 round-trip |
| `session_overrides` 表 | 不存在独立表，会话覆盖在 `session_groups.runtime_config TEXT` 整段 JSON | 同上，session_groups JSON 自动支持 |

**AC-26 措辞修正**：当前 `sessionConfig` 写在 `session_groups.runtime_config` —— 这本来就是 thread/room 级别（一条聊天线一直生效）；原 AC-26 注释"scope thread-level vs session-level 需独立确认 store key"是误读，实际无需独立 store key。

实施按修正后的真实代码 base 走。Plan 完成后用一次 docs commit 在 feature doc 加注 corrigendum。

---

## Straight-Line Check（A→B 不绕路）

**Pin finish line（B 终态）**：
- 用户在右侧齿轮 Global Defaults Tab 修改 Claude "最大窗口 = 2_000_000" + "Seal 阈值 = 50%" → 保存 → 下一次 Claude turn 在 1M token 处提早触发 seal
- 用户在 Session Overrides Tab 修改某 thread Claude "Seal 阈值 = 60%" → 保存 → 该 thread 下一次 turn 用 60%（其他 thread 仍走全局 50%）
- observation-bar 实时显示三家 fillRatio（如 `Claude ▓▓▓▓░░ 67% (670k/1M) 距 seal 13%`），跨 warn 变黄 / 跨 action 变红
- 删空所有用户配置 → 自动回退到代码默认（Claude 90% / 200k 等）

**"我们不做什么"（明确 scope 外）**：
- 不暴露 warn 阈值（自动 = action - 5%，UI 只暴露一个 action 数字）
- 不暴露其他 8 处架构内常量（Bootstrap cap / ThreadMemory cap / auto-resume 上限 / F-BLOAT 等），保留代码硬编码
- 不做"模型→窗口表"的 catalog 编辑器（只能针对当前 model 通过 contextWindow 字段覆盖；CONTEXT_WINDOW_FALLBACKS regex 表保留代码内）
- 不做预设档位按钮（保守/平衡/激进），用户输入数字

**Terminal schema（终态接口）**：

```typescript
// shared/runtime-config.ts (前后端共享)
export type AgentOverride = {
  model?: string
  effort?: string
  contextWindow?: number  // tokens, > 0
  sealPct?: number        // 0~1, action 阈值；warn 自动 = sealPct - 0.05
}

// 后端新接口
function resolveSealConfig(provider, threadId, sessionId)
  : { window: number; warnPct: number; actionPct: number }
function resolveContextWindow(model, threadId, sessionId): number
```

**步骤过三问**：
- 每个 Task 产物（type 字段、sanitize 分支、新函数、UI Field、进度条）都在终态保留 ✅
- 每个 Task 完成后能跑特定测试或在 UI 看到具体改变 ✅
- 删任一 Task 系统直接缺一个对应能力（schema/取值/UI/观测）✅

---

## Task 拆分

### Task 1 — AgentOverride 类型扩两字段 + sanitize（前后端 schema 同步）

**Files:**
- Modify: `packages/api/src/runtime/runtime-config.ts:5-10`（type）, `:73-93`（sanitize）
- Modify: `components/stores/runtime-config-store.ts:10-12`（type）, `:43-48`（cleanOverride）
- Test: `packages/api/src/runtime/runtime-config.test.ts`（新建或扩）

**Step 1.1 — 写失败测试（后端 sanitize）**

```typescript
// packages/api/src/runtime/runtime-config.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { loadRuntimeConfig, saveRuntimeConfig } from "./runtime-config"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"

describe("AgentOverride contextWindow + sealPct sanitize", () => {
  it("accepts contextWindow as positive integer", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rc-"))
    const file = path.join(dir, "rc.json")
    writeFileSync(file, JSON.stringify({ claude: { contextWindow: 1000000 } }))
    const config = loadRuntimeConfig(file)
    assert.equal(config.claude?.contextWindow, 1000000)
    rmSync(dir, { recursive: true })
  })

  it("rejects contextWindow <= 0", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rc-"))
    const file = path.join(dir, "rc.json")
    writeFileSync(file, JSON.stringify({ claude: { contextWindow: 0 } }))
    assert.equal(loadRuntimeConfig(file).claude?.contextWindow, undefined)
    rmSync(dir, { recursive: true })
  })

  it("accepts sealPct in 0.3..1.0", () => { /* ... */ })
  it("rejects sealPct out of [0.3, 1.0]", () => { /* ... */ })
  it("preserves other fields (model/effort) when only contextWindow set", () => { /* ... */ })
})
```

**Step 1.2 — 跑测试确认失败**：`pnpm --filter @multi-agent/api test runtime-config` → 红

**Step 1.3 — 实现（扩 type + sanitize）**

```typescript
// packages/api/src/runtime/runtime-config.ts
export type AgentOverride = {
  model?: string
  effort?: string
  contextWindow?: number
  sealPct?: number
}

// in sanitize():
if (typeof entry.contextWindow === "number" && entry.contextWindow > 0 && Number.isFinite(entry.contextWindow)) {
  override.contextWindow = Math.floor(entry.contextWindow)
}
if (typeof entry.sealPct === "number" && entry.sealPct >= 0.3 && entry.sealPct <= 1.0) {
  override.sealPct = entry.sealPct
}
// 上面 has-any 判断改为：if (override.model || override.effort || override.contextWindow !== undefined || override.sealPct !== undefined)
```

**Step 1.4 — 跑测试确认通过**：绿

**Step 1.5 — 前端 store schema 同步 + 单测**

```typescript
// components/stores/runtime-config-store.ts:10
export type AgentOverride = {
  model?: string
  effort?: string
  contextWindow?: number
  sealPct?: number
}

// cleanOverride: 把 contextWindow + sealPct 的清洗加进去
// writeOverride: has-any 判断同步扩
```

测试：`components/stores/runtime-config-store.test.ts` 加 contextWindow + sealPct 边界。

**Step 1.6 — Commit**：`feat(F021-P6): AgentOverride 加 contextWindow + sealPct + sanitize`

---

### Task 2 — 后端 `resolveSealConfig` + `computeSealDecision` 三层取值（AC-23）

**Files:**
- Modify: `packages/api/src/runtime/cli-orchestrator.ts:266-282` (`computeSealDecision`)
- Create: `packages/api/src/runtime/seal-config-resolver.ts`（纯函数，可单测）
- Modify: `packages/api/src/services/message-service.ts`（调用点传 threadId, sessionId）
- Test: `packages/api/src/runtime/seal-config-resolver.test.ts`（新建）+ 扩 `context-seal.test.ts`

**Step 2.1 — 写失败测试（resolver 三层）**

```typescript
// seal-config-resolver.test.ts
describe("resolveSealConfig three-tier fallback", () => {
  it("session override wins over global", () => { /* session.sealPct=0.5, global.sealPct=0.7 → 0.5 */ })
  it("global wins when session not set", () => { /* global.sealPct=0.7, session=undefined → 0.7 */ })
  it("falls back to SEAL_THRESHOLDS_BY_PROVIDER when both unset", () => { /* → 0.90 for claude */ })
  it("warn = action - 0.05 (clamped to >=0)", () => { /* sealPct=0.5 → warn=0.45 */ })
  it("returns valid config even when only contextWindow set on session", () => { /* model/effort/window 跟 sealPct 独立 */ })
})
```

**Step 2.2 — 跑测试确认失败**：红

**Step 2.3 — 实现 resolver + 改 computeSealDecision 签名**

```typescript
// seal-config-resolver.ts
export type ResolvedSealConfig = { actionPct: number; warnPct: number }

export function resolveSealConfig(
  provider: Provider,
  globalConfig: RuntimeConfig,
  sessionConfig: SessionRuntimeConfig,
): ResolvedSealConfig {
  const sessionPct = sessionConfig?.[provider]?.sealPct
  const globalPct = globalConfig?.[provider]?.sealPct
  const fallback = SEAL_THRESHOLDS_BY_PROVIDER[provider].action
  const actionPct = sessionPct ?? globalPct ?? fallback
  const warnPct = Math.max(0, actionPct - 0.05)
  return { actionPct, warnPct }
}
```

```typescript
// cli-orchestrator.ts: computeSealDecision 加参数
export function computeSealDecision(
  provider: Provider,
  usage: TokenUsageSnapshot | null,
  sealConfig?: ResolvedSealConfig,  // 新参，未传时回退原硬编码（向后兼容）
): SealDecision | null { /* fillRatio 与 actionPct/warnPct 比较 */ }
```

**Step 2.4 — 跑测试确认通过**：绿

**Step 2.5 — message-service.ts 调用点改造**

在 `computeSealDecision` 调用点之前 load 当前 thread 的 session_group runtime_config + global runtime-config，过 resolver，把结果传入。

**Step 2.6 — context-seal.test.ts 扩集成回归**

确保旧单测（无 override）行为不变。新增 3 个集成 case：session/global/fallback。

**Step 2.7 — Commit**：`feat(F021-P6): resolveSealConfig 三层取值 + computeSealDecision 接入`

---

### Task 3 — 后端 `resolveContextWindow` 三层取值（AC-24）

**Files:**
- Create: `packages/api/src/runtime/context-window-resolver.ts`
- Modify: `packages/shared/src/constants.ts:119-129`（`getContextWindowForModel` 保留作为内部 fallback）
- Modify: 所有 `getContextWindowForModel` 调用点（grep + 替换为 `resolveContextWindow`）
- Test: `context-window-resolver.test.ts`

**Step 3.1 — 写失败测试**：三层 + 字段独立性

**Step 3.2 — 红**

**Step 3.3 — 实现**

```typescript
// context-window-resolver.ts
export function resolveContextWindow(
  model: string | null | undefined,
  provider: Provider,
  globalConfig: RuntimeConfig,
  sessionConfig: SessionRuntimeConfig,
): number | null {
  return sessionConfig?.[provider]?.contextWindow
      ?? globalConfig?.[provider]?.contextWindow
      ?? getContextWindowForModel(model)
}
```

**Step 3.4 — 绿**

**Step 3.5 — 调用点替换**

```bash
grep -rn "getContextWindowForModel" packages/ | grep -v test
```

每个调用点上下文有 provider + thread/session 上下文 — 改为 `resolveContextWindow`。

**Step 3.6 — Commit**：`feat(F021-P6): resolveContextWindow 三层取值 + 调用点接入`

---

### Task 4 — Global Defaults Tab 加两 Field（AC-25）

**Files:**
- Modify: `components/chat/right-panel/global-defaults-tab.tsx`
- Test: `components/chat/right-panel/global-defaults-tab.test.tsx`

**Step 4.1 — 写失败测试**

```tsx
// global-defaults-tab.test.tsx
it("AC-25: renders contextWindow input with current value", () => {
  render(<GlobalDefaultsTab provider="claude" />)
  const win = screen.getByLabelText(/最大窗口/)
  expect(win).toBeInTheDocument()
})
it("AC-25: renders sealPct input with % unit", () => { /* ... */ })
it("AC-25: rejects negative contextWindow on save", () => { /* ... */ })
it("AC-25: rejects sealPct out of 30-100 on save", () => { /* ... */ })
```

**Step 4.2 — 红**

**Step 4.3 — 实现**

```tsx
// global-defaults-tab.tsx 加两 Field
const [contextWindow, setContextWindow] = useState(override?.contextWindow?.toString() ?? "")
const [sealPct, setSealPct] = useState(override?.sealPct ? (override.sealPct * 100).toString() : "")

<Field label="最大窗口（tokens）" /* ... */>
  <input type="number" min={1} value={contextWindow} onChange={...} />
</Field>

<Field label="Seal 阈值（%）" /* ... */>
  <input type="number" min={30} max={100} value={sealPct} onChange={...} />
</Field>

// 保存：解析 + 校验 + setGlobalOverride({ model, effort, contextWindow: parseInt(...) || undefined, sealPct: parseFloat(...) / 100 || undefined })
```

**Step 4.4 — 绿 + Commit**：`feat(F021-P6): Global Defaults Tab 加 contextWindow + sealPct Field`

---

### Task 5 — Session Overrides Tab 加两 Field（AC-26）

**Files:**
- Modify: `components/chat/right-panel/session-overrides-tab.tsx`
- Test: `components/chat/right-panel/session-overrides-tab.test.tsx`

镜像 Task 4 + inheritValue 显示来自全局。

**关键**：scope 已经是 thread/session_group 级（写在 `session_groups.runtime_config`），不需要新 store key，AC-26"thread-level"已经天然满足。

**Commit**：`feat(F021-P6): Session Overrides Tab 加 contextWindow + sealPct Field`

---

### Task 6 — Observation Bar fillRatio 进度条（AC-27）

**Files:**
- Modify: `components/chat/right-panel/observation-bar.tsx`
- Create: `components/chat/right-panel/seal-progress.tsx`（独立子组件）
- Modify: 数据源 — invocation 事件流里取 latest fillRatio per provider（具体 store/hook 待 Task 6.0 调研）
- Test: `seal-progress.test.tsx`

**Step 6.0 — Spike（限时 30 分钟）**

调研当前哪个 store/hook 能拿到"per provider 当前 fillRatio"。候选：
- `invocationStats` (F021 P3.3 frozen snapshot — 单 invocation 内)
- `useTokenUsageStore`（如有）
- 后端 WebSocket usage 事件

产出：决策记录"用 X 数据源"，写到 plan 末尾的 Decisions 段。**不**立即写代码。

**Step 6.1 — 写失败测试**

```tsx
it("AC-27: renders fillRatio bar per provider", () => { /* 三家各一行 */ })
it("AC-27: warn 阈值变黄 (>= warnPct)", () => { /* ... */ })
it("AC-27: action 阈值变红 (>= actionPct)", () => { /* ... */ })
it("AC-27: 文案显示 '距 seal Y%'", () => { /* ... */ })
```

**Step 6.2 — 红**

**Step 6.3 — 实现 SealProgress 组件**

```tsx
// seal-progress.tsx
type Props = { provider: Provider; usedTokens: number; window: number; actionPct: number; warnPct: number }
export function SealProgress({ provider, usedTokens, window, actionPct, warnPct }: Props) {
  const fillRatio = Math.min(usedTokens / window, 1.0)
  const remaining = Math.max(0, actionPct - fillRatio)
  const color = fillRatio >= actionPct ? "red" : fillRatio >= warnPct ? "yellow" : "slate"
  return <div className={`... ${colorClasses[color]}`}>
    {provider} ▓...░ {Math.round(fillRatio*100)}% ({fmt(usedTokens)}/{fmt(window)}) 距 seal {Math.round(remaining*100)}%
  </div>
}
```

**Step 6.4 — observation-bar.tsx 嵌入 SealProgress**：每 provider 一行，挂在 3 数字之下

**Step 6.5 — 绿 + Commit**：`feat(F021-P6): observation-bar 加 fillRatio 进度条`

---

### Task 7 — Fallback 链路集成测试（AC-28）

**Files:**
- Test: `packages/api/src/runtime/seal-config-resolver.integration.test.ts`

**测试矩阵**：

| 场景 | session.sealPct | global.sealPct | 期望 actionPct |
|---|---|---|---|
| 都不设 | undefined | undefined | `SEAL_THRESHOLDS_BY_PROVIDER[provider].action`（fallback）|
| 只设全局 | undefined | 0.7 | 0.7 |
| 都设 | 0.5 | 0.7 | 0.5（session 赢）|
| 删全局保留会话 | 0.5 | undefined | 0.5 |
| 删会话保留全局 | undefined | 0.7 | 0.7 |
| 全删 | undefined | undefined | fallback |

contextWindow 同款矩阵。

**Commit**：`test(F021-P6): fallback 链路集成回归（matrix 6 场景 × 2 字段）`

---

### Task 8 — 校验边界（AC-29）

**Files:**
- Test: `runtime-config.test.ts`（已在 Task 1 起头）+ `global-defaults-tab.test.tsx` + 后端 PUT API
- Modify: `packages/api/src/routes/runtime-config.ts` + `session-runtime-config.ts`（reject invalid）

**校验规则**：
- `contextWindow`: 整数 > 0；非整数/0/负数 → reject
- `sealPct`: `0.3 ≤ sealPct ≤ 1.0`；越界 → reject
- 前端 input 阻止保存（disable 按钮 + 红色提示）；后端 sanitize 静默丢弃**等价于** reject HTTP 400（统一错误码）

**Commit**：`feat(F021-P6): 边界校验（contextWindow > 0 / sealPct 0.3-1.0）`

---

### Task 9 — 小孙端到端验收（AC-30）

**人工跑 3 场景**（在 worktree preview 里）：

1. (a) Global Tab 调 Claude 阈值到 50% → 发任务 → 验证 Claude turn 在 ~100k token 处提早 seal（200k 窗口）
2. (b) 切某 thread Session Tab 设 60% → 发任务 → 验证只此 thread 用 60%；切别的 thread 仍 50%
3. (c) observation-bar 进度条与实际 fillRatio 数字对得上（用主仓 dev:api 的 token 输出对照）

产出：截图归档 `.agents/acceptance/F021-P6/` + `acceptance-report.md`

**Commit**：`docs(F021-P6): AC-30 小孙端到端验收报告 + 截图`

---

## Decisions（实施过程沉淀）

### D-1 — Task 6.0 Spike：fillRatio 数据源（2026-04-25）

**结论：复用 `useThreadStore.providers[provider].fillRatio`，不引入新数据通道。**

**调研三候选**：

| 候选 | 现状 | 决策 |
|------|------|------|
| ① `useThreadStore.providers[p].fillRatio` | 已存在并贯通到前端：后端 `message-service.ts:1358` 在每次 invocation 完成时从 `sealDecision.fillRatio` 取值 → `sessions.updateThread(..., lastFillRatio)` 写 SQLite `threads.last_fill_ratio` → `session-service.ts:167/257` 把 `thread.lastFillRatio` 推到 `ProviderThreadView.fillRatio` → 通过 `thread_snapshot_delta.providers` (WebSocket) 流到前端 → `thread-store.ts:28` 接收存为 `ProviderCardState.fillRatio`。`agent-list.tsx:45` 与 `execution-bar.tsx:49` 已在用此字段渲染 | ✅ **采用** |
| ② `invocationStats` (P3.3 frozen snapshot) | `packages/shared/src/realtime.ts:104` 的 `InvocationStats` 仅含 `inputTokens/outputTokens/cachedTokens` + `configSnapshot`，**不含 fillRatio**。是 per-invocation 累加，不是 per-provider 当前态 | ❌ 字段缺失，不合适 |
| ③ 后端独立 usage / token streaming 事件 | 当前 `RealtimeEvent` 类型枚举（realtime.ts 行 307–443）无 `usage` / `token` 类事件；fillRatio 唯一传输路径就是 `thread_snapshot_delta` 里的 providers | ❌ 不存在，新建成本不在本 phase scope |

**采用 ① 的关键属性**：
- **更新粒度**：每次 invocation end（不是 token-streaming 级），与 SealDecision 同源 → 进度条与 Seal 决策永远一致，不会"显示 65% 但已经 seal"或反之的视觉错位
- **覆盖**：3 家 provider 都有
- **持久化**：DB 列 `threads.last_fill_ratio`，跨页面刷新保留
- **配套字段已就位**：`AgentList.fillRatioTone()` 已用阈值染色（>0.7 红 / >0.5 黄 / 其他绿）；新 SealProgress 与之保持视觉一致即可

**对 Task 6 的影响（plan 调整）**：
- Step 6.0 决策完成 ✅
- Step 6.1–6.5 **不需要碰后端**，纯前端组件 + observation-bar 嵌入
- SealProgress 入参从 plan 草案的 `usedTokens/window/actionPct/warnPct` 简化为：`fillRatio`（thread-store 拿到）+ `window`（resolveContextWindow 已有）+ `actionPct/warnPct`（resolveSealThresholds 已有）。`usedTokens` 显示用 `Math.round(fillRatio × window)` 反推（仅展示，不参与决策）
- 染色阈值用真实的 `actionPct/warnPct`（来自 resolveSealThresholds），**而不是** agent-list 现有的硬编码 0.5/0.7 — 这正是 Phase 6 "可配"的意义

### D-2 — 实施过程中遇到的边界判断

待填。


---

## 测试矩阵汇总

| AC | 单测 | 集成 | 人工 |
|---|---|---|---|
| AC-22 类型扩字段 | Task 1.1/1.5 | — | — |
| AC-23 Seal 三层 | Task 2.1 | Task 2.6 + Task 7 | — |
| AC-24 Window 三层 | Task 3.1 | Task 7 | — |
| AC-25 Global Tab Field | Task 4.1 | — | Task 9 |
| AC-26 Session Tab Field | Task 5 | — | Task 9 |
| AC-27 fillRatio 进度条 | Task 6.1 | — | Task 9 |
| AC-28 Fallback 链 | — | Task 7 | — |
| AC-29 校验边界 | Task 8 | — | — |
| AC-30 端到端 | — | — | Task 9 |

---

## 验证命令（quality-gate 阶段会跑）

```bash
# 后端单测
pnpm --filter @multi-agent/api test
# 期望：runtime-config + seal-config-resolver + context-window-resolver + context-seal 全绿

# 前端单测
pnpm test:components
# 期望：global-defaults-tab + session-overrides-tab + seal-progress 全绿

# 类型检查
pnpm typecheck
# 期望：0 错误

# Build
pnpm build
# 期望：0 错误
```
