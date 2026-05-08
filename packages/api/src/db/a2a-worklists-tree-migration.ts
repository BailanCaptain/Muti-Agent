import type { DatabaseSync } from "node:sqlite"

/**
 * F026 P2 v2 Task 1 · 给老库 a2a_worklists 表加 parent_worklist_id 列（自引用树）+
 * 树形查询所需的两条索引。
 *
 * 同构 a2a_calls 的 parent_call_id / root_call_id：worklist 树照抄 call 树形态。
 *
 * 幂等：重复调用安全——
 *   - 列已存在 → 跳过 ALTER
 *   - 索引用 CREATE INDEX IF NOT EXISTS
 *   - 表不存在（init 顺序边界 / 测试隔离）→ 跳过整段
 *
 * 调用方：SqliteStore init 末尾（runAlterMigrations 之后），见 sqlite.ts。
 */
export function applyA2AWorklistsTreeMigration(db: DatabaseSync): void {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a2a_worklists'")
    .get() as { name: string } | undefined
  if (!tableExists) return

  const cols = db.prepare("PRAGMA table_info(a2a_worklists)").all() as Array<{ name: string }>
  const hasParentCol = cols.some((c) => c.name === "parent_worklist_id")
  if (!hasParentCol) {
    db.exec("ALTER TABLE a2a_worklists ADD COLUMN parent_worklist_id TEXT")
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_a2a_worklists_parent_worklist ON a2a_worklists(parent_worklist_id)",
  )
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_a2a_worklists_root_status ON a2a_worklists(root_call_id, status)",
  )
}
