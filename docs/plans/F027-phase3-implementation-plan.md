---
id: F027-phase3-implementation-plan
title: F027 Phase 3 实施 plan — 前端面板 + 调度器 go-live + P20 wiring
status: v3（范 r1 CONDITIONAL → 全接受 2 P1 + 5 P2 + 3 P3 修订；小孙 2026-05-20 拍 A 全接 + plan v3）
created: 2026-05-20
feature: docs/features/F027-unified-memory-architecture.md
phase: Phase 3 · 前端 + P20 wiring（V16.5 P20）
parent: docs/plans/F027-P19-phase2-evidence-summary.md（Phase 2 收稿）
---

# F027 Phase 3 实施 plan — 前端面板 + go-live + P20 wiring

## 0. 修订摘要

| 版本 | 变更 |
|---|---|
| v1 | 首稿。基于前端结构探查（status-panel/composer/AtPill 已有；RuntimeLog/viewfinder/inspector/IngestModal 从零）。含 7 Open 待小孙拍。 |
| v2 | 小孙 2026-05-20 拍 7 Open 全按建议过。§5 转拍板态。待范德彪 review。 |
| **v3** | **范-r1 CONDITIONAL（2 P1 + 5 P2 + 3 P3）小孙拍 A 全接受**。新增 3 块 wiring AC（AC-P3-8/9/10）补齐 feature.md AC-P1-10/12 P20 挂位 + AC-P3-6 落盘闭环；§3 节奏 4 周/18-22 天 → 5 周/26-32 天；§6 加 3 项风险；§5 加范有条件同意备注；§7 加 P1 wiring 依赖；§4 升 7 AC → 10 AC；同步回写 feature.md（任务 #171）。 |
| **v3.1** | **范-r2 CONDITIONAL（无 P1/P2，1 处 P3）**：feature.md 4 处工期残留扫尾（行 85 Phase 3 小节标题 / 行 275 风险表 / 行 287 立项材料 / 行 293 Gate 1 接受）；plan §3 Week 2 加节奏备注（5 天目标 / 7 天风险）；§6 风险表加 Week 2 过载项。范-r2 GO 条件已满足。 |

## 1. 范围

Phase 3 = F027 统一记忆架构的**前端面板层** + **Phase 2 调度器 go-live 接线** + **Phase 1 留给 P20 的生产 wiring**。

把 Phase 1（后端服务）+ Phase 2（调度逻辑）已建好的"引擎"接上人能看、能操作的界面 **+ 接通 Phase 1 显式挂在 P20 的生产 wiring 挂位**。

### 1.1 交付物（feature.md Phase 3 · 6 AC）

1. **StatusPanel 拖宽**（AC-P3-1）— 360-720px 可拖 + localStorage 持久
2. **RuntimeLog 5-tab 容器**（AC-P3-2）— viewfinder / prompt-inspector / draft-approval / warnings / knowledge-base，切换保状态
3. **prompt-inspector 透明显示**（AC-P3-3）— 注入 part 表 + token 占比 + 自动召回 query + Adaptive Recall Policy 状态（接 AC-P3-9 真 prompt_audit 数据）
4. **viewfinder §4 a2a 人话化**（AC-P3-4）— a2a 引用用 F026 `<AtPill>` 渲染 + in-place drawer
5. **prompt-inspector wake-up 触发因**（AC-P3-5）— `🔔 触发因: [a2a_call=xxx]`
6. **IngestModal 3 入口 + sanitize 预扫**（AC-P3-6）— composer 拖文件 / [+ Drop 资料] / `/ingest` 命令（preview 部分；commit 落盘见 AC-P3-10）

### 1.2 plan 追加交付物（v3 扩到 6 项）

