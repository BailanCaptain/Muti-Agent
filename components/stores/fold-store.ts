"use client"

import { PROVIDERS, type Provider } from "@multi-agent/shared"
import { create } from "zustand"

type ProviderFoldMap = Record<Provider, boolean>

type FoldStore = {
  // Explicit per-message override (true=folded, false=unfolded). Absent → fall back to provider default.
  // Overrides let users pin a specific message open while the rest of that provider stays collapsed.
  messageFolds: Record<string, boolean>
  // Per-provider default fold state.
  providerFolds: ProviderFoldMap
  // Group-level fold state: groupId → folded (true = collapsed). Groups default to folded.
  groupFolds: Record<string, boolean>
  toggleMessage: (messageId: string, provider: Provider) => void
  toggleProvider: (provider: Provider) => void
  toggleGroup: (groupId: string) => void
  foldAll: () => void
  unfoldAll: () => void
}

function makeProviderFolds(value: boolean): ProviderFoldMap {
  return Object.fromEntries(PROVIDERS.map((p) => [p, value])) as ProviderFoldMap
}

export const useFoldStore = create<FoldStore>((set) => ({
  messageFolds: {},
  providerFolds: makeProviderFolds(false),
  groupFolds: {},
  toggleMessage: (messageId, provider) => {
    set((state) => {
      const explicit = state.messageFolds[messageId]
      const current =
        typeof explicit === "boolean" ? explicit : Boolean(state.providerFolds[provider])
      return {
        messageFolds: { ...state.messageFolds, [messageId]: !current },
      }
    })
  },
  toggleProvider: (provider) => {
    set((state) => ({
      providerFolds: { ...state.providerFolds, [provider]: !state.providerFolds[provider] },
    }))
  },
  toggleGroup: (groupId) => {
    set((state) => {
      // Default is folded (true) when groupId absent from map
      const current = state.groupFolds[groupId] ?? true
      return {
        groupFolds: { ...state.groupFolds, [groupId]: !current },
      }
    })
  },
  foldAll: () => {
    // Clear per-message overrides so the new provider default wins uniformly.
    set({ providerFolds: makeProviderFolds(true), messageFolds: {} })
  },
  unfoldAll: () => {
    set({ providerFolds: makeProviderFolds(false), messageFolds: {} })
  },
}))

export function useIsMessageFolded(messageId: string, provider: Provider): boolean {
  return useFoldStore((state) => {
    const override = state.messageFolds[messageId]
    if (typeof override === "boolean") return override
    return Boolean(state.providerFolds[provider])
  })
}

/** Groups default to folded (true) when not explicitly set. */
export function useIsGroupFolded(groupId: string): boolean {
  return useFoldStore((state) => state.groupFolds[groupId] ?? true)
}
