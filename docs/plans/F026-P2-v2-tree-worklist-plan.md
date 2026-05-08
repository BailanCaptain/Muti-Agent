---
plan: F026-P2-v2-tree-worklist
feature: F026
status: drafted
created: 2026-05-05
supersedes:
  - F026-P2-clean-cut-plan.md（仅 Step 1 替换；Step 2-8 删除清单引用不动）
---

# F026 P2 v2 — 树形 Worklist 收敛模型 Implementation Plan

**Feature:** F026 — `docs/features/F026-a2a-reliability-layer.md`
**Goal:** 把 1B 阶段的"平表 worklist + child finished 即 settle"模型替换成"树形 worklist + drain-based settle"，让 A→B→C 多层接力链能自然收敛回最顶层 user-root，而不是在 B 层断链。
**Acceptance Criteria（从 F026 spec + Round 2 拍板抄过来）：**
- [ ] **AC-Tree-1（核心）**：A→B→C 链路实测 — `user @ 黄仁勋 找范德彪 review 后让桂芬出图`：黄仁勋 → 范德彪 → 黄仁勋 → 桂芬 → 黄仁勋整合 reply 给 user。最终 a2a_calls 树根为 user-root，叶子全 done，中间 worklist 全 settled。**与 v1 平表实现的关键差别：B 在续推时若再派 grandchild C，A 的 worklist 不会过早 settle，C 的回复能传回 A**。
- [ ] **AC-Tree-2**：A→B→A 单层链路（相当于 v1 的 R-080 场景）继续实测过：黄仁勋 [Call: @桂芬] → 桂芬答 → 黄仁勋整合 reply 给 user。
- [ ] **AC-Tree-3**：用户多 @ + 嵌套（A 派 [B, C]，C 又派 D）：A 的 worklist 等 B done **且** C 的子 worklist (含 D) 全 drain 后才 settle。
- [ ] **AC-Tree-4**：进程重启鲁棒 — 任意时刻 kill API 后重启，rehydrate 能从 a2a_worklists 表恢复 tree 结构 + 未 settle 的子树继续 cascade。
- [ ] **AC-Tree-5（继承自 v1 DoD-A）**：`grep -r "planReturnPathDispatchWithFlag\|isCallTreeEnabled" packages/` = 0（Step 2 删除任务保留，引用 v1 plan）。
- [ ] **AC-Tree-6**：全套测试绿（`pnpm --filter @multi-agent/api test` + `pnpm --filter components test`）。

**不在本 plan 范围（明确）：**
- Step 2-8（删除 return-path / parallel-group / parallel_think / DiscussionCoordinator / collapsible-group / a2a_handoff 产出 / skill 文档收尾）— **不动**，照搬 `F026-P2-clean-cut-plan.md` Step 2-8 序列。本 plan 只重做 Step 1。
- F003 旧 return-path 双轨保留还是删 — 旧 plan 已拍板"删"。本 plan 的 Step 1 完成 + 实测 chain 接通后，下一步直接进 v1 plan 的 Step 2 删 return-path。

**Architecture：** 把 `a2a_worklists` 表加 `parent_worklist_id` 列变成自引用树（同构于 `a2a_calls` 的 parent_call_id）。settle 不再是 child finished 时直接进，而是走 `tryCascadeSettle(worklistId)`：检查自身 items 全 done **且** 子 worklist 全 settled — 满足才 settle，settle 时再向上递归 `tryCascadeSettle(parentWorklistId)`。续推派发只在 worklist 真 settle 那一刻、且 worklist 有 parent thread 时触发（中间层 settle 时它的 parent agent 还在 invocation 内，不需要被续推；它会在自己 finished 时由 cascade 自然推进）。

**Tech Stack：** TypeScript / Node.js test runner（`node:test`）/ `node:sqlite` / 已有 `CallRegistry` + `A2ALifecycleService`（不动）/ `WorklistRegistry` + `WorklistExecutor`（重做）

---

## Pin Finish Line

**B = 接力链 A→B→C→…→Leaf 的 reply 在 chain 完整 drain 后由最顶层 agent 整合给 user。中间任何一层 child 在 reply 里继续派 grandchild，上层都不会过早 settle。**

判定 B 达成的客观证据（worktree preview 实测）：
1. 跑场景 4（接力：`@黄仁勋 找范德彪 review 后让桂芬出图`），DB 查 `SELECT * FROM a2a_worklists WHERE root_call_id = ?`，应有 ≥ 2 条 worklist（黄仁勋 root level + 黄仁勋接力时的 grandchild level），全 status='settled'。
2. 黄仁勋的 final reply（user 看见的那一条）在 messages 表有且仅有一条（不是接力中途漏出的半成品）。
3. user-root call 的 status='done'，叶子（桂芬）的 reply 时间戳早于黄仁勋 final reply 时间戳。

**Terminal Schema（树形 worklist 的最终形态）**：

```sql
CREATE TABLE IF NOT EXISTS a2a_worklists (
  worklist_id        TEXT PRIMARY KEY,
  parent_worklist_id TEXT,                          -- ★ NEW · NULL = root worklist
  parent_call_id     TEXT NOT NULL,                  -- 派发者 agent 的 call_id（树形不变）
  root_call_id       TEXT NOT NULL,                  -- 整棵 call tree 的根（树形不变）
  session_group_id   TEXT NOT NULL,
  items              TEXT NOT NULL,                  -- JSON: WorklistItem[] (alias + status)
  current_index      INTEGER NOT NULL DEFAULT 0,     -- 兼容指标，不再是决策依据
  status             TEXT NOT NULL CHECK(status IN ('active','settled')),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (parent_worklist_id) REFERENCES a2a_worklists(worklist_id)
);

CREATE INDEX IF NOT EXISTS idx_a2a_worklists_parent_worklist
  ON a2a_worklists(parent_worklist_id);
CREATE INDEX IF NOT EXISTS idx_a2a_worklists_parent_call_active
  ON a2a_worklists(parent_call_id, status);
CREATE INDEX IF NOT EXISTS idx_a2a_worklists_root_status
  ON a2a_worklists(root_call_id, status);
```

