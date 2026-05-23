---
id: F027-phase3-walkthrough
title: F027 Phase 3 walkthrough script — 10 AC 手动验证 + evidence pack 步骤
created: 2026-05-23
phase: F027 Phase 3 — 前端容器 + IngestModal + AC 闭环
plan: docs/plans/F027-phase3-implementation-plan.md（v3.2/v3.3 frozen）
---

# F027 Phase 3 Walkthrough Script

**目的**: Phase 3 收口走小孙拍的 C 路径（plan v3.3 patch）— walkthrough script + Phase 2 evidence pack runner 复用 + 双 judge double-pass。不引 Playwright。

**Worktree**: `.worktrees/F027` (port :3100 by F024 dynamic registry)

## 入口

```bash
cd .worktrees/F027
pnpm dev:web   # next dev 拉 worktree preview (port 由 F024 分配)
pnpm dev:api   # API server :8800 (worktree env vars: API_PORT + SQLITE_PATH 见 feedback_worktree_api_env_vars)
```

确认浏览器打 worktree port (查 .worktrees/F027/.env.local NEXT_PUBLIC_API_HTTP_URL)

---

## AC-P3-1 · StatusPanel 拖宽 ≥50fps + reload ±1px (v3.4: max 1200)

**操作**:
1. 浏览器 worktree :3100 → 任意 room
2. 右侧 StatusPanel 鼠标拖左边界 (resize handle)
3. 拖到 360px (minWidth) — 不能再小
4. 拖到 1200px (maxWidth, v3.4 升) — 不能再大
5. 中间拖动 — DOM-direct width 平滑 (Day 11 P2-2 fix · 无 React rerender)
6. Chrome DevTools Performance 录 5s 拖动 → 测平均 fps
7. reload 浏览器 → 宽度持久化 (localStorage)

**evidence**:
- screenshot: 拖宽至 360 / 720 边界 (PNG)
- DevTools Performance flame chart 截图: ≥50fps
- reload 前后宽度 diff ≤1px (像素截图对比)

---

## AC-P3-2 · RuntimeLog 5-tab 容器 + 状态保持

**操作**:
1. 右下 RuntimeLog 容器: 1 级 tabs (system-prompt enabled / logs disabled-future)
2. 2 级 5 tabs: viewfinder / **prompt-inspector (默认)** / draft-approval / warnings / knowledge-base
3. 默认进入是 prompt-inspector ✅
4. 切到 viewfinder → 等数据加载 → scroll 到底部
5. 切到 draft-approval → 切回 viewfinder → 验证 scroll 位置保留 (always-render 5 tab pattern, Day 12-13 r2 P2-1)
6. ARIA keyboard: ArrowLeft/Right/Home/End 跳 tab (Day 12-13 r2 P3-1)

**evidence**:
- screenshot: 5 tab 全可见, prompt-inspector 默认 active
- video: 切 tab + scroll 保留 (record 5s)
- keyboard nav screenshot

---

## AC-P3-3 · prompt-inspector 透明显示 7 块 (V16.5 chap 18 line 2030-2079)

**操作**:
1. RuntimeLog → prompt-inspector tab
2. 验 7 块依次显示:
   - Header (roomId + alias + tok cap)
   - InjectedPartsTable (IronLaws / RecallPack / Viewfinder 等)
   - NotInjectedSection (❌ 未注入预期 parts)
   - RecallSection (自动召回 query 列表 + Quality Gate 三段)
   - AdaptiveRecallPolicy (recall_path Level 1-5 / budget)
   - AgentSessionSection (🤝 agent session)
   - **WakeTriggerSection (🔔 wake-up 触发因, Day 14-15 done + Day 20 加 click pill)**
   - BottomButtonsBar (4 按钮, Week 5 启用)

**evidence**:
- screenshot: 7 块完整 (fixture room data 注入)
- API fetch: `GET /api/rooms/:id/prompt-inspector` returns 200 + 9 fields

---

## AC-P3-4 · viewfinder §4 a2a 状态人话化 + click drawer (V16.5.2)

