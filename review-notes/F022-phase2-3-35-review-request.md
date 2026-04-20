## Review Request — F022 Phase 2 + 3 + 3.5（合入前最终 review）

**Feature:** F022 左侧侧栏重塑 — `docs/features/F022-left-sidebar-redesign.md`
**Branch:** `feat/f022-phase1` @ `C:\Users\-\Desktop\multi-agent-f022-phase1`
**Base:** `origin/dev`（最新 merge 自 dev 在 `1311306`）
**Reviewer:** 范德彪（Codex）
**Author:** 黄仁勋（Claude）
**对应 AC:** AC-20（范德彪 code review 通过：Haiku 调用有超时、migration 幂等）

### Scope

Phase 1 已独立 review 过（`F022-phase1-review-request.md`）。**本轮 review 覆盖 Phase 2 + Phase 3 + Phase 3.5 整包** — 这是 F022 merge 前最后一道门。

Phase 4（AC-16/17/18 标题栏三层 ID 徽章）**Dropped 2026-04-21，迁 F021**，本轮不看。

### Commits（since Phase 1 merge 基线）

**Phase 2（AC-05~10 Haiku 自动命名）：**
```
0f41f1d feat(F022-P1): 全局递增 ROOM ID（Phase 1 收尾）
80d0a87 feat(F022-P2): isDefaultTitle util — 识别 3 种默认/未命名 title 模式
1bac10e feat(F022-P2): repo 新增 updateSessionGroupTitle
f581cd6 feat(F022-P2): HaikuRunner — claude --print --model claude-haiku-4-5 单轮 + 5s 超时
4ea633d feat(F022-P2): SessionTitler — debounce + 幂等 + Haiku 调用 + 失败回退 + 结构化日志
9a9cf4c feat(F022-P2): SessionTitler 接入 SessionService.appendAssistantMessage(final)
07ca3de docs(F022-P2): feature AC-05~10 勾选 + Timeline 收尾 + 实施计划入库
```

**Phase 3（AC-11~15 Sidebar UI 重塑）：**
```
90472d3 docs(F022-P3): Phase 3 Sidebar UI 实施计划 — 8 tasks AC-11~15
f0abc3f feat(F022-P3): backend 透传 roomId + participants + messageCount + createdAtLabel
450ec55 feat(F022-P3): thread-store SessionListItem 镜像 roomId/participants/messageCount
9d2fe1e feat(F022-P3): SessionCard — R-xxx · title 前缀 + 真实参与者头像 + 悬停详情
6293d83 feat(F022-P3): 搜索识别 R-xxx 精确跳转 + 自动选中 + 空结果提示
8349473 feat(F022-P3): agent 头像过滤 pills — 多选 AND 过滤参与房间  ⚠️ **AC-14 Dropped，实现被 3152712 删除**
705fffd docs(F022): Phase 3 完成标记（AC-11~15 ✅）+ Timeline
```

**Phase 3.5（AC-14a~j 预览验收反馈补丁）：**
```
3cb014e docs(F022): Phase 3.5 kickoff — AC-14 Dropped + AC-14a/b/c 新增
3152712 feat(F022-P3.5): 删 agent pills + title fallback + 时间分组 + 历史回填 migration
7a5ca7d feat(F022-P3.5): AC-14d/14e 标题前缀分类 + 立项号识别
fc720c8 feat(F022-P3.5): AC-14f/g/h/i/j — HaikuRunner 修复 + 右键菜单四件套 + 归档软删
01796f9 docs(F022): Phase 4 Dropped — AC-16/17/18 迁 F021
205e49e style(F022): R-xxx 徽章琥珀主色 + active 反色（:3200 实机验收通过）
```

### What Changed（结构化视图）

