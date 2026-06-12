import type { FastifyInstance, FastifyReply } from "fastify"

import { BinaryFileError, readTreeContent } from "../project-tree/tree-content"
import { listTreeDir } from "../project-tree/tree-list"
import { listTreeRoots, resolveTreeRoot, type TreeRootDeps } from "../project-tree/tree-roots"
import { WikiPathInvalidError } from "../wiki/path-containment"
import { PreviewGuardError } from "../worktrees/preview-guards"

/**
 * F028 Task 14 · project-tree 路由（AC1/AC2 HTTP 面）
 * 全只读 GET（worktree preview 实例同样可用——无控制面语义，不走 D12 门禁）。
 * 错误分流：越界/ADS/二进制 → 400；root 未知/已删/denylist/文件不存在 → 404。
 */

export type ProjectTreeRoutesOpts = TreeRootDeps

function mapError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof BinaryFileError) {
    return reply.code(400).send({ code: "BINARY_FILE", error: err.message })
  }
  if (err instanceof WikiPathInvalidError || err instanceof PreviewGuardError) {
    return reply.code(400).send({ code: "PATH_INVALID", error: err.message })
  }
  throw err
}

export function registerProjectTreeRoutes(
  app: FastifyInstance,
  opts: ProjectTreeRoutesOpts,
): void {
  app.get("/api/project-tree/roots", async () => {
    return { roots: await listTreeRoots(opts) }
  })

  app.get<{ Querystring: { root?: string; dir?: string } }>(
    "/api/project-tree/list",
    async (req, reply) => {
      const root = await resolveTreeRoot(req.query.root ?? "", opts)
      if (!root) return reply.code(404).send({ error: `unknown root "${req.query.root ?? ""}"` })
      try {
        const result = await listTreeDir(req.query.dir ?? "", root)
        if (result === null) {
          // denied 段 / 不存在 / dir 指向文件 → 404（隐藏语义，与 content 端点对称）
          return reply.code(404).send({ error: `dir not found: ${req.query.dir ?? ""}` })
        }
        return result
      } catch (err) {
        return mapError(err, reply)
      }
    },
  )

  app.get<{ Querystring: { root?: string; path?: string } }>(
    "/api/project-tree/content",
    async (req, reply) => {
      const root = await resolveTreeRoot(req.query.root ?? "", opts)
      if (!root) return reply.code(404).send({ error: `unknown root "${req.query.root ?? ""}"` })
      try {
        const res = await readTreeContent(req.query.path ?? "", root)
        if (res === null) {
          return reply.code(404).send({ error: `file not found: ${req.query.path ?? ""}` })
        }
        return res
      } catch (err) {
        return mapError(err, reply)
      }
    },
  )
}
