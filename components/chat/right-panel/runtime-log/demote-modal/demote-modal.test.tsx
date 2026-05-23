/**
 * F027 P4 AC-P4-3 (a)(d) (codex Week 5 j2 FAIL Red→Green) · DemoteModal 单元测试
 *
 * 覆盖:
 *   (1) open=false → 不渲染
 *   (2) open=true + srcWikiPath → 渲染 dialog + src info
 *   (3) reason 空 → [Demote] 禁用
 *   (4) reason 填好 + click [Demote] → 成功显示 rejectedPath
 *   (5) demote 失败 (DENIED_ACL) → 红 error panel
 *   (6) 取消按钮 → onClose 调用
 *   (7) 成功后 onDemoteSuccess 回调
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DemoteModal } from "./demote-modal"

function mockResponse(response: { ok: boolean; status: number; json: unknown }) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.json),
    }) as unknown as Promise<Response>,
  ) as unknown as typeof fetch
}

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DemoteModal", () => {
  it("(1) open=false → renders nothing", () => {
    const { container } = render(
      <DemoteModal
        open={false}
        srcWikiPath="wiki/concepts/foo.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("(2) open=true + srcWikiPath → renders dialog + src info", () => {
    render(
      <DemoteModal
        open={true}
        srcWikiPath="wiki/concepts/rag-overview.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByText("wiki/concepts/rag-overview.md")).toBeTruthy()
  })

  it("(3) reason 空 → [Demote 拒绝] 禁用", () => {
    render(
      <DemoteModal
        open={true}
        srcWikiPath="wiki/concepts/foo.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    const btn = screen.getByRole("button", { name: /Demote 拒绝/ })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it("(4) reason 填好 + click [Demote] → success 显示 rejectedPath", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        ok: true,
        rejectedPath:
          "/tmp/wiki-root/wiki/_rejected/concepts--rag-overview.md",
        eventId: 42,
      },
    })
    render(
      <DemoteModal
        open={true}
        srcWikiPath="wiki/concepts/rag-overview.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
      />,
    )
    const textarea = screen.getByLabelText("Reason") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "spec 已 supersede" } })
    const btn = screen.getByRole("button", { name: /Demote 拒绝/ })
    fireEvent.click(btn)
    await waitFor(() => {
      expect(screen.getByText(/Demote 成功/)).toBeTruthy()
      expect(screen.getByText(/wiki\/_rejected\/concepts--rag-overview\.md/)).toBeTruthy()
      expect(screen.getByText(/wiki_events.id = 42/)).toBeTruthy()
    })
  })

  it("(5) demote 失败 (DENIED_ACL) → 红 error panel", async () => {
    mockResponse({
      ok: false,
      status: 403,
      json: { ok: false, code: "DENIED_ACL", error: "no demote permission" },
    })
    render(
      <DemoteModal
        open={true}
        srcWikiPath="wiki/concepts/foo.md"
        callerAlias="桂芬"
        onClose={() => {}}
      />,
    )
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "test" },
    })
    fireEvent.click(screen.getByRole("button", { name: /Demote 拒绝/ }))
    await waitFor(() => {
      expect(screen.getByText(/Demote 失败/)).toBeTruthy()
      expect(screen.getByText(/DENIED_ACL/)).toBeTruthy()
    })
  })

  it("(6) 取消按钮 → onClose 调用", () => {
    const onClose = vi.fn()
    render(
      <DemoteModal
        open={true}
        srcWikiPath="wiki/concepts/foo.md"
        callerAlias="黄仁勋"
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "取消" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("(7) 成功后 onDemoteSuccess 回调", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: { ok: true, rejectedPath: "/tmp/r/foo", eventId: 7 },
    })
    const onSuccess = vi.fn()
    render(
      <DemoteModal
        open={true}
        srcWikiPath="wiki/concepts/foo.md"
        callerAlias="黄仁勋"
        onClose={() => {}}
        onDemoteSuccess={onSuccess}
      />,
    )
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "test" } })
    fireEvent.click(screen.getByRole("button", { name: /Demote 拒绝/ }))
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onSuccess.mock.calls[0][0].eventId).toBe(7)
    })
  })
})