```typescript
// worklist-registry.ts terminal types
export interface WorklistRow {
  worklistId: string
  parentWorklistId: string | null    // ★ NEW
  parentCallId: string
  rootCallId: string
  sessionGroupId: string
  items: WorklistItem[]
  currentIndex: number
  status: 'active' | 'settled'
  createdAt: string
  updatedAt: string
}

export interface WorklistRegisterInput {
  worklistId?: string
  parentWorklistId: string | null    // ★ NEW · 调用方必传（root 时传 null）
  parentCallId: string
  rootCallId: string
  sessionGroupId: string
  items: WorklistItem[]
}
```

**唯一 settle 不变量**：

```typescript
// 一条规则定义所有：worklist 可 settle ⟺ 自己 items 全 done 且子 worklist 全 settled
export function canSettle(self: WorklistRow, children: WorklistRow[]): boolean {
  const itemsAllDone = self.items.every((it) => it.status === 'done')
  const childrenAllSettled = children.every((c) => c.status === 'settled')
  return itemsAllDone && childrenAllSettled
}
```

---

## Design Decisions（v2 锁定 · 跟 v1 关键差异）

| 决策 | v1 平表 | v2 树形 | 理由 |
|---|---|---|---|
| settle 不变量 | items 全 done | items 全 done **且** 子 worklist 全 settled | 多层接力 child reply 写 [Call:@grandchild] 时 v1 会过早 settle 上层；v2 自然延后 |
| schema 变化 | 平表无父字段 | 加 `parent_worklist_id` 自引用 | 跟 `a2a_calls.parent_call_id` 同构 |
| onChildFinished 路径 | mark item done → 立即 settle 自身 | mark item done → tryCascadeSettle(self) → 满足条件 settle → tryCascadeSettle(parent) | 树 bottom-up 自然展开 |
| 续推派发触发点 | worklist settle 即派 | **只在 root worklist settle 时派**（root = parent_worklist_id IS NULL） | 中间层 settle 时父 agent 还在 invocation 内，不需要被续推；root settle 才意味整棵树 drain 完 |
| sibling-guard | a2a-gateway 拦截 [Call: @sibling]（v1 1B.7 引入 + 1B.8 修 race） | **不需要** — 树形下 sibling 自然由父 worklist 等待 | 删除整套 sibling-guard 逻辑（不出现在 v2 实现里） |
| relay-aware（B reply 含 [Call:@A]） | v1 1B.6 Fix-3 跳续推让 mention dispatch 接管 | **保留** — 跟树形不冲突 | A 收到 [Call:@A] 后会跑新一轮 turn，自然连进树 |
| ParallelGroup（用户多 @） | v1 仍走 Phase 1 fan-out | **每个 mention 各自一棵子树，root_call_id 共享 user-root** | 用户多 @ = root worklist 含 N 个 items；每个 child reply 中的 [Call:] 各自挂自己的子 worklist |
| Migration 兼容 | — | 新加 column 走 schema migration; 老 worklist 行 parent_worklist_id 默认 NULL（被当 root） | 不破坏 P3-P5 历史数据 |

---

## Task 0 · 仓库准备 + Spike

**Files:** 无（仅工作流）

**Step 0.1 — 当前状态**

worktree `.worktrees/F026-p0` 分支 `feat/F026-p0-a2a-stabilize`，HEAD `a2390c5`：
- `c716020` 1A.1 + 1A.2（call tree 入口 wire）— 保留
- `2723292` 1A.2 replyTo 修补（抢救 1）
- `754f380` R-085 跨房间限流（抢救 2）
- `a2390c5` R-088 DiscussionCoordinator empty_summary（抢救 3）

baseline：3 个抢救 commit 都过 pre-commit hook 全套测试。

**Step 0.2 — Spike（限时 30 分钟）：核现有 a2a_calls schema 是不是真的有 parent_call_id 自引用，把 worklist 树形跟它同构当 reference**

```bash
grep -n "parent_call_id\|root_call_id" .worktrees/F026-p0/packages/api/src/orchestrator/call-registry.ts | head -10
```

预期：a2a_calls 已经是自引用树（CREATE TABLE 含 parent_call_id 外键 + root_call_id）。这就是 worklist 树形要照抄的形态。

**产出**：决策 — schema migration 方法（add column + index）跟 a2a_calls 同款，无需创新；本 Spike 完成即可关。

---

## Task 1 · Schema migration · 加 parent_worklist_id

**Files:**
- Modify: `packages/api/src/db/sqlite.ts`（INIT_SQL `a2a_worklists` 表定义 — 新建库）
- Create: `packages/api/src/db/a2a-worklists-tree-migration.ts`（老库迁移脚本，跟 `agent-events-nullable-migration.ts` 同款风格）
- Create: `packages/api/src/db/a2a-worklists-tree-migration.test.ts`

**Step 1.1 — 写失败测试：老库 add column + index**

