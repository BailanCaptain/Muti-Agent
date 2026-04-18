# F022 Phase 1 Implementation Plan — ROOM ID 生成 + 存储 + 历史回填

**Feature:** F022 — `docs/features/F022-left-sidebar-redesign.md`
**Goal:** 给 session_groups 加全局递增 ROOM ID（`R-001`, `R-002`, ...），新建 session 自动分配，历史 session 按 createdAt 升序回填，DB 层全局唯一。
**Acceptance Criteria:**
- AC-01: 新建 session 时分配全局递增 ID：`R-001`, `R-002`, ...
- AC-02: ID 持久化到 session 记录（`session_groups.room_id` 字段）
- AC-03: 历史 session 回填（migration：按 createdAt 升序分配 R-xxx）
- AC-04: ID 在数据库层面全局唯一（不按 projectTag 分号，不复用）

**Architecture:** 在 `session_groups` 表新增 `room_id TEXT UNIQUE` 列；分配逻辑复用 `MAX(CAST(SUBSTR(room_id, 3) AS INTEGER)) + 1`；回填在启动 migrate 路径中幂等执行（`room_id IS NULL` 才填）。保留 UUID `id` 作为内部主键不变，`roomId` 作为用户可见引用。
**Tech Stack:** `node:sqlite` (DatabaseSync) · drizzle-orm schema · node:test · TypeScript

**Out of scope (Phase 1)**：不改 UI（sidebar / 徽章 / header 都留到 Phase 3/4）；不接 Haiku（Phase 2）；不改搜索（Phase 3）。`roomId` 只在 DB + repository 返回值中出现。

**Terminal schema**:
```sql
-- session_groups 新增一列
room_id TEXT UNIQUE  -- 'R-001' / 'R-042' / 'R-1234'(>999 时自然扩位)
```
格式化规则：`R-{n.toString().padStart(3, '0')}`，n ≥ 1000 时自然变 4+ 位。

---

## Task 1: Schema 加列 + 幂等 migrate

**Files:**
- Modify: `packages/api/src/db/schema.ts:3-9`（`sessionGroups` 表加 `roomId` 字段）
- Modify: `packages/api/src/db/sqlite.ts:92-98`（`CREATE TABLE IF NOT EXISTS` 加列，给新库用）
- Modify: `packages/api/src/db/sqlite.ts:252-269`（`runAlterMigrations` 加 F022 entry，给旧库加列）

**Step 1: 改 schema.ts**

```typescript
export const sessionGroups = sqliteTable("session_groups", {
  id: text("id").primaryKey(),
  roomId: text("room_id").unique(),
  title: text("title").notNull(),
  projectTag: text("project_tag"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})
```

（`unique()` 即 `UNIQUE` 约束。暂不加 `notNull()` — 因为 ALTER ADD COLUMN 对已有行无法赋非空值；回填完成后由 `createSessionGroup()` 保证新行 NOT NULL。）

**Step 2: 改 sqlite.ts `CREATE TABLE IF NOT EXISTS session_groups`（L92-98）**

```sql
CREATE TABLE IF NOT EXISTS session_groups (
  id TEXT PRIMARY KEY,
  room_id TEXT UNIQUE,
  title TEXT NOT NULL,
  project_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Step 3: 在 `runAlterMigrations` 数组末尾（L268 之后）加 F022 条目**

```typescript
// F022 Phase 1: 全局递增 ROOM ID (R-001, R-002, ...)
{
  name: "F022-session-groups-add-room-id",
  sql: "ALTER TABLE session_groups ADD COLUMN room_id TEXT",
},
```

（ALTER 里不加 UNIQUE，因为已有行均为 NULL，多 NULL 值在 SQLite UNIQUE 中被视为互异，兼容。新库由 `CREATE TABLE` 路径的 `UNIQUE` 保证。若有顾虑可在 ALTER 之后 `CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_room_id ON session_groups(room_id)` —— 见 Task 4 Step 1 的补丁。）

**Step 4: 跑一次现有测试确认未破坏**

Run: `pnpm --filter @multi-agent/api test`
Expected: 现有全部测试 PASS（无新增/改动测试，结构调整是向后兼容的 additive）

**Step 5: Commit**

```bash
git add packages/api/src/db/schema.ts packages/api/src/db/sqlite.ts
git commit -m "feat(F022-P1): session_groups 表新增 room_id 列（schema + migrate 幂等）"
```

---

## Task 2: `allocateNextRoomId()` 内部工具函数

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository.ts`（在类内加 private 方法）
- Test: `packages/api/src/db/repositories/session-repository.test.ts`

