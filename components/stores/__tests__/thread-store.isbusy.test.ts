import { describe, it, expect } from "vitest"
import { selectIsBusyForActiveGroup } from "../thread-store"

type PartialState = Parameters<typeof selectIsBusyForActiveGroup>[0]

const baseProviders = {
  claude: { running: false },
  codex: { running: false },
  gemini: { running: false },
} as unknown as PartialState["providers"]

function makeState(overrides: Partial<PartialState>): PartialState {
  return {
    activeGroup: null,
    providers: baseProviders,
    ...overrides,
  } as PartialState
}

describe("selectIsBusyForActiveGroup (F026 P0 Day1 · 并发 @ 解锁)", () => {
  it("returns false when activeGroup is null", () => {
    expect(selectIsBusyForActiveGroup(makeState({}))).toBe(false)
  })

  it("returns true when activeGroup has pending dispatches", () => {
    expect(
      selectIsBusyForActiveGroup(
        makeState({
          activeGroup: { hasPendingDispatches: true } as PartialState["activeGroup"],
        }),
      ),
    ).toBe(true)
  })

  it("returns false when a provider is running but no pending dispatches · 允许并发发第二条 @", () => {
    expect(
      selectIsBusyForActiveGroup(
        makeState({
          activeGroup: { hasPendingDispatches: false } as PartialState["activeGroup"],
          providers: {
            claude: { running: true },
            codex: { running: false },
            gemini: { running: false },
          } as unknown as PartialState["providers"],
        }),
      ),
    ).toBe(false)
  })

  it("returns false on clean state (nothing running, nothing pending)", () => {
    expect(
      selectIsBusyForActiveGroup(
        makeState({
          activeGroup: { hasPendingDispatches: false } as PartialState["activeGroup"],
        }),
      ),
    ).toBe(false)
  })
})