7. **后端 HTTP API 层** — 前端面板要的读取 endpoint（viewfinder / inspector / draft list / ingest preview / decision read），含 DTO/schema fixture + 错误码 + contract tests（v3 强化 — 范 P2-1）
8. **Phase 2 调度器 go-live 接线** — API server boot 时构造 11 个真 job 适配器 + `new SchedulerRuntime` + start（小孙 2026-05-20 拍：归 Phase 3）
9. **wake-up 触发因 WS 协议** — 后端经 WS 推 wake-up trigger（AC-P3-5 物理依赖）
10. **AC-P1-10 P20 wiring**（v3 新增 — 范 P1-1）— manual confirm decision API（POST /api/rooms/:id/decisions）+ Inspector Coverage warning unresolved 入口数据契约。Phase 1 P12 写完 room_decisions ledger 但只暴露到 service/MCP，HTTP 路由 + 前端入口在 Phase 3 完成
11. **AC-P1-12 P20 wiring**（v3 新增 — 范 P1-1）— orchestrator / RoomCompiler 接 `executeAdaptiveRecall` 调用点 + `prompt_audit` 表 9 字段真写入（recall_path / recall_satisfied / escalate_reason 等）+ Level5Sink 生产实现（写 wiki_events action='recall_escalate' + 推审计通知 + Inspector UI 显示）
12. **AC-P3-6 commit endpoint**（v3 新增 — 范 P1-2）— POST `/api/wiki/ingest/commit`，前端 [/ingest 编译] 触发后端走 Phase 1 已有 `update_wiki`，复用 ACL / CAS / lease / fencing；preview 不落盘 / commit 才落盘 / 失败不产生 `wiki_events`

### 1.3 不做（明确划走）

- **promote / demote / 批量审批动作** — feature.md AC-P4-1/3/4 明确 Phase 4。Phase 3 的 draft-approval / knowledge-base tab 只做**只读列表 + 展示**，promote 按钮留 Phase 4 接（见 Open #4）
- **PromoteModal / 命令面板 promote 类命令** — Phase 4
- **完整 P18 双 judge 验收框架** — Phase 4 AC-P4-5。Phase 3 用轻量"采用同款架构提前演练"（双 judge 复用 Phase 2 已有 runner），但不与 Phase 4 完整验证套件边界重复（范 P3-1）
- AC-P3-6 的 IngestModal 做 drop 入口 + sanitize/编译**预览**；真落盘走 AC-P3-10 的 commit endpoint 复用 Phase 1 `update_wiki`，不重写

### 1.4 P20 wiring 边界说明（v3 新增）

AC-P3-8 / AC-P3-9 不是 Phase 3 新发明的 AC —— 它们是 feature.md Phase 1 AC-P1-10 / AC-P1-12 在 P12 / P13 实施时**显式挂出来留给 Phase 3 完成**的生产 wiring：

| Phase 1 AC | Phase 1 范围（已完成） | 留给 Phase 3 P20 的挂位 |
|---|---|---|
| AC-P1-10（feature.md:139-141）| 决策 ledger CRUD + 关键词宽召 + HaikuRunner + Coverage Check 三集合 + rule-based viewfinder + jaccard drift + fixture | manual confirm decision API + Inspector unresolved 入口（→ **AC-P3-8**） |
| AC-P1-12（feature.md:155-157）| AdaptiveRecallExecutor 状态机 + Critique Agent + 4 Level Backend Adapter + Per-turn Budget + Judge BLOCKED lint + 55 单测 | orchestrator/RoomCompiler 接 executeAdaptiveRecall + prompt_audit 9 字段真写入 + Level5Sink 生产实现（→ **AC-P3-9**） |

**为什么 v2 漏了**：我写 v2 时只翻了 feature.md "Phase 3 AC" 段（feature.md:175-182 6 条 AC），没去翻 Phase 1 AC 的"挂 Phase 3 P20"边界条款。范-r1 P1-1 实证打击。v3 补回。

## 2. 现状盘点（前端探查结论 + v3 修订）

| 组件 | 现状 | Phase 3 动作 |
|---|---|---|
| StatusPanel | `components/chat/status-panel.tsx` 固定 `w-[340px]` | 改：加 ResizeHandle |
| layout-store | `components/stores/layout-store.ts` 有 collapsed bool，无 width | 改：加 `statusPanelWidth` |
| RuntimeLog 容器 | 不存在 | 从零 |
| 5 个 tab 内容 | 全不存在 | 从零 |
| `<AtPill>` / `<TimeoutTombstone>` | `components/chat/at-pill.tsx` / `timeout-tombstone.tsx`（F026，6 态状态机）| 复用 |
| composer | `components/chat/composer.tsx` 有 @mention + 拖**图片**附件（`ACCEPTED_IMAGE_TYPES`，`accept="image/*"`，composer.tsx:88/492）| **从零开新通道**：资料文件 drop 不是改图片附件，是独立的 ingest 拖入通道（v3 修订 — 范 P2-4）|
| Modal 体系 | `decision-board-modal.tsx` / `settings-modal.tsx` 模式可循 | 从零做 IngestModal 沿用模式 |
| 后端 viewfinder/inspector/ingest HTTP 路由 | 缺（service 存在，无 route）| 从零（见 §1.2-7）|
| **room_decisions 写入路径** | Phase 1 P12 service + MCP 已完成；HTTP 暴露 + 前端 unresolved 入口缺 | 接（§1.2-10，AC-P3-8）|
| **orchestrator / RoomCompiler ↔ AdaptiveRecallExecutor** | Phase 1 P13 AdaptiveRecallExecutor 完成；orchestrator 当前未调 executeAdaptiveRecall（P13 未接生产 caller）| 接（§1.2-11，AC-P3-9）|
| **prompt_audit 表 9 字段写入** | schema 存在；recall_path / recall_satisfied / escalate_reason 当前未真写入 | 接（§1.2-11，AC-P3-9）|
| **Level5Sink 生产实现** | P13 模块设计上 "caller 责任"不绑后端；当前无生产 sink | 接（§1.2-11，AC-P3-9）|
| SchedulerRuntime 实例化 | 仅 class + test 未接 boot | go-live 接线（§1.2-8） |

