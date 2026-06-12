"use client"

import type { Provider } from "@multi-agent/shared"
import { create } from "zustand"

export type ModelEntry = { name: string; label: string }
export type AgentCatalog = { models: ModelEntry[]; efforts: string[] }
export type ModelCatalog = Record<Provider, AgentCatalog>

export type AgentOverride = {
  model?: string
  effort?: string
  contextWindow?: number
  sealPct?: number
}
/** F027 收录设置 · wiki 编译引擎+模型（全局段，不进 session 配置；卡片在审批页）。 */
export type WikiCompileProvider = "claude" | "codex" | "gemini"
export type WikiCompileOverride = { provider?: WikiCompileProvider; primaryModel?: string }
export type RuntimeConfig = Partial<Record<Provider, AgentOverride>> & {
  wikiCompile?: WikiCompileOverride
}
export type SessionRuntimeConfig = Partial<Record<Provider, AgentOverride>>

export const SEAL_PCT_MIN = 0.3
export const SEAL_PCT_MAX = 1.0

function isValidContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function isValidSealPct(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= SEAL_PCT_MIN &&
    value <= SEAL_PCT_MAX
  )
}

function hasAnyField(o: AgentOverride): boolean {
  return Boolean(o.model || o.effort) || o.contextWindow !== undefined || o.sealPct !== undefined
}

type RuntimeConfigStore = {
  catalog: ModelCatalog | null
  config: RuntimeConfig
  sessionConfig: SessionRuntimeConfig
  pendingConfig: SessionRuntimeConfig
  activeSessionId: string | null
  loaded: boolean
  loadError: string | null
  /** 德彪 kb-ux2 r2 P2：上次 load 真失败（loaded 只表示"尝试过"）。收录卡靠它禁保存。 */
  loadFailed: boolean
  load: () => Promise<void>
  loadSession: (sessionId: string) => Promise<void>
  setGlobalOverride: (provider: Provider, override: AgentOverride) => Promise<void>
  /**
   * F027 收录设置（审批页卡片专用）：单次 PUT 设/清 wikiCompile 段（null/空 = 清除回默认）。
   * 与 setGlobalOverride 各管各段、各自单 PUT（小孙拍：收录设置不放 agent 配置区）。
   */
  setWikiCompile: (wikiCompile: WikiCompileOverride | null) => Promise<void>
  setSessionOverride: (
    provider: Provider,
    override: AgentOverride,
    isRunning: boolean,
  ) => Promise<void>
  flushPendingToSession: (sessionId: string) => Promise<void>
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
  const response = await fetch(`${baseUrl}${path}`, init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `请求失败: ${response.status}`)
  }
  return (await response.json()) as T
}

function cleanOverride(override: AgentOverride): AgentOverride {
  const cleaned: AgentOverride = {}
  if (override.model?.trim()) cleaned.model = override.model.trim()
  if (override.effort?.trim()) cleaned.effort = override.effort.trim()
  if (isValidContextWindow(override.contextWindow)) {
    cleaned.contextWindow = Math.floor(override.contextWindow)
  }
  if (isValidSealPct(override.sealPct)) {
    cleaned.sealPct = override.sealPct
  }
  return cleaned
}

function writeOverride(
  target: SessionRuntimeConfig,
  provider: Provider,
  cleaned: AgentOverride,
): SessionRuntimeConfig {
  const next: SessionRuntimeConfig = { ...target }
  if (hasAnyField(cleaned)) {
    next[provider] = cleaned
  } else {
    delete next[provider]
  }
  return next
}

