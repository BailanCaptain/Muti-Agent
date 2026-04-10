"use client"

import type { DecisionBoardItem } from "@multi-agent/shared"
import { create } from "zustand"

/**
 * F002: per-item user choice. `null` means the user hasn't picked yet;
 * the submit handler defaults unchosen items to the first option.
 */
export type BoardChoice =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string }

type DecisionBoardState = {
  isOpen: boolean
  sessionGroupId: string | null
  items: DecisionBoardItem[]
  choices: Record<string, BoardChoice>
  /** Set of item IDs the user has switched into "其他（自己写）" mode. */
  customModes: Record<string, boolean>

  receiveFlush: (payload: {
    sessionGroupId: string
    items: DecisionBoardItem[]
    flushedAt: string
  }) => void
  setOptionChoice: (itemId: string, optionId: string) => void
  setCustomMode: (itemId: string, on: boolean) => void
  setCustomText: (itemId: string, text: string) => void
  /** Remove a single resolved item from the modal. Used when a late
   * decision.board_item_resolved arrives (e.g. agents converged during the
   * 2s debounce). When the last item is removed, closes the modal. */
  removeItem: (itemId: string) => void
  close: () => void
}

const initialState = {
  isOpen: false,
  sessionGroupId: null as string | null,
  items: [] as DecisionBoardItem[],
  choices: {} as Record<string, BoardChoice>,
  customModes: {} as Record<string, boolean>,
}

export const useDecisionBoardStore = create<DecisionBoardState>((set) => ({
  ...initialState,

  receiveFlush: ({ sessionGroupId, items }) =>
    set({
      isOpen: true,
      sessionGroupId,
      items,
      choices: {},
      customModes: {},
    }),

  setOptionChoice: (itemId, optionId) =>
    set((state) => ({
      choices: { ...state.choices, [itemId]: { kind: "option", optionId } },
      customModes: { ...state.customModes, [itemId]: false },
    })),

  setCustomMode: (itemId, on) =>
    set((state) => {
      const nextCustomModes = { ...state.customModes, [itemId]: on }
      if (!on) return { customModes: nextCustomModes }
      const existing = state.choices[itemId]
      const nextChoices = { ...state.choices }
      if (!existing || existing.kind !== "custom") {
        nextChoices[itemId] = { kind: "custom", text: "" }
      }
      return { customModes: nextCustomModes, choices: nextChoices }
    }),

  setCustomText: (itemId, text) =>
    set((state) => ({
      choices: { ...state.choices, [itemId]: { kind: "custom", text } },
      customModes: { ...state.customModes, [itemId]: true },
    })),

  removeItem: (itemId) =>
    set((state) => {
      const nextItems = state.items.filter((i) => i.id !== itemId)
      if (nextItems.length === 0) return initialState
      const { [itemId]: _removed, ...restChoices } = state.choices
      const { [itemId]: _removedMode, ...restModes } = state.customModes
      return { items: nextItems, choices: restChoices, customModes: restModes }
    }),

  close: () => set(initialState),
}))
