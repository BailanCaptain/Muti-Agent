## Review Request

**Feature:** F022 Phase 1 — `docs/features/F022-left-sidebar-redesign.md`
**Plan:** `docs/plans/F022-phase1-plan.md`
**Branch:** `feat/f022-phase1` @ `C:\Users\-\Desktop\multi-agent-f022-phase1`
**Reviewer:** 范德彪（Codex）
**Author:** 黄仁勋（Claude）

### What Changed

纯后端 DB 层：`session_groups` 表新增全局递增 `roomId`（`R-001`, `R-002`, ...），新建 session 自动分配，历史 session 按 `createdAt` 升序回填，DB 层 UNIQUE 约束。**UI 零改动。**

**4 个 commits，7 文件，+382/-4 行：**

- `packages/api/src/db/schema.ts` — drizzle schema 加 `roomId: text("room_id").unique()`
- `packages/api/src/db/sqlite.ts` — CREATE TABLE 含 UNIQUE + ALTER migration（F011 双路）
- `packages/api/src/db/drizzle-instance.ts` — `backfillRoomIds()` 事务回填 + `CREATE UNIQUE INDEX` 兜底
- `packages/api/src/db/drizzle-instance.test.ts` — 回填 3 用例（升序/幂等/混合数据）
- `packages/api/src/db/repositories/session-repository-drizzle.ts` — `allocateNextRoomId()` + `createSessionGroup` 接入 roomId + `getSessionGroupById`/`listSessionGroups` 返回 roomId
- `packages/api/src/db/repositories/session-repository-drizzle.test.ts` — AC-01/02/04 测试
- `docs/features/F022-left-sidebar-redesign.md` — Phase 1 AC 打勾 + Timeline

### Why

小孙原话（feature doc L17）：

> "左侧全是新会话带日期好难看。如果我想日后找到某个房间的聊天记录当证据给某个 agent 定位，可能就难找了。"

反向溯源场景要**时间 · agent · 语义**三把索引。Phase 1 打底：**稳定可引用的 ROOM ID**，像 GitHub Issue 一样可跨项目引用（小孙/产品拍板：全局递增而非 projectTag 分号）。

### Original Requirements

**Phase 1 AC（feature doc L41-45）**：
- AC-01: 新建 session 时分配全局递增 ID：`R-001`, `R-002`, ...
- AC-02: ID 持久化到 session 记录（DB schema 加 `roomId` 字段）
- AC-03: 历史 session 回填（migration：按 createdAt 升序分配 R-xxx）
- AC-04: ID 在数据库层面全局唯一（不按 projectTag 分号，不复用）

**产品决策**（feature doc L83）：ROOM 编号策略 = 全局递增 `R-001, R-002...`（像 GitHub Issue，跨项目可引用）

**Out of Scope（Plan L463-468）**：不改 UI（sidebar/header/徽章都在 Phase 3/4）· 不接 Haiku（Phase 2）· 不改搜索（Phase 3）· `roomId` 只在 DB + repository 返回值中出现，Frontend 类型不变

### Self-Check Evidence

**quality-gate**：✅ 全 AC 通过
- typecheck: exit 0
- pnpm test: 774/774 pass, 0 fail（F022 相关 10 用例全过）
- pnpm build: exit 0
- pnpm lint: 4 pre-existing warnings（非本次改动）

**acceptance-guardian（F024 路径绑定 · 独立 agent）**：✅ PASS
- 验收路径：`C:\Users\-\Desktop\multi-agent-f022-phase1`（与待 merge worktree 同源）
- 报告：`.agents/acceptance/F022/2026-04-19T0430/worktree-report.md`（worktree 本地，`.gitignore` 忽略）
- UNIQUE 三处一致 ✅（schema.ts `.unique()` + drizzle-instance CREATE TABLE UNIQUE + CREATE UNIQUE INDEX 兜底 ALTER 路径）
- B001~B016 历史 bug 回归扫描：**无关**

### Known Risks / 实施备注

**Plan 路径描述失真**（已补 commit 55d72eb）：

Plan 原文以 legacy `SqliteStore` + `SessionRepository` 为目标，但 `server.ts:62-63` 生产实际走 `DrizzleSessionRepository`（barrel export 别名），legacy 类在生产零引用。

因此实施落点是 drizzle 路径（`drizzle-instance.ts` + `session-repository-drizzle.ts`），AC 实质覆盖与 plan 一致，仅类/文件名不同。已在 plan 末尾追加备注段说明。

**Tech debt**：清理 legacy `session-repository.ts` + `sqlite.ts` 中已零引用的旧路径 → 后续单独 refactor PR，**不阻塞 F022**。

### Review Focus（建议重点）

1. **双路 migrate 幂等性**（`sqlite.ts` CREATE TABLE UNIQUE + ALTER ADD COLUMN + `drizzle-instance.ts` CREATE UNIQUE INDEX IF NOT EXISTS 兜底）：新库走 CREATE TABLE 路径拿到 UNIQUE；旧库走 ALTER 路径（ALTER 不带 UNIQUE，多 NULL 兼容），回填后由 CREATE UNIQUE INDEX 补齐约束。这条链路正确吗？有没有旧库 → 新版本升级时的边界风险？

2. **`backfillRoomIds()` 事务 + 并发**（`drizzle-instance.ts:280-313`）：startup 时单次调用、事务内按 `createdAt ASC, id ASC` 顺序 UPDATE。多 worker 启动会不会重复回填 / 竞争 roomId？（当前假设：startup 回填是单进程一次性动作，不考虑并发 server 启动。）

3. **`allocateNextRoomId()` 的 MAX+1 语义**（`session-repository-drizzle.ts`）：`MAX(CAST(SUBSTR(room_id, 3) AS INTEGER)) + 1`。如果 `room_id` 不符合 `R-%` 前缀会被 WHERE 过滤。如果以后 roomId 格式变了（比如加项目前缀 `P1-R-001`），这个 cast 会不会炸？

4. **UNIQUE 冲突兜底**：`createSessionGroup` 并发调用时两个请求拿到同一个 MAX+1 → INSERT 冲突。当前靠 UNIQUE 约束抛错。这种情况预期吗？要不要加重试？

### Out of Scope（本次不看）

- ❌ UI 显示 roomId（sidebar / header / 徽章）→ Phase 3/4
- ❌ Haiku 自动命名 → Phase 2
- ❌ 搜索支持 `R-042` 直跳 → Phase 3
- ❌ `listSessionGroups` 返回类型的 Frontend 侧消费 → Phase 3
- ❌ legacy `session-repository.ts` 清理 → 独立 refactor PR

### Commits

```
55d72eb docs(F022-P1): plan 补充实施路径备注（drizzle 落点 + legacy cleanup tech debt）
77a7f5e docs(F022): Phase 1 完成标记（AC-01~04 ✅）
25375f0 feat(F022-P1): backfillRoomIds 历史回填 + UNIQUE index 补齐 (AC-03/04)
617e537 feat(F022-P1): createSessionGroup 分配全局递增 roomId (AC-01/02/04)
bff353a feat(F022-P1): session_groups 表新增 room_id 列（schema + 双路 migrate 幂等）
```

请范德彪按 code-review SOP 给 finding（P1/P2/P3），我进 receiving-review 处理。