```typescript
// a2a-worklists-tree-migration.test.ts
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { applyA2AWorklistsTreeMigration } from "./a2a-worklists-tree-migration"

describe("a2a_worklists tree migration", () => {
  it("adds parent_worklist_id column to existing table", () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`CREATE TABLE a2a_worklists (
      worklist_id TEXT PRIMARY KEY,
      parent_call_id TEXT NOT NULL,
      root_call_id TEXT NOT NULL,
      session_group_id TEXT NOT NULL,
      items TEXT NOT NULL,
      current_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('active','settled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)

    applyA2AWorklistsTreeMigration(db)

    const cols = db.prepare("PRAGMA table_info(a2a_worklists)").all() as Array<{name: string}>
    assert.ok(cols.some((c) => c.name === "parent_worklist_id"), "parent_worklist_id column added")

    const indexes = db.prepare("PRAGMA index_list(a2a_worklists)").all() as Array<{name: string}>
    assert.ok(
      indexes.some((i) => i.name === "idx_a2a_worklists_parent_worklist"),
      "idx_a2a_worklists_parent_worklist created",
    )
  })

  it("is idempotent — applying twice is safe", () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`CREATE TABLE a2a_worklists (worklist_id TEXT PRIMARY KEY, parent_call_id TEXT NOT NULL, root_call_id TEXT NOT NULL, session_group_id TEXT NOT NULL, items TEXT NOT NULL, current_index INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('active','settled')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    applyA2AWorklistsTreeMigration(db)
    applyA2AWorklistsTreeMigration(db) // 第二次不应抛错
    // 列只有一份
    const cols = db.prepare("PRAGMA table_info(a2a_worklists)").all() as Array<{name: string}>
    const parentCols = cols.filter((c) => c.name === "parent_worklist_id")
    assert.equal(parentCols.length, 1)
  })
})
```

**Step 1.2 — 跑测试确认失败**

```bash
cd .worktrees/F026-p0 && pnpm tsx --test packages/api/src/db/a2a-worklists-tree-migration.test.ts
```

预期：FAIL（applyA2AWorklistsTreeMigration is not exported）

**Step 1.3 — 写最小实现**

```typescript
// a2a-worklists-tree-migration.ts
import type { DatabaseSync } from "node:sqlite"

/**
 * F026 P2 v2 · 给老库 a2a_worklists 表加 parent_worklist_id 列（自引用树）。
 * 幂等：重复调用安全（先 PRAGMA 查列是否存在）。
 */
export function applyA2AWorklistsTreeMigration(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(a2a_worklists)").all() as Array<{name: string}>
  const hasParentCol = cols.some((c) => c.name === "parent_worklist_id")
  if (!hasParentCol) {
    db.exec("ALTER TABLE a2a_worklists ADD COLUMN parent_worklist_id TEXT")
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_a2a_worklists_parent_worklist ON a2a_worklists(parent_worklist_id)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_a2a_worklists_root_status ON a2a_worklists(root_call_id, status)")
}
```

**Step 1.4 — 跑测试确认通过**

```bash
pnpm tsx --test packages/api/src/db/a2a-worklists-tree-migration.test.ts
```

预期：PASS（2 测试）

**Step 1.5 — 把新建库 INIT_SQL 同步**

`packages/api/src/db/sqlite.ts` `a2a_worklists` 建表 SQL 加 `parent_worklist_id TEXT` 字段 + 两条 CREATE INDEX。

**Step 1.6 — 在 server 启动 wire 调 migration**

```typescript
// server.ts (a2a_worklists migration 调用点附近)
import { applyA2AWorklistsTreeMigration } from "./db/a2a-worklists-tree-migration"
// ... 已有的 schema migration 序列后面
applyA2AWorklistsTreeMigration(db)
```

**Step 1.7 — Commit**

```bash
git add packages/api/src/db/a2a-worklists-tree-migration.ts packages/api/src/db/a2a-worklists-tree-migration.test.ts packages/api/src/db/sqlite.ts packages/api/src/server.ts
git commit -m "feat(F026 P2 v2 T1): a2a_worklists schema 加 parent_worklist_id 自引用 [黄仁勋/Opus-47 🐾]"
```

---

## Task 2 · WorklistRegistry 重做 · 树形 register + 树形查询

**Files:**
- Create: `packages/api/src/orchestrator/worklist-registry.ts`（新写，覆盖旧文件 — 旧文件已被 reset 删除，这里重做）
- Create: `packages/api/src/orchestrator/worklist-registry.test.ts`

**Step 2.1 — 写失败测试：register 必传 parentWorklistId（含 null）+ findChildWorklists**

```typescript
// worklist-registry.test.ts
import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { WorklistRegistry } from "./worklist-registry"
import { applyA2AWorklistsTreeMigration } from "../db/a2a-worklists-tree-migration"

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:")
  // 简化版建表（生产用 INIT_SQL，测试只建 a2a_worklists）
  db.exec(`CREATE TABLE a2a_worklists (
    worklist_id TEXT PRIMARY KEY,
    parent_call_id TEXT NOT NULL,
    root_call_id TEXT NOT NULL,
    session_group_id TEXT NOT NULL,
    items TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('active','settled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  applyA2AWorklistsTreeMigration(db)
  return db
}

describe("WorklistRegistry tree", () => {
  it("register root worklist with parentWorklistId=null", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const row = r.get(id)
    assert.ok(row)
    assert.equal(row?.parentWorklistId, null)
  })

  it("register child worklist with parentWorklistId pointing to existing root", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const rootId = r.register({
      parentWorklistId: null,
      parentCallId: "call-A",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "桂芬", status: "pending" }],
    })
    const childId = r.register({
      parentWorklistId: rootId,
      parentCallId: "call-B",
      rootCallId: "call-root",
      sessionGroupId: "sg-1",
      items: [{ alias: "范德彪", status: "pending" }],
    })
    const child = r.get(childId)
    assert.equal(child?.parentWorklistId, rootId)
  })

  it("findChildWorklists returns all worklists with parent_worklist_id = self", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const rootId = r.register({
      parentWorklistId: null, parentCallId: "call-A", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "桂芬", status: "pending"}, {alias: "范德彪", status: "pending"}],
    })
    const child1 = r.register({
      parentWorklistId: rootId, parentCallId: "call-B-桂芬", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "X", status: "pending"}],
    })
    const child2 = r.register({
      parentWorklistId: rootId, parentCallId: "call-B-范德彪", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "Y", status: "pending"}],
    })
    const children = r.findChildWorklists(rootId)
    assert.equal(children.length, 2)
    assert.deepEqual(children.map((c) => c.worklistId).sort(), [child1, child2].sort())
  })
})
```

**Step 2.2 — 跑测试确认失败**

```bash
pnpm tsx --test packages/api/src/orchestrator/worklist-registry.test.ts
```

预期：FAIL（WorklistRegistry / findChildWorklists 未导出）

**Step 2.3 — 实现 register + get + findChildWorklists**

完整 `worklist-registry.ts` 骨架（关键方法 — 完整代码 TDD 中迭代补全）：

```typescript
// worklist-registry.ts
import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { WorklistItem, WorklistItemStatus } from "./worklist-advance"

