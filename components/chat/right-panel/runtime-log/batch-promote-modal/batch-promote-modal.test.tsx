/**
 * F027 P4 Week 3 Day 12 (AC-P4-4) · BatchPromoteModal 单元测试
 *
 * 覆盖:
 *   (1) open=false → 不渲染
 *   (2) open=true + rows.length=3 → 渲染 header + 3 行 src + 自动推断 dest
 *   (3) dest 改成 invalid → 行内红字 + submit 禁用
 *   (4) reason 空/填 → submit 禁用/启用
 *   (5) ✕ 删除中间行 → rows 减 1 + header 更新
 *   (6) submit happy path 3 成功 → POST 调用 + report view success=3 / failed=0
 *   (7) 部分失败 2 成功 + 1 audit_rejected → report view failed row 含 layer/matched/hint
 *   (8) onBatchComplete 多次 render 只调一次 (notifiedRef guard)
 *   (9) submit network error → 留 compose phase + 显示 error
 *  (10) report phase [关闭] → onClose 被调
 *  (11) suggestDestWikiPath helper 推断正确
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BatchPromoteModal } from "./batch-promote-modal"
import { suggestDestWikiPath } from "./use-batch-promote-api"

function mockOnce(response: { ok: boolean; status: number; json: unknown }) {
  globalThis.fetch = vi.fn(
    () =>
      Promise.resolve({
        ok: response.ok,
        status: response.status,
        json: () => Promise.resolve(response.json),
      }) as unknown as Promise<Response>,
  ) as unknown as typeof fetch
}

function mockReject(message: string) {
  globalThis.fetch = vi.fn(() => Promise.reject(new Error(message))) as unknown as typeof fetch
}

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

const THREE_ROWS = [
  { srcDraftPath: "wiki/concepts/draft/_auto/a.md", displayTitle: "A draft" },
  { srcDraftPath: "wiki/concepts/draft/_auto/b.md", displayTitle: "B draft" },
  { srcDraftPath: "wiki/concepts/draft/_auto/c.md", displayTitle: "C draft" },
] as const

describe("BatchPromoteModal", () => {
  it("(1) open=false → 不渲染", () => {
    const { container } = render(
      <BatchPromoteModal open={false} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("(2) open=true + rows.length=3 → header + 3 src + 自动推断 dest", () => {
    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )

    expect(screen.getByText("批量审批 3 份 draft → wiki")).toBeTruthy()
    // 每行显示 displayTitle
    expect(screen.getByText("A draft")).toBeTruthy()
    expect(screen.getByText("B draft")).toBeTruthy()
    expect(screen.getByText("C draft")).toBeTruthy()
    // 每行 dest input 默认值 = suggestDestWikiPath
    const destA = screen.getByLabelText(
      "dest path for wiki/concepts/draft/_auto/a.md",
    ) as HTMLInputElement
    expect(destA.value).toBe("wiki/concepts/a.md")
  })

  it("补丁#3 · submitting 阶段显示分批进度（已提交 X/Y，小孙进度条）", async () => {
    let release: ((v: unknown) => void) | undefined
    globalThis.fetch = vi.fn(
      () =>
        new Promise((res) => {
          release = (v) =>
            res({ ok: true, status: 200, json: () => Promise.resolve(v) } as Response)
        }),
    ) as unknown as typeof fetch

    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "首批" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))

    // 提交在飞 → 进度态显示 已提交 0/3
    const prog = await screen.findByTestId("batch-promote-progress")
    expect(prog.textContent).toContain("0/3")

    release?.({ ok: true, total: 3, success: [], failed: [] })
    await waitFor(() => screen.getByText(/批量审批结果/))
  })

  it("(3) dest 改成 invalid → 行内红字 + submit 禁用", () => {
    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    // 先填 reason 排除 reason 禁因
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "首批" } })

    const submitBtn = screen.getByTestId("batch-promote-submit") as HTMLButtonElement
    expect(submitBtn.disabled).toBe(false)

    // 改 B 的 dest 成 invalid
    fireEvent.change(screen.getByLabelText("dest path for wiki/concepts/draft/_auto/b.md"), {
      target: { value: "invalid/x.md" },
    })

    expect(screen.getAllByText(/路径需以/).length).toBeGreaterThan(0)
    expect(submitBtn.disabled).toBe(true)
  })

  it("(4) reason 空 → submit 禁用，填了 → 启用", () => {
    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    const submitBtn = screen.getByTestId("batch-promote-submit") as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true) // reason 空

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "首批" } })
    expect(submitBtn.disabled).toBe(false)
  })

  it("(5) ✕ 删除中间行 → rows 减 1 + header 更新", () => {
    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    fireEvent.click(screen.getByTestId("batch-promote-remove-wiki/concepts/draft/_auto/b.md"))
    expect(screen.getByText("批量审批 2 份 draft → wiki")).toBeTruthy()
    expect(screen.queryByText("B draft")).toBeNull()
  })

  it("(6) submit happy path 3 成功 → report view success=3 failed=0", async () => {
    mockOnce({
      ok: true,
      status: 200,
      json: {
        ok: true,
        total: 3,
        success: [
          {
            srcDraftPath: "wiki/concepts/draft/_auto/a.md",
            destWikiPath: "wiki/concepts/a.md",
            finalPath: "/tmp/wiki/concepts/a.md",
            eventId: 1,
          },
          {
            srcDraftPath: "wiki/concepts/draft/_auto/b.md",
            destWikiPath: "wiki/concepts/b.md",
            finalPath: "/tmp/wiki/concepts/b.md",
            eventId: 2,
          },
          {
            srcDraftPath: "wiki/concepts/draft/_auto/c.md",
            destWikiPath: "wiki/concepts/c.md",
            finalPath: "/tmp/wiki/concepts/c.md",
            eventId: 3,
          },
        ],
        failed: [],
      },
    })

    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "首批整理" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))

    await waitFor(() => {
      expect(screen.getByTestId("batch-promote-report")).toBeTruthy()
    })
    expect(screen.getByText(/批量审批结果 · 3 成功 \/ 0 失败/)).toBeTruthy()
    expect(screen.getByText("✅ Success: 3 份")).toBeTruthy()
    expect(screen.getByText("❌ Failed: 0 份")).toBeTruthy()
  })

  it("(7) 部分失败 2 成功 + 1 audit_rejected → failed row 含 layer/matched/hint", async () => {
    mockOnce({
      ok: true,
      status: 200,
      json: {
        ok: true,
        total: 3,
        success: [
          {
            srcDraftPath: "wiki/concepts/draft/_auto/a.md",
            destWikiPath: "wiki/concepts/a.md",
            finalPath: "/tmp/wiki/concepts/a.md",
            eventId: 1,
          },
          {
            srcDraftPath: "wiki/concepts/draft/_auto/c.md",
            destWikiPath: "wiki/concepts/c.md",
            finalPath: "/tmp/wiki/concepts/c.md",
            eventId: 3,
          },
        ],
        failed: [
          {
            srcDraftPath: "wiki/concepts/draft/_auto/b.md",
            destWikiPath: "wiki/concepts/b.md",
            status: "audit_rejected",
            error: "V14 reject",
            auditReject: {
              layer: "llm_semantic_injection",
              matchedPatterns: ["必须", "ignore"],
              hint: "改写为陈述句",
            },
          },
        ],
      },
    })

    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "试试" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))

    await waitFor(() => {
      expect(screen.getByTestId("batch-promote-report")).toBeTruthy()
    })
    expect(screen.getByText("✅ Success: 2 份")).toBeTruthy()
    expect(screen.getByText("❌ Failed: 1 份")).toBeTruthy()
    // failed row 内含 status badge 中文 + auditReject layer/matched/hint
    expect(
      screen.getByTestId("batch-promote-failed-status-wiki/concepts/draft/_auto/b.md").textContent,
    ).toContain("审计驳回")
    expect(screen.getByText(/LLM 语义注入/)).toBeTruthy()
    expect(screen.getByText(/必须 \/ ignore/)).toBeTruthy()
    expect(screen.getByText(/改写为陈述句/)).toBeTruthy()
    // 失败留原位提示
    expect(screen.getByText(/失败的 1 份 draft 留在原位/)).toBeTruthy()
  })

  it("(8) onBatchComplete 多次 render 只调一次 (防 refetch loop)", async () => {
    mockOnce({
      ok: true,
      status: 200,
      json: {
        ok: true,
        total: 1,
        success: [
          {
            srcDraftPath: "wiki/concepts/draft/_auto/a.md",
            destWikiPath: "wiki/concepts/a.md",
            finalPath: "/tmp/wiki/concepts/a.md",
            eventId: 1,
          },
        ],
        failed: [],
      },
    })

    let callCount = 0
    function Wrapper() {
      const [_, setForce] = useState(0)
      const onBatchComplete = () => {
        callCount++
        setTimeout(() => setForce((n) => n + 1), 0)
        setTimeout(() => setForce((n) => n + 1), 10)
        setTimeout(() => setForce((n) => n + 1), 20)
      }
      return (
        <BatchPromoteModal
          open={true}
          rows={[{ srcDraftPath: "wiki/concepts/draft/_auto/a.md" }]}
          callerAlias="小孙"
          onClose={() => {}}
          onBatchComplete={onBatchComplete}
        />
      )
    }

    render(<Wrapper />)
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "试" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))

    await waitFor(() => screen.getByTestId("batch-promote-report"))
    await new Promise((r) => setTimeout(r, 80))

    expect(callCount).toBe(1)
  })

  it("(9) submit network error → 留 compose phase + 显示 error", async () => {
    mockReject("Failed to fetch")
    render(
      <BatchPromoteModal open={true} rows={THREE_ROWS} callerAlias="小孙" onClose={() => {}} />,
    )
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "试" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))

    await waitFor(() => {
      expect(screen.getByTestId("batch-promote-error")).toBeTruthy()
    })
    // 留 compose phase (still 显示 rows 列表)
    expect(screen.getByTestId("batch-promote-rows")).toBeTruthy()
    expect(screen.queryByTestId("batch-promote-report")).toBeNull()
  })

  it("(10) report phase [关闭] → onClose 被调", async () => {
    mockOnce({
      ok: true,
      status: 200,
      json: {
        ok: true,
        total: 1,
        success: [
          {
            srcDraftPath: "wiki/concepts/draft/_auto/a.md",
            destWikiPath: "wiki/concepts/a.md",
            finalPath: "/tmp/wiki/concepts/a.md",
            eventId: 1,
          },
        ],
        failed: [],
      },
    })

    const onClose = vi.fn()
    render(
      <BatchPromoteModal
        open={true}
        rows={[{ srcDraftPath: "wiki/concepts/draft/_auto/a.md" }]}
        callerAlias="小孙"
        onClose={onClose}
      />,
    )
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "试" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))
    await waitFor(() => screen.getByTestId("batch-promote-close"))
    fireEvent.click(screen.getByTestId("batch-promote-close"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("(10a) codex mid-r1 P1: open=true 状态下 rows 变 → phase 不被重置 (防 batch report 被清)", async () => {
    mockOnce({
      ok: true,
      status: 200,
      json: {
        ok: true,
        total: 1,
        success: [
          {
            srcDraftPath: "wiki/concepts/draft/_auto/a.md",
            destWikiPath: "wiki/concepts/a.md",
            finalPath: "/tmp/wiki/concepts/a.md",
            eventId: 1,
          },
        ],
        failed: [],
      },
    })

    // Wrapper 允许动态改 rows
    function Wrapper({ rows }: { rows: readonly { srcDraftPath: string }[] }) {
      return (
        <BatchPromoteModal
          open={true}
          rows={rows}
          callerAlias="小孙"
          onClose={() => {}}
          onBatchComplete={() => {}}
        />
      )
    }

    const initialRows = [{ srcDraftPath: "wiki/concepts/draft/_auto/a.md" }]
    const { rerender } = render(<Wrapper rows={initialRows} />)

    // 提交 + 等 report phase
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "首批" } })
    fireEvent.click(screen.getByTestId("batch-promote-submit"))
    await waitFor(() => screen.getByTestId("batch-promote-report"))

    // 关键: parent re-render 传新 rows (模拟成功后 selectedPaths 被清/数据 refetch 导致 rows 变 [])
    rerender(<Wrapper rows={[]} />)

    // 仍应停在 report phase, 不被重置回 compose
    expect(screen.getByTestId("batch-promote-report")).toBeTruthy()
    expect(screen.queryByTestId("batch-promote-rows")).toBeNull()
  })

  it("(11) suggestDestWikiPath helper 推断正确", () => {
    expect(suggestDestWikiPath("wiki/concepts/draft/_auto/rag.md")).toBe("wiki/concepts/rag.md")
    expect(suggestDestWikiPath("wiki/methods/draft/x.md")).toBe("wiki/methods/x.md")
    expect(suggestDestWikiPath("wiki/concepts/_drafts/x.md")).toBe("wiki/concepts/x.md")
    // 不像 draft path → 原样返
    expect(suggestDestWikiPath("wiki/concepts/x.md")).toBe("wiki/concepts/x.md")
  })
})

describe("BatchPromoteModal · suggestedDestPath 行初值（F027 bucket-routing 补丁）", () => {
  it("row 带 suggestedDestPath → dest 初值用建议桶；缺省行退回路径推导", () => {
    render(
      <BatchPromoteModal
        open={true}
        rows={[
          {
            srcDraftPath: "wiki/concepts/draft/_auto/m.md",
            displayTitle: "M",
            suggestedDestPath: "wiki/methods/m.md",
          },
          { srcDraftPath: "wiki/concepts/draft/_auto/c.md", displayTitle: "C" },
        ]}
        callerAlias="小孙"
        onClose={() => {}}
      />,
    )
    expect(screen.getByDisplayValue("wiki/methods/m.md")).toBeTruthy()
    expect(screen.getByDisplayValue("wiki/concepts/c.md")).toBeTruthy()
  })
})