**后端 / API：**
- `haiku-runner.ts` — 子进程调 `claude --print --model claude-haiku-4-5`；AC-14f 补 `proc.stdin?.end()` 防 Windows stdin-EOF hang + `DEFAULT_TIMEOUT_MS: 5000 → 15000` 给冷启动留余量；四类失败（timeout / exit-code / empty-output / spawn-error）统一返回 null
- `session-titler/session-titler.ts` — debounce 2.5s 合并多次 schedule；`isDefaultTitle` 正则判幂等（跳已命名）；`title_locked_at` 存在时跳过（手动重命名不被覆盖）；`buildTitlePrompt` 含 F/B/D/Q 前缀规则 + 立项号规则（AC-14d/e）；sanitize 兜底
- `session-service.ts` — `appendAssistantMessage(final)` 后调 `sessionTitler.schedule`；启动 `backfillHistoricalTitles()` 扫 title NULL/default 批量排队（AC-14b，带并发限流）
- `db/schema.ts` — 新增 `title_locked_at` / `archived_at` / `deleted_at` 三字段（`integer mode:"timestamp_ms"`）
- `db/drizzle-instance.ts` — `backfillRoomIds()` 事务幂等 + CREATE UNIQUE INDEX 兜底（Phase 1 已 review，但修了两处细节）
- `db/repositories/session-repository-drizzle.ts` — `updateSessionGroupTitle` / `patchSessionGroup` / `listSessionGroups` 过滤软删/归档 / `listArchived`；查询时 `title_locked_at != null` 透传给 UI
- `routes/threads.ts` — `PATCH /api/session-groups/:id` 接受 `{ title, projectTag, archivedAt, deletedAt }` 四类字段；title 写入同步 `title_locked_at = now()`
- `server.ts` — 启动时挂 `backfillHistoricalTitles`
- `shared/session-groups.ts` — 时间分桶 helper（今日 / 本周 / 本月 / 更早）+ test 覆盖
- `shared/realtime.ts` — WS 事件增补（session 更新广播）

**前端：**
- `session-sidebar.tsx` — 492 行大改：时间分桶 / 归档列表 tab / SessionCard R-xxx 徽章（琥珀 100/700 + active 反色）/ 搜索 R-xxx 跳转 / 行内重命名（Enter 提交 / Escape 取消 / ≤40 字）/ 🔒 图标 / pinned 区置顶
- `session-context-menu.tsx` — 四入口：重命名 / 清除项目标签（仅 projectTag ≠ null 可见）/ 归档 / 删除（二次确认）
- `confirm-dialog.tsx`（新）— 软删二次确认弹框
- `provider-avatar.tsx` — 参与者头像堆叠渲染
- `components/stores/thread-store.ts` — `SessionListItem` 镜像 `roomId / participants / messageCount / titleLockedAt / archivedAt / deletedAt`
- `app/page.tsx` — 顶层挂载归档列表 tab 状态

### Self-Check Evidence

- **typecheck**: `pnpm -w typecheck` → exit 0（2026-04-21 17:xx）
- **tests**: `pnpm test` → **928/928 pass, 0 fail**（含 Phase 2/3/3.5 新增 TDD 测试 60+）
- **Pre-commit hook**: 每个 commit 都跑 928 测试，全绿
- **实机验收（小孙 L1 @ :3200）**：
  - 分桶：今日 / 本周 / 本月 / 更早 ✅
  - Haiku 命名（backfill 扫 197 条 pending 43 条，session-titler 调用成功）✅
  - 右键菜单四件套（重命名 / 清标签 / 归档 / 软删 + 归档列表恢复）✅
  - R-xxx 徽章琥珀色 + active 反色 ✅

### Review Focus（AC-20 对标 + 本轮高风险点）

**P0 硬门（AC-20 原文 + 铁律）**

1. **HaikuRunner 子进程管理** — `haiku-runner.ts`
   - `proc.stdin?.end()` 能否保证 Windows/macOS/Linux 都正确关闭子进程 stdin？冷启动 15s 超时后是否一定 `proc.kill()`？僵尸子进程风险？
   - 四类失败（timeout / exit-code / empty-output / spawn-error）是否完整覆盖？比如 `claude` 二进制缺失走哪条路径？
   - SessionTitler 在高并发（多个 session 同时 debounce 触发）时会不会拉满 CPU？有无并发上限？

