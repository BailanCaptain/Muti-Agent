---
id: F027-phase3-implementation-plan
title: F027 Phase 3 实施 plan — 前端面板 + 调度器 go-live 接线
status: v1 draft（待小孙拍 Open + 范德彪 review）
created: 2026-05-20
feature: docs/features/F027-unified-memory-architecture.md
phase: Phase 3 · 前端（V16.5 P20）
parent: docs/plans/F027-P19-phase2-evidence-summary.md（Phase 2 收稿）
---

# F027 Phase 3 实施 plan — 前端面板 + 调度器 go-live

## 0. 修订摘要

| 版本 | 变更 |
|---|---|
| v1 | 首稿。基于前端结构探查（status-panel/composer/AtPill 已有；RuntimeLog/viewfinder/inspector/IngestModal 从零）。含 7 Open 待小孙拍。|

## 1. 范围

Phase 3 = F027 统一记忆架构的**前端面板层** + **Phase 2 调度器 go-live 接线**。

把 Phase 1（后端服务）+ Phase 2（调度逻辑）已建好的"引擎"接上人能看、能操作的界面。

### 1.1 交付物（feature.md Phase 3 · 6 AC）

1. **StatusPanel 拖宽**（AC-P3-1）— 360-720px 可拖 + localStorage 持久
2. **RuntimeLog 5-tab 容器**（AC-P3-2）— viewfinder / prompt-inspector / draft-approval / warnings / knowledge-base，切换保状态
3. **prompt-inspector 透明显示**（AC-P3-3）— 注入 part 表 + token 占比 + 自动召回 query + Adaptive Recall Policy 状态
4. **viewfinder §4 a2a 人话化**（AC-P3-4）— a2a 引用用 F026 `<AtPill>` 渲染 + in-place drawer
5. **prompt-inspector wake-up 触发因**（AC-P3-5）— `🔔 触发因: [a2a_call=xxx]`
6. **IngestModal 3 入口 + sanitize 预扫**（AC-P3-6）— composer 拖文件 / [+ Drop 资料] / `/ingest` 命令

### 1.2 plan 追加交付物（feature.md 未列，本 plan 提案 — 见 Open #1/#2）

7. **后端 HTTP API 层** — 前端面板要的读取 endpoint（viewfinder / inspector / draft list / ingest preview）。Phase 1 建的是 service + MCP 工具，前端走 HTTP/WS，缺路由。
8. **Phase 2 调度器 go-live 接线** — API server boot 时构造 11 个真 job 适配器 + `new SchedulerRuntime` + start（小孙 2026-05-20 拍：归 Phase 3）。
9. **wake-up 触发因 WS 协议** — 后端经 WS 推 wake-up trigger（AC-P3-5 物理依赖）。

### 1.3 不做（明确划走）

- **promote / demote / 批量审批动作** — feature.md AC-P4-1/3/4 明确 Phase 4。Phase 3 的 draft-approval / knowledge-base tab 只做**只读列表 + 展示**，promote 按钮留 Phase 4 接（见 Open #4）。
- **PromoteModal / 命令面板 promote 类命令** — Phase 4。
- AC-P3-6 的 IngestModal 做 drop 入口 + sanitize/编译**预览**；真落盘走已有 update_wiki（Phase 1），不重写。

## 2. 现状盘点（前端探查结论）

| 组件 | 现状 | Phase 3 动作 |
|---|---|---|
| StatusPanel | `components/chat/status-panel.tsx` 固定 `w-[340px]` | 改：加 ResizeHandle |
| layout-store | `components/stores/layout-store.ts` 有 collapsed bool，无 width | 改：加 `statusPanelWidth` |
| RuntimeLog 容器 | 不存在 | 从零 |
| 5 个 tab 内容 | 全不存在 | 从零 |
| `<AtPill>` / `<TimeoutTombstone>` | `components/chat/at-pill.tsx` / `timeout-tombstone.tsx`（F026，6 态状态机）| 复用 |
| composer | `components/chat/composer.tsx` 有 @mention + 拖图片 | 扩：加 `/slash-menu` |
| Modal 体系 | `decision-board-modal.tsx` / `settings-modal.tsx` 模式可循 | 从零做 IngestModal 沿用模式 |
| 后端 viewfinder/inspector/ingest HTTP 路由 | 缺（service 存在，无 route）| 从零（见 §1.2-7）|
| SchedulerRuntime 实例化 | 仅 class + test，未接 API boot | go-live 接线（§1.2-8）|

技术栈：Next.js 16 + React 19 + Zustand。前端 app 在 worktree root，组件 `components/chat/`。

## 3. 里程碑（建议 4 周 / 18-22 单人天 — 待 Open #6 校准）

### Week 1 · 后端 API 层 + go-live 接线（5 天）

| Day | 任务 |
|---|---|
| 1 | go-live 接线：API boot 构造 11 真 job 适配器（注入真 fs/db scan/write）+ `new SchedulerRuntime` + start；fallback config 跑（无 wiki.config.yaml）|
| 2 | viewfinder 读取 API + draft list API（GET /api/rooms/:id/viewfinder、GET /api/wiki/drafts）|
| 3 | prompt-inspector 数据 API（注入 part + token 占比 + 召回 query + Adaptive Recall 状态）|
| 4 | ingest preview API（5 层 sanitize + LLM 编译预览，不落盘）|
| 5 | wake-up 触发因 WS 协议改动 + job_trace → panel 读取 API |

### Week 2 · 前端骨架（5 天）