**操作**:
1. RuntimeLog → viewfinder tab
2. 验 §4 (等谁/blocker) 包 `[a2a_call=call-xxx, status=pending, deadline 17:30]` → AtPillRef 渲染 (Day 16-17)
3. **Day 20**: click pill → in-place drawer 展开 mini call tree (A2ATreeView 复用 F026)
4. drawer 关闭: ✕ / overlay / Escape 三路径

**evidence**:
- screenshot: viewfinder §4 含 pill (颜色: pending 黄 / failed 红 / done 绿)
- screenshot: drawer 展开 a2a tree
- screenshot: Escape 关闭

---

## AC-P3-5 · prompt-inspector wake-up trigger pill + click drawer (V16.5.2)

**操作**:
1. RuntimeLog → prompt-inspector → WakeTriggerSection
2. 验 WS trigger (优先) 或 API trigger (fallback) 显示
3. **Day 20**: a2a_call kind ref 包 WakeTriggerA2APill (amber 紫色 click 区)
4. click pill → drawer 展开 (与 viewfinder §4 共用 store + drawer 组件)

**evidence**:
- screenshot: WakeTriggerSection 含 pill
- screenshot: click 后 drawer (source=prompt-inspector)
- store state: a2a-drawer-store.callId 切换

---

## AC-P3-6 · IngestModal 3 入口 + sanitize 预扫

**操作 (三入口分别测)**:

### 入口 A: composer 拖文件
1. composer 区域拖入 `test.md` → composer 边框紫色 + drag-hint 显示
2. drop → IngestModal 自动 open
3. Modal 渲染: file / type radio / sanitize warnings / LLM compile preview
4. 点 [取消] → modal close, preview 不落盘

### 入口 B: KB tab [+ Drop 资料]
1. RuntimeLog → knowledge-base tab
2. 点紫色 [+ Drop 资料] 按钮 → file picker → 选 `test.md`
3. IngestModal open + sanitize 预览
4. type 切换 → 重 preview (Day 19a r2 P1-1 fix)
5. 点 [/ingest 编译] → commit endpoint 落盘 → CommitSuccess 显示 finalPath

### 入口 C: composer / 命令面板
1. composer 输 `/` → SlashCommandMenu 显示 5 命令 (ingest enabled, 其他 Phase 4 灰)
2. Enter 或 click `/ingest` → 触发 hidden file picker → 选 .md → IngestModal open

**evidence**:
- 3 入口各 1 screenshot (Modal opened)
- screenshot: drag-hint 紫色 / [+ Drop] 按钮 / SlashCommandMenu
- screenshot: sanitize 警告 (sensitive_token 红 / size_truncated 黄)
- screenshot: CommitSuccess + finalPath

---

## AC-P3-7 · 调度器 go-live + Iron Laws 3 边界

**操作**:
1. `pnpm dev:api` 启动 → 看 log: `SchedulerRuntime` 实例化 + 11 job 注册
2. 等 5min RoomCompilerTick 跑 → 看 `.runtime/job-traces/room-compiler-tick-*.json` 落
3. Iron Laws 3 验证: `ls wiki.config.yaml` → 不存在 ✅
4. fallback config 来源在 log 可见 (BLOCKED 状态)

**evidence**:
- log 截图: 11 job 注册
- ls 截图: wiki.config.yaml 不存在 + Gate 2 未批 BLOCKED
- job_trace JSON 文件示例

---

## AC-P3-8 · manual confirm decision + Inspector unresolved 入口

**操作**:
1. POST `/api/rooms/R-001/decisions` { kind: "commit", content: "test", evidence: [{...}], callerAlias: "小孙" }
2. GET `/api/rooms/R-001/decisions/coverage` → broad/resolved/unresolved 三集合
3. Inspector → CoverageSection (Week 5 ?) 显示 unresolved → click → manual confirm modal

**evidence**:
- curl POST/GET 响应 JSON
- screenshot: Inspector unresolved 入口 (Phase 3 当前 7 块未含, 可能 Phase 4)

