import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { AtPill, deriveAtPillStatus, deriveLiveAtPillStatus, type AtPillStatus } from "./at-pill"

function setup(overrides: { status?: AtPillStatus; onRetry?: () => void } = {}) {
  return render(
    <AtPill
      targetAlias={overrides.status === "sending" ? undefined : "桂芬"}
      status={overrides.status ?? "working"}
      onRetry={overrides.onRetry}
    />,
  )
}

describe("F026 P5 F1 · AtPill 六态状态机", () => {
  it("renders sending state with hourglass + 派发中 label", () => {
    render(<AtPill targetAlias={undefined} status="sending" />)
    const pill = screen.getByTestId("at-pill")
    expect(pill.textContent).toMatch(/派发中/)
    expect(pill.dataset.status).toBe("sending")
  })

  it("renders ack state — 已阅 + alias", () => {
    setup({ status: "ack" })
    const pill = screen.getByTestId("at-pill")
    expect(pill.textContent).toMatch(/桂芬/)
    expect(pill.textContent).toMatch(/已阅/)
    expect(pill.dataset.status).toBe("ack")
  })

  it("renders working state — 处理中 + alias", () => {
    setup({ status: "working" })
    const pill = screen.getByTestId("at-pill")
    expect(pill.textContent).toMatch(/桂芬/)
    expect(pill.textContent).toMatch(/处理中/)
    expect(pill.dataset.status).toBe("working")
  })

  it("renders done state — 已完成 + alias", () => {
    setup({ status: "done" })
    const pill = screen.getByTestId("at-pill")
    expect(pill.textContent).toMatch(/已完成/)
    expect(pill.dataset.status).toBe("done")
  })

  it("renders timeout state — 超时 + alias", () => {
    setup({ status: "timeout" })
    const pill = screen.getByTestId("at-pill")
    expect(pill.textContent).toMatch(/超时/)
    expect(pill.dataset.status).toBe("timeout")
  })

  it("renders error state — 失败 + alias", () => {
    setup({ status: "error" })
    const pill = screen.getByTestId("at-pill")
    expect(pill.textContent).toMatch(/失败/)
    expect(pill.dataset.status).toBe("error")
  })

  it("shows retry button on timeout when onRetry provided", () => {
    const onRetry = vi.fn()
    setup({ status: "timeout", onRetry })
    const button = screen.getByTestId("at-pill-retry")
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("shows retry button on error when onRetry provided", () => {
    const onRetry = vi.fn()
    setup({ status: "error", onRetry })
    expect(screen.getByTestId("at-pill-retry")).toBeTruthy()
    fireEvent.click(screen.getByTestId("at-pill-retry"))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("hides retry button on done state even when onRetry provided", () => {
    setup({ status: "done", onRetry: () => {} })
    expect(screen.queryByTestId("at-pill-retry")).toBeNull()
  })

  it("hides retry button on working state even when onRetry provided", () => {
    setup({ status: "working", onRetry: () => {} })
    expect(screen.queryByTestId("at-pill-retry")).toBeNull()
  })

  it("hides retry button when onRetry not provided (no broken UI)", () => {
    setup({ status: "error" })
    expect(screen.queryByTestId("at-pill-retry")).toBeNull()
  })
})

describe("F026 P5 F1 · deriveAtPillStatus mapping a2a_calls.status → pill", () => {
  it("maps undefined → sending", () => {
    expect(deriveAtPillStatus(undefined)).toBe("sending")
  })

  it("maps null → sending", () => {
    expect(deriveAtPillStatus(null)).toBe("sending")
  })

  it("maps pending → ack", () => {
    expect(deriveAtPillStatus("pending")).toBe("ack")
  })

  it("maps working → working", () => {
    expect(deriveAtPillStatus("working")).toBe("working")
  })

  it("maps done → done", () => {
    expect(deriveAtPillStatus("done")).toBe("done")
  })

  it("maps timeout → timeout", () => {
    expect(deriveAtPillStatus("timeout")).toBe("timeout")
  })

  it("maps failed → error", () => {
    expect(deriveAtPillStatus("failed")).toBe("error")
  })

  it("maps cancelled → error", () => {
    expect(deriveAtPillStatus("cancelled")).toBe("error")
  })

  it("falls back to sending for unknown status (forward compat)", () => {
    expect(deriveAtPillStatus("totally-new-state")).toBe("sending")
  })
})

/**
 * F026 P5 F1 follow-up · deriveLiveAtPillStatus
 *
 * connector_message 上 LEFT JOIN 来的 a2aCallStatus 只是 message.created 那一瞬间的快照；
 * 之后 a2a_calls.status 流转（pending→working→done）只 emit `pending.change` 喂
 * thread-store.pendingByRoot —— message envelope 不重发，导致 AtPill 永远停在第一次拿到的状态。
 *
 * 修复：AtPill 在 connector-bubble 里改吃 deriveLiveAtPillStatus(message, pendingByRoot)，
 * 优先从 pendingByRoot[rootCallId] 里按 callId 反查实时 status；不在 pendingSet 里
 * （已 settle / root 已收口 / 字段缺失）才 fallback 到 snapshot。
 */
describe("F026 P5 F1 · deriveLiveAtPillStatus · 实时 status 反查 pendingByRoot", () => {
  type PendingByRoot = Parameters<typeof deriveLiveAtPillStatus>[1]

  function msg(
    callId: string | null,
    rootCallId: string | null,
    snapshotStatus: string | null = null,
  ) {
    return { a2aCallId: callId, a2aRootCallId: rootCallId, a2aCallStatus: snapshotStatus }
  }

  it("callId 在 pendingSet + entry.status='pending' → 'ack'（实时态优先 snapshot）", () => {
    const pendingByRoot: PendingByRoot = {
      "call-root": [{ callId: "call-c1", alias: "桂芬", status: "pending" }],
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", null), pendingByRoot),
    ).toBe("ack")
  })

  it("callId 在 pendingSet + entry.status='working' → 'working'", () => {
    const pendingByRoot: PendingByRoot = {
      "call-root": [{ callId: "call-c1", alias: "桂芬", status: "working" }],
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), pendingByRoot),
    ).toBe("working")
  })

  it("callId 已离开 pendingSet（settle 后被剔除）→ fallback 到 snapshot=done", () => {
    const pendingByRoot: PendingByRoot = {
      "call-root": [{ callId: "call-other", alias: "范德彪", status: "pending" }],
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "done"), pendingByRoot),
    ).toBe("done")
  })

  it("rootCallId key 不在 pendingByRoot（root 已收口）→ fallback 到 snapshot=done", () => {
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "done"), {}),
    ).toBe("done")
  })

  it("snapshot=timeout + 不在 pendingSet → 'timeout'（六态完整传递）", () => {
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "timeout"), {}),
    ).toBe("timeout")
  })

  it("a2aCallId null → fallback 到 snapshot（不查 store）", () => {
    const pendingByRoot: PendingByRoot = {
      "call-root": [{ callId: "call-c1", alias: "桂芬", status: "working" }],
    }
    expect(
      deriveLiveAtPillStatus(msg(null, "call-root", "pending"), pendingByRoot),
    ).toBe("ack") // snapshot pending → ack
  })

  it("a2aRootCallId null → fallback 到 snapshot（不查 store）", () => {
    const pendingByRoot: PendingByRoot = {
      "call-root": [{ callId: "call-c1", alias: "桂芬", status: "pending" }],
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", null, "working"), pendingByRoot),
    ).toBe("working")
  })

  it("两个 id 都 null + snapshot null → 'sending'（默认 fallback）", () => {
    expect(deriveLiveAtPillStatus(msg(null, null, null), {})).toBe("sending")
  })

  it("实时态压过 snapshot（race: snapshot 还 pending 但 store 已 working）", () => {
    const pendingByRoot: PendingByRoot = {
      "call-root": [{ callId: "call-c1", alias: "桂芬", status: "working" }],
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), pendingByRoot),
    ).toBe("working")
  })
})