2. **Migration 幂等性** — `drizzle-instance.ts` + `session-service.ts` 启动钩子
   - `backfillRoomIds()` 二次启动不应 re-assign；多 worker 启动（假设单进程但未来可能变）会不会竞争？
   - `backfillHistoricalTitles()` 重启时扫 `title IS NULL OR isDefaultTitle(title)` — 如果 Haiku 调用失败，title 回退到 `D-新会话 YYYY-MM-DD`（默认格式），下次启动会**再次被扫进队列**。这是幂等了但会死循环 Haiku。是不是需要"尝试次数上限" / "最后尝试时间戳"字段？

3. **铁律 1 — 软删无物理入口** — `routes/threads.ts` + `session-repository-drizzle.ts`
   - `PATCH /api/session-groups/:id` 只接受 `{ title, projectTag, archivedAt, deletedAt }` — 没有 DELETE 路由吧？请确认。
   - `listSessionGroups` 默认过滤 `deleted_at IS NULL AND archived_at IS NULL`，`listArchived` 走独立查询。数据路径上真的没有"彻底清除"的方法吗？

**P1 中风险**

4. **title_locked_at 语义一致性** — `PATCH {title}` 写 `title_locked_at = now()`；`PATCH {title: ""}`（清空）是否也应该 lock？清空后 SessionTitler 跳过会永远空白吗？

5. **time-bucket helper 时区** — `shared/session-groups.ts` 用 `new Date()` / `toISOString` — 服务端（UTC）和前端（本地时区）是否对同一个 session 会落进不同分桶？（比如凌晨 0 点左右的 session）

6. **allocateNextRoomId MAX+1 并发冲突** — Phase 1 review focus #4 延续：现在 Haiku backfill 可能触发并发 createSessionGroup 吗？UNIQUE 约束兜底但无重试。

**P2 轻风险**

7. **session-context-menu `清除项目标签` 可见性**：`projectTag != null` 才渲染入口 — 如果后端 projectTag 是空字符串 `""`，会不会误判？
8. **confirm-dialog 焦点陷阱 / Escape 取消**：Esc 键是否正确取消不提交删除？
9. **归档列表空状态**：没有归档条目时的 empty-state 文案？

### Out of Scope（本次不看）

- ❌ F021 右侧面板重设计（R-xxx 三层徽章 AC-16/17/18 已迁过去）
- ❌ legacy `session-repository.ts` + `sqlite.ts` 零引用路径清理 — 已知 tech debt，独立 refactor PR
- ❌ 桂芬视觉验收（AC-19）— 独立由桂芬跑
- ❌ 小孙 R-042 搜索验收（AC-21）— 独立由小孙跑

### Handoff（五件套）

**What**：Phase 2/3/3.5 共 17 commits，约 +1600/-200 行 · 跨后端（Haiku + DB 三新字段 + 两 migration）· 前端（sidebar 大改 + 右键菜单 + 归档列表）· shared（时间分桶 helper）

**Why**：小孙反向溯源场景需要"时间 · agent · 语义"三索引 → Phase 2 Haiku 语义命名、Phase 3 UI 呈现、Phase 3.5 预览验收反馈补丁把 agent pills Dropped 换成时间分桶 + 右键管理

**Tradeoff**：
- HaikuRunner 选 `claude --print` 子进程（不引 SDK）— 简单可控但依赖 CLI 二进制就位
- `title_locked_at` 锁字段用 timestamp 而非 bool — 给未来"查看谁什么时候改的"留 affordance
- 归档 + 软删合一视图用 status 小标签区分 — 减少 UI 视图复杂度（小孙产品拍板）

**Open Question**：review focus 第 2 点 — 历史 title backfill 死循环风险（失败→默认格式→再扫入队列）是否需要加"尝试次数"字段？

**Next**：
- 范德彪 finding → P1 我进 `receiving-review` 全修 → P2 逐条回复（修 / 跳 / 记 tech debt）
- 范德彪放行 → 桂芬视觉验收（AC-19）→ 小孙 R-042 搜索验收（AC-21）→ `merge-gate` 进 PR → squash merge dev

请范德彪按 code-review SOP 给 finding（P0/P1/P2），我全程在 `feat/f022-phase1` worktree 待命。