技术栈：Next.js 16 + React 19 + Zustand。前端 app 在 worktree root，组件 `components/chat/`。

## 3. 里程碑（5 周 / 26-32 单人天 — v3 修订）

> v2 节奏 4 周 / 18-22 天因 v3 加 3 块 wiring AC + Week 1 拆 1.5 周 backend contract + IngestModal 前移 调整。

### Week 1 · 后端 API + go-live + Backend Contract（5 天）

| Day | 任务 |
|---|---|
| 1 | go-live 接线：API boot 构造 11 真 job 适配器（注入真 fs/db scan/write）+ `new SchedulerRuntime` + start；fallback config 跑（无 wiki.config.yaml）；**adapter 映射表**（输入/输出/trace schema/失败策略/scheduler duplicate-start 保护/leader lease 复用点）入 plan §9（v3 — 范 P2-2）|
| 2 | **Backend Contract**：DTO/schema fixture + 错误码 + 空状态 + 权限/roomId 边界 + contract tests（v3 — 范 P2-1）|
| 3 | viewfinder 读取 API + draft list API（GET /api/rooms/:id/viewfinder、GET /api/wiki/drafts）|
| 4 | prompt-inspector 数据 API（注入 part + token 占比 + 召回 query + Adaptive Recall 状态占位）|
| 5 | ingest preview API（5 层 sanitize + LLM 编译预览，不落盘）|

### Week 2 · P20 Wiring + WS（5 天目标 / 7 天风险 — v3.1 修订）

| Day | 任务 | 工日估 |
|---|---|---|
| 6 | **AC-P3-8 a**：manual confirm decision API（POST /api/rooms/:id/decisions）+ Inspector unresolved 入口数据契约（GET /api/rooms/:id/decisions/coverage）| 1d |
| 7-8 | **AC-P3-9 a**：orchestrator/RoomCompiler 接 executeAdaptiveRecall 调用点（识别 wake-up + per-turn budget 注入） | 1.5-2d |
| 8 | **AC-P3-9 b**：prompt_audit 9 字段真写入（recall_required / recall_path Level 1-5 / recall_satisfied / escalate_reason / budget_consumed 等） | 1d |
| 9 | **AC-P3-9 c**：Level5Sink 生产实现（写 wiki_events action='recall_escalate' + 推审计通知 + Inspector UI hook） | 1-1.5d |
| 9-10 | **AC-P3-10**：POST /api/wiki/ingest/commit endpoint（前端 [/ingest 编译] → 后端 update_wiki，复用 ACL/CAS/lease/fencing）| 1d |
| 10 | wake-up 触发因 WS 协议改动 + job_trace → panel 读取 API（可吃 Week 5 buffer）| 1-1.5d |

**节奏备注**（范-r2 节奏复核）：累计工日估 6.5-8d，超 5 天名义；按"5 天目标 / 7 天风险"管理 — 优先保证 AC-P3-8/9/10 后端闭环（前端 Week 3-4 接得到契约），WS 协议 + job_trace API 可推迟到 Week 5 buffer。Week 2 r1 review 时以 AC-P3-8/9/10 完成度为 GO 信号，WS 推迟允许。

### Week 3 · 前端骨架（5 天）