| Day | 任务 |
|---|---|
| 6 | AC-P3-1 StatusPanel 拖宽（layout-store width + ResizeHandle + localStorage）|
| 7-8 | AC-P3-2 RuntimeLog 5-tab 容器骨架（1 级 tabs + 2 级 5 tab + 切换保 fetch 状态）|
| 9-10 | knowledge-base tab + warnings tab + draft-approval tab（只读列表，接 Week 1 API）|

### Week 3 · 核心面板（5 天）

| Day | 任务 |
|---|---|
| 11-12 | AC-P3-3 prompt-inspector（注入 part 表 + token + 召回 query + Recall Policy 状态）|
| 13 | AC-P3-5 wake-up 触发因（接 WS 协议）|
| 14-15 | AC-P3-4 viewfinder 6 段视图 + §4 a2a `<AtPill>` 渲染 + in-place drawer |

### Week 4 · IngestModal + 验收（3-7 天 buffer）

| Day | 任务 |
|---|---|
| 16-17 | AC-P3-6 IngestModal（3 入口：composer 拖文件 / [+ Drop] 按钮 / `/ingest` slash 命令）+ composer slash-menu |
| 18-19 | Playwright 验收套件 + evidence pack（7 AC × 双 judge）|
| 20-22 | buffer / 修 / 合 dev |

每 Week 走 requesting-review → 范德彪 code-review → receiving-review chain（同 Phase 2 节奏）。

## 4. AC 列表（提案 7 个 — feature.md 6 + 本 plan +1）

| AC | 内容 | 验收位 |
|---|---|---|
| AC-P3-1 | StatusPanel 360-720px 拖宽 ≥50fps + localStorage persist + reload ±1px | Playwright Performance |
| AC-P3-2 | 5 tab 渲染 + 切换保 fetch 状态（scroll ±10px）+ 默认 prompt-inspector | Playwright 截图 + DOM 断言 |
| AC-P3-3 | prompt-inspector 注入 part 表 + token 占比 + 召回 query（Quality Gate 三段）+ Adaptive Recall Policy 状态 | 组件测试 + fixture |
| AC-P3-4 | viewfinder §4 `[a2a_call=xxx]` → `<AtPill>` 渲染 + click in-place drawer 展开 mini call tree | 组件测试 |
| AC-P3-5 | prompt-inspector 顶部 `🔔 触发因: [a2a_call=xxx]` + click in-place drawer | 组件测试 + WS fixture |
| AC-P3-6 | IngestModal 3 入口任一触发 → 5 层 sanitize + LLM 编译预览 + multi-drop 关联 → 点 [/ingest 编译] 才落盘 | 组件测试 + E2E |
| **AC-P3-7**（新）| 调度器 go-live：API server 启动 → `SchedulerRuntime` 实例化 + 11 job 注册 + 真 job_trace 落 `.runtime/job-traces/` | 集成测试（启真 server + 探针 trace）|

## 5. Open 待小孙拍（7 个）

| # | 决策 | 黄建议 | 理由 |
|---|---|---|---|
| 1 | 后端 HTTP API 层算不算 Phase 3 | **算** | 前端面板没 API 就是空壳；Phase 1 建的是 service + MCP，前端走 HTTP/WS。不算的话 Phase 3 无法独立交付 |
| 2 | go-live 接线范围 | **API boot 实例化 + fallback config 启动** | 小孙已拍归 Phase 3；用 Phase 2 的 fallback 默认调度即可启动，不依赖 Gate 2 |
| 3 | wake-up WS 协议改动放 Phase 3 | **是** | AC-P3-5 物理依赖；属"前端 phase 里必需的后端协议改动"，范围内 |
| 4 | draft-approval / 批量审批动作 | **Phase 3 只读展示，promote 动作留 Phase 4** | feature.md AC-P4-1/3/4 明确 Phase 4；Phase 3 先把"看得见"做完 |
| 5 | 前端测试策略 | **Playwright + worktree preview（F024 registry :3100）** | AC-P3-1/2 要求 Playwright 实测；worktree 端口动态分配 |
| 6 | 工期 | **4 周 / 18-22 单人天** | 6 frontend AC + API 层 + go-live；frontend 不确定性大，留 buffer |
| 7 | feature.md 是否加 AC-P3-7 | **加** | go-live 接线需独立 AC 锁验收；feature.md AC 列表 Phase 3 段补一条 |

## 6. 风险

| 风险 | mitigation |
|---|---|
| Phase 3 被后端 API 层撑大（名为"前端"实含后端）| Open #1 显式拍；Week 1 全做后端，前后端解耦 |
| go-live 接线 + Gate 2 耦合 | go-live 走 fallback config 启动，不等 Gate 2；真 wiki.config.yaml 仍 BLOCKED |
| Playwright 在 worktree 跑不稳 | 端口走 F024 registry；fps 类断言用 DevTools trace 而非肉眼 |
| viewfinder/inspector 数据契约与 Phase 1 service 输出 drift | Week 1 API 层做适配，前端只认 HTTP 契约 |
| 5-tab 切换保状态（AC-P3-2）实现复杂 | tab 内容组件 keep-alive / 状态提到 store，不靠 unmount |

## 7. 依赖

- Phase 1 服务：viewfinder-compiler / memory-preflight / sanitize / wiki 表 — 已合 dev
- Phase 2 调度：11 jobs + SchedulerRuntime — 在 worktree（go-live 接线消费它）
- F026：`<AtPill>` / `<TimeoutTombstone>` — 已有，AC-P3-4 复用
- Gate 2：**不阻塞 Phase 3**（go-live 走 fallback config）

## 8. 下一步

1. 小孙拍 §5 的 7 个 Open
2. 范德彪 review 本 plan（同 Phase 2 v1→v2 walkthrough 模式）
3. 修订冻结 → 开 Week 1
