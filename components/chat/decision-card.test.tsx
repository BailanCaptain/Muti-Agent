/**
 * F033 · DecisionCard 三 kind 渲染 + DecisionRecordCard resolved/disabled 态
 *
 * 覆盖:
 *   - select（multi_choice 单选）: 点选项只选中不回传；显式提交才回传（clowder B1 教训）
 *   - multi_select: 勾多项提交回传多 verdict
 *   - confirm（inline_confirmation）: description 渲染；确认/取消各自回传 approved/rejected
 *   - textarea 内 Enter 不提交（AC4 回归面）
 *   - DecisionRecordCard: resolved 高亮所选无可点；timeout/orphaned 状态足注
 */

import type { DecisionRecord, DecisionRequest } from "@multi-agent/shared"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DecisionCard, DecisionRecordCard } from "./decision-card"

function makeRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    requestId: "req-1",
    kind: "multi_choice",
    title: "选一个方案",
    options: [
      { id: "a", label: "方案甲" },
      { id: "b", label: "方案乙" },
    ],
    sessionGroupId: "group-1",
    createdAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  }
}

function makeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    requestId: "req-1",
    sessionGroupId: "group-1",
    kind: "multi_choice",
    title: "选一个方案",
    options: [
      { id: "a", label: "方案甲" },
      { id: "b", label: "方案乙" },
    ],
    status: "resolved",
    verdicts: [
      { optionId: "a", verdict: "approved" },
      { optionId: "b", verdict: "rejected" },
    ],
    createdAt: "2026-07-02T10:00:00.000Z",
    resolvedAt: "2026-07-02T10:01:00.000Z",
    ...overrides,
  }
}

describe("DecisionCard · select（multi_choice 单选）", () => {
  it("点选项只选中不回传；点提交回传单项 approved", () => {
    const onRespond = vi.fn()
    render(<DecisionCard request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByText("方案甲"))
    expect(onRespond).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /提交/ }))
    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith(
      "req-1",
      [{ optionId: "a", verdict: "approved" }],
      undefined,
    )
  })

  it("单选点第二项替换第一项", () => {
    const onRespond = vi.fn()
    render(<DecisionCard request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByText("方案甲"))
    fireEvent.click(screen.getByText("方案乙"))
    fireEvent.click(screen.getByRole("button", { name: /提交/ }))
    expect(onRespond).toHaveBeenCalledWith(
      "req-1",
      [{ optionId: "b", verdict: "approved" }],
      undefined,
    )
  })

  it("textarea 内按 Enter 不提交（AC4 回归面）", () => {
    const onRespond = vi.fn()
    render(<DecisionCard request={makeRequest()} onRespond={onRespond} />)

    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "想法" } })
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onRespond).not.toHaveBeenCalled()
  })
})

describe("DecisionCard · multi_select", () => {
  it("复选指示器是方角（rounded-md），不残留单选圆形 class（守护 O3）", () => {
    const { container } = render(
      <DecisionCard request={makeRequest({ multiSelect: true })} onRespond={vi.fn()} />,
    )
    const indicators = container.querySelectorAll(".rounded-md")
    expect(indicators.length).toBeGreaterThan(0)
    for (const el of Array.from(indicators)) {
      expect(el.className).not.toContain("rounded-full")
    }
  })

  it("勾多项提交回传多 verdict", () => {
    const onRespond = vi.fn()
    render(
      <DecisionCard request={makeRequest({ multiSelect: true })} onRespond={onRespond} />,
    )

    fireEvent.click(screen.getByText("方案甲"))
    fireEvent.click(screen.getByText("方案乙"))
    fireEvent.click(screen.getByRole("button", { name: /提交/ }))

    const decisions = onRespond.mock.calls[0][1]
    expect(decisions).toHaveLength(2)
    expect(decisions.map((d: { optionId: string }) => d.optionId).sort()).toEqual(["a", "b"])
  })
})

describe("DecisionCard · confirm（inline_confirmation）", () => {
  const confirmRequest = makeRequest({
    kind: "inline_confirmation",
    title: "确认清理吗",
    description: "将删除 3 个 worktree",
    options: [
      { id: "confirm", label: "确认" },
      { id: "cancel", label: "取消" },
    ],
  })

  it("渲染 description 上下文", () => {
    render(<DecisionCard request={confirmRequest} onRespond={vi.fn()} />)
    expect(screen.getByText("将删除 3 个 worktree")).toBeTruthy()
  })

  it("点确认 → confirm approved + cancel rejected", () => {
    const onRespond = vi.fn()
    render(<DecisionCard request={confirmRequest} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole("button", { name: "确认" }))
    expect(onRespond).toHaveBeenCalledWith(
      "req-1",
      [
        { optionId: "confirm", verdict: "approved" },
        { optionId: "cancel", verdict: "rejected" },
      ],
      undefined,
    )
  })

  it("点取消 → confirm rejected + cancel approved", () => {
    const onRespond = vi.fn()
    render(<DecisionCard request={confirmRequest} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(onRespond).toHaveBeenCalledWith(
      "req-1",
      [
        { optionId: "confirm", verdict: "rejected" },
        { optionId: "cancel", verdict: "approved" },
      ],
      undefined,
    )
  })
})

describe("DecisionRecordCard · disabled 态", () => {
  it("resolved: 无可点按钮 + 所选高亮 + 已确认足注", () => {
    render(<DecisionRecordCard record={makeRecord()} />)

    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByText("方案甲")).toBeTruthy()
    expect(screen.getByText(/已确认/)).toBeTruthy()
    const approvedRow = screen.getByTestId("record-option-a")
    const rejectedRow = screen.getByTestId("record-option-b")
    expect(approvedRow.dataset.verdict).toBe("approved")
    expect(rejectedRow.dataset.verdict).toBe("rejected")
  })

  it("timeout: 超时自动处理足注", () => {
    render(<DecisionRecordCard record={makeRecord({ status: "timeout" })} />)
    expect(screen.getByText(/超时自动处理/)).toBeTruthy()
  })

  it("orphaned: 已过期足注", () => {
    render(<DecisionRecordCard record={makeRecord({ status: "orphaned", verdicts: undefined })} />)
    expect(screen.getByText(/已过期/)).toBeTruthy()
  })

  it("userInput 显示补充说明", () => {
    render(<DecisionRecordCard record={makeRecord({ userInput: "轻量优先" })} />)
    expect(screen.getByText(/轻量优先/)).toBeTruthy()
  })
})
