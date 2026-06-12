/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · runtime-log-store 单元测试
 *
 * 覆盖:
 *   - 默认 activeLvl1=system-prompt / activeLvl2=prompt-inspector (AC-P3-2 拍)
 *   - setActiveLvl1 / setActiveLvl2 切换
 *   - disabled lvl1 tab (日志/未来) 切换被拒
 *   - toggleCollapsed
 *   - LVL1_ITEMS / LVL2_ITEMS 常量真相源对齐 V16.5 §18
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RUNTIME_LOG_LVL1_ITEMS,
  RUNTIME_LOG_LVL2_ITEMS,
  useRuntimeLogStore,
} from "./runtime-log-store"

function resetStore() {
  useRuntimeLogStore.setState({
    activeLvl1: "system-prompt",
    activeLvl2: "prompt-inspector",
    collapsed: false,
  })
}

describe("runtime-log-store 常量对齐 V16.5 §18", () => {
  it("LVL1_ITEMS = 4 项 (system-prompt/worktrees/project-tree enabled + logs disabled+future) — F028 双 tab 落位", () => {
    expect(RUNTIME_LOG_LVL1_ITEMS).toHaveLength(4)
    expect(RUNTIME_LOG_LVL1_ITEMS.map((i) => i.key)).toEqual([
      "system-prompt",
      "worktrees",
      "project-tree",
      "logs",
    ])
    expect(RUNTIME_LOG_LVL1_ITEMS.filter((i) => i.enabled).map((i) => i.key)).toEqual([
      "system-prompt",
      "worktrees",
      "project-tree",
    ])
    const logs = RUNTIME_LOG_LVL1_ITEMS[3]
    expect(logs.enabled).toBe(false)
    expect(logs.futureTag).toBe(true)
  })

  it("LVL2_ITEMS = 5 tabs 按 V16.5 §18 line 1948-1954 顺序", () => {
    expect(RUNTIME_LOG_LVL2_ITEMS).toHaveLength(5)
    const keys = RUNTIME_LOG_LVL2_ITEMS.map((i) => i.key)
    expect(keys).toEqual([
      "viewfinder",
      "prompt-inspector",
      "draft-approval",
      "warnings",
      "knowledge-base",
    ])
  })
})

describe("runtime-log-store 默认 state (AC-P3-2 拍板)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("activeLvl1 默认 = system-prompt", () => {
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt")
  })

  it("activeLvl2 默认 = prompt-inspector (V16.5 §18 line 1951 默认)", () => {
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("prompt-inspector")
  })

  it("collapsed 默认 false", () => {
    expect(useRuntimeLogStore.getState().collapsed).toBe(false)
  })
})

describe("runtime-log-store setActiveLvl1", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("切到 system-prompt enabled tab 成功", () => {
    useRuntimeLogStore.setState({ activeLvl1: "logs" }) // bypass setter 强设
    useRuntimeLogStore.getState().setActiveLvl1("system-prompt")
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt")
  })

  it("切到 disabled (logs/未来) tab 被拒 — 状态不变", () => {
    useRuntimeLogStore.getState().setActiveLvl1("logs")
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt") // 不变
  })

  it("切到不存在的 key 被拒", () => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试故意传非法 key
    useRuntimeLogStore.getState().setActiveLvl1("nonexistent" as any)
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt")
  })
})

describe("runtime-log-store setActiveLvl2 (5 tab 切换)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("切到 viewfinder", () => {
    useRuntimeLogStore.getState().setActiveLvl2("viewfinder")
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("viewfinder")
  })

  it("切到 draft-approval / warnings / knowledge-base 都成功", () => {
    const tabs = ["draft-approval", "warnings", "knowledge-base"] as const
    for (const tab of tabs) {
      useRuntimeLogStore.getState().setActiveLvl2(tab)
      expect(useRuntimeLogStore.getState().activeLvl2).toBe(tab)
    }
  })

  it("切回 prompt-inspector (默认 tab) 成功", () => {
    useRuntimeLogStore.setState({ activeLvl2: "viewfinder" })
    useRuntimeLogStore.getState().setActiveLvl2("prompt-inspector")
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("prompt-inspector")
  })
})

describe("runtime-log-store toggleCollapsed", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("toggle 翻转 collapsed", () => {
    expect(useRuntimeLogStore.getState().collapsed).toBe(false)
    useRuntimeLogStore.getState().toggleCollapsed()
    expect(useRuntimeLogStore.getState().collapsed).toBe(true)
    useRuntimeLogStore.getState().toggleCollapsed()
    expect(useRuntimeLogStore.getState().collapsed).toBe(false)
  })
})
