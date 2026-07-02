import assert from "node:assert/strict"
import test from "node:test"
import type { DecisionRecord } from "@multi-agent/shared"
import Fastify from "fastify"
import type { DecisionManager } from "../orchestrator/decision-manager"
import type { MessageService } from "../services/message-service"
import { registerDecisionBoardRoutes } from "./decision-board"

const resolvedRecord: DecisionRecord = {
  requestId: "req-1",
  sessionGroupId: "group-1",
  kind: "multi_choice",
  title: "T",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  status: "resolved",
  verdicts: [{ optionId: "a", verdict: "approved" }],
  createdAt: "2026-07-02T10:00:00.000Z",
  resolvedAt: "2026-07-02T10:01:00.000Z",
}

function makeDeps(withRecords: boolean) {
  const calls: Array<{ sessionGroupId: string; opts?: { excludePending?: boolean } }> = []
  const deps = {
    messageService: {} as MessageService,
    decisions: { getPendingRequests: () => [] } as unknown as DecisionManager,
    ...(withRecords
      ? {
          decisionRecords: {
            listBySessionGroup: (
              sessionGroupId: string,
              opts?: { excludePending?: boolean },
            ): DecisionRecord[] => {
              calls.push({ sessionGroupId, opts })
              return sessionGroupId === "group-1" ? [resolvedRecord] : []
            },
          },
        }
      : {}),
  }
  return { deps, calls }
}

test("F033: GET /api/decisions/records 返回非 pending records", async () => {
  const app = Fastify()
  const { deps, calls } = makeDeps(true)
  registerDecisionBoardRoutes(app, deps)

  const res = await app.inject({
    method: "GET",
    url: "/api/decisions/records?sessionGroupId=group-1",
  })
  await app.close()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { records: [resolvedRecord] })
  assert.equal(calls[0].sessionGroupId, "group-1")
  assert.equal(calls[0].opts?.excludePending, true, "pending 行由 /pending 端点负责，此处必须排除")
})

test("F033: GET /api/decisions/records 无 sessionGroupId → 空", async () => {
  const app = Fastify()
  const { deps } = makeDeps(true)
  registerDecisionBoardRoutes(app, deps)

  const res = await app.inject({ method: "GET", url: "/api/decisions/records" })
  await app.close()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { records: [] })
})

test("F033: 未接 decisionRecords 依赖 → 空（优雅降级）", async () => {
  const app = Fastify()
  const { deps } = makeDeps(false)
  registerDecisionBoardRoutes(app, deps)

  const res = await app.inject({
    method: "GET",
    url: "/api/decisions/records?sessionGroupId=group-1",
  })
  await app.close()

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { records: [] })
})
