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
import { useState } from "react"
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
      expect(screen.getByText(/结构检查通过/)).toBeTruthy()
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

    await waitFor(() => screen.getByText(/结构检查通过/))

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
              layer: "prompt_structure",
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

    await waitFor(() => screen.getByText(/结构检查 FAIL/))
    expect(screen.getByText(/Prompt 结构/)).toBeTruthy()
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

    await waitFor(() => screen.getByText(/结构检查通过/))

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

    await waitFor(() => screen.getByText(/结构检查通过/))
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

  it("补丁#3 · commit 成功 → 显式成功面板含 finalPath（小孙「好了没好看不懂」）", async () => {
    mockSequence([
      { ok: true, status: 200, json: { ok: true, audit: { passed: true } } },
      {
        ok: true,
        status: 200,
        json: { ok: true, finalPath: "wiki/concepts/rag.md", eventId: 7 },
      },
    ])
    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/rag.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    await waitFor(() => screen.getByText(/结构检查通过/))
    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "wiki/concepts/rag.md" },
    })
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "整理" } })
    fireEvent.click(screen.getByRole("button", { name: "Promote" }))

    // 成功后不再静默消失：modal 内显式成功面板 + 落地路径
    const ok = await screen.findByTestId("promote-success")
    expect(ok.textContent).toContain("wiki/concepts/rag.md")
    // 成功后表单输入隐去（不再让用户误以为还要再点）
    expect(screen.queryByLabelText("Target wiki path")).toBeNull()
  })

  it("补丁#3 · commit 进行中 → 显式进度态（spinner + 文案），不只是弱文字", async () => {
    let resolveCommit: ((v: unknown) => void) | undefined
    let call = 0
    globalThis.fetch = vi.fn(() => {
      call++
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, audit: { passed: true } }),
        }) as unknown as Promise<Response>
      }
      return new Promise((res) => {
        resolveCommit = (v) =>
          res({ ok: true, status: 200, json: () => Promise.resolve(v) } as Response)
      }) as unknown as Promise<Response>
    }) as unknown as typeof fetch

    render(
      <PromoteModal
        open={true}
        srcDraftPath="wiki/concepts/draft/_auto/rag.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    await waitFor(() => screen.getByText(/结构检查通过/))
    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "wiki/concepts/rag.md" },
    })
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "整理" } })
    fireEvent.click(screen.getByRole("button", { name: "Promote" }))

    // 提交在飞 → 进度态可见
    expect(await screen.findByTestId("promote-progress")).toBeTruthy()
    resolveCommit?.({ ok: true, finalPath: "wiki/concepts/rag.md", eventId: 7 })
    await screen.findByTestId("promote-success")
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

    await waitFor(() => screen.getByText(/结构检查通过/))
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

  it("(7a) codex r3 P1: onPromoteSuccess 多次 render 只 call 一次 (防 refetch loop)", async () => {
    mockSequence([
      { ok: true, status: 200, json: { ok: true, audit: { passed: true } } },
      {
        ok: true,
        status: 200,
        json: { ok: true, finalPath: "/tmp/wiki/concepts/rag.md", eventId: 42 },
      },
    ])

    let callCount = 0
    // Wrapper component that re-renders parent multiple times after promote success
    // (simulates real-world parent using useDraftsData whose refetch identity changes per render)
    function Wrapper() {
      const [_, setForceRerender] = useState(0)
      const onPromoteSuccess = () => {
        callCount++
        // simulate parent re-rendering (refetch identity change)
        setTimeout(() => setForceRerender((n) => n + 1), 0)
        setTimeout(() => setForceRerender((n) => n + 1), 10)
        setTimeout(() => setForceRerender((n) => n + 1), 20)
      }
      return (
        <PromoteModal
          open={true}
          srcDraftPath="wiki/concepts/draft/_auto/rag.md"
          callerAlias="黄仁勋"
          onClose={() => {}}
          onPromoteSuccess={onPromoteSuccess}
        />
      )
    }

    render(<Wrapper />)
    await waitFor(() => screen.getByText(/结构检查通过/))
    fireEvent.change(screen.getByLabelText("Target wiki path"), {
      target: { value: "wiki/concepts/rag.md" },
    })
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "首批整理" } })
    fireEvent.click(screen.getByRole("button", { name: "Promote" }))

    // wait for the simulated re-renders to complete (50ms covers all 3 setTimeout)
    await new Promise((r) => setTimeout(r, 80))

    // P1 guard: 即使 parent re-render 多次 + onPromoteSuccess identity 变,
    //   notifiedRef 已 set 防 effect 重 call → callCount 仍是 1
    expect(callCount).toBe(1)
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