export type WorklistStatus = "active" | "settled"

export interface WorklistRegisterInput {
  worklistId?: string
  parentWorklistId: string | null   // ★ NEW · null = root worklist
  parentCallId: string
  rootCallId: string
  sessionGroupId: string
  items: WorklistItem[]
}

export interface WorklistRow {
  worklistId: string
  parentWorklistId: string | null   // ★ NEW
  parentCallId: string
  rootCallId: string
  sessionGroupId: string
  items: WorklistItem[]
  currentIndex: number
  status: WorklistStatus
  createdAt: string
  updatedAt: string
}

export interface WorklistRegistryOptions {
  db: DatabaseSync
  now?: () => string
  newId?: () => string
}

export class WorklistRegistry {
  private readonly db: DatabaseSync
  private readonly now: () => string
  private readonly newId: () => string

  constructor(options: WorklistRegistryOptions) {
    this.db = options.db
    this.now = options.now ?? (() => new Date().toISOString())
    this.newId = options.newId ?? (() => `worklist-${randomUUID()}`)
  }

  register(input: WorklistRegisterInput): string {
    if (!input.parentCallId) throw new Error("WorklistRegistry.register: parentCallId required")
    if (!input.rootCallId) throw new Error("WorklistRegistry.register: rootCallId required")
    if (!input.sessionGroupId) throw new Error("WorklistRegistry.register: sessionGroupId required")
    if (!input.items || input.items.length === 0) {
      throw new Error("WorklistRegistry.register: items must be non-empty")
    }
    // parentWorklistId 可以是 null（root），但必须显式传 — 调用方意图明确

    const worklistId = input.worklistId ?? this.newId()
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO a2a_worklists (
          worklist_id, parent_worklist_id, parent_call_id, root_call_id, session_group_id,
          items, current_index, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
      )
      .run(
        worklistId,
        input.parentWorklistId,            // ★ NEW
        input.parentCallId,
        input.rootCallId,
        input.sessionGroupId,
        JSON.stringify(input.items),
        now,
        now,
      )
    return worklistId
  }

  get(worklistId: string): WorklistRow | null { /* SELECT * + toWorklistRow */ }

  /** ★ NEW · 找所有 parent_worklist_id = self 的子 worklist（按 created_at ASC）。 */
  findChildWorklists(parentWorklistId: string): WorklistRow[] { /* ... */ }

  /** ★ NEW · 反查 a2a_calls 树根对应的 root worklist（parent_worklist_id IS NULL）。 */
  findRootByCallTree(rootCallId: string): WorklistRow | null { /* ... */ }

  // 已有方法保留：markItemStatus / advanceIndex / settle / findActiveByParentCallId / findByParentCallId
}
```

`toWorklistRow` 把 `parent_worklist_id` 列读出来（NULL → JS `null`）。

**Step 2.4 — 跑测试确认通过**

预期：3 测试 PASS。

**Step 2.5 — Commit**

```bash
git add packages/api/src/orchestrator/worklist-registry.ts packages/api/src/orchestrator/worklist-registry.test.ts
git commit -m "feat(F026 P2 v2 T2): WorklistRegistry register/get/findChildWorklists 树形支持 [黄仁勋/Opus-47 🐾]"
```

---

## Task 3 · cascade settle 不变量实现

**Files:**
- Modify: `packages/api/src/orchestrator/worklist-registry.ts`（加 `tryCascadeSettle`）
- Modify: `packages/api/src/orchestrator/worklist-registry.test.ts`

**Step 3.1 — 写失败测试：tryCascadeSettle 三个核心场景**

```typescript
describe("WorklistRegistry tryCascadeSettle", () => {
  it("settles self when items all done AND no children", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const id = r.register({
      parentWorklistId: null, parentCallId: "call-A", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "桂芬", status: "pending"}],
    })
    r.markItemStatus(id, 0, "done")
    const result = r.tryCascadeSettle(id)
    assert.equal(result.settled.length, 1)
    assert.equal(result.settled[0], id)
    assert.equal(r.get(id)?.status, "settled")
  })

  it("does NOT settle when items all done but has active child worklist", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const parentId = r.register({
      parentWorklistId: null, parentCallId: "call-A", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "桂芬", status: "pending"}],
    })
    // 桂芬 reply 时又派了 grandchild → 注册 child worklist
    r.register({
      parentWorklistId: parentId, parentCallId: "call-B-桂芬", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "范德彪", status: "pending"}],
    })
    r.markItemStatus(parentId, 0, "done") // 桂芬 invocation 完成
    const result = r.tryCascadeSettle(parentId)
    // 关键差异：v1 平表会立即 settle，v2 树形必须等 child 也 settled
    assert.equal(result.settled.length, 0)
    assert.equal(r.get(parentId)?.status, "active")
  })

  it("cascades up: child settle then parent settle when all conditions met", () => {
    const db = setupDb()
    const r = new WorklistRegistry({ db })
    const parentId = r.register({
      parentWorklistId: null, parentCallId: "call-A", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "桂芬", status: "pending"}],
    })
    const childId = r.register({
      parentWorklistId: parentId, parentCallId: "call-B-桂芬", rootCallId: "call-root",
      sessionGroupId: "sg-1", items: [{alias: "范德彪", status: "pending"}],
    })
    r.markItemStatus(parentId, 0, "done")
    r.markItemStatus(childId, 0, "done")
    // 从叶子触发 cascade
    const result = r.tryCascadeSettle(childId)
    // child + parent 都应被 cascade settle
    assert.deepEqual(result.settled.sort(), [childId, parentId].sort())
  })
})
```

**Step 3.2 — 实现 tryCascadeSettle**

```typescript
// worklist-registry.ts
/**
 * F026 P2 v2 · drain-based cascade settle 不变量。
 *
 * 从给定 worklist 开始 bottom-up 检查：
 *   - 自身 items 全 done 且子 worklist 全 settled → settle 自己 → 递归向上
 *   - 否则停止
 *
 * 返回这次 cascade 实际推进的 settled worklist id 列表（按 settle 顺序，子→父）。
 *
 * 调用方契约：
 *   - 调用前应当已 markItemStatus 把驱动这次推进的 item 标 done。
 *   - cascade 不会触发任何续推派发；那是 executor 层的事，executor 拿到本方法
 *     返回的 settled[] 决定哪个 root settle 触发回调。
 */
