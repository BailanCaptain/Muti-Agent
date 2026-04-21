---
feature: F021
title: 右侧面板重设计 — 实施计划
owner: 黄仁勋
created: 2026-04-20
status: draft
---

# F021 Implementation Plan

**Feature:** F021 — `docs/features/F021-right-panel-redesign.md`
**Goal:** 把 `components/chat/status-panel.tsx`（657 行、9 块信息挤在 340px 宽里）重构为 3 段式（观测带 + 智能体列表 + 房间开关）；配置从 Popover 改 Side-Drawer；继承层级从三层砍到两层（全局 / 会话）；运行中改配置挂起到下一轮生效。
**Acceptance Criteria:** 覆盖 AC-01 ~ AC-18（见 feature doc）
**Architecture:**
  - 前端：拆 3 子组件（`ObservationBar` / `AgentList` / `RoomSwitches`）+ `AgentConfigDrawer`（Side-Drawer 容器，内含 `GlobalDefaultsTab` / `SessionOverridesTab`）+ ROOM 徽章合入 `StatusPanel` 顶部
  - 状态：扩展 `runtime-config-store`（会话覆盖 `sessionConfig` + `pendingConfig`）；扩展 `thread-store.invocationStats` 快照 schema 加 `configSnapshot`
  - 后端：新增 `/api/sessions/:id/runtime-config`（会话覆盖读写）+ invocation 启动时 snapshot `pendingConfig` 到 invocation 元数据
**Tech Stack:** Next.js (App Router) + React 19 + Zustand + Tailwind + Vitest + @testing-library/react + happy-dom（F025 落地）

---

## Straight-Line Check（终态定义）

### Pin finish line

**终态 B**：右侧面板（`StatusPanel`）在 340px 宽度下一屏无纵向滚动；单击任意 agent ⚙ 从右侧滑出 Drawer，Segmented Tab「全局默认 / 会话专属」切换编辑；运行中保存按钮 disable 并提示"下一轮生效"；模型 pill 右侧橙色小点标识存在会话覆盖；下一轮 invocation 启动时 snapshot `pendingConfig` 到 `invocationStats`。

### 不做什么（YAGNI）

- 不做"多会话间覆盖复制/模板"（超出本 feature）
- 不做"房间级"第三层继承（Design Decision 已锁定 2 层）
- 不改 provider-avatar / message-bubble 等周边组件（本轮只动右侧面板）
- 不做 F022 左侧 sidebar 改动（独立 feature，并行 worktree）

### Terminal Schema（终态接口）

**`runtime-config-store` 扩展**（终态，不是临时脚手架）：

```ts
type SessionRuntimeConfig = Partial<Record<Provider, AgentOverride>>

type RuntimeConfigStore = {
  catalog: ModelCatalog | null
  config: RuntimeConfig                    // 全局默认（已有）
  sessionConfig: SessionRuntimeConfig      // 会话覆盖（新增）
  pendingConfig: SessionRuntimeConfig      // 运行中挂起（新增）
  loaded: boolean
  loadError: string | null
  load: () => Promise<void>
  loadSession: (sessionId: string) => Promise<void>
  setGlobalOverride: (provider: Provider, override: AgentOverride) => Promise<void>  // 重命名自 setAgentOverride
  setSessionOverride: (provider: Provider, override: AgentOverride, isRunning: boolean) => Promise<void>
  flushPendingToSession: (sessionId: string) => Promise<void>  // invocation 启动时调用
}
```

**`invocationStats` 条目扩展**：新增 `configSnapshot?: SessionRuntimeConfig` 字段（本次 invocation 启动时的冻结快照）

**后端新端点**：
- `GET /api/sessions/:id/runtime-config` → `{ config: SessionRuntimeConfig }`
- `PUT /api/sessions/:id/runtime-config` → `{ ok, config }`

---

## Phase 1：观测带 + 智能体行（对应 AC-01 ~ AC-05）

**Pre-flight**：当前 worktree `feat/F021-right-panel-redesign`，在 `C:/Users/-/Desktop/multi-agent-F021`。所有命令都在 worktree 内执行。

### Task 1.1: 抽取 `ObservationBar` 子组件（TDD）

**Files:**
- Create: `components/chat/right-panel/observation-bar.tsx`
- Create: `components/chat/right-panel/observation-bar.test.tsx`
- Modify: `components/chat/status-panel.tsx`（暂不删除老 block，Phase 1 末统一删）

**Step 1 — 写失败测试**（渲染 3 数字 + 会话链链接）