**Step 1: 写失败测试**

在 `session-repository.test.ts` 合适的 describe 下（或新开 `describe("F022 room ID allocation")`）加：

```typescript
test("F022 AC-01: allocateNextRoomId returns R-001 on empty table", () => {
  const repo = makeRepo() // 使用测试 setup helper，内存 DB 或临时文件
  assert.equal(repo["allocateNextRoomId"](), "R-001")
})

test("F022 AC-01: allocateNextRoomId increments monotonically", () => {
  const repo = makeRepo()
  repo.createSessionGroup("a") // will insert with R-001
  assert.equal(repo["allocateNextRoomId"](), "R-002")
})

test("F022 AC-04: allocateNextRoomId skips gaps but never reuses", () => {
  const repo = makeRepo()
  // 手工插一条 R-005（模拟回填过的库）
  repo["store"].db.prepare(
    "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run("uuid-x", "R-005", "test", new Date().toISOString(), new Date().toISOString())
  assert.equal(repo["allocateNextRoomId"](), "R-006")
})

test("F022 AC-01: allocateNextRoomId formats >999 naturally", () => {
  const repo = makeRepo()
  repo["store"].db.prepare(
    "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run("uuid-y", "R-1234", "test", new Date().toISOString(), new Date().toISOString())
  assert.equal(repo["allocateNextRoomId"](), "R-1235")
})
```

**Step 2: 跑测试确认失败**

Run: `pnpm --filter @multi-agent/api test --test-name-pattern "F022 room ID"`
Expected: FAIL（`allocateNextRoomId is not a function`）

**Step 3: 写最小实现（加在 `SessionRepository` 类内）**

```typescript
private allocateNextRoomId(): string {
  const row = this.store.db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(room_id, 3) AS INTEGER)) AS maxSeq
       FROM session_groups
       WHERE room_id IS NOT NULL AND room_id LIKE 'R-%'`,
    )
    .get() as { maxSeq: number | null }
  const next = (row?.maxSeq ?? 0) + 1
  return `R-${String(next).padStart(3, "0")}`
}
```

**Step 4: 跑测试确认通过**

Run: `pnpm --filter @multi-agent/api test --test-name-pattern "F022 room ID"`
Expected: 前 3 个 PASS；"increments monotonically" 可能仍 FAIL（因 `createSessionGroup` 未接入 roomId，见 Task 3）—— 先允许 FAIL，Task 3 之后 GREEN。

**Step 5: Commit**

```bash
git add packages/api/src/db/repositories/session-repository.ts packages/api/src/db/repositories/session-repository.test.ts
git commit -m "feat(F022-P1): allocateNextRoomId 工具函数（全局 MAX+1 分配）"
```

---

## Task 3: `createSessionGroup()` 接入 roomId + 返回值扩展

**Files:**
- Modify: `packages/api/src/db/repositories/session-repository.ts:129-141`
- Modify: `packages/api/src/db/sqlite.ts`（如有 `SessionGroupRecord` 类型定义的话也要加字段，搜索后决定）
- Test: 同上文件

**Step 1: 写失败测试**

```typescript
test("F022 AC-02: createSessionGroup 新建时写入 roomId", () => {
  const repo = makeRepo()
  const id = repo.createSessionGroup("hello")
  const group = repo.getSessionGroupById(id) as any
  assert.match(group.roomId, /^R-\d{3,}$/)
})

test("F022 AC-01: createSessionGroup 连续创建递增", () => {
  const repo = makeRepo()
  const id1 = repo.createSessionGroup("a")
  const id2 = repo.createSessionGroup("b")
  const id3 = repo.createSessionGroup("c")
  const r1 = (repo.getSessionGroupById(id1) as any).roomId
  const r2 = (repo.getSessionGroupById(id2) as any).roomId
  const r3 = (repo.getSessionGroupById(id3) as any).roomId
  assert.equal(r1, "R-001")
  assert.equal(r2, "R-002")
  assert.equal(r3, "R-003")
})
```

**Step 2: 跑测试确认失败**

Run: `pnpm --filter @multi-agent/api test --test-name-pattern "F022"`
Expected: FAIL（`group.roomId` 是 undefined，`getSessionGroupById` 不返回 room_id）

**Step 3: 改实现**

3a. 修改 `SessionGroupRow` 类型（L42-48 附近）：

```typescript
type SessionGroupRow = {
  id: string
  roomId: string | null
  title: string
  projectTag: string | null
  createdAt: string
  updatedAt: string
}
```

3b. 修改 `getSessionGroupById`（L65-74）SELECT：

```typescript
`SELECT id, room_id as roomId, title, project_tag as projectTag,
        created_at as createdAt, updated_at as updatedAt
 FROM session_groups WHERE id = ? LIMIT 1`