tryCascadeSettle(startWorklistId: string): { settled: string[] } {
  const settled: string[] = []
  let cursorId: string | null = startWorklistId

  while (cursorId) {
    const self = this.get(cursorId)
    if (!self) break
    if (self.status !== "active") break
    const itemsAllDone = self.items.every((it) => it.status === "done")
    if (!itemsAllDone) break
    const children = this.findChildWorklists(cursorId)
    const childrenAllSettled = children.every((c) => c.status === "settled")
    if (!childrenAllSettled) break

    const ok = this.settle(cursorId)
    if (!ok) break // CAS race（不太可能；当外层观察）
    settled.push(cursorId)

    cursorId = self.parentWorklistId
  }

  return { settled }
}
```

**Step 3.3 — 测试通过**

3 测试 PASS。

**Step 3.4 — Commit**

```bash
git add packages/api/src/orchestrator/worklist-registry.ts packages/api/src/orchestrator/worklist-registry.test.ts
git commit -m "feat(F026 P2 v2 T3): tryCascadeSettle drain-based 不变量 [黄仁勋/Opus-47 🐾]"
```

---

## Task 4 · WorklistExecutor 重做 · registerForDispatch 透 parentWorklistId

**Files:**
- Create: `packages/api/src/services/worklist-executor.ts`（新写）
- Create: `packages/api/src/services/worklist-executor.test.ts`

**Step 4.1 — 写失败测试：registerForDispatch 自动反查 parentWorklistId**

调用方 message-service.ts 在 enqueue mention 后调 `registerForDispatch`。executor 需要从 dispatch 上下文反查"派发者 agent (parent_call_id 对应) 当前是不是某个 worklist 的 child"——是 → 新 worklist 挂在那个 worklist 下；否 → root worklist (parentWorklistId=null)。

反查逻辑：派发者 = `parentCallId` 对应 a2a_calls 行的 issuer 在哪个 worklist 的 items 里出现。等价于：从 `parentCallId` 反查它的 `parent_call_id`（grandparent call），找 grandparent_call 对应的 active worklist — 找到 → 它就是新 worklist 的 parentWorklist。

```typescript
describe("WorklistExecutor registerForDispatch tree", () => {
  it("registers root worklist when no parent worklist exists for the dispatcher", () => {
    // user → A 派发：A 还没在任何 worklist 里 → 新 worklist 挂 root（parentWorklistId=null）
    // ... 测试用 mock CallRegistry 摆 a2a_calls 行
  })

  it("registers child worklist when dispatcher is itself in an active worklist", () => {
    // A → B → A reply [Call: @C]：
    // B 完成后 A 续推 reply 含 [Call:@C]，派发 C 时 dispatcher=A，A 当前在 user-root worklist 的 item 里
    // 新 C worklist 应挂 user-root worklist 下（parentWorklistId=user-root-worklist-id）
  })
})
```

**Step 4.2 — 实现 registerForDispatch**

关键查询：

```typescript
registerForDispatch(input: {
  parentCallId: string | null | undefined  // 派发者 agent 的 call_id
  sessionGroupId: string
  queued: ReadonlyArray<QueueEntry>
}): string | null {
  if (!input.parentCallId) return null
  if (input.queued.length === 0) return null

  const callRow = this.callRegistry.get(input.parentCallId)
  if (!callRow) return null
  const rootCallId = callRow.rootCallId

  // ★ NEW · 反查 parentWorklistId：派发者 agent 是否当前是某个 worklist 的 item？
  // 等价于：找 grandparent_call_id 对应的 active worklist
  let parentWorklistId: string | null = null
  if (callRow.parentCallId) {
    const grandparentWorklist = this.registry.findActiveByParentCallId(callRow.parentCallId)
    parentWorklistId = grandparentWorklist?.worklistId ?? null
  }

  const items: WorklistItem[] = input.queued.map((entry) => ({
    alias: entry.to.agentId,
    status: "pending",
  }))

  return this.registry.register({
    parentWorklistId,  // ★ NEW
    parentCallId: input.parentCallId,
    rootCallId,
    sessionGroupId: input.sessionGroupId,
    items,
  })
}
```

**Step 4.3 — 测试通过 + Commit**

```bash
git add packages/api/src/services/worklist-executor.ts packages/api/src/services/worklist-executor.test.ts
git commit -m "feat(F026 P2 v2 T4): WorklistExecutor.registerForDispatch 反查 parentWorklistId [黄仁勋/Opus-47 🐾]"
```

---

## Task 5 · onChildFinished 走 cascade · 只在 root settle 时派续推

**Files:**
- Modify: `packages/api/src/services/worklist-executor.ts`
- Modify: `packages/api/src/services/worklist-executor.test.ts`

**Step 5.1 — 写失败测试：3 个核心场景**

```typescript
describe("WorklistExecutor.onChildFinished cascade", () => {
  it("multi-layer chain: A→B→C does NOT trigger A continuation when B finishes (B has child worklist)", () => {
    // 1) A 派 [Call:@B] → root worklist {items:[B], parentWL=null}
    // 2) B 跑完前自己又派 [Call:@C] → child worklist {items:[C], parentWL=root}
    // 3) B finished → onChildFinished(B_call)
    //    断言：onDoneContinuation NOT called（root worklist 还有 active child）
    //    断言：root worklist status 仍 active
  })

  it("multi-layer chain: when C also finishes, cascade settles child then root, only root triggers continuation", () => {
    // 续上：C finished → onChildFinished(C_call)
    //   断言：cascade settle child (C 那条) → 再 cascade settle root
    //   断言：onDoneContinuation called 一次（且参数是 root worklist，不是 child worklist）
  })

  it("middle worklist settle does NOT trigger continuation (only root does)", () => {
    // 同上场景，断言中间层 settle 不触发 cb，只有 root settle 触发
  })
})
```

**Step 5.2 — 实现 onChildFinished cascade 路径**

```typescript
onChildFinished(input: {
  childCallId: string | null | undefined
  childAlias?: string | null | undefined
  childContent: string
  ok: boolean
  continuationContext?: unknown
}): { decision: "halted" | "advanced" | "settled" | "noop"; rootSettled: boolean } | null {
  if (!input.childCallId) return null

  const childRow = this.callRegistry.get(input.childCallId)
  if (!childRow) return null
  const parentCallId = childRow.parentCallId
  if (!parentCallId) return null

  const worklist = this.registry.findActiveByParentCallId(parentCallId)
  if (!worklist) return null

  // 反查 alias 对应 idx（保留 1B.6 Fix-1）
  let completedIndex: number
  if (input.childAlias) {
    const found = worklist.items.findIndex((it) => it.alias === input.childAlias)
    completedIndex = found >= 0 ? found : worklist.currentIndex
  } else {
    completedIndex = worklist.currentIndex
  }

  // 标 done / failed
  const itemStatus: WorklistItemStatus =
    !input.ok || (input.childContent ?? "").trim().length === 0 ? "failed" : "done"
  this.registry.markItemStatus(worklist.worklistId, completedIndex, itemStatus)

  // failed 路径：直接 settle（halt 语义保留）— v2 也保留这个，failed 不等 grandchild
  if (itemStatus === "failed") {
    this.registry.settle(worklist.worklistId)
    return { decision: "halted", rootSettled: false }
  }

  // ★ NEW · cascade 路径 · v2 核心
  const cascadeResult = this.registry.tryCascadeSettle(worklist.worklistId)
  if (cascadeResult.settled.length === 0) {
    return { decision: "advanced", rootSettled: false }
  }

  // 只在 root worklist (parentWorklistId IS NULL) settle 时触发续推
  for (const settledId of cascadeResult.settled) {
    const settled = this.registry.get(settledId)
    if (!settled) continue
    if (settled.parentWorklistId !== null) continue  // 中间层 settle 不派续推

    if (this.onDoneContinuation && !this.shouldSkipContinuationAsRelay(settled.parentCallId, input.childContent ?? "")) {
      const childAliases = settled.items.map((it) => it.alias).filter((a) => a && a.length > 0)
      try {
        this.onDoneContinuation({
          worklist: settled,
          childAliases,
          parentCallId: settled.parentCallId,
          continuationContext: input.continuationContext,
        })
      } catch (err) {
        this.log.warn({ err }, "onDoneContinuation cb threw — swallow")
      }
    }
  }

  return { decision: "settled", rootSettled: true }
}
```

**Step 5.3 — 测试通过 + Commit**

```bash
git add packages/api/src/services/worklist-executor.ts packages/api/src/services/worklist-executor.test.ts
git commit -m "feat(F026 P2 v2 T5): onChildFinished cascade · 只 root settle 派续推 [黄仁勋/Opus-47 🐾]"
```

---

## Task 6 · Wire 到 message-service · 沿用 1A 入口 + 接续推

**Files:**
- Modify: `packages/api/src/services/message-service.ts`（接 worklistExecutor.registerForDispatch + onChildFinished + onDoneContinuation 派发）
- Modify: `packages/api/src/server.ts`（构造 worklistExecutor 时透 callRegistry + worklistRegistry）

**Step 6.1 — Spike：把 v1 1B.2/1B.3/1B.4 wire 点找出来照抄**

由于 1A.1 + 1A.2 已经把 user-root call 建好 + dispatchedCallId 透传，wire 点跟 v1 一样：
- `enqueuePublicMentions` 后调 `registerForDispatch`
- `invocation.finished` 后调 `onChildFinished`
- `setOnDoneContinuation(cb)` 注入续推派发回调

参考旧 commit `16538c1` / `defdd2e` / `e1ff7b4`（已 reset，但 git show 能看）。

**Step 6.2 — 写失败测试：chain e2e replay (R-080 风格 单层)**

抄 v1 测试 `R-080-style-single-mention-continuation.test.ts`（v1 e6f2166 引入），调整 register 入参带 parentWorklistId=null（root）。

```typescript
// __tests__/a2a-replay/F026-v2-single-layer-continuation.test.ts
describe("F026 v2 · single-layer chain user@A → A [Call:@B] → B done → A 续推", () => {
  it("registers root worklist with parentWorklistId=null, settles on B done, triggers continuation", () => {
    // ... 单层场景断言：只一个 root worklist + 它 settle 时触发 continuation
  })
})
```

**Step 6.3 — 实现 wire（message-service.ts）**

注入续推派发回调（沿用 v1 `dispatchWorklistContinuation` 的合成函数 — 它本身跟"平表 vs 树形"无关，只关心 prompt 合成）：

```typescript
// message-service.ts (服务构造时)
this.worklistExecutor.setOnDoneContinuation(({ worklist, childAliases, parentCallId, continuationContext }) => {
  const ctx = continuationContext as { emit: EmitEvent; rootMessageId: string } | undefined
  if (!ctx) return
  void this.dispatchWorklistContinuation({
    worklist,
    childAliases,
    parentCallId,
    emit: ctx.emit,
    rootMessageId: ctx.rootMessageId,
  })
})

