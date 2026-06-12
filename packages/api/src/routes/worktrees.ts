import type { FastifyInstance } from "fastify"

import { PreviewGuardError, assertAllowedOrigin } from "../worktrees/preview-guards"
import type { PreviewOrchestrator } from "../worktrees/preview-orchestrator"
import type { WorktreeInventoryEntry } from "../worktrees/worktree-inventory"
import type { SummaryError, WorktreeSummary } from "../worktrees/worktree-summary"

/**
 * F028 Task 7 · worktrees 路由（AC3/AC4/AC5/AC6/AC10 HTTP 面）
 *
 * D12 控制面单实例：controlEnabled=false（WORKTREE_PREVIEW 实例）只注册只读 GET，
 * 控制 POST 不存在（404），reconcile 不跑；capabilities 端点供 UI 感知禁钮。
 * AC6 Origin：POST 控制端点上 Origin 头存在时必须命中精确白名单（resolveControlPlaneOrigins
 * 产物，主 UI :3000 + registry webPorts），否则 403；无 Origin（curl/同进程）放行。
 */

export type WorktreeRoutesOpts = {
  controlEnabled: boolean
  inventory: () => Promise<WorktreeInventoryEntry[]>
  summary: (name: string, worktreePath: string) => Promise<WorktreeSummary | SummaryError>
  orchestrator: PreviewOrchestrator
  allowedOrigins: () => Promise<Set<string>>
  reconcile: () => Promise<void>
}

export async function registerWorktreeRoutes(
  app: FastifyInstance,
  opts: WorktreeRoutesOpts,
): Promise<void> {
  app.get("/api/worktrees", async () => {
    return { worktrees: await opts.inventory() }
  })

  app.get("/api/worktrees/capabilities", async () => {
    return { control: opts.controlEnabled }
  })

  app.get<{ Params: { name: string } }>("/api/worktrees/:name/summary", async (req, reply) => {
    const entries = await opts.inventory()
    const entry = entries.find((e) => e.name === req.params.name)
    if (!entry) return reply.code(404).send({ error: `worktree ${req.params.name} not found` })
    const summary = await opts.summary(entry.name, entry.path)
    if ("error" in summary) return reply.code(404).send(summary)
    return summary
  })

  app.get<{ Params: { name: string }; Querystring: { proc?: string; lines?: string } }>(
    "/api/worktrees/:name/preview/log",
    async (req, reply) => {
      const proc = req.query.proc
      if (proc !== "api" && proc !== "web") {
        return reply.code(400).send({ error: `proc must be api|web, got ${proc ?? "(none)"}` })
      }
      const lines = Math.max(1, Math.min(1000, Number(req.query.lines) || 120))
      return opts.orchestrator.tailLog(req.params.name, proc, lines)
    },
  )

  if (!opts.controlEnabled) return // D12: preview 实例到此为止——控制路由不注册、reconcile 不跑

  await opts.reconcile() // boot reconcile 接线（主 API 注册路径恰一次）

  const actions = {
    "compile-backend": (name: string) => opts.orchestrator.compileBackend(name),
    restart: (name: string) => opts.orchestrator.restartAll(name),
    start: (name: string) => opts.orchestrator.start(name),
  } as const

  for (const [action, run] of Object.entries(actions)) {
    app.post<{ Params: { name: string } }>(
      `/api/worktrees/:name/preview/${action}`,
      async (req, reply) => {
        try {
          assertAllowedOrigin(req.headers.origin, await opts.allowedOrigins())
        } catch (err) {
          if (err instanceof PreviewGuardError) {
            return reply.code(403).send({ error: err.message })
          }
          throw err
        }
        const entries = await opts.inventory()
        const entry = entries.find((e) => e.name === req.params.name)
        if (!entry || entry.isMain) {
          return reply
            .code(400)
            .send({ error: entry ? "main worktree is not operable" : `worktree ${req.params.name} not in inventory` })
        }
        const result = await run(entry.name)
        if (!result.ok && result.stage === "in-progress") {
          return reply.code(409).send(result) // AC10
        }
        return result // 业务失败也是 HTTP 200 + ok:false（前端按 stage 分流展示）
      },
    )
  }
}