| Day | 任务 |
|---|---|
| 11 | AC-P3-1 StatusPanel 拖宽（layout-store width + ResizeHandle + localStorage）|
| 12-13 | AC-P3-2 RuntimeLog 5-tab 容器骨架（1 级 tabs + 2 级 5 tab + 切换保 fetch 状态）|
| 14-15 | draft-approval tab（只读列表，接 GET /api/wiki/drafts）+ **AC-P3-8 b**：prompt-inspector unresolved 入口 UI 接 manual confirm |
| | **patch v3.2 (2026-05-23 小孙拍 B)**：knowledge-base tab + warnings tab 推 Phase 4 — Week 1-2 8 endpoint 未列 `/api/wiki/warnings` + `/api/wiki/index`（V16.5 chap 18 line 1953-1954 引用属 plan bug），后端依赖 wiki 写盘 + 派生 jobs 上线，本 Phase scope 外 |

### Week 4 · 核心面板 + IngestModal（5 天）

| Day | 任务 |
|---|---|
| 16-17 | AC-P3-3 prompt-inspector（注入 part 表 + token + 召回 query + Adaptive Recall Policy 状态 — 接 AC-P3-9 b 真 prompt_audit 数据）|
| 18 | AC-P3-5 wake-up 触发因（接 WS 协议）|
| 19-20 | AC-P3-6 IngestModal（3 入口：composer 拖文件 — **新通道，非图片附件改扩** / [+ Drop] 按钮 / `/ingest` slash 命令）+ composer slash-menu + AC-P3-10 commit endpoint 调用（preview/commit/失败展示）|

### Week 5 · viewfinder + Playwright 验收（5 天）

| Day | 任务 |
|---|---|
| 21-22 | AC-P3-4 viewfinder 6 段视图 + §4 a2a `<AtPill>` 渲染 + in-place drawer |
| 23-24 | **Playwright worktree preview smoke**（覆盖 AC-P3-3/4/5 — 不只组件测试，浏览器实操；F024 :3100，范 P2-5）+ evidence pack 10 AC × 双 judge（轻量复用 Phase 2 runner）|
| 25 | buffer / 修 / 合 dev |
| | **patch v3.3 (2026-05-23 小孙拍 C)**：Day 23-24 改走 walkthrough script + Phase 2 evidence pack runner 复用（不引入 Playwright）。理由：项目无 Playwright 基建（无 playwright.config / tests/e2e/），引入 + 写 6 AC E2E ~1.5-2d 额外工。复用 Phase 2 pattern（每 AC `result.json` + `judges/{judge1_claude-opus-4-7, judge2_codex-gpt-5.4, arbitration}.json`）+ 双 judge double-pass 0.5-1d 完成。Playwright 推 Phase 4 与 F024 worktree preview 全面同步。|

每 Week 走 requesting-review → 范德彪 code-review → receiving-review chain（同 Phase 2 节奏）。

## 4. AC 列表（v3 升 7 → 10）

| AC | 内容 | 验收位 |
|---|---|---|
| AC-P3-1 | StatusPanel 360-720px 拖宽 ≥50fps + localStorage persist + reload ±1px | Playwright Performance |
| AC-P3-2 | 5 tab 渲染 + 切换保 fetch 状态（scroll ±10px）+ 默认 prompt-inspector | Playwright 截图 + DOM 断言 |
| AC-P3-3 | prompt-inspector 注入 part 表 + token 占比 + 召回 query（Quality Gate 三段）+ Adaptive Recall Policy 状态（**接 AC-P3-9 真 prompt_audit 数据**）| 组件测试 + fixture **+ Playwright smoke**（v3 — 范 P2-5）|
| AC-P3-4 | viewfinder §4 `[a2a_call=xxx]` → `<AtPill>` 渲染 + click in-place drawer 展开 mini call tree | 组件测试 + WS fixture **+ Playwright smoke**（v3）|
| AC-P3-5 | prompt-inspector 顶部 `🔔 触发因: [a2a_call=xxx]` + click in-place drawer | 组件测试 + WS fixture **+ Playwright smoke**（v3）|
| AC-P3-6 | IngestModal 3 入口任一触发 → 5 层 sanitize + LLM 编译预览 + multi-drop 关联 → 点 [/ingest 编译] 才落盘（**commit 路径走 AC-P3-10**）| 组件测试 + E2E |
| **AC-P3-7**（v2 新增 / v3 强化）| 调度器 go-live：API server 启动 → `SchedulerRuntime` 实例化 + 11 job 注册 + 真 job_trace 落 `.runtime/job-traces/` **+ Iron Laws 3 负断言**：不存在/不创建/不写入 `wiki.config.yaml`；fallback config 来源可观测；Gate 2 未批准时真配置路径保持 BLOCKED（v3 — 范 P2-3）| 集成测试（启真 server + 探针 trace + 文件系统断言）|
| **AC-P3-8**（v3 新 — 接 AC-P1-10 P20 wiring）| manual confirm decision API（POST /api/rooms/:id/decisions）+ Inspector Coverage warning unresolved 列表入口 — UI click → manual confirm 写新行；Phase 1 P12 ledger append-only + tombstone 语义不变 | 集成测试 + 组件测试 |
| **AC-P3-9**（v3 新 — 接 AC-P1-12 P20 wiring）| Adaptive Recall production wiring：(a) orchestrator/RoomCompiler 实际调用 `executeAdaptiveRecall`；(b) `prompt_audit` 表 9 字段真写入 fixture 验证；(c) Level5Sink 生产实现（wiki_events action='recall_escalate' + 推审计通知 + Inspector UI 显示）| 集成测试（端到端：触发 wake-up → recall 跑 → prompt_audit 行存在 → Level5 触发时 sink 真写 wiki_events）|
| **AC-P3-10**（v3 新 — 修 AC-P3-6 落盘闭环）| POST /api/wiki/ingest/commit endpoint：前端 [/ingest 编译] → 后端复用 Phase 1 `update_wiki`，含 ACL/CAS/lease/fencing；E2E：preview 不落盘 / commit 才落盘 / 失败不产生 `wiki_events` | 集成测试 + E2E |

