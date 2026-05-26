"use client"

import { useCallback, useState } from "react"

/**
 * F027 final-vision P1-1 · UnresolvedDecisionModal 数据 fetch hook
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-9 c 场景 3 step 3.5-3.6
 *   - V16.5 chap 11 line 1238-1247 (Decision Coverage Check)
 *   - packages/api/src/routes/phase3/decisions.ts (POST /api/rooms/:id/decisions)
 *   - packages/api/src/routes/phase3/contracts.ts §5 PostDecisionBody/Response
 *
 * 端到端：
 *   - Inspector Coverage section click unresolved item
 *   - Modal 弹出 → 用户选 [supersede] / [reject] + 填 reason
 *   - POST /api/rooms/:id/decisions:
 *       supersede → { kind:"commit", supersedesDecisionId, content:reason } → ledger.revoke
 *       reject    → { kind:"reject", supersedesDecisionId, content:reason } → ledger.revoke
 *     两路径都写新 ledger 行 + UPDATE 旧行 status='superseded' / superseded_by=新 id
 *   - response action 字段 "revoke" 表示真走了覆盖路径
 *
 * Evidence chain:
 *   - manual confirm 无 LLM 抽出的原文 — evidence 默认为 [{kind:"decision", ref:targetDecisionId}]
 *     语义：本次手动 supersede/reject 的证据就是目标 decision 自己
 *   - sourceMessageIds（可选）：调用方可补充触发本次确认的对话消息 ID 列表
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

export type SupersedeRejectAction = "supersede" | "reject"

export interface SupersedeRejectRequest {
  roomId: string
  /** 目标 unresolved decision 的 ROWID stringified（与 DecisionRef.decisionId 同源）。 */
  targetDecisionId: string
  action: SupersedeRejectAction
  reason: string
  callerAlias: string
  /** 额外的对话消息 evidence ref；不传则只用 target decision 自己作为 evidence。 */
  sourceMessageIds?: readonly string[]
}

export interface SupersedeRejectSuccess {
  ok: true
  /** 新写入的 ledger 行 decision_id（被覆盖的旧行 id 仍是 targetDecisionId）。 */
  newDecisionId: string
  /** 后端 ledger cursor（前端拿来 invalidate viewfinder cache）。 */
  ledgerCursor: number
  appendedAt: string
  /** 后端实际执行的动作（contracts §5 PostDecisionResponse.action）。 */
  serverAction: "append" | "revoke" | "tombstone"
}

export interface SupersedeRejectErrorResponse {
  ok: false
  code: string
  error?: string
}

export type SupersedeRejectResponse = SupersedeRejectSuccess | SupersedeRejectErrorResponse

export interface UseDecisionSupersedeRejectApiReturn {
  data: SupersedeRejectSuccess | null
  isLoading: boolean
  error: string | null
  submit: (body: SupersedeRejectRequest) => Promise<void>
  reset: () => void
}

export function useDecisionSupersedeRejectApi(): UseDecisionSupersedeRejectApiReturn {
  const [data, setData] = useState<SupersedeRejectSuccess | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(async (body: SupersedeRejectRequest) => {
    setIsLoading(true)
    setError(null)
    try {
      const kind = body.action === "supersede" ? "commit" : "reject"
      const evidence: Array<{ kind: "message" | "decision"; ref: string }> = [
        { kind: "decision", ref: body.targetDecisionId },
      ]
      if (body.sourceMessageIds) {
        for (const ref of body.sourceMessageIds) {
          evidence.push({ kind: "message", ref })
        }
      }
      const resp = await fetch(`${API_BASE_URL}/api/rooms/${body.roomId}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          content: body.reason,
          evidence,
          supersedesDecisionId: body.targetDecisionId,
          callerAlias: body.callerAlias,
        }),
      })
      const raw = (await resp.json()) as
        | {
            decisionId: string
            ledgerCursor: number
            appendedAt: string
            action: "append" | "revoke" | "tombstone"
          }
        | { error: string; message?: string; detail?: Record<string, unknown> }
      if (!resp.ok || "error" in raw) {
        const errObj = raw as { error: string; message?: string }
        setError(`${errObj.error}: ${errObj.message ?? "submit failed"}`)
        return
      }
      setData({
        ok: true,
        newDecisionId: raw.decisionId,
        ledgerCursor: raw.ledgerCursor,
        appendedAt: raw.appendedAt,
        serverAction: raw.action,
      })
    } catch (err) {
      setError((err as Error).message ?? "network error")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return { data, isLoading, error, submit, reset }
}
