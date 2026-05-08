import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { WorklistItem, WorklistItemStatus } from "./worklist-advance"

/**
 * F026 P2 v2 · 树形 worklist 持久化层。
 *
 * Schema 详见 `db/sqlite.ts` `a2a_worklists` 建表 + migration
 * `db/a2a-worklists-tree-migration.ts`。
 *
 * 核心：parent_worklist_id 自引用形成树（同构 a2a_calls.parent_call_id）。
 * settle 不变量由 Task 3 `tryCascadeSettle` 实现：自身 items 全 done 且
 * 子 worklist 全 settled 才能 settle —— 这里只提供原子操作 + 查询基础。
 */

export type WorklistStatus = "active" | "settled"

export interface WorklistRegisterInput {
  worklistId?: string
  /** ★ 树形必传 · root worklist 时显式 null（禁止 undefined fallback） */
  parentWorklistId: string | null
  parentCallId: string
  rootCallId: string
  sessionGroupId: string
  items: WorklistItem[]
}

export interface WorklistRow {
  worklistId: string
  parentWorklistId: string | null
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

type RawWorklistRow = {
  worklist_id: string
  parent_worklist_id: string | null
  parent_call_id: string
  root_call_id: string
  session_group_id: string
  items: string
  current_index: number
  status: string
  created_at: string
  updated_at: string
}

function toWorklistRow(raw: RawWorklistRow): WorklistRow {
  return {
    worklistId: raw.worklist_id,
    parentWorklistId: raw.parent_worklist_id,
    parentCallId: raw.parent_call_id,
    rootCallId: raw.root_call_id,
    sessionGroupId: raw.session_group_id,
    items: JSON.parse(raw.items) as WorklistItem[],
    currentIndex: raw.current_index,
    status: raw.status as WorklistStatus,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
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
    if (!input.sessionGroupId)
      throw new Error("WorklistRegistry.register: sessionGroupId required")
    if (!input.items || input.items.length === 0) {
      throw new Error("WorklistRegistry.register: items must be non-empty")
    }

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
        input.parentWorklistId,
        input.parentCallId,
        input.rootCallId,
        input.sessionGroupId,
        JSON.stringify(input.items),
        now,
        now,
      )
    return worklistId
  }

  get(worklistId: string): WorklistRow | null {
    const raw = this.db
      .prepare("SELECT * FROM a2a_worklists WHERE worklist_id = ?")
      .get(worklistId) as RawWorklistRow | undefined
    return raw ? toWorklistRow(raw) : null
  }

  /** 返回所有 parent_worklist_id = self 的子 worklist，按 created_at ASC。 */
  findChildWorklists(parentWorklistId: string): WorklistRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM a2a_worklists WHERE parent_worklist_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(parentWorklistId) as RawWorklistRow[]
    return rows.map(toWorklistRow)
  }

  /**
   * F026 P3 continuation-guard · 返回 root_call_id 下所有 worklist（含 active /
   * settled / 任意层），按 created_at ASC。
   *
   * dispatchWorklistContinuation 续推 guard 用此反查 root tree 内是否曾有
   * worklist.items 含 panel agent alias —— 若有，说明 panel agent 已在某 leaf
   * 被自然召唤过，再续推就重复（R-095/R-096 案）。
   */
  findAllByRootCallId(rootCallId: string): WorklistRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM a2a_worklists WHERE root_call_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(rootCallId) as RawWorklistRow[]
    return rows.map(toWorklistRow)
  }

  /** 返回 parentCallId 对应的 active worklist（每个 parent 同时只能有一个 active）。 */
  findActiveByParentCallId(parentCallId: string): WorklistRow | null {
    const raw = this.db
      .prepare(
        "SELECT * FROM a2a_worklists WHERE parent_call_id = ? AND status = 'active' LIMIT 1",
      )
      .get(parentCallId) as RawWorklistRow | undefined
    return raw ? toWorklistRow(raw) : null
  }

  /** 标记某 item 的状态（按 index）。 */
  markItemStatus(worklistId: string, itemIndex: number, status: WorklistItemStatus): void {
    const row = this.get(worklistId)
    if (!row) throw new Error(`WorklistRegistry.markItemStatus: worklist ${worklistId} not found`)
    if (itemIndex < 0 || itemIndex >= row.items.length) {
      throw new Error(
        `WorklistRegistry.markItemStatus: index ${itemIndex} out of bounds (len=${row.items.length})`,
      )
    }
    const next = row.items.slice()
    const target = next[itemIndex]
    if (!target) return
    next[itemIndex] = { ...target, status }
    this.db
      .prepare(
        "UPDATE a2a_worklists SET items = ?, updated_at = ? WHERE worklist_id = ?",
      )
      .run(JSON.stringify(next), this.now(), worklistId)
  }

  /** CAS active → settled. 返回 true = 本次成功 settle；false = 已是 settled（幂等无副作用）。 */
  settle(worklistId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE a2a_worklists SET status = 'settled', updated_at = ? WHERE worklist_id = ? AND status = 'active'",
      )
      .run(this.now(), worklistId)
    return result.changes === 1
  }

  /**
   * F026 P2 v2 · drain-based cascade settle 不变量（v2 核心区别 vs v1 平表）。
   *
   * 从给定 worklist 开始 bottom-up 递推：
   *   - 自身 items 全 done **且** 子 worklist 全 settled → settle 自己 → 向上走 parent
   *   - 否则停止
   *
   * 调用方契约：
   *   - 调用前应当已 markItemStatus 把驱动这次推进的 item 标 done
   *   - 不触发任何续推派发；那是 executor 层的事，executor 拿到本方法返回的
   *     settled[] 决定哪个 root settle 触发回调
   *
   * 防御：环（异常 schema）下用 visited set + 深度上限 50 强制 break，不死循环。
   *
   * 返回 settled[] = 本次实际推进 settle 的 worklist id 列表（按 settle 顺序，子 → 父）
   */
  tryCascadeSettle(startWorklistId: string): { settled: string[] } {
    const settled: string[] = []
    const visited = new Set<string>()
    let cursorId: string | null = startWorklistId
    let depth = 0
    const MAX_DEPTH = 50

    while (cursorId && depth < MAX_DEPTH) {
      if (visited.has(cursorId)) break
      visited.add(cursorId)
      depth++

      const self: WorklistRow | null = this.get(cursorId)
      if (!self) break
      if (self.status !== "active") break

      const itemsAllDone = self.items.every((it) => it.status === "done")
      if (!itemsAllDone) break

      const children = this.findChildWorklists(cursorId)
      const childrenAllSettled = children.every((c) => c.status === "settled")
      if (!childrenAllSettled) break

      const ok = this.settle(cursorId)
      if (!ok) break // CAS 撞车（并发场景）

      settled.push(cursorId)
      cursorId = self.parentWorklistId
    }

    return { settled }
  }
}
