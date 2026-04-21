import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import { SessionOverridesTab } from "./session-overrides-tab"

describe("SessionOverridesTab", () => {
  beforeEach(() => {
    useRuntimeConfigStore.setState({
      catalog: {
        claude: { models: [{ name: "claude-opus-4-7", label: "Opus 4.7" }], efforts: ["high"] },
        codex: { models: [], efforts: [] },
        gemini: { models: [], efforts: [] },
      },
      config: { claude: { model: "claude-opus-4-7", effort: "high" } },
      sessionConfig: {},
      pendingConfig: {},
      activeSessionId: "session-1",
      loaded: true,
      loadError: null,
    })
  })

  it("shows global-default placeholder for model when no session override exists", () => {
    render(<SessionOverridesTab provider="claude" isRunning={false} />)
    const modelInput = screen.getByLabelText("模型") as HTMLInputElement
    expect(modelInput.placeholder).toBe("claude-opus-4-7")
    expect(modelInput.value).toBe("")
  })

  it("pre-fills with session override when present", () => {
    useRuntimeConfigStore.setState({
      sessionConfig: { claude: { model: "claude-sonnet-4-6" } },
    })
    render(<SessionOverridesTab provider="claude" isRunning={false} />)
    const modelInput = screen.getByLabelText("模型") as HTMLInputElement
    expect(modelInput.value).toBe("claude-sonnet-4-6")
  })

  // F021 P2 (范德彪 二轮 review): 切 provider 后 input 必须反映新 provider 的 sessionOverride
  // 当前 bug：useState 只在 mount 时取初值，rerender 改 provider 不会同步
  it("F021 P2: rerender with new provider reflects the new provider's sessionOverride", () => {
    useRuntimeConfigStore.setState({
      sessionConfig: {
        claude: { model: "claude-sonnet-4-6" },
        codex: { model: "gpt-5" },
      },
    })
    const { rerender } = render(
      <SessionOverridesTab provider="claude" isRunning={false} />,
    )
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe(
      "claude-sonnet-4-6",
    )

    rerender(<SessionOverridesTab provider="codex" isRunning={false} />)
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe(
      "gpt-5",
    )
  })

  // F021 P2 (范德彪 二轮 review): loadSession 异步 race —— mount 时 sessionConfig 为空，
  // 之后 store 更新也必须把 input 填上新值
  it("F021 P2: async sessionOverride arriving after mount populates the inputs", async () => {
    useRuntimeConfigStore.setState({ sessionConfig: {} })
    render(<SessionOverridesTab provider="claude" isRunning={false} />)
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe("")

    await act(async () => {
      useRuntimeConfigStore.setState({
        sessionConfig: { claude: { model: "claude-opus-4-7" } },
      })
    })
    expect((screen.getByLabelText("模型") as HTMLInputElement).value).toBe(
      "claude-opus-4-7",
    )
  })

  it("apply button invokes setSessionOverride with isRunning=false", async () => {
    const setSessionOverride = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({ setSessionOverride } as never)
    render(<SessionOverridesTab provider="claude" isRunning={false} />)
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "claude-sonnet-4-6" } })
    fireEvent.click(screen.getByRole("button", { name: "应用到当前会话" }))
    expect(setSessionOverride).toHaveBeenCalledWith("claude", { model: "claude-sonnet-4-6", effort: "" }, false)
  })

  it("apply button is disabled + shows '运行中，下一轮生效' tooltip when isRunning=true", () => {
    render(<SessionOverridesTab provider="claude" isRunning={true} />)
    const btn = screen.getByRole("button", { name: "应用到当前会话" })
    expect(btn.hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/运行中，下一轮生效/)).toBeTruthy()
  })

  it("apply button passes isRunning=true when session is running (writes to pendingConfig)", async () => {
    const setSessionOverride = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({ setSessionOverride } as never)
    render(<SessionOverridesTab provider="claude" isRunning={true} />)
    // Running state disables the primary apply; but a separate "挂起到下一轮" button writes to pendingConfig.
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "new-model" } })
    fireEvent.click(screen.getByRole("button", { name: "挂起到下一轮" }))
    expect(setSessionOverride).toHaveBeenCalledWith("claude", { model: "new-model", effort: "" }, true)
  })

  it("clear button invokes setSessionOverride with empty override", async () => {
    const setSessionOverride = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({
      sessionConfig: { claude: { model: "claude-sonnet-4-6" } },
      setSessionOverride,
    } as never)
    render(<SessionOverridesTab provider="claude" isRunning={false} />)
    fireEvent.click(screen.getByRole("button", { name: "清除覆盖" }))
    expect(setSessionOverride).toHaveBeenCalledWith("claude", { model: "", effort: "" }, false)
  })

  describe("button feedback (idle → saving → saved → idle)", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("apply button shows '保存中…' then '✓ 已保存' then returns to idle", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      let resolveSave!: () => void
      const setSessionOverride = vi.fn(
        () => new Promise<void>((resolve) => {
          resolveSave = resolve
        })
      )
      useRuntimeConfigStore.setState({ setSessionOverride } as never)

      render(<SessionOverridesTab provider="claude" isRunning={false} />)
      fireEvent.click(screen.getByRole("button", { name: "应用到当前会话" }))

      const savingBtn = await screen.findByRole("button", { name: /保存中/ })
      expect(savingBtn.hasAttribute("disabled")).toBe(true)

      await act(async () => {
        resolveSave()
      })
      expect(await screen.findByRole("button", { name: /已保存/ })).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByRole("button", { name: "应用到当前会话" })).toBeInTheDocument()
    })

    it("'挂起到下一轮' button shows '保存中…' then '✓ 已保存' then returns to idle", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      let resolveSave!: () => void
      const setSessionOverride = vi.fn(
        () => new Promise<void>((resolve) => {
          resolveSave = resolve
        })
      )
      useRuntimeConfigStore.setState({ setSessionOverride } as never)

      render(<SessionOverridesTab provider="claude" isRunning={true} />)
      fireEvent.click(screen.getByRole("button", { name: "挂起到下一轮" }))

      expect(await screen.findByRole("button", { name: /保存中/ })).toBeInTheDocument()

      await act(async () => {
        resolveSave()
      })
      expect(await screen.findByRole("button", { name: /已保存/ })).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByRole("button", { name: "挂起到下一轮" })).toBeInTheDocument()
    })

    it("'清除覆盖' button shows '清除中…' then '✓ 已清除' then returns to idle", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      let resolveClear!: () => void
      const setSessionOverride = vi.fn(
        () => new Promise<void>((resolve) => {
          resolveClear = resolve
        })
      )
      useRuntimeConfigStore.setState({
        sessionConfig: { claude: { model: "claude-sonnet-4-6" } },
        setSessionOverride,
      } as never)

      render(<SessionOverridesTab provider="claude" isRunning={false} />)
      fireEvent.click(screen.getByRole("button", { name: "清除覆盖" }))

      expect(await screen.findByRole("button", { name: /清除中/ })).toBeInTheDocument()

      await act(async () => {
        resolveClear()
      })
      expect(await screen.findByRole("button", { name: /已清除/ })).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.getByRole("button", { name: "清除覆盖" })).toBeInTheDocument()
    })
  })
})
