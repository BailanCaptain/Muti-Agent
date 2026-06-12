import { beforeEach, describe, expect, it } from "vitest"

import {
  RUNTIME_LOG_LVL1_ITEMS,
  useRuntimeLogStore,
} from "./runtime-log-store"

/** F028 Task 8 · LVL1 注册 "worktrees"（plan v5：enabled / 可激活 / logs 仍禁用） */

describe("F028 T8 · runtime-log-store LVL1 worktrees", () => {
  beforeEach(() => {
    useRuntimeLogStore.setState({ activeLvl1: "system-prompt" })
  })

  it("registers worktrees as enabled LVL1 item", () => {
    const item = RUNTIME_LOG_LVL1_ITEMS.find((i) => i.key === "worktrees")
    expect(item).toBeDefined()
    expect(item?.enabled).toBe(true)
    expect(item?.label).toBe("Worktree")
  })

  it("setActiveLvl1('worktrees') activates", () => {
    useRuntimeLogStore.getState().setActiveLvl1("worktrees")
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("worktrees")
  })

  it("logs stays disabled and non-activatable", () => {
    const logs = RUNTIME_LOG_LVL1_ITEMS.find((i) => i.key === "logs")
    expect(logs?.enabled).toBe(false)
    useRuntimeLogStore.getState().setActiveLvl1("logs")
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt")
  })
})
