/**
 * F027 P4 Week 2 Day 8 (AC-P4-1 + AC-P4-2) · PromoteModal 单元测试
 *
 * 覆盖:
 *   - (1) open=false → 不渲染
 *   - (2) open=true + srcDraftPath → 渲染 header + draft info + V14 audit panel
 *   - (3) V14 audit success (passed=true) → 绿色 PASS + [Promote] 可点 (after fill dest+reason)
 *   - (4) V14 audit reject (passed=false layer=imperative) → 红 panel 显示 reject + [Promote] 禁用
 *   - (5) destWikiPath 非 allowed prefix → 输入校验红字 + [Promote] 禁
 *   - (6) commit happy path → onPromoteSuccess 回调
 *   - (7) commit 422 reject (AC-P4-2) → commit reject panel 显示 + draft 留原位 (调用者验证)
 *   - (8) 取消按钮 → onClose
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PromoteModal } from "./promote-modal"

function mockSequence(responses: Array<{ ok: boolean; status: number; json: unknown }>) {
  let idx = 0
  globalThis.fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[idx++] ?? responses[responses.length - 1]
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve(r.json),
    }) as unknown as Promise<Response>
  }) as unknown as typeof fetch
}

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("PromoteModal", () => {
  it("(1) open=false → renders nothing", () => {
    const { container } = render(
      <PromoteModal
        open={false}
        srcDraftPath="wiki/concepts/draft/_auto/x.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("(2) open=true + srcDraftPath → renders dialog + draft info", async () => {
    mockSequence([{ ok: true, status: 200, json: { ok: true, audit: { passed: true } } }])
    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/rag.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("wiki/concepts/draft/_auto/rag.md")).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText(/V14 二次审计 PASS/)).toBeTruthy()
    })
  })

  it("(3) V14 audit success → [Promote] enabled after fill dest + reason", async () => {
    mockSequence([{ ok: true, status: 200, json: { ok: true, audit: { passed: true } } }])
    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/rag.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )

    await waitFor(() => screen.getByText(/V14 二次审计 PASS/))

    const promoteBtn = screen.getByRole("button", { name: "Promote" }) as HTMLButtonElement
    expect(promoteBtn.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "wiki/concepts/rag.md" },
    })
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "首批整理" },
    })

    expect(promoteBtn.disabled).toBe(false)
  })

  it("(4) V14 audit reject (layer=imperative) → red panel + [Promote] disabled", async () => {
    mockSequence([
      {
        ok: true,
        status: 200,
        json: {
          ok: true,
          audit: {
            passed: false,
            rejectReason: {
              layer: "imperative_statement",
              matchedPatterns: ["必须", "ignore"],
              hint: "改写为陈述句",
            },
          },
        },
      },
    ])

    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/bad.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )

    await waitFor(() => screen.getByText(/V14 二次审计 FAIL/))
    expect(screen.getByText(/命令式语句/)).toBeTruthy()
    expect(screen.getByText(/必须 \/ ignore/)).toBeTruthy()
    expect(screen.getByText(/改写为陈述句/)).toBeTruthy()

    const promoteBtn = screen.getByRole("button", { name: "Promote" }) as HTMLButtonElement

    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "wiki/concepts/bad.md" },
    })
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "试试" },
    })

    // even with valid dest+reason, audit reject keeps button disabled
    expect(promoteBtn.disabled).toBe(true)
  })

  it("(5) destWikiPath 非 allowed prefix → 红字 + [Promote] disabled", async () => {
    mockSequence([{ ok: true, status: 200, json: { ok: true, audit: { passed: true } } }])
    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/x.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )

    await waitFor(() => screen.getByText(/V14 二次审计 PASS/))

    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "invalid/path/x.md" },
    })

    expect(screen.getByText(/路径需以/)).toBeTruthy()
    const promoteBtn = screen.getByRole("button", { name: "Promote" }) as HTMLButtonElement
    expect(promoteBtn.disabled).toBe(true)
  })

  it("(6) commit happy path → onPromoteSuccess called", async () => {
    mockSequence([
      { ok: true, status: 200, json: { ok: true, audit: { passed: true } } },
      {
        ok: true,
        status: 200,
        json: { ok: true, finalPath: "/tmp/wiki/concepts/rag.md", eventId: 42 },
      },
    ])

    const onPromoteSuccess = vi.fn()
    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/rag.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
        onPromoteSuccess={onPromoteSuccess}
      />,
    )

    await waitFor(() => screen.getByText(/V14 二次审计 PASS/))
    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "wiki/concepts/rag.md" },
    })
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "首批整理" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Promote" }))

    await waitFor(
      () => {
        expect(onPromoteSuccess).toHaveBeenCalledWith({
          ok: true,
          finalPath: "/tmp/wiki/concepts/rag.md",
          eventId: 42,
        })
      },
      { timeout: 3000 },
    )
  })

  it("(7) commit 422 reject (AC-P4-2) → commit reject panel 显示 (用户改 body 重试)", async () => {
    // preview pass, commit 422 reject (服务端 V14 二次跑时 reject — 罕见但 plan v5 锁的 path)
    mockSequence([
      { ok: true, status: 200, json: { ok: true, audit: { passed: true } } },
      {
        ok: false,
        status: 422,
        json: {
          ok: false,
          code: "AUDIT_REJECTED",
          audit: {
            layer: "prompt_structure",
            matchedPatterns: ["system: 行"],
            hint: "不能含 prompt 结构标记",
          },
        },
      },
    ])

    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/sneaky.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )

    await waitFor(() => screen.getByText(/V14 二次审计 PASS/))
    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "wiki/concepts/sneaky.md" },
    })
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "试试" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Promote" }))

    await waitFor(() => {
      expect(screen.getByText(/Promote 被拒（commit 阶段二次审计 fail/)).toBeTruthy()
    })
    expect(screen.getByText(/Prompt 结构/)).toBeTruthy()
    expect(screen.getByText(/system: 行/)).toBeTruthy()
  })

  it("(8) 取消按钮 → onClose", async () => {
    mockSequence([{ ok: true, status: 200, json: { ok: true, audit: { passed: true } } }])
    const onClose = vi.fn()
    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/rag.md"
        callerAlias="黄仁勋"
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