// invocation.finished 块后追加 (照抄 v1 message-service.ts:2057-2079)：
this.worklistExecutor?.onChildFinished({
  childCallId: options.dispatchedCallId ?? null,
  childAlias: thread.alias,
  childContent: accumulatedContent,
  ok: result.exitCode === 0 && !dispatchRetryExhausted,
  continuationContext: { emit: options.emit, rootMessageId: options.rootMessageId },
})

// enqueuePublicMentions 块后追加 (照抄 v1 message-service.ts:2115-2119)：
this.worklistExecutor?.registerForDispatch({
  parentCallId: options.dispatchedCallId ?? null,
  sessionGroupId: thread.sessionGroupId,
  queued: enqueueResult.queued,
})
```

**Step 6.4 — 实现 dispatchWorklistContinuation（沿用 v1 buildWorklistContinuationPrompt）**

prompt 合成函数 v1 `worklist-continuation.ts:34-54` 是纯函数，跟续推模型无关，**整文件 cherry-pick 回来**：

```bash
git checkout e1ff7b4 -- packages/api/src/orchestrator/worklist-continuation.ts packages/api/src/orchestrator/worklist-continuation.test.ts
```

Verify 拉过来的文件不依赖平表 — `buildWorklistContinuationPrompt` 入参只有 `childAliases: string[]`，纯函数，无依赖。

`dispatchWorklistContinuation` 的派发实现也沿用 v1（在 v1 e1ff7b4 message-service 块），cherry-pick 回来即可。

**Step 6.5 — 测试通过 + Commit**

```bash
git add packages/api/src/services/message-service.ts packages/api/src/server.ts \
        packages/api/src/orchestrator/worklist-continuation.ts \
        packages/api/src/orchestrator/worklist-continuation.test.ts \
        packages/api/src/__tests__/a2a-replay/F026-v2-single-layer-continuation.test.ts
