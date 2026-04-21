import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import { GlobalDefaultsTab } from "./global-defaults-tab"

describe("GlobalDefaultsTab", () => {
  beforeEach(() => {
    useRuntimeConfigStore.setState({
      catalog: {
        claude: { models: [{ name: "claude-opus-4-7", label: "Opus 4.7" }], efforts: ["high", "medium"] },
        codex: { models: [], efforts: [] },
        gemini: { models: [], efforts: [] },
      },
      config: { claude: { model: "claude-opus-4-7", effort: "high" } },
      sessionConfig: {},
      pendingConfig: {},
      activeSessionId: null,
      loaded: true,
      loadError: null,
    })
  })

  it("renders current global model and effort for provider", () => {
    render(<GlobalDefaultsTab provider="claude" />)
    const modelInput = screen.getByLabelText("模型") as HTMLInputElement
    expect(modelInput.value).toBe("claude-opus-4-7")
    const effortSelect = screen.getByLabelText("强度") as HTMLSelectElement
    expect(effortSelect.value).toBe("high")
  })

  // F021 P2 (范德彪 二轮 review): 切 provider 后 input 必须反映新 provider 的 global override
  it("F021 P2: rerender with new provider reflects the new provider's global override", () => {
    useRuntimeConfigStore.setState({
      config: {
        claude: { model: "claude-opus-4-7", effort: "high" },
        codex: { model: "gpt-5", effort: "low" },
      },
    })
    const { rerender } = render(<GlobalDefaultsTab provider="claude" />)
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe(
      "claude-opus-4-7",
    )

    rerender(<GlobalDefaultsTab provider="codex" />)
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe(
      "gpt-5",
    )
  })

  it("save button invokes setGlobalOverride with the edited values", async () => {
    const setGlobalOverride = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({ setGlobalOverride } as never)

    render(<GlobalDefaultsTab provider="claude" />)
    const modelInput = screen.getByLabelText("模型")
    fireEvent.change(modelInput, { target: { value: "claude-sonnet-4-6" } })
    fireEvent.click(screen.getByRole("button", { name: "保存全局默认" }))
    expect(setGlobalOverride).toHaveBeenCalledWith("claude", {
      model: "claude-sonnet-4-6",
      effort: "high",
    })
  })

  describe("save button feedback (idle → saving → saved → idle)", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("shows '保存中…' while pending and '✓ 已保存' after resolve, then returns to idle", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      let resolveSave!: () => void
      const setGlobalOverride = vi.fn(
        () => new Promise<void>((resolve) => {
          resolveSave = resolve
        })
      )
      useRuntimeConfigStore.setState({ setGlobalOverride } as never)

      render(<GlobalDefaultsTab provider="claude" />)
      fireEvent.click(screen.getByRole("button", { name: "保存全局默认" }))

      const savingBtn = await screen.findByRole("button", { name: /保存中/ })
      expect(savingBtn.hasAttribute("disabled")).toBe(true)

      await act(async () => {
        resolveSave()
      })
      expect(await screen.findByRole("button", { name: /已保存/ })).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByRole("button", { name: "保存全局默认" })).toBeInTheDocument()
    })

    it("returns to idle when setGlobalOverride rejects", async () => {
      const setGlobalOverride = vi.fn().mockRejectedValue(new Error("boom"))
      useRuntimeConfigStore.setState({ setGlobalOverride } as never)

      render(<GlobalDefaultsTab provider="claude" />)
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "保存全局默认" }))
      })
      expect(screen.getByRole("button", { name: "保存全局默认" })).toBeInTheDocument()
    })
  })
})
