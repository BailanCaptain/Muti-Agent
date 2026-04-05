"use client"

import type { Provider } from "@multi-agent/shared"
import { create } from "zustand"

export type ModelEntry = { name: string; label: string }
export type AgentCatalog = { models: ModelEntry[]; efforts: string[] }
export type ModelCatalog = Record<Provider, AgentCatalog>

export type AgentOverride = { model?: string; effort?: string }
export type RuntimeConfig = Partial<Record<Provider, AgentOverride>>

type RuntimeConfigStore = {
  catalog: ModelCatalog | null
  config: RuntimeConfig
  loaded: boolean
  loadError: string | null
  load: () => Promise<void>
  setAgentOverride: (provider: Provider, override: AgentOverride) => Promise<void>
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

export const useRuntimeConfigStore = create<RuntimeConfigStore>((set, get) => ({
  catalog: null,
  config: {},
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
  setAgentOverride: async (provider, override) => {
    // Drop fields with empty strings so sanitize on the server treats them as absent.
    const cleaned: AgentOverride = {}
    if (override.model?.trim()) cleaned.model = override.model.trim()
    if (override.effort?.trim()) cleaned.effort = override.effort.trim()

    const nextConfig: RuntimeConfig = { ...get().config }
    if (cleaned.model || cleaned.effort) {
      nextConfig[provider] = cleaned
    } else {
      delete nextConfig[provider]
    }
    // Optimistic update so the UI responds instantly; the server's canonical
    // response below replaces this state on success.
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
      set({ loadError: (error as Error).message })
    }
  },
}))