```

3c. 同步修改 `listSessionGroups`（L80-87）SELECT 加 `sg.room_id AS roomId` 并在 groupMap 中传递（group map 当前没放 roomId，新增）。（此步虽超出本 Phase 必要，但 `listSessionGroups` 已是 session 查询入口，不改会成为后续 Phase 3 的返工；改动最小，仅加字段透传。）

3d. 修改 `createSessionGroup`：

```typescript
createSessionGroup(title?: string) {
  const now = new Date().toISOString()
  const sessionGroupId = crypto.randomUUID()
  const roomId = this.allocateNextRoomId()

  this.store.db
    .prepare(
      `INSERT INTO session_groups (id, room_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionGroupId, roomId, title ?? `新会话 ${now.slice(0, 19).replace("T", " ")}`, now, now)

  return sessionGroupId
}
```

**Step 4: 跑测试确认通过**

Run: `pnpm --filter @multi-agent/api test --test-name-pattern "F022"`
Expected: Task 2 和 Task 3 所有测试 PASS

再跑全量：`pnpm --filter @multi-agent/api test`
Expected: 全绿（若 `SessionGroupRecord` 类型在别处消费，先编译检查 `pnpm --filter @multi-agent/api typecheck`）

**Step 5: Commit**

```bash
git add packages/api/src/db/repositories/session-repository.ts packages/api/src/db/repositories/session-repository.test.ts
git commit -m "feat(F022-P1): createSessionGroup 分配 roomId + 查询返回 roomId"
```

---

## Task 4: 历史 session 回填 migration

**Files:**
- Modify: `packages/api/src/db/sqlite.ts`（在 `migrate()` 末尾加 `backfillRoomIds()` 调用 + 实现）
- Test: `packages/api/src/db/sqlite.test.ts`（若存在，否则在 `session-repository.test.ts` 加）

**Step 1: 写失败测试（幂等性 + 顺序正确）**

在合适测试文件：

```typescript
test("F022 AC-03: 历史 session 按 createdAt 升序回填 roomId", () => {
  const store = makeStore() // 临时 DB
  const repo = new SessionRepository(store)

  // 绕过 createSessionGroup 直接写入三条无 roomId 的历史数据
  const db = store.db
  db.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run("u1", "oldest", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  db.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run("u2", "middle", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z")
  db.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run("u3", "newest", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z")

  // 跑回填（暴露为 store 上的方法或 SessionRepository 的 public 方法）
  store.backfillRoomIds()

  assert.equal((repo.getSessionGroupById("u1") as any).roomId, "R-001")
  assert.equal((repo.getSessionGroupById("u2") as any).roomId, "R-002")
  assert.equal((repo.getSessionGroupById("u3") as any).roomId, "R-003")
})

test("F022 AC-03: 回填幂等 — 再跑一次不改变已有 roomId", () => {
  const store = makeStore()
  // ... 同上插入 + 回填
  store.backfillRoomIds()
  store.backfillRoomIds() // 第二次
  // 断言 roomId 不变
})

test("F022 AC-03/AC-04: 混合数据 — 已有 R-005 + 两条 null，新 ID 从 R-006 起", () => {
  const store = makeStore()
  const db = store.db
  db.prepare(
    "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run("u-existing", "R-005", "existing", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  db.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run("u-old", "old", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z")
  db.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ).run("u-new", "new", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z")

  store.backfillRoomIds()

  const repo = new SessionRepository(store)
  assert.equal((repo.getSessionGroupById("u-existing") as any).roomId, "R-005")
  assert.equal((repo.getSessionGroupById("u-old") as any).roomId, "R-006")
  assert.equal((repo.getSessionGroupById("u-new") as any).roomId, "R-007")
})
```

**Step 2: 跑测试确认失败**

Run: `pnpm --filter @multi-agent/api test --test-name-pattern "F022 AC-03"`
Expected: FAIL（`store.backfillRoomIds is not a function`）

**Step 3: 写实现（放在 `SqliteStore` 类）**

在 `sqlite.ts` 中，`SqliteStore` 类内加 public 方法：

```typescript
backfillRoomIds(): void {
  const rows = this.db
    .prepare(
      `SELECT id FROM session_groups
       WHERE room_id IS NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{ id: string }>

  if (rows.length === 0) return

  // 找到当前 MAX 序号，接着往下分配
  const maxRow = this.db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(room_id, 3) AS INTEGER)) AS maxSeq
       FROM session_groups
       WHERE room_id IS NOT NULL AND room_id LIKE 'R-%'`,
    )
    .get() as { maxSeq: number | null }
  let next = (maxRow?.maxSeq ?? 0) + 1

  const update = this.db.prepare("UPDATE session_groups SET room_id = ? WHERE id = ?")
  const tx = this.db.exec.bind(this.db)
  tx("BEGIN")
  try {
    for (const row of rows) {
      const rid = `R-${String(next).padStart(3, "0")}`
      update.run(rid, row.id)
      next++
    }
    tx("COMMIT")
  } catch (err) {
    tx("ROLLBACK")
    throw err
  }
}
```

