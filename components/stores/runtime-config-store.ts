"use client"

import type { Provider } from "@multi-agent/shared"
import { create } from "zustand"

export type ModelEntry = { name: string; label: string }
export type AgentCatalog = { models: ModelEntry[]; efforts: string[] }
export type ModelCatalog = Record<Provider, AgentCatalog>

export type AgentOverride = { model?: string; effort?: string }
export type RuntimeConfig = Partial<Record<Provider, AgentOverride>>
export type SessionRuntimeConfig = Partial<Record<Provider, AgentOverride>>

type RuntimeConfigStore = {
  catalog: ModelCatalog | null
  config: RuntimeConfig
  sessionConfig: SessionRuntimeConfig
  pendingConfig: SessionRuntimeConfig
  activeSessionId: string | null
  loaded: boolean
  loadError: string | null
  load: () => Promise<void>
  loadSession: (sessionId: string) => Promise<void>
  setGlobalOverride: (provider: Provider, override: AgentOverride) => Promise<void>
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
  return cleaned
}

function writeOverride(
  target: SessionRuntimeConfig,
  provider: Provider,
  cleaned: AgentOverride,
): SessionRuntimeConfig {
  const next: SessionRuntimeConfig = { ...target }
  if (cleaned.model || cleaned.effort) {
    next[provider] = cleaned
  } else {
    delete next[provider]
  }
  return next
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
    if (combined.model || combined.effort) merged[provider] = combined
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
      })
    } catch (error) {
      set({ loadError: (error as Error).message, loaded: true })
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

  setGlobalOverride: async (provider, override) => {
    const cleaned = cleanOverride(override)
    const nextConfig = writeOverride(get().config, provider, cleaned)
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
      // F021 P2: rethrow so useSaveStatus can distinguish success vs failure;
      // loadError is still set for diagnostics.
      set({ loadError: (error as Error).message })
      throw error
    }
  },

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