```tsx
// observation-bar.test.tsx
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ObservationBar } from "./observation-bar"

describe("ObservationBar", () => {
  it("renders 3 metric numbers (messages/evidence/followUp) + session chain link", () => {
    render(<ObservationBar messages={12} evidence={3} followUp={5} sessionChainHref="/sessions" />)
    expect(screen.getByText("12")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
    expect(screen.getByText("5")).toBeTruthy()
    expect(screen.getByRole("link", { name: /会话链/ })).toBeTruthy()
  })
})
```

**Step 2 — 跑测试确认失败**

```bash
pnpm test:components observation-bar
# Expected: FAIL ("Cannot find module './observation-bar'")
```

**Step 3 — 最小实现**

```tsx
// observation-bar.tsx
type Props = { messages: number; evidence: number; followUp: number; sessionChainHref: string }

export function ObservationBar({ messages, evidence, followUp, sessionChainHref }: Props) {
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs">
      <div className="flex gap-4">
        <Metric label="消息" value={messages} />
        <Metric label="证据" value={evidence} />
        <Metric label="跟进" value={followUp} />
      </div>
      <a href={sessionChainHref} className="text-slate-500 underline">会话链</a>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div><span className="text-slate-400">{label}</span> <span className="font-mono">{value}</span></div>
}
```

**Step 4 — 跑测试确认通过**

```bash
pnpm test:components observation-bar
# Expected: PASS
```

**Step 5 — Commit**

```bash
git add components/chat/right-panel/
git commit -m "feat(F021): ObservationBar 子组件（3 数字 + 会话链）[黄仁勋/Opus-47 🐾]"
```

### Task 1.2: 抽取 `AgentList` 子组件（TDD）

**Files:**
- Create: `components/chat/right-panel/agent-list.tsx`
- Create: `components/chat/right-panel/agent-list.test.tsx`

**Step 1 — 失败测试**：渲染 agent 行（头像 / 名字 / 模型 pill / ⚙ / 运行状态 pulse or idle）

**Step 2** — FAIL  
**Step 3** — 最小实现（一行 flex 布局 + ProviderAvatar 复用 + pill + gear icon + 状态 dot）  
**Step 4** — PASS  
**Step 5** — Commit `feat(F021): AgentList 子组件`

### Task 1.3: 抽取 `RoomSwitches` 子组件（心里话 toggle + 发言器）

**Files:**
- Create: `components/chat/right-panel/room-switches.tsx`
- Create: `components/chat/right-panel/room-switches.test.tsx`

**Step 1-5** — TDD 同上。从 `status-panel.tsx` 平移心里话 toggle 逻辑。

### Task 1.4: 顶部 ROOM 徽章（AC-02）

**Files:**
- Create: `components/chat/right-panel/room-badge.tsx`
- Create: `components/chat/right-panel/room-badge.test.tsx`

格式：`ROOM · {title} · #{shortHash}`。`shortHash` = 取 roomId 前 6 字符。

### Task 1.5: 组装新 `StatusPanel` + 删除旧 block（AC-01, AC-05）

**Files:**
- Modify: `components/chat/status-panel.tsx`（核心重写为组装器）

新结构：

```tsx
export function StatusPanel() {
  return (
    <aside className="flex h-full flex-col gap-3 overflow-hidden">
      <RoomBadge />
      <ObservationBar ... />
      <AgentList ... />
      <RoomSwitches ... />
    </aside>
  )
}
```

删除旧 `SessionTabContent` / `DefaultConfigSection` / 心里话 inline 块。模型 pill 先不含 ⚙ 入口（Phase 2 加）。

**Step — 手动验证 AC-05**：启动 `pnpm worktree:preview`，1080p 下右侧无纵向滚动。截图保存到 `.agents/acceptance/F021/phase1-no-scroll.png`。

**Commit**：`feat(F021): StatusPanel 重构为 3 段式 + ROOM 徽章，删除旧 9-block 布局`

### Task 1.6: Phase 1 收口

- 跑 `pnpm test` + `pnpm type-check` + `pnpm lint`
- `pnpm worktree:preview` 人眼 smoke：3 段都在、ROOM 徽章可见、无纵向滚动
- **合入 dev？** 否。Phase 级中间 commit 留 worktree（按 feedback_feature_completion_before_merge 规则）

---

## Phase 2：Side-Drawer 配置态（对应 AC-06 ~ AC-10）

### Task 2.1: 扩展 `runtime-config-store` — sessionConfig（TDD，纯逻辑）

**Files:**
- Modify: `components/stores/runtime-config-store.ts`
- Create: `components/stores/runtime-config-store.test.ts`

**Step 1 — 失败测试**：

```ts
describe("runtime-config-store session layer", () => {
  it("setSessionOverride writes to sessionConfig (not config) and persists via PUT /api/sessions/:id/runtime-config", async () => { ... })
  it("loadSession populates sessionConfig from GET /api/sessions/:id/runtime-config", async () => { ... })
  it("setGlobalOverride still writes to global config only", async () => { ... })
})
```