/**
 * F026 review#4 fix · deriveLiveAtPillStatus 反查 settledByRoot terminal cache
 *
 * 范德彪 review#4 P1: pendingByRoot 命不中时 fallback 到 message envelope snapshot，
 * 但 envelope 不重发，settle/timeout 后 snapshot 仍是 pending → AtPill 永远卡在 ack。
 *
 * A' 修复：deriveLiveAtPillStatus 加第三参数 settledByRoot（terminal cache）。
 * 反查链路：pendingByRoot 命中 → settledByRoot 命中 → snapshot fallback。
 *
 * settledByRoot 不能在 root 收口（pendingSet 空 → 删 pendingByRoot key）时同步清，
 * 否则单 child settle 立即回落 snapshot=pending = ack（P1 还在）。
 * 仅在 active group 切换 / snapshot 重载时清。
 */
describe("F026 review#4 fix · deriveLiveAtPillStatus 反查 settledByRoot", () => {
  type SettledByRoot = Record<string, Record<string, "done" | "failed" | "timeout" | "cancelled">>

  function msg(
    callId: string | null,
    rootCallId: string | null,
    snapshotStatus: string | null = null,
  ) {
    return { a2aCallId: callId, a2aRootCallId: rootCallId, a2aCallStatus: snapshotStatus }
  }

  it("pendingByRoot 命不中 + settledByRoot 命中 status='done' → 'done'", () => {
    const pendingByRoot = {}
    const settledByRoot: SettledByRoot = {
      "call-root": { "call-c1": "done" },
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), pendingByRoot, settledByRoot),
    ).toBe("done")
  })

  it("settledByRoot 命中 status='timeout' → 'timeout'", () => {
    const settledByRoot: SettledByRoot = {
      "call-root": { "call-c1": "timeout" },
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), {}, settledByRoot),
    ).toBe("timeout")
  })

  it("settledByRoot 命中 status='failed' → 'error'", () => {
    const settledByRoot: SettledByRoot = {
      "call-root": { "call-c1": "failed" },
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), {}, settledByRoot),
    ).toBe("error")
  })

  it("settledByRoot 命中 status='cancelled' → 'error'", () => {
    const settledByRoot: SettledByRoot = {
      "call-root": { "call-c1": "cancelled" },
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), {}, settledByRoot),
    ).toBe("error")
  })

  it("pendingByRoot 命中 working 压过 settledByRoot（race 防御：实时优先终态）", () => {
    const pendingByRoot = {
      "call-root": [{ callId: "call-c1", alias: "桂芬", status: "working" as const }],
    }
    const settledByRoot: SettledByRoot = {
      "call-root": { "call-c1": "done" },
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), pendingByRoot, settledByRoot),
    ).toBe("working")
  })

  it("settledByRoot 命不中 + pendingByRoot 命不中 → fallback snapshot=pending → 'ack'", () => {
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), {}, {}),
    ).toBe("ack")
  })

  it("旧调用方不传 settledByRoot（向后兼容）→ 行为等价于空 cache", () => {
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), {}),
    ).toBe("ack")
  })

  it("root 收口（pendingByRoot 删 key）但 settledByRoot 仍在 → 显示终态 done（A' 关键场景）", () => {
    const settledByRoot: SettledByRoot = {
      "call-root": { "call-c1": "done" },
    }
    expect(
      deriveLiveAtPillStatus(msg("call-c1", "call-root", "pending"), {}, settledByRoot),
    ).toBe("done")
  })
})