然后在 `migrate()` 末尾（`this.runAlterMigrations()` 之后）加：

```typescript
this.runAlterMigrations()
this.backfillRoomIds()  // F022 Phase 1: 历史 session 回填
// 回填后建 UNIQUE 索引（此时所有非 NULL roomId 已唯一）
this.db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_groups_room_id ON session_groups(room_id);"
)
```

**Step 4: 跑测试确认通过**

Run: `pnpm --filter @multi-agent/api test --test-name-pattern "F022"`
Expected: 全部 F022 用例 PASS

再跑全量：`pnpm --filter @multi-agent/api test`
Expected: 全绿

**Step 5: Commit**

```bash
git add packages/api/src/db/sqlite.ts packages/api/src/db/**/*.test.ts
git commit -m "feat(F022-P1): 历史 session 按 createdAt 升序回填 roomId（幂等 + UNIQUE index）"
```

---

## Task 5: 集成验收

**Files:** 无改动；仅验证。

**Step 1: 全量 typecheck + test**

```bash
pnpm --filter @multi-agent/api typecheck
pnpm --filter @multi-agent/api test
```
Expected: 两者全绿

**Step 2: 对现有 dev DB 做一次实跑（不删数据）**

```bash
pnpm --filter @multi-agent/api dev  # 或正常启动方式
```
然后用 sqlite CLI 或 repo script 查：

```sql
SELECT id, room_id, title, created_at FROM session_groups ORDER BY created_at ASC LIMIT 10;
```

Expected:
- 每行都有 `room_id` 非 NULL
- 按 `created_at` 升序看，room_id 从 R-001 递增
- 无重复 roomId

**Step 3: 创建一个新 session 验证 AC-01**

从 UI 或 API 新建一个 session，再查 DB：

```sql
SELECT room_id, title FROM session_groups ORDER BY created_at DESC LIMIT 1;
```

Expected: 新行的 room_id = `R-{MAX+1}`

**Step 4: 文档同步 + 最终 commit（如有）**

在 F022 feature doc 的 Timeline 加一行：

```markdown
| 2026-04-19 | Phase 1 完成（ROOM ID 生成 + 回填）|
```

并在 Phase 1 AC 列表打勾 AC-01 ~ AC-04。

```bash
git add docs/features/F022-left-sidebar-redesign.md
git commit -m "docs(F022): Phase 1 完成标记（AC-01~04 ✅）"
```

---

## Verification Matrix（交付前自查）

| AC | 验证方法 | Pass 条件 |
|----|---------|-----------|
| AC-01 新建递增 | Task 3 测试 + Task 5 手动 | 连续创建返回 R-N, R-N+1 |
| AC-02 持久化 | Task 3 测试（getSessionGroupById 读到） | roomId 非 null 写入 DB |
| AC-03 历史回填 | Task 4 三个测试 + Task 5 SQL 查 | 旧库按 createdAt 升序拿到 R-xxx |
| AC-04 全局唯一 | UNIQUE index + Task 4 "混合数据" 测试 | 无重复；跨 projectTag 共享序号 |

## Out of Scope（显式不做）

- ❌ UI 显示 roomId（sidebar / header / 徽章）→ Phase 3/4
- ❌ Haiku 命名 → Phase 2
- ❌ 搜索支持 `R-042` 直跳 → Phase 3
- ❌ `listSessionGroups` 返回类型的 Frontend 侧消费 → Phase 3（本 Plan 已在 repo 层透传 roomId，Frontend 类型不变）

## 下一步

Plan done → **worktree 创建隔离环境** → **tdd 执行 Task 1~5** → **quality-gate 自检** → **acceptance-guardian 独立验收**。