---

## AC-P3-9 · Adaptive Recall production wiring

**操作**:
1. orchestrator/RoomCompiler 触发 wake-up → executeAdaptiveRecall 跑
2. SELECT * FROM prompt_audit WHERE room_id='R-001' ORDER BY ts DESC LIMIT 1
3. 验 9 字段写入: recall_required / recall_path / recall_satisfied / escalate_reason / budget_consumed / ...
4. Level 5 trigger → wiki_events action='recall_escalate' 行
5. Inspector RecallSection 显示 query 列表 + gate

**evidence**:
- SQL 查询结果 (prompt_audit 9 字段填全)
- wiki_events SQL 查询: action='recall_escalate'
- Inspector screenshot: RecallSection 数据

---

## AC-P3-10 · IngestModal commit endpoint 落盘闭环

**操作**:
1. AC-P3-6 入口 任意 → IngestModal preview ok
2. 点 [/ingest 编译] → POST /api/wiki/ingest/commit
3. 后端: acquireLease → updateWiki (ACL/CAS/lease/fencing) → 落盘
4. 验 `.runtime/wiki/concepts/draft/_auto/2026-05-23-*.md` 存在
5. SQL wiki_events 查 action='write' 行存在
6. preview 不落盘 (input不点 commit → wiki_events 无新行)
7. commit 失败 (mock 409 LEASE_FENCING_FAILED) → wiki_events 无新行 + UI 显示 error

**evidence**:
- screenshot: IngestModal CommitSuccess + finalPath
- ls 截图: 落盘文件
- SQL wiki_events 查询结果 (preview 无新行 vs commit 有新行)

---

## Evidence Pack 三件套 (按 Phase 2 pattern)

每 AC 落点: `docs/features/F027/evidence/phase3/AC-P3-<N>/`

```
docs/features/F027/evidence/phase3/AC-P3-1/
├── result.json              # walkthrough 结果 + evidence file refs
├── judges/
│   ├── judge1_claude-opus-4-7.json
│   ├── judge2_codex-gpt-5.4.json
│   └── arbitration.json
├── screenshots/             # 截图证据
└── walkthrough-log.md       # 手动执行步骤日志
```

**result.json schema**:
```json
{
  "ac_id": "AC-P3-1",
  "ac_text": "StatusPanel 360-720px 拖宽 ≥50fps + localStorage persist + reload ±1px",
  "evidence_files": [
    "screenshots/resize-360.png",
    "screenshots/resize-720.png",
    "screenshots/devtools-fps.png",
    "screenshots/reload-diff.png"
  ],
  "walkthrough_log": "walkthrough-log.md",
  "executed_at": "2026-05-24T..."
}
```

**judge** 评估 rubric (复用 P18 judge wrapper):
- evidence 完整性 (screenshots / API responses / SQL queries)
- AC 字面契约 (拖宽范围 / fps 阈值 / reload 误差 / 5-tab 列表 / etc)
- 设计意图对齐 (V16.5 chap 18 真相源)
- residual risk 评估

**arbitration.json**: judge1 + judge2 一致 = double-pass; 不一致 = re-judge or escalate

## 走法节奏

1. **Step 1 (~2-3h)**: 跑 walkthrough — 10 AC 操作 + 截图 + log
2. **Step 2 (~1h)**: 整理 evidence pack 目录 + result.json
3. **Step 3 (~1h)**: 派 judge1 (Claude Opus 4.7 直接评) + judge2 (Codex 异构)
4. **Step 4 (~30min)**: arbitration + evidence summary md
5. **Step 5**: 小孙最终拍板 → 合 dev

## 不做 (Phase 4 范围)

- Playwright 引入 (与 F024 worktree preview 全面同步 deferred)
- AC-P4-1 PromoteModal
- AC-P4-3 命令面板 5 命令全部启用
- AC-P4-4 批量审批 UI
- AC-P4-5 三层验证套件
- AC-P4-6 手 walk-through (Phase 4 走全套 V16.5 walkthrough 三场景)