git commit -m "feat(F026 P2 v2 T6): message-service wire worklistExecutor + 续推派发（树形单层 e2e 通） [黄仁勋/Opus-47 🐾]"
```

---

## Task 7 · 多层链路 e2e replay

**Files:**
- Create: `packages/api/src/__tests__/a2a-replay/F026-v2-multi-layer-tree-drain.test.ts`

**Step 7.1 — 写多层链 e2e 测试（关键：v1 平表会 fail，v2 树形必须 pass）**

```typescript
describe("F026 v2 · multi-layer chain · A→B→C drain 收敛", () => {
  it("scenario 4: user@黄仁勋 找范德彪 review 后让桂芬出图 — 收敛回黄仁勋", () => {
    // 1) user 发 "@黄仁勋 找范德彪 review 后让桂芬出图"
    //    → 黄仁勋 user-root worklist {items=[黄仁勋], parentWL=null}（实际：directTurn child call）
    //    更准确：handleSendMessage 入口建 user-root call，黄仁勋是 directTurn child
    //    黄仁勋 reply 含 [Call:@范德彪] → root worklist {items=[范德彪], parentCall=黄仁勋_call, parentWL=null}
    // 2) 范德彪 finished → onChildFinished
    //    黄仁勋 reply 时再次 [Call:@桂芬] → 这里 "再次" 的语义是黄仁勋被续推后又派
    //    更精确：范德彪 done → 续推黄仁勋 → 黄仁勋这次 turn 只 [Call:@桂芬] → 注册新 worklist?
    //    实测断言：tree drain 完后只剩 root worklist settled，user 看到黄仁勋一条 final
  })

  it("scenario 嵌套: A 派 [B,C], C 又派 D — A worklist 等 B done + C 子 worklist (D) drain 后才 settle", () => {
    // 多孩子 + 嵌套
  })

  it("v1 regression check: 同样多层场景下，v1 平表会让 A 在 B finished 时立即 settle 派续推 — v2 不会", () => {
    // 只是 negative case 注释清楚 — 真正断言已在第 1 / 2 个 case 覆盖
  })
})
```

**Step 7.2 — 跑测试（前提：Task 6 wire 通）**

```bash
pnpm --filter @multi-agent/api test -- F026-v2-multi-layer-tree-drain
```

预期：3 测试 PASS（如果不 PASS，回到 Task 3/4/5 修 cascade 逻辑）。

**Step 7.3 — Commit**

```bash
git add packages/api/src/__tests__/a2a-replay/F026-v2-multi-layer-tree-drain.test.ts
git commit -m "test(F026 P2 v2 T7): multi-layer tree drain e2e 3 case [黄仁勋/Opus-47 🐾]"
```

---

## Task 8 · 进程重启 rehydrate

**Files:**
- Modify: `packages/api/src/services/a2a-lifecycle.ts`（rehydrate 时重建 worklistRegistry 已能从 SQL 读 — 因为 schema 持久化）
- Create: `packages/api/src/__tests__/a2a-replay/F026-v2-rehydrate-tree.test.ts`

**Step 8.1 — 写 rehydrate 测试**

```typescript
describe("F026 v2 · process restart rehydrate", () => {
  it("kill -9 mid-chain: tree shape preserved, cascade resumes from leaf", () => {
    // 1) 摆 root worklist + child worklist 都 active 状态写库
    // 2) 重启 (新建 WorklistRegistry 实例指向同 db)
    // 3) 模拟 leaf invocation finished
    // 4) 断言 cascade 正常上升 settle child + root
  })
})
```

**Step 8.2 — 实现：rehydrate 不需要新代码**

worklist 状态全持久化在 `a2a_worklists` 表，新 registry 实例指向同 db 直接能读。F026-P4 P4 T2/T3 已经把 rehydrate 框架做了；这里只验证 tree 数据被正确读出。

**Step 8.3 — 测试通过 + Commit**

```bash
git add packages/api/src/__tests__/a2a-replay/F026-v2-rehydrate-tree.test.ts
git commit -m "test(F026 P2 v2 T8): kill-9 rehydrate 树形 worklist 恢复 cascade [黄仁勋/Opus-47 🐾]"
```

---

## Task 9 · quality-gate

**Step 9.1 — 跑全套测试 + typecheck**

```bash
pnpm --filter @multi-agent/api test 2>&1 | tail -30
pnpm typecheck
pnpm --filter components test 2>&1 | tail -10
```

预期：
- API test 全绿（baseline 1530+ + 新增 ~12 = ~1542+ pass / 0 fail）
- typecheck 0 error
- components test 全绿

**Step 9.2 — grep 确认 v1 sibling-guard / 平表概念已不复存在**

```bash
grep -r "isWorklistSibling\|findActiveByParentCallId" packages/api/src/orchestrator --exclude="*.test.ts"
```

预期：findActiveByParentCallId 仍在（registry 内部 + executor 反查 grandparent 用），isWorklistSibling = 0（v1 sibling-guard 没被抢救，已 reset 后未引入）。

**Step 9.3 — quality-gate skill 跑一遍**

```
/quality-gate
```

输出：spec 合规报告。

---

## Task 10 · acceptance-guardian + 5 场景实测

走 worktree preview，5 场景按 v1 plan §验收场景表实测：
1. R-080 单层（@黄仁勋 帮我叫桂芬评价我爱你这三个字）→ 黄仁勋整合 reply
2. 用户单 @（@桂芬 看视觉）→ 桂芬独立 reply
3. 用户多 @（@桂芬 @范德彪 各自看下方案）→ 两人独立 reply
4. **接力（@黄仁勋 找范德彪 review 后让桂芬出图）→ 多层 chain → 黄仁勋整合 reply** ← v2 关键差别场景
5. 进程重启 → 续推恢复

走 acceptance-guardian skill，留报告。

---

## Task 11 · Step 2-8 删除（引用 v1 plan）

> v1 plan `docs/plans/F026-P2-clean-cut-plan.md` Step 2-8 完整删除清单不重做。本 plan Task 1-10 完成后直接进入 v1 plan Step 2 删 return-path → Step 3 ParallelGroup → Step 4 parallel_think → Step 5 phase2 / discussion-coordinator → Step 6 collapsible-group → Step 7 a2a_handoff 产出 → Step 8 skill 文档收尾。

---

## Verification scenarios（终态客观证据）

每条都需要 worktree preview 实跑 + DB 查证：

| # | 场景 | 期望 | DB 证据 |
|---|---|---|---|
| 1 | R-080 单层 | 黄仁勋整合 reply | `SELECT count(*) FROM a2a_worklists WHERE root_call_id=?` = 1 (root worklist), status='settled' |
| 4 | 接力多层 | 黄仁勋整合 reply（不是中途半成品） | worklist 行数 ≥ 2，全 settled；max(settled_at) 那条 parent_worklist_id IS NULL |
| 嵌套 | A 派 [B,C], C 又派 D | A 等 B done + D drain | A worklist 在 B done 后**仍 active**，D done 后才 cascade 到 A settle |
| 重启 | mid-chain kill -9 | rehydrate 后 tree 完整 | 重启前后 `SELECT * FROM a2a_worklists` 行数 + parent_worklist_id 关系一致 |

---

## 风险

1. **Cascade 死循环**：parentWorklistId 形成环（不应该出现，但要 guard）— 实现 tryCascadeSettle 时加 visited set，超过深度 50 强制 break + log.warn。
2. **CAS 竞争**：两条并发 cascade 在中间层撞 settle CAS 失败 — settle CAS 是幂等的（status active→settled 单向），失败的那条直接 break，不会破坏一致性。
3. **Migration 失败**：老库 ALTER TABLE 在生产数据上抛错 — Step 1.5 的幂等性测试覆盖；上线前 worktree DB 跑过一次。
4. **续推重复触发**：两个 invocation 同时触发 cascade 都到达 root — onDoneContinuation 在 root settle 这一帧只可能由其中一个 cascade 推到底（CAS 保护），另一个的 settled[] 里 root 不会包含。

---

## Out of Scope（v2 不解决）

- F003 旧 return-path 删除（v1 Step 2，本 plan 完成后做）
- ParallelGroup 删除（v1 Step 3）
- DiscussionCoordinator 套件删除（v1 Step 5）— v2 只 carry over 了 R-088 empty_summary 短路修补，整套删除留 v1 Step 5
- collapsible-group / a2a_handoff 产出 / skill 文档（v1 Step 6/7/8）

---

## 工时预估

| Task | 预估 |
|---|---|
| Task 0 仓库准备 + Spike | 30 分钟 |
| Task 1 schema migration | 1 小时 |
| Task 2 WorklistRegistry tree register/query | 2 小时 |
| Task 3 tryCascadeSettle 不变量 | 2-3 小时 |
| Task 4 WorklistExecutor.registerForDispatch parentWorklistId 反查 | 1-2 小时 |
| Task 5 onChildFinished cascade · root-only 续推 | 3-4 小时 |
| Task 6 wire 到 message-service + 单层 e2e | 4-6 小时 |
| Task 7 多层 e2e replay 3 case | 3-4 小时 |
| Task 8 rehydrate test | 1-2 小时 |
| Task 9 quality-gate | 1 小时 |
| Task 10 acceptance-guardian + 5 场景实测 | 4-6 小时 |
| **小计 (Step 1 重做)** | **~20-30 小时（3-4 天）** |
| Task 11 Step 2-8 引用 v1 plan | ~2-3 周（v1 估时） |
| **总计** | **~3-4 周**（跟 v1 估时持平） |

---

## 下一步

1. 把本 plan 给小孙过目签收
2. 进入 Task 0 Spike（30 分钟）核 a2a_calls schema 同构性
3. Task 1-10 顺序 TDD（每 Task 一个 commit）
4. Task 9 quality-gate + Task 10 acceptance-guardian 通过 → 进 v1 plan Step 2 删除清单
