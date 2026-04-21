import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useSaveStatus } from "./use-save-status"

describe("useSaveStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("status flows idle → saving → saved when action resolves", async () => {
    const { result } = renderHook(() =>
      useSaveStatus({ idle: "保存", saving: "保存中…", saved: "✓ 已保存" }),
    )

    expect(result.current.status).toBe("idle")
    expect(result.current.label).toBe("保存")

    let resolve!: () => void
    const pending = new Promise<void>((r) => {
      resolve = r
    })

    let runPromise: Promise<unknown>
    act(() => {
      runPromise = result.current.run(() => pending)
    })
    expect(result.current.status).toBe("saving")
    expect(result.current.label).toBe("保存中…")

    await act(async () => {
      resolve()
      await runPromise
    })

    expect(result.current.status).toBe("saved")
    expect(result.current.label).toBe("✓ 已保存")

    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(result.current.status).toBe("idle")
  })

  it("F021 P2: action that rejects must NOT transition to saved", async () => {
    const { result } = renderHook(() =>
      useSaveStatus({ idle: "保存", saving: "保存中…", saved: "✓ 已保存" }),
    )

    await act(async () => {
      await result.current.run(async () => {
        throw new Error("boom")
      })
    })

    // failure → back to idle, never "saved"
    expect(result.current.status).toBe("idle")
    expect(result.current.label).toBe("保存")
  })
})
