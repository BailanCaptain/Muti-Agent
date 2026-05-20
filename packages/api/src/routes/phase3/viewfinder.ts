/**
 * F027 Phase 3 P20 · GET /api/rooms/:id/viewfinder — Week 1 Day 3
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1 Day 3
 *   + contracts.ts §1 GetViewfinderResponse
 *
 * 数据源：
 *   - viewfinder markdown：wiki/rooms/<roomId>/viewfinder.md（Phase 1 P12 RoomCompiler 写盘）
 *   - coverage / lastCompiledAt：从 viewfinder frontmatter 解析
 *   - ledger：DecisionLedger 查 active count + latestDecisionId（直读 SQLite）
 *
 * 设计：
 *   - 文件不存在 → viewfinder=null + ledger 仍正常返回（room 可能刚创建未编译）
 *   - 文件存在但 frontmatter 缺字段 → 用兜底（coverage=null + status='fail'）
 *   - 不重跑 extractor / coverage 计算（耗 LLM）— 只读 RoomCompiler 已落盘的结果
 *
 * 不做（Phase 3 Week 1 Day 3 范围）：
 *   - 不实现 prompt-inspector（Day 4）
 *   - 不接 manual decision API（AC-P3-8 Week 2 Day 6）
 *   - 不实现 viewfinder force-recompile endpoint
 */

import fs from "node:fs/promises"
import path from "node:path"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import {
  ErrorCode,
  HTTP_STATUS_BY_ERROR,
  type GetViewfinderResponse,
  toErrorResponse,
  validateGetViewfinder,
} from "./contracts"
import { parseFrontmatter } from "./frontmatter"

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface ViewfinderFrontmatter {
  viewfinder_id?: string
  generated_at?: string
  inputs?: {
    coverage?: string
    decision_ledger_count?: number
    last_committed_cursor?: number | string | null
  }
  coverage_status?: "pass" | "warn" | "fail" | "unknown"
}

export interface ViewfinderServiceDeps {
  db: DrizzleDb
  wikiRoot: string
  /** 注入 fs reader（测试用）；默认走 node:fs/promises.readFile。 */
  readFile?: (absPath: string) => Promise<string>
}

interface DecisionLedgerSnapshot {
  activeCount: number
  latestDecisionId: string | null
}

export class ViewfinderService {
  private readonly db: DrizzleDb
  private readonly wikiRoot: string
  private readonly readFile: (absPath: string) => Promise<string>

  constructor(deps: ViewfinderServiceDeps) {
    this.db = deps.db
    this.wikiRoot = deps.wikiRoot
    this.readFile =
      deps.readFile ??
      ((p) => fs.readFile(p, "utf-8"))
  }

  async getViewfinder(roomId: string): Promise<GetViewfinderResponse> {
    const ledger = this.queryLedgerSnapshot(roomId)

    const viewfinderPath = path.join(
      this.wikiRoot,
      "wiki",
      "rooms",
      roomId,
      "viewfinder.md",
    )
    let raw: string | null = null
    try {
      raw = await this.readFile(viewfinderPath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") {
        // room 未编译过 — viewfinder.md 不存在；ledger 仍正常返回
        return {
          viewfinder: null,
          coverage: emptyCoverage(),
          lastCompiledAt: null,
          ledger,
        }
      }
      throw err
    }

    const { frontmatter } = parseFrontmatter<ViewfinderFrontmatter>(raw)
    const coverage = parseCoverageFromFrontmatter(frontmatter)
    const lastCompiledAt = frontmatter?.generated_at ?? null

    return {
      viewfinder: raw,
      coverage,
      lastCompiledAt,
      ledger,
    }
  }

  private queryLedgerSnapshot(roomId: string): DecisionLedgerSnapshot {
    // 直读 room_decisions 表 — 不依赖 DecisionLedger 类（避免拉 SqliteAdapterLike 依赖）
    const stmt = (this.db as unknown as {
      $client: {
        prepare: (sql: string) => {
          get: (...args: unknown[]) => unknown
        }
      }
    }).$client

    const activeRow = stmt.prepare(
      `SELECT COUNT(*) as cnt FROM room_decisions
        WHERE room_id = ? AND status = 'active' AND superseded_by IS NULL`,
    ).get(roomId) as { cnt: number } | undefined
    const activeCount = activeRow?.cnt ?? 0

    const latestRow = stmt.prepare(
      `SELECT decision_id FROM room_decisions
        WHERE room_id = ?
        ORDER BY decision_id DESC LIMIT 1`,
    ).get(roomId) as { decision_id: number } | undefined
    const latestDecisionId =
      latestRow?.decision_id !== undefined ? String(latestRow.decision_id) : null

    return { activeCount, latestDecisionId }
  }
}

function emptyCoverage(): GetViewfinderResponse["coverage"] {
  return { broad: 0, resolved: 0, unresolved: 0, coverage: null, status: "fail" }
}

function parseCoverageFromFrontmatter(
  fm: ViewfinderFrontmatter | null,
): GetViewfinderResponse["coverage"] {
  if (!fm) return emptyCoverage()

  // frontmatter.inputs.coverage 是字符串 "X% (resolved/broad)" 或 "unknown (broad=N)"
  const coverageStr = fm.inputs?.coverage ?? null
  const status = fm.coverage_status ?? "fail"

  if (typeof coverageStr === "string") {
    // 形如 "85% (17/20)"
    const m = coverageStr.match(/^(\d+)%\s*\((\d+)\/(\d+)\)/)
    if (m) {
      const resolved = Number.parseInt(m[2], 10)
      const broad = Number.parseInt(m[3], 10)
      const unresolved = Math.max(0, broad - resolved)
      const ratio = broad > 0 ? resolved / broad : null
      return {
        broad,
        resolved,
        unresolved,
        coverage: ratio,
        status: status === "unknown" ? "warn" : status,
      }
    }
    // 形如 "unknown (broad=2)"
    const um = coverageStr.match(/^unknown\s*\(broad=(\d+)\)/)
    if (um) {
      const broad = Number.parseInt(um[1], 10)
      return {
        broad,
        resolved: 0,
        unresolved: 0,
        coverage: null,
        status: "warn",
      }
    }
  }

  return emptyCoverage()
}

export function registerViewfinderRoute(
  app: FastifyInstance,
  service: ViewfinderService,
): void {
  app.get("/api/rooms/:id/viewfinder", async (request, reply) => {
    const validation = validateGetViewfinder(request.params)
    if (!validation.ok) {
      reply.code(HTTP_STATUS_BY_ERROR[validation.error])
      return toErrorResponse(validation)
    }
    try {
      const body = await service.getViewfinder(validation.value.roomId)
      return body
    } catch (err) {
      request.log.error({ err, roomId: validation.value.roomId }, "viewfinder service threw")
      reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR])
      return toErrorResponse({
        ok: false,
        error: ErrorCode.INTERNAL_ERROR,
        message: (err as Error).message,
      })
    }
  })
}
