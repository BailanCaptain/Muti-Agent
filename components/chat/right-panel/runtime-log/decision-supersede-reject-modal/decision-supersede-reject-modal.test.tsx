/**
 * F027 final-vision P1-1 · DecisionSupersedeRejectModal 单元测试
 *
 * 覆盖:
 *   (1) open=false → 不渲染
 *   (2) open=true + target → 渲染 dialog + target 信息 (id/type/summary/decidedBy)
 *   (3) action 未选 → [确认] 禁用
 *   (4) action 选了但 reason 空 → [确认] 禁用
 *   (5) supersede + reason 填好 + submit → POST body kind="commit" + supersedesDecisionId + evidence
 *   (6) reject + reason 填好 + submit → POST body kind="reject" + supersedesDecisionId
 *   (7) submit success → 显示 newDecisionId + serverAction + 调 onSubmitSuccess
 *   (8) submit 失败 (DECISION_INVALID) → 红 error panel + 不调 onSubmitSuccess
 *   (9) sourceMessageIds 传入 → POST body evidence 含 message ref
 *   (10) 取消按钮 → onClose
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DecisionSupersedeRejectModal } from "./decision-supersede-reject-modal"

interface MockResponseSpec {
  ok: boolean
  status: number
  json: unknown
}

let lastFetchInit: RequestInit | undefined

function mockResponse(response: MockResponseSpec) {
  globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    lastFetchInit = init
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.json),
    }) as unknown as Promise<Response>
  }) as unknown as typeof fetch
}

const SAMPLE_TARGET = {
  decisionId: "42",
  decisionType: "spec",
  summary: "ingest pipeline 默认接 LLM compile",
  decidedBy: "黄仁勋",
  decidedAt: "2026-05-20T12:00:00Z",
}

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch
  lastFetchInit = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DecisionSupersedeRejectModal", () => {
  it("(1) open=false → renders nothing", () => {
    const { container } = render(
      <DecisionSupersedeRejectModal
        open={false}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("(2) open=true + target → renders dialog + target info", () => {
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("42")).toBeTruthy()
    expect(screen.getByText("spec")).toBeTruthy()
    expect(screen.getByText(/ingest pipeline 默认接 LLM compile/)).toBeTruthy()
    expect(screen.getByText("黄仁勋")).toBeTruthy()
  })

  it("(3) action 未选 → [确认] disabled", () => {
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    const btn = screen.getByTestId("decision-supersede-reject-submit") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it("(4) action 选了但 reason 空 → [确认] disabled", () => {
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("action-radio-supersede"))
    const btn = screen.getByTestId("decision-supersede-reject-submit") as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it("(5) supersede + reason 填好 → POST kind=commit + supersedesDecisionId + evidence", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        decisionId: "43",
        ledgerCursor: 43,
        appendedAt: "2026-05-27T10:00:00Z",
        action: "revoke",
      },
    })
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-7"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("action-radio-supersede"))
    fireEvent.change(screen.getByTestId("decision-supersede-reject-reason"), {
      target: { value: "新决策接 docs-watcher" },
    })
    fireEvent.click(screen.getByTestId("decision-supersede-reject-submit"))
    await waitFor(() => {
      expect(screen.getByTestId("decision-supersede-reject-success")).toBeTruthy()
    })
    expect(lastFetchInit?.method).toBe("POST")
    const body = JSON.parse(lastFetchInit?.body as string) as {
      kind: string
      content: string
      evidence: Array<{ kind: string; ref: string }>
      supersedesDecisionId: string
      callerAlias: string
    }
    expect(body.kind).toBe("commit")
    expect(body.content).toBe("新决策接 docs-watcher")
    expect(body.supersedesDecisionId).toBe("42")
    expect(body.callerAlias).toBe("黄仁勋")
    expect(body.evidence).toEqual([{ kind: "decision", ref: "42" }])
  })

  it("(6) reject + reason 填好 → POST kind=reject + supersedesDecisionId", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        decisionId: "44",
        ledgerCursor: 44,
        appendedAt: "2026-05-27T10:01:00Z",
        action: "revoke",
      },
    })
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-7"
        target={SAMPLE_TARGET}
        callerAlias="桂芬"
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("action-radio-reject"))
    fireEvent.change(screen.getByTestId("decision-supersede-reject-reason"), {
      target: { value: "拒绝该 spec — 不接 LLM" },
    })
    fireEvent.click(screen.getByTestId("decision-supersede-reject-submit"))
    await waitFor(() => {
      expect(screen.getByTestId("decision-supersede-reject-success")).toBeTruthy()
    })
    const body = JSON.parse(lastFetchInit?.body as string) as { kind: string; callerAlias: string }
    expect(body.kind).toBe("reject")
    expect(body.callerAlias).toBe("桂芬")
  })

  it("(7) submit success → 显示 newDecisionId + serverAction + onSubmitSuccess 调一次", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        decisionId: "100",
        ledgerCursor: 100,
        appendedAt: "2026-05-27T11:00:00Z",
        action: "revoke",
      },
    })
    const onSuccess = vi.fn()
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={() => {}}
        onSubmitSuccess={onSuccess}
      />,
    )
    fireEvent.click(screen.getByTestId("action-radio-supersede"))
    fireEvent.change(screen.getByTestId("decision-supersede-reject-reason"), {
      target: { value: "test" },
    })
    fireEvent.click(screen.getByTestId("decision-supersede-reject-submit"))
    await waitFor(() => {
      const successPanel = screen.getByTestId("decision-supersede-reject-success")
      expect(successPanel.textContent).toContain("100")
      expect(successPanel.textContent).toContain("revoke")
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onSuccess.mock.calls[0][0].newDecisionId).toBe("100")
      expect(onSuccess.mock.calls[0][0].serverAction).toBe("revoke")
    })
  })

  it("(8) submit 失败 (DECISION_INVALID) → 红 error panel + onSubmitSuccess 不调", async () => {
    mockResponse({
      ok: false,
      status: 400,
      json: {
        error: "DECISION_INVALID",
        message: "supersedesDecisionId must be numeric ROWID",
      },
    })
    const onSuccess = vi.fn()
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={() => {}}
        onSubmitSuccess={onSuccess}
      />,
    )
    fireEvent.click(screen.getByTestId("action-radio-supersede"))
    fireEvent.change(screen.getByTestId("decision-supersede-reject-reason"), {
      target: { value: "test" },
    })
    fireEvent.click(screen.getByTestId("decision-supersede-reject-submit"))
    await waitFor(() => {
      expect(screen.getByTestId("decision-supersede-reject-error")).toBeTruthy()
      expect(screen.getByText(/DECISION_INVALID/)).toBeTruthy()
    })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("(9) sourceMessageIds 传入 → POST evidence 含 message ref", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        decisionId: "55",
        ledgerCursor: 55,
        appendedAt: "2026-05-27T10:00:00Z",
        action: "revoke",
      },
    })
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        sourceMessageIds={["msg-abc", "msg-def"]}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("action-radio-supersede"))
    fireEvent.change(screen.getByTestId("decision-supersede-reject-reason"), {
      target: { value: "evidence with msg refs" },
    })
    fireEvent.click(screen.getByTestId("decision-supersede-reject-submit"))
    await waitFor(() => {
      expect(screen.getByTestId("decision-supersede-reject-success")).toBeTruthy()
    })
    const body = JSON.parse(lastFetchInit?.body as string) as {
      evidence: Array<{ kind: string; ref: string }>
    }
    expect(body.evidence).toEqual([
      { kind: "decision", ref: "42" },
      { kind: "message", ref: "msg-abc" },
      { kind: "message", ref: "msg-def" },
    ])
  })

  it("(10) 取消按钮 → onClose 调用", () => {
    const onClose = vi.fn()
    render(
      <DecisionSupersedeRejectModal
        open={true}
        roomId="R-1"
        target={SAMPLE_TARGET}
        callerAlias="黄仁勋"
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByTestId("decision-supersede-reject-cancel"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