**Step 3 — 实现**：新增 `sessionConfig` + `loadSession` + `setSessionOverride` + 重命名 `setAgentOverride` → `setGlobalOverride`（全局搜 replace）

**Step 5 — Commit**：`feat(F021): runtime-config-store 新增会话覆盖层`

### Task 2.2: 后端 session runtime-config 端点（TDD，后端优先）

**Files:**
- Create: `packages/api/src/routes/session-runtime-config.ts`
- Create: `packages/api/src/routes/session-runtime-config.test.ts`
- Modify: `packages/api/src/services/session-service.ts`（新增 `getSessionRuntimeConfig` / `setSessionRuntimeConfig`）
- Modify: `packages/api/src/db/schema.ts`（sessions 表加 `runtimeConfig JSON` 字段）
- Create: `packages/api/src/db/migrations/XXXX_add_session_runtime_config.sql`

**注意（后端 API 约定）**：按 feat-lifecycle Design Gate 要求，纯后端 API 契约需要 `collaborative-thinking` 与范德彪/桂芬确认。但本次 API 是前端驱动的对称 endpoint（与 `/api/runtime-config` 形态一致），视为 **已锁定设计** —— 实施时若发现契约分歧，停下拉 `collaborative-thinking`。

**TDD** 顺序：失败测试 → migration → service → route → PASS → commit

### Task 2.3: `AgentConfigDrawer` 壳子（AC-06, AC-07）

**Files:**
- Create: `components/chat/right-panel/agent-config-drawer.tsx`
- Create: `components/chat/right-panel/agent-config-drawer.test.tsx`

**测试**：渲染 `isOpen={true}` + `provider="anthropic"`，应当看到 Segmented Tab 两个选项"全局默认"和"会话专属"。

**实现**：使用 Tailwind `translate-x` + `transition` 做从右滑入；`role="dialog"` + `aria-label`；Esc 关闭；点击遮罩关闭。

### Task 2.4: `GlobalDefaultsTab`（AC-08）

**Files:**
- Create: `components/chat/right-panel/global-defaults-tab.tsx`
- Test: 同文件 `.test.tsx`

**行为**：表单（model / effort）+ 一个"保存"按钮，调用 `setGlobalOverride`。

### Task 2.5: `SessionOverridesTab`（AC-09）

**Files:**
- Create: `components/chat/right-panel/session-overrides-tab.tsx`
- Test: 同文件 `.test.tsx`

**行为**：
- 表单字段显示 placeholder = 全局默认值（灰）；用户输入后变黑
- "应用到当前会话"按钮调用 `setSessionOverride`
- "清除覆盖"按钮 = 传空 override（回落到全局）

### Task 2.6: 在 `AgentList` 加 ⚙ + 橙色小点（AC-10）

**Files:**
- Modify: `components/chat/right-panel/agent-list.tsx`
- Modify: `components/chat/right-panel/agent-list.test.tsx`

**测试新增**：
```ts
it("renders orange dot next to model pill when sessionConfig has override for this provider", () => { ... })
it("no dot when sessionConfig[provider] is undefined", () => { ... })
```

**实现**：⚙ 点击 → `openDrawer(provider)`；小点 2px 橙色 `bg-orange-400`，位置 `absolute right-0 top-0`。

### Task 2.7: Phase 2 人眼 smoke + AC 自检

- 启动 preview；点 ⚙ 看 Drawer 滑入；切换 Tab；编辑会话覆盖 → 保存 → 刷新页面 → 覆盖仍在 + 橙点出现
- 证据截图 → `.agents/acceptance/F021/phase2-drawer.png`

---

## Phase 3：运行中保护 + 下一轮生效（对应 AC-11 ~ AC-15）

### Task 3.1: `pendingConfig` 状态（TDD）

**Files:**
- Modify: `components/stores/runtime-config-store.ts`
- Modify: `components/stores/runtime-config-store.test.ts`

**测试**：
```ts
it("setSessionOverride with isRunning=true writes to pendingConfig, not sessionConfig", async () => { ... })
it("flushPendingToSession merges pendingConfig into sessionConfig and clears pending", async () => { ... })
```

### Task 3.2: Drawer 运行中 disable（AC-11, AC-12）

**Files:**
- Modify: `components/chat/right-panel/session-overrides-tab.tsx`
- Test update

**测试**：
```ts
it("应用按钮 disabled 且显示'运行中，下一轮生效'提示 when isAnyRunning=true", () => { ... })
```

**实现**：从 `useThreadStore` 读 `providers` 判断 `isAnyRunning`；disable + tooltip。