## 5. Open 拍板（7 个 — 小孙 2026-05-20 全过；v3 加范 r1 复核）

| # | 决策 | 小孙拍 | 范-r1 复核 |
|---|---|---|---|
| 1 | 后端 HTTP API 层算 Phase 3 | 算 | 有条件同意 — 需补 contract tests + P1 wiring 三块（v3 已纳入 §1.2-7/10/11 + Week 1 Day 2）|
| 2 | go-live 走 fallback config | 是 | 有条件同意 — AC-P3-7 须明确不读写真 `wiki.config.yaml`（v3 已纳入 §4 AC-P3-7）|
| 3 | wake-up WS 改动归 Phase 3 | 是 | 同意 |
| 4 | promote/批量审批留 Phase 4 | 是（Phase 3 只读展示）| 同意 — 但 ingest commit 不是 promote，AC-P3-6/10 仍需闭环（v3 已纳入 AC-P3-10）|
| 5 | Playwright + worktree preview | 是 | 有条件同意 — 组件测试覆盖的 AC 也要补浏览器 smoke（v3 已纳入 AC-P3-3/4/5）|
| 6 | 4 周 / 18-22 单人天 | 是 | 有条件同意 — 反对 Week 4 IngestModal 3 入口 + slash-menu + E2E 全压 2-4 天（v3 改 5 周 / 26-32 天 + IngestModal 前移 Week 4 + Playwright 拆 Week 5）|
| 7 | 加 AC-P3-7 | 是 | 有条件同意 — AC-P3-7 须含 config 安全边界 + adapter 生命周期（v3 已纳入）|

## 6. 风险（v3 加 3 项）

| 风险 | mitigation |
|---|---|
| Phase 3 被后端 API 层撑大（名为"前端"实含后端 + P20 wiring）| Open #1 显式拍；Week 1-2 全做后端 + wiring，前后端解耦；§1.4 P20 wiring 边界说明已落地为 AC 不留模糊 |
| go-live 接线 + Gate 2 耦合 | go-live 走 fallback config 启动，不等 Gate 2；真 wiki.config.yaml 仍 BLOCKED；AC-P3-7 负断言锁死 |
| Playwright 在 worktree 跑不稳 | 端口走 F024 registry；fps 类断言用 DevTools trace 而非肉眼；smoke 只断关键 DOM |
| viewfinder/inspector 数据契约与 Phase 1 service 输出 drift | Week 1 Day 2 DTO/schema fixture + 错误码 + contract tests；前端只认 HTTP 契约 |
| 5-tab 切换保状态（AC-P3-2）实现复杂 | tab 内容组件 keep-alive / 状态提到 store，不靠 unmount |
| **wake-up WS 顺序 / 重连 / 重复事件**（v3 — 范 P3-2）| WS fixture 覆盖乱序、重复、断线重连、room 切换不串房；client 端 ack + dedupe seq |
| **ingest commit 写入安全**（v3 — 范 P1-2）| AC-P3-10 commit endpoint 严格复用 Phase 1 `update_wiki`，不绕过 ACL/CAS/lease/fencing；失败明确不产生 `wiki_events` |
| **scheduler duplicate-start**（v3 — 范 P2-2）| API boot 内 SchedulerRuntime 单例 + idempotent start guard + leader lease 兜底；HMR / 多进程场景 explicit 防护 |
| **Week 2 P20 wiring 三块挤压**（v3.1 — 范 r2 节奏复核）| Week 2 累计工日估 6.5-8d > 5 天名义；按"5 天目标 / 7 天风险"管理，AC-P3-8/9/10 后端闭环优先；WS 协议 + job_trace API 可吃 Week 5 buffer 推迟；r1 review 信号以 8/9/10 完成度为准 |

