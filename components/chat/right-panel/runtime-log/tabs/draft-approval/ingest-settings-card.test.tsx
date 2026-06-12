/**
 * F027 收录设置卡单测（小孙 2026-06-13 拍：放记忆页面族 / 三引擎 / 模型可自己写）
 */

import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { IngestSettingsCard } from "./ingest-settings-card"

describe("IngestSettingsCard", () => {
  beforeEach(() => {
    useRuntimeConfigStore.setState({
      catalog: null,
      config: {},
      sessionConfig: {},
      pendingConfig: {},
      activeSessionId: null,
      loaded: true, // 跳过自动 load
      loadError: null,
      load: vi.fn().mockResolvedValue(undefined),
      setWikiCompile: vi.fn().mockResolvedValue(undefined),
    } as never)
  })

  it("默认渲染：claude 选中 + 模型输入空（占位提示默认 Opus 4.7）", () => {
    render(<IngestSettingsCard />)
    const claude = screen.getByTestId("ingest-settings-provider-claude") as HTMLInputElement
    expect(claude.checked).toBe(true)
    const input = screen.getByTestId("ingest-settings-model-input") as HTMLInputElement
    expect(input.value).toBe("")
    expect(input.placeholder).toMatch(/claude-opus-4-7/)
  })

  it("反映 store 既有配置（provider + 自由模型 id）", () => {
    useRuntimeConfigStore.setState({
      config: { wikiCompile: { provider: "codex", primaryModel: "gpt-5.4-codex" } },
    } as never)
    render(<IngestSettingsCard />)
    expect(
      (screen.getByTestId("ingest-settings-provider-codex") as HTMLInputElement).checked,
    ).toBe(true)
    expect(
      (screen.getByTestId("ingest-settings-model-input") as HTMLInputElement).value,
    ).toBe("gpt-5.4-codex")
  })

  it("切引擎 + 自由填模型 + 保存 → setWikiCompile({provider, primaryModel})", async () => {
    const setWikiCompile = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({ setWikiCompile } as never)
    render(<IngestSettingsCard />)

    fireEvent.click(screen.getByTestId("ingest-settings-provider-gemini"))
    fireEvent.change(screen.getByTestId("ingest-settings-model-input"), {
      target: { value: "gemini-3-flash-preview" },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("ingest-settings-save"))
    })
    expect(setWikiCompile).toHaveBeenCalledWith({
      provider: "gemini",
      primaryModel: "gemini-3-flash-preview",
    })
  })

  it("非 claude 引擎 + 模型留空 → 保存 {provider}（CLI 默认模型）", async () => {
    const setWikiCompile = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({ setWikiCompile } as never)
    render(<IngestSettingsCard />)

    fireEvent.click(screen.getByTestId("ingest-settings-provider-codex"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("ingest-settings-save"))
    })
    expect(setWikiCompile).toHaveBeenCalledWith({ provider: "codex" })
  })

  it("claude + 模型留空 → 保存 null（清除段回落默认）", async () => {
    const setWikiCompile = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({
      setWikiCompile,
      config: { wikiCompile: { provider: "gemini" } },
    } as never)
    render(<IngestSettingsCard />)

    fireEvent.click(screen.getByTestId("ingest-settings-provider-claude"))
    fireEvent.change(screen.getByTestId("ingest-settings-model-input"), {
      target: { value: "" },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId("ingest-settings-save"))
    })
    expect(setWikiCompile).toHaveBeenCalledWith(null)
  })

  it("未 loaded → 自动触发 load 拉全局配置", () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({ loaded: false, load } as never)
    render(<IngestSettingsCard />)
    expect(load).toHaveBeenCalled()
  })

  // 德彪 kb-ux2 r1 P2：load 完成前保存 = 把默认值（claude+空 → null）写穿真配置（清段）
  it("未 loaded → 保存按钮 disabled（防默认值覆盖未拉到的真配置）", () => {
    useRuntimeConfigStore.setState({
      loaded: false,
      load: vi.fn().mockResolvedValue(undefined),
    } as never)
    render(<IngestSettingsCard />)
    expect(
      (screen.getByTestId("ingest-settings-save") as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  // 德彪 kb-ux2 r2 P2：保存在飞时若仍可编辑，旧请求成功后 setDirty(false) 会让
  // sync effect 吞掉保存期间的新草稿 → 保存进行中输入一并禁用
  it("保存进行中 → provider/model 输入禁用，落定后恢复", async () => {
    let resolveSave: (() => void) | undefined
    const setWikiCompile = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveSave = r
        }),
    )
    useRuntimeConfigStore.setState({ setWikiCompile } as never)
    render(<IngestSettingsCard />)

    fireEvent.click(screen.getByTestId("ingest-settings-provider-codex"))
    fireEvent.click(screen.getByTestId("ingest-settings-save"))

    expect(
      (screen.getByTestId("ingest-settings-model-input") as HTMLInputElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByTestId("ingest-settings-provider-gemini") as HTMLInputElement).disabled,
    ).toBe(true)

    await act(async () => {
      resolveSave?.()
    })
    expect(
      (screen.getByTestId("ingest-settings-model-input") as HTMLInputElement).disabled,
    ).toBe(false)
  })

  // 德彪 kb-ux2 r2 P2：load 失败（loadFailed）时保存必须禁用——否则瞬时加载失败后
  // 可用默认值（claude+空 → null）清掉服务端既有配置；给重试按钮
  it("loadFailed → 保存禁用 + 重试按钮触发 load", () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useRuntimeConfigStore.setState({ loaded: true, loadFailed: true, load } as never)
    render(<IngestSettingsCard />)
    expect(
      (screen.getByTestId("ingest-settings-save") as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByTestId("ingest-settings-retry"))
    expect(load).toHaveBeenCalled()
  })

  // 德彪 kb-ux2 r1 P2：异步 load/外部变更不得覆盖正在编辑的输入（dirty guard）
  it("用户编辑后 store 异步变更 → 不覆盖正在编辑的 provider/model", () => {
    render(<IngestSettingsCard />)
    fireEvent.change(screen.getByTestId("ingest-settings-model-input"), {
      target: { value: "my-half-typed" },
    })
    act(() => {
      useRuntimeConfigStore.setState({
        config: { wikiCompile: { provider: "codex", primaryModel: "gpt-5.4" } },
      } as never)
    })
    expect(
      (screen.getByTestId("ingest-settings-model-input") as HTMLInputElement).value,
    ).toBe("my-half-typed")
    expect(
      (screen.getByTestId("ingest-settings-provider-claude") as HTMLInputElement).checked,
    ).toBe(true)
  })
})
