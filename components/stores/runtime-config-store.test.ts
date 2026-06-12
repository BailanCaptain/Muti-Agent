import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useRuntimeConfigStore } from "./runtime-config-store"

type FetchCall = { url: string; init?: RequestInit }

function mockFetch(response: unknown, calls: FetchCall[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => response,
    } as unknown as Response
  })
}

describe("runtime-config-store session layer", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    useRuntimeConfigStore.setState({
      catalog: null,
      config: {},
      sessionConfig: {},
      pendingConfig: {},
      activeSessionId: null,
      loaded: false,
      loadError: null,
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("setGlobalOverride writes to global config and PUTs /api/runtime-config", async () => {
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { ok: true, config: { claude: { model: "claude-opus-4-7" } } },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().setGlobalOverride("claude", {
      model: "claude-opus-4-7",
    })

    expect(useRuntimeConfigStore.getState().config).toEqual({
      claude: { model: "claude-opus-4-7" },
    })
    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({})
    expect(calls[0]?.url).toMatch(/\/api\/runtime-config$/)
    expect(calls[0]?.init?.method).toBe("PUT")
  })

  // F027 收录设置（审批页卡片）：setWikiCompile 对象版（provider + 自由模型 id），单次 PUT
  it("setWikiCompile({provider, primaryModel}) → 单次 PUT 全量 config 含两字段", async () => {
    useRuntimeConfigStore.setState({
      config: { codex: { model: "gpt-5.4" } },
    } as never)
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      {
        ok: true,
        config: {
          codex: { model: "gpt-5.4" },
          wikiCompile: { provider: "gemini", primaryModel: "gemini-3-pro" },
        },
      },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore
      .getState()
      .setWikiCompile({ provider: "gemini", primaryModel: "gemini-3-pro" })

    expect(calls.length).toBe(1)
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      config: Record<string, unknown>
    }
    expect(body.config.codex).toEqual({ model: "gpt-5.4" })
    expect(body.config.wikiCompile).toEqual({ provider: "gemini", primaryModel: "gemini-3-pro" })
  })

  it("setWikiCompile(null) → PUT 移除 wikiCompile（回落默认 claude+Opus 4.7）", async () => {
    useRuntimeConfigStore.setState({
      config: {
        claude: { model: "claude-opus-4-7" },
        wikiCompile: { provider: "codex" },
      },
    } as never)
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { ok: true, config: { claude: { model: "claude-opus-4-7" } } },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().setWikiCompile(null)

    expect(calls.length).toBe(1)
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      config: Record<string, unknown>
    }
    expect("wikiCompile" in body.config).toBe(false)
  })

  // F027 自审：wikiCompile 是自由文本入口，后端 400 真实可达（非法字符）。失败必须
  // 回滚乐观更新——否则脏段留在 store 内存，setGlobalOverride 以 get().config 为基的
  // 全量 PUT 会反复携带脏 wikiCompile → agent 配置保存连带 400，直到刷新页面。
  it("setWikiCompile 后端拒绝 → 回滚乐观更新 + rethrow（脏段不得污染后续全量 PUT）", async () => {
    useRuntimeConfigStore.setState({
      config: {
        claude: { model: "claude-opus-4-7" },
        wikiCompile: { provider: "codex", primaryModel: "gpt-5.4-codex" },
      },
    } as never)
    globalThis.fetch = failingFetch(
      400,
      '{"errors":["wikiCompile.primaryModel must be ..."]}',
    ) as typeof fetch

    await expect(
      useRuntimeConfigStore
        .getState()
        .setWikiCompile({ provider: "gemini", primaryModel: "bad value" }),
    ).rejects.toThrow()

    // 回滚到失败前的完整 config（含原 wikiCompile，不是清空）
    expect(useRuntimeConfigStore.getState().config).toEqual({
      claude: { model: "claude-opus-4-7" },
      wikiCompile: { provider: "codex", primaryModel: "gpt-5.4-codex" },
    })
    expect(useRuntimeConfigStore.getState().loadError).toBeTruthy()
  })

  // 德彪 kb-ux2 r1 P2 + r2 P2：两个全量 PUT 写者必须严格串行——任务执行时才读 config
  // 计算 nextConfig（前序已落定/已回滚），同时消灭响应乱序覆盖与脏段携带。
  it("全量 PUT 串行化：第二个写者等第一个落定后才发请求，且以确认后的 config 为基", async () => {
    const pending: ((body: unknown) => void)[] = []
    const bodies: { config: Record<string, unknown> }[] = []
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Promise<Response>((res) => {
        pending.push((body: unknown) =>
          res({
            ok: true,
            status: 200,
            text: async () => "",
            json: async () => body,
          } as unknown as Response),
        )
      })
    }) as typeof fetch

    const p1 = useRuntimeConfigStore
      .getState()
      .setGlobalOverride("claude", { model: "claude-opus-4-7" })
    const p2 = useRuntimeConfigStore
      .getState()
      .setWikiCompile({ provider: "gemini", primaryModel: "gemini-3-pro" })

    await Promise.resolve()
    expect(pending.length).toBe(1) // p2 的 PUT 在 p1 落定前不得发出

    pending[0]({ ok: true, config: { claude: { model: "claude-opus-4-7" } } })
    await p1
    await vi.waitFor(() => expect(pending.length).toBe(2))
    // p2 body 以 p1 确认后的服务端响应为基（不是并发快照）
    expect(bodies[1].config.claude).toEqual({ model: "claude-opus-4-7" })

    pending[1]({
      ok: true,
      config: {
        claude: { model: "claude-opus-4-7" },
        wikiCompile: { provider: "gemini", primaryModel: "gemini-3-pro" },
      },
    })
    await p2
    expect(useRuntimeConfigStore.getState().config.wikiCompile).toEqual({
      provider: "gemini",
      primaryModel: "gemini-3-pro",
    })
  })

  // 德彪 r2 P2 原场景：脏 wiki 请求失败后紧接 global 请求——串行 + 双写者回滚协同下，
  // global 请求不得携带脏段，store 终态干净。
  it("脏 wikiCompile 失败 + 并发 global 保存：global 不携带脏段，双双不留残留", async () => {
    useRuntimeConfigStore.setState({
      config: { wikiCompile: { provider: "codex" } },
    } as never)
    const bodies: { config: Record<string, unknown> }[] = []
    let call = 0
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      call++
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => "bad primaryModel",
          json: async () => ({}),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ ok: true, config: bodies[bodies.length - 1].config }),
      } as unknown as Response
    }) as typeof fetch

    const p1 = useRuntimeConfigStore
      .getState()
      .setWikiCompile({ provider: "gemini", primaryModel: "bad value" })
    const p2 = useRuntimeConfigStore
      .getState()
      .setGlobalOverride("claude", { model: "claude-opus-4-7" })

    await expect(p1).rejects.toThrow()
    await p2

    // global 请求 body 必须是回滚后的确认段（codex），不是 gemini 脏段
    expect(bodies[1].config.wikiCompile).toEqual({ provider: "codex" })
    expect(useRuntimeConfigStore.getState().config).toEqual({
      claude: { model: "claude-opus-4-7" },
      wikiCompile: { provider: "codex" },
    })
  })

  // 德彪 r2 P2：load 失败必须可区分（loaded:true 只表示"尝试过"），卡片靠 loadFailed 禁保存
  it("load 失败 → loadFailed=true；下次成功 → 复位 false", async () => {
    globalThis.fetch = failingFetch(500, "api down") as typeof fetch
    await useRuntimeConfigStore.getState().load()
    expect(useRuntimeConfigStore.getState().loadFailed).toBe(true)
    expect(useRuntimeConfigStore.getState().loaded).toBe(true)

    globalThis.fetch = mockFetch({ catalog: {}, config: {} }, []) as typeof fetch
    await useRuntimeConfigStore.getState().load()
    expect(useRuntimeConfigStore.getState().loadFailed).toBe(false)
  })

  it("setGlobalOverride 不碰既有 wikiCompile（spread 保留，各管各段）", async () => {
    useRuntimeConfigStore.setState({
      config: { wikiCompile: { provider: "codex", primaryModel: "gpt-5.4" } },
    } as never)
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      {
        ok: true,
        config: {
          codex: { model: "gpt-5.4" },
          wikiCompile: { provider: "codex", primaryModel: "gpt-5.4" },
        },
      },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().setGlobalOverride("codex", { model: "gpt-5.4" })

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      config: Record<string, unknown>
    }
    expect(body.config.wikiCompile).toEqual({ provider: "codex", primaryModel: "gpt-5.4" })
  })

  it("loadSession populates sessionConfig from GET /api/sessions/:id/runtime-config", async () => {
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { config: { gemini: { model: "gemini-pro" } } },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().loadSession("session-abc")

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({
      gemini: { model: "gemini-pro" },
    })
    expect(useRuntimeConfigStore.getState().activeSessionId).toBe("session-abc")
    expect(calls[0]?.url).toMatch(/\/api\/sessions\/session-abc\/runtime-config$/)
    expect(calls[0]?.init?.method ?? "GET").toBe("GET")
  })

  it("setSessionOverride writes to sessionConfig (not config) and PUTs /api/sessions/:id/runtime-config", async () => {
    useRuntimeConfigStore.setState({ activeSessionId: "session-xyz" })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { ok: true, config: { codex: { model: "gpt-5" } } },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().setSessionOverride(
      "codex",
      { model: "gpt-5" },
      false,
    )

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({
      codex: { model: "gpt-5" },
    })
    expect(useRuntimeConfigStore.getState().config).toEqual({})
    expect(calls[0]?.url).toMatch(/\/api\/sessions\/session-xyz\/runtime-config$/)
    expect(calls[0]?.init?.method).toBe("PUT")
  })

  it("setSessionOverride with isRunning=true writes to pendingConfig and PUTs { pending } to backend", async () => {
    useRuntimeConfigStore.setState({ activeSessionId: "session-run" })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { ok: true, config: {}, pending: { claude: { model: "claude-sonnet-4-6" } } },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().setSessionOverride(
      "claude",
      { model: "claude-sonnet-4-6" },
      true,
    )

    expect(useRuntimeConfigStore.getState().pendingConfig).toEqual({
      claude: { model: "claude-sonnet-4-6" },
    })
    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({})
    expect(calls[0]?.url).toMatch(/\/api\/sessions\/session-run\/runtime-config$/)
    expect(calls[0]?.init?.method).toBe("PUT")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      pending: { claude: { model: "claude-sonnet-4-6" } },
    })
  })

  it("loadSession also populates pendingConfig when backend returns pending", async () => {
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { config: { claude: { model: "c" } }, pending: { codex: { model: "g" } } },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().loadSession("session-pending")

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({
      claude: { model: "c" },
    })
    expect(useRuntimeConfigStore.getState().pendingConfig).toEqual({
      codex: { model: "g" },
    })
  })

  it("flushPendingToSession merges pendingConfig into sessionConfig and clears pending", async () => {
    useRuntimeConfigStore.setState({
      activeSessionId: "session-flush",
      sessionConfig: { claude: { model: "old" } },
      pendingConfig: { gemini: { model: "new-gem" } },
    })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      {
        ok: true,
        config: { claude: { model: "old" }, gemini: { model: "new-gem" } },
      },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().flushPendingToSession("session-flush")

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({
      claude: { model: "old" },
      gemini: { model: "new-gem" },
    })
    expect(useRuntimeConfigStore.getState().pendingConfig).toEqual({})
    expect(calls[0]?.init?.method).toBe("PUT")
  })

  // F021 P1 (范德彪 二轮 review): flush 必须字段级 merge，不能 provider 级浅覆盖
  // 场景：active 有 {model, effort}，pending 只改了 effort；flush 后 model 不能丢
  it("F021 P1: flushPendingToSession merges per-field within a provider (partial pending preserves active fields)", async () => {
    useRuntimeConfigStore.setState({
      activeSessionId: "session-flush-field",
      sessionConfig: { claude: { model: "claude-opus-4-7", effort: "high" } },
      pendingConfig: { claude: { effort: "low" } },
    })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      {
        ok: true,
        config: { claude: { model: "claude-opus-4-7", effort: "low" } },
      },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore
      .getState()
      .flushPendingToSession("session-flush-field")

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({
      claude: { model: "claude-opus-4-7", effort: "low" },
    })
    expect(useRuntimeConfigStore.getState().pendingConfig).toEqual({})
    // 请求 body 的 config 也必须是字段级 merge 后的完整 override
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.config).toEqual({
      claude: { model: "claude-opus-4-7", effort: "low" },
    })
  })

  // F021 P1 (范德彪 二轮 review): 非 running 保存 active 时必须清掉旧 pending
  // 场景：运行中挂了 pending；停下来后用户保存新 active —— 旧 pending 必须作废
  it("F021 P1: setSessionOverride (not running) clears stale pendingConfig atomically", async () => {
    useRuntimeConfigStore.setState({
      activeSessionId: "session-clear-pending",
      sessionConfig: {},
      pendingConfig: { codex: { model: "gpt-5-stale" } },
    })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { ok: true, config: { codex: { effort: "high" } }, pending: {} },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore
      .getState()
      .setSessionOverride("codex", { effort: "high" }, false)

    expect(useRuntimeConfigStore.getState().pendingConfig).toEqual({})
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.pending).toEqual({})
    expect(body.config).toEqual({ codex: { effort: "high" } })
  })

  // F021 P2 (范德彪 review): save 失败时必须 rethrow，否则 useSaveStatus 会误报 saved
  function failingFetch(status = 500, body = "boom") {
    return vi.fn(async () => ({
      ok: false,
      status,
      text: async () => body,
      json: async () => ({}),
    } as unknown as Response))
  }

  it("F021 P2: setGlobalOverride rethrows on API failure and still records loadError", async () => {
    globalThis.fetch = failingFetch() as typeof fetch
    await expect(
      useRuntimeConfigStore.getState().setGlobalOverride("claude", {
        model: "claude-opus-4-7",
      }),
    ).rejects.toThrow()
    expect(useRuntimeConfigStore.getState().loadError).toBeTruthy()
  })

  it("F021 P2: setSessionOverride (not running) rethrows on API failure", async () => {
    useRuntimeConfigStore.setState({ activeSessionId: "session-fail" })
    globalThis.fetch = failingFetch() as typeof fetch
    await expect(
      useRuntimeConfigStore.getState().setSessionOverride(
        "codex",
        { model: "gpt-5" },
        false,
      ),
    ).rejects.toThrow()
    expect(useRuntimeConfigStore.getState().loadError).toBeTruthy()
  })

  it("F021 P2: setSessionOverride (running → pending) rethrows on API failure", async () => {
    useRuntimeConfigStore.setState({ activeSessionId: "session-fail" })
    globalThis.fetch = failingFetch() as typeof fetch
    await expect(
      useRuntimeConfigStore.getState().setSessionOverride(
        "codex",
        { model: "gpt-5" },
        true,
      ),
    ).rejects.toThrow()
    expect(useRuntimeConfigStore.getState().loadError).toBeTruthy()
  })

  it("F021 P2: flushPendingToSession rethrows on API failure", async () => {
    useRuntimeConfigStore.setState({
      activeSessionId: "session-fail",
      pendingConfig: { codex: { model: "gpt-5" } },
    })
    globalThis.fetch = failingFetch() as typeof fetch
    await expect(
      useRuntimeConfigStore.getState().flushPendingToSession("session-fail"),
    ).rejects.toThrow()
    expect(useRuntimeConfigStore.getState().loadError).toBeTruthy()
  })

  // F021 Phase 6: AgentOverride 扩 contextWindow + sealPct
  // store 必须把这两字段一并 round-trip：cleanOverride 保留有效值，
  // writeOverride 的 has-any 判断把它们算"有内容"，mergeOverridesFieldwise 字段级合并。

  it("F021 P6: setGlobalOverride round-trips contextWindow + sealPct", async () => {
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { ok: true, config: { claude: { contextWindow: 1_000_000, sealPct: 0.5 } } },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().setGlobalOverride("claude", {
      contextWindow: 1_000_000,
      sealPct: 0.5,
    })

    expect(useRuntimeConfigStore.getState().config).toEqual({
      claude: { contextWindow: 1_000_000, sealPct: 0.5 },
    })
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.config).toEqual({
      claude: { contextWindow: 1_000_000, sealPct: 0.5 },
    })
  })

  it("F021 P6: setSessionOverride writes contextWindow-only entry without dropping it", async () => {
    useRuntimeConfigStore.setState({ activeSessionId: "session-p6" })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      { ok: true, config: { gemini: { contextWindow: 2_000_000 } }, pending: {} },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore
      .getState()
      .setSessionOverride("gemini", { contextWindow: 2_000_000 }, false)

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({
      gemini: { contextWindow: 2_000_000 },
    })
  })

  it("F021 P6: cleanOverride drops invalid contextWindow (<=0, non-finite) and sealPct (out of [0.3,1.0])", async () => {
    // setGlobalOverride 接受 raw 值，cleanOverride 必须过滤掉非法的；
    // 结果：本次保存等于"清掉这个 provider"（has-any 全部 false）。
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch({ ok: true, config: {} }, calls) as typeof fetch

    await useRuntimeConfigStore.getState().setGlobalOverride("claude", {
      contextWindow: -1,
      sealPct: 0.1,
    })

    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.config).toEqual({})
    expect(useRuntimeConfigStore.getState().config).toEqual({})
  })

  it("F021 P6: flushPendingToSession merges contextWindow + sealPct field-wise within a provider", async () => {
    useRuntimeConfigStore.setState({
      activeSessionId: "session-flush-p6",
      sessionConfig: { claude: { model: "claude-opus-4-7", contextWindow: 1_000_000 } },
      pendingConfig: { claude: { sealPct: 0.55 } },
    })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch(
      {
        ok: true,
        config: {
          claude: { model: "claude-opus-4-7", contextWindow: 1_000_000, sealPct: 0.55 },
        },
      },
      calls,
    ) as typeof fetch

    await useRuntimeConfigStore.getState().flushPendingToSession("session-flush-p6")

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({
      claude: { model: "claude-opus-4-7", contextWindow: 1_000_000, sealPct: 0.55 },
    })
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.config).toEqual({
      claude: { model: "claude-opus-4-7", contextWindow: 1_000_000, sealPct: 0.55 },
    })
  })

  it("setSessionOverride with empty override clears entry (回落到全局)", async () => {
    useRuntimeConfigStore.setState({
      activeSessionId: "session-clear",
      sessionConfig: { codex: { model: "gpt-5" } },
    })
    const calls: FetchCall[] = []
    globalThis.fetch = mockFetch({ ok: true, config: {} }, calls) as typeof fetch

    await useRuntimeConfigStore.getState().setSessionOverride(
      "codex",
      { model: "" },
      false,
    )

    expect(useRuntimeConfigStore.getState().sessionConfig).toEqual({})
  })
})