## 7. 依赖（v3 加 P1 wiring 挂位）

- Phase 1 服务：viewfinder-compiler / memory-preflight / sanitize / wiki 表 — 已合 dev
- **Phase 1 P12 room_decisions ledger** — 已合 dev，HTTP 路由 + UI 在 Phase 3 完成（AC-P3-8）
- **Phase 1 P13 AdaptiveRecallExecutor + Level Backend** — 已合 dev，orchestrator 调用点 + prompt_audit 写入 + Level5Sink 生产实现在 Phase 3 完成（AC-P3-9）
- Phase 2 调度：11 jobs + SchedulerRuntime — 在 worktree（go-live 接线消费它）
- F026：`<AtPill>` / `<TimeoutTombstone>` — 已有，AC-P3-4 复用
- Gate 2：**不阻塞 Phase 3**（go-live 走 fallback config）

## 8. 下一步

1. ~~小孙拍 §5 的 7 个 Open~~ ✓ 2026-05-20 全过
2. ~~范德彪 review plan v2~~ ✓ 2026-05-20 CONDITIONAL（2 P1 + 5 P2 + 3 P3）
3. ~~小孙拍 v3 修订方向~~ ✓ 2026-05-20 拍 A 全接受
4. 同步回写 feature.md（任务 #171：Phase 3 工期 12-15 → 26-32 + AC-P3-7/8/9/10 加入 Phase 3 AC 段 + 依赖列加 P1 wiring 挂位）
5. 范德彪 review plan v3 + feature.md 同步 commit（r2）
6. r2 GO → 开 Week 1 Day 1（go-live 接线）

## 9. Go-live Adapter 映射表（v3 新增 — 范 P2-2）

API boot 内每个 job 适配器的输入/输出/trace schema/失败策略 / scheduler duplicate-start 保护点。Week 1 Day 1 完成实施细节，本节先列契约骨架：

| Job | 类型 | 输入（runtime ctx）| 输出（trace schema 关键字段）| 失败策略 |
|---|---|---|---|---|
| StartupReconciler | one-shot @ boot | fs(.runtime), db | reconciled_rooms[] / orphan_files[] | log + 继续 boot |
| RoomCompilerTick | scheduled 5min | db, leaderTerm | rooms_compiled / drift_detected | retry 3 / 后续 tick 兜底 |
| DocsWatcher | event-driven | fs(docs/) watch | files_ingested / debounce_skipped | log + watch 继续 |
| NightlyHealthCheck | cron 04:00 | db, fs | checks_passed / checks_failed | alert sink + 不阻塞下次 |
| NightlyVacuum | cron 05:00 | db | bytes_reclaimed / sessions_archived | retry next night |
| WeeklyDraftDigest | cron 周一 09:00 | db | drafts_summarized | log + 下周补 |
| DriftDetector | cron 周一 10:00 | db | drift_score / replaced | log + 不自动 replace |
| MonthlySnapshot | cron 1 号 03:00 | db, fs | snapshot_id / size_bytes | retry 24h |
| ArchiveYearlySessions | cron 1/1 03:00 | fs, db | sessions_archived / packs_created | log + 留待次年 |
| WikiCompilerDebounce | event-driven | wiki_events queue | views_regenerated / debounce_window_ms | retry exponential |
| ChainedAlertNotifier | event-driven | chained_suspect queue, room MCP | alerts_pushed | retry 3 / dead-letter |

**duplicate-start 保护**：`SchedulerRuntime` 实例化加 boolean guard，重复 `start()` 直接 noop + 日志；leader lease 是第二道兜底（Phase 2 已实现）。HMR 场景注意 module-level singleton，避免 dev 模式启 2 个。

---

**Plan v3 frozen，待范德彪 review r2 + feature.md 同步回写。**