// 德彪 kb-ux2 r1+r2 P2：setGlobalOverride / setWikiCompile 都全量 PUT /api/runtime-config。
// 并发时两类事故：①响应乱序，旧响应覆盖新状态；②前一个失败请求的脏乐观段被后一个
// 以内存为基的全量 PUT 携带重发（r2 实锤：seq guard 只挡①挡不住②）。
// 改为严格串行：任务排队执行，执行时才读 config 计算 nextConfig——前序必已落定或
// 已回滚，乱序与脏携带同时消灭，rollback 快照恒为确认态。localhost 亚秒级 PUT，
// 排队延迟无感。
let globalConfigPutChain: Promise<unknown> = Promise.resolve()
function enqueueGlobalConfigPut<T>(task: () => Promise<T>): Promise<T> {
  const run = globalConfigPutChain.then(task, task) // 前序失败不阻塞队列
  globalConfigPutChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// F021 P1 (范德彪 二轮 review): flush/merge 必须在 provider 内按字段合并，
// 不能直接 { ...active, ...pending } — 否则 pending 只含单字段时会把 active 另一字段吞掉。
function mergeOverridesFieldwise(
  active: SessionRuntimeConfig,
  pending: SessionRuntimeConfig,
): SessionRuntimeConfig {
  const providers = new Set<Provider>([
    ...(Object.keys(active) as Provider[]),
    ...(Object.keys(pending) as Provider[]),
  ])
  const merged: SessionRuntimeConfig = {}
  for (const provider of providers) {
    const combined: AgentOverride = { ...active[provider], ...pending[provider] }
    if (hasAnyField(combined)) merged[provider] = combined
  }
  return merged
}

export const useRuntimeConfigStore = create<RuntimeConfigStore>((set, get) => ({
  catalog: null,
  config: {},
  sessionConfig: {},
  pendingConfig: {},
  activeSessionId: null,
  loaded: false,
  loadError: null,
  loadFailed: false,

  load: async () => {
    try {
      const [catalogResponse, configResponse] = await Promise.all([
        fetchJson<{ catalog: ModelCatalog }>("/api/models"),
        fetchJson<{ config: RuntimeConfig }>("/api/runtime-config"),
      ])
      set({
        catalog: catalogResponse.catalog,
        config: configResponse.config,
        loaded: true,
        loadError: null,
        loadFailed: false,
      })
    } catch (error) {
      // 德彪 kb-ux2 r2 P2：loaded:true 只表示"尝试过"（右面板 banner 语义不动）；
      // loadFailed 单独标记真失败——收录卡靠它禁保存，防默认值清掉未拉到的服务端配置。
      set({ loadError: (error as Error).message, loaded: true, loadFailed: true })
    }
  },

  loadSession: async (sessionId) => {
    try {
      const response = await fetchJson<{
        config: SessionRuntimeConfig
        pending?: SessionRuntimeConfig
      }>(`/api/sessions/${sessionId}/runtime-config`)
      set({
        sessionConfig: response.config,
        activeSessionId: sessionId,
        pendingConfig: response.pending ?? {},
      })
    } catch (error) {
      set({ loadError: (error as Error).message })
    }
  },

  setGlobalOverride: (provider, override) =>
    enqueueGlobalConfigPut(async () => {
      const cleaned = cleanOverride(override)
      const prevConfig = get().config
      const nextConfig: RuntimeConfig = writeOverride(prevConfig, provider, cleaned)
      set({ config: nextConfig })

      try {
        const response = await fetchJson<{ ok: boolean; config: RuntimeConfig }>(
          "/api/runtime-config",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: nextConfig }),
          },
        )
        set({ config: response.config })
      } catch (error) {
        // F021 P2: rethrow so useSaveStatus can distinguish success vs failure.
        // 德彪 r2 P2：失败回滚乐观更新（串行下 prevConfig 恒为确认态），否则脏段
        // 留内存被后续全量 PUT 携带重发。
        set({ config: prevConfig, loadError: (error as Error).message })
        throw error
      }
    }),

  setWikiCompile: (wikiCompile) =>
    enqueueGlobalConfigPut(async () => {
      const prevConfig = get().config
      const nextConfig: RuntimeConfig = { ...prevConfig }
      const provider = wikiCompile?.provider
      const model = wikiCompile?.primaryModel?.trim()
      if (wikiCompile !== null && (provider || model)) {
        nextConfig.wikiCompile = {
          ...(provider ? { provider } : {}),
          ...(model ? { primaryModel: model } : {}),
        }
      } else {
        delete nextConfig.wikiCompile
      }
      set({ config: nextConfig })

      try {
        const response = await fetchJson<{ ok: boolean; config: RuntimeConfig }>(
          "/api/runtime-config",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ config: nextConfig }),
          },
        )
        set({ config: response.config })
      } catch (error) {
        // 自由文本入口 → 后端 400 真实可达。脏 wikiCompile 不回滚的话会留在内存，
        // setGlobalOverride 以 get().config 为基的全量 PUT 反复携带它 → agent 配置
        // 保存连带 400 直到刷新。串行下 prevConfig 恒为确认态，无条件回滚。
        set({ config: prevConfig, loadError: (error as Error).message })
        throw error
      }
    }),

  setSessionOverride: async (provider, override, isRunning) => {
    const cleaned = cleanOverride(override)
    const sessionId = get().activeSessionId

    if (isRunning) {
      const nextPending = writeOverride(get().pendingConfig, provider, cleaned)
      set({ pendingConfig: nextPending })
      if (!sessionId) return
      try {
        const response = await fetchJson<{
          ok: boolean
          config: SessionRuntimeConfig
          pending: SessionRuntimeConfig
        }>(`/api/sessions/${sessionId}/runtime-config`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pending: nextPending }),
        })
        set({ pendingConfig: response.pending })
      } catch (error) {
        set({ loadError: (error as Error).message })
        throw error
      }
      return
    }

    const nextSession = writeOverride(get().sessionConfig, provider, cleaned)
    // F021 P1 (范德彪 二轮 review): 用户显式保存 active 时，旧 pending 必须作废，
    // 否则停下来后保存的 active 会在下一轮启动被旧 pending 悄悄覆盖。
    set({ sessionConfig: nextSession, pendingConfig: {} })

    if (!sessionId) return
    try {
      const response = await fetchJson<{
        ok: boolean
        config: SessionRuntimeConfig
        pending?: SessionRuntimeConfig
      }>(`/api/sessions/${sessionId}/runtime-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: nextSession, pending: {} }),
      })
      set({
        sessionConfig: response.config,
        pendingConfig: response.pending ?? {},
      })
    } catch (error) {
      set({ loadError: (error as Error).message })
      throw error
    }
  },

  flushPendingToSession: async (sessionId) => {
    const { sessionConfig, pendingConfig } = get()
    const merged = mergeOverridesFieldwise(sessionConfig, pendingConfig)
    set({ sessionConfig: merged, pendingConfig: {} })

    try {
      const response = await fetchJson<{ ok: boolean; config: SessionRuntimeConfig }>(
        `/api/sessions/${sessionId}/runtime-config`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: merged }),
        },
      )
      set({ sessionConfig: response.config })
    } catch (error) {
      set({ loadError: (error as Error).message })
      throw error
    }
  },
}))