### Task 3.3: Invocation 启动时 snapshot（AC-13, AC-14, AC-15）

**Files:**
- Modify: `packages/api/src/services/invocation-service.ts`（在 invocation 启动处读取会话 `pendingConfig` → merge 到 sessionConfig → snapshot 到 invocation 记录）
- Modify: `packages/api/src/db/schema.ts`（invocations 表加 `configSnapshot JSON`）
- Create: migration
- Modify: `packages/shared/src/realtime.ts`（`InvocationStatsEntry` 加 `configSnapshot?: SessionRuntimeConfig`）
- Test: invocation-service.test.ts

**测试**：
```ts
it("invocation 启动时，从 session 读取 pendingConfig → flush 到 sessionConfig → snapshot 到 invocation.configSnapshot", async () => { ... })
it("无 pendingConfig 时，configSnapshot = 当前 sessionConfig", async () => { ... })
```

### Task 3.4: Phase 3 人眼 smoke

- 启动一个长 invocation；运行中改 sessionOverride → 按钮 disabled；invocation 完 → 刷新 → 下一轮生效
- 证据 → `.agents/acceptance/F021/phase3-deferred.png`

---

## Phase 4：验收（对应 AC-16 ~ AC-18）

### Task 4.1: `quality-gate` 自检

- 愿景对照三问 + spec 合规报告
- `pnpm test` + `pnpm type-check` + `pnpm lint` 全绿
- 构建 `pnpm build`

### Task 4.2: 请 **桂芬** 视觉验收（AC-16）

- 发送五件套（What/Why/Tradeoff/Open/Next）+ preview URL（worktree port 3102）+ 截图 3 张
- 问题点：ROOM 徽章色值、Drawer 宽度、橙点对比度

### Task 4.3: 请 **范德彪** code review（AC-17）

- 重点关注：运行中配置竞态（`pendingConfig` 和 `sessionConfig` flush 时序）+ 后端 migration 兼容性

### Task 4.4: 独立 `acceptance-guardian`（愿景验收）

- 选非实现者非 reviewer 的 agent
- 证物对照表对齐小孙原话"右侧信息太冗余了"→ 3 段式清爽
- PASS → merge-gate

### Task 4.5: 小孙端到端跑一轮（AC-18）

- 合入 dev 前最后一关
- 发 demo 视频或 gif → 小孙 OK → `merge-gate`

---

## 交付清单（AC 到 Task 映射）

| AC | Task | Phase |
|----|------|-------|
| AC-01 | 1.1-1.5 | P1 |
| AC-02 | 1.4 | P1 |
| AC-03 | 1.1 | P1 |
| AC-04 | 1.2 | P1 |
| AC-05 | 1.5 人眼 | P1 |
| AC-06 | 2.3 | P2 |
| AC-07 | 2.3 | P2 |
| AC-08 | 2.4 | P2 |
| AC-09 | 2.5 | P2 |
| AC-10 | 2.6 | P2 |
| AC-11 | 3.2 | P3 |
| AC-12 | 3.2 | P3 |
| AC-13 | 3.1 | P3 |
| AC-14 | 3.3 | P3 |
| AC-15 | 3.3 | P3 |
| AC-16 | 4.2 | P4 |
| AC-17 | 4.3 | P4 |
| AC-18 | 4.5 | P4 |

## Phase 碰头节奏（≥3 Phase 的家规）

- Phase 1 merge 后：不碰头（仍是 feat/F021 分支上的中间 commit，**不合 dev**），但跑一次 quality-gate 内部自检
- Phase 2 merge 后：同上
- Phase 3 结束 + Phase 4 开始前：**必须 Phase 碰头**（展示 P1+P2+P3 成果、愿景进度、P4 验收计划）→ 小孙确认方向
- 全部 AC 打勾 + 验收通过 → `merge-gate` 一次性合 dev

## Risks & Open Questions

1. **后端 session runtime-config schema 迁移风险**：现有 sessions 表需要加 `runtimeConfig` 字段。需要验证 migration 在已有数据上是否无损。**对策**：migration 加 `DEFAULT '{}'` + 单独测试。
2. **`pendingConfig` 和并发 invocation**：如果同时有 2 个 invocation 跑，第二个启动时读到第一个的 flush？**对策**：flush 是 session 粒度串行，同一会话同一时刻只有一个 invocation，天然无竞态。加单测验证。
3. **Drawer 在窄屏（<768px）的表现**：当前面板 340px，Drawer 又要从右滑入，移动端可能挤。**Open Question**：是否需要响应式（窄屏变全屏 modal）？先做桌面，若桂芬验收提出再加。

## 下一步

计划交给小孙 review（+ 设计最终点 double-check）→ 小孙 OK → 进 `tdd` 从 Task 1.1 开始。
