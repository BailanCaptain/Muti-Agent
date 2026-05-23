/**
 * F027 Phase 3 P20 Week 3 Day 11 (AC-P3-1) · layout-store statusPanelWidth 单元测试
 *
 * 覆盖:
 *   - clampStatusPanelWidth 边界（< 360 / > 720 / NaN / Infinity / 非整数）
 *   - setStatusPanelWidth 调 clamp
 *   - persist localStorage 写入 / rehydrate clamp corrupt 值
 *   - sidebar / statusPanel collapsed 不受影响
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  STATUS_PANEL_DEFAULT_WIDTH,
  STATUS_PANEL_MAX_WIDTH,
  STATUS_PANEL_MIN_WIDTH,
  clampStatusPanelWidth,
  useLayoutStore,
} from "./layout-store"

const STORE_KEY = "multi-agent-layout-store"

function resetStore() {
  useLayoutStore.setState({
    sidebarCollapsed: false,
    statusPanelCollapsed: false,
    statusPanelWidth: STATUS_PANEL_DEFAULT_WIDTH,
  })
  localStorage.removeItem(STORE_KEY)
}

describe("clampStatusPanelWidth (AC-P3-1 范围 360-1200, plan v3.4)", () => {
  it("范围内值原样返回", () => {
    expect(clampStatusPanelWidth(400)).toBe(400)
    expect(clampStatusPanelWidth(STATUS_PANEL_MIN_WIDTH)).toBe(STATUS_PANEL_MIN_WIDTH)
    expect(clampStatusPanelWidth(STATUS_PANEL_MAX_WIDTH)).toBe(STATUS_PANEL_MAX_WIDTH)
    expect(clampStatusPanelWidth(540)).toBe(540)
    expect(clampStatusPanelWidth(900)).toBe(900) // 旧 720 之上, v3.4 后合法
  })

  it("< 360 clamp 到 360", () => {
    expect(clampStatusPanelWidth(100)).toBe(STATUS_PANEL_MIN_WIDTH)
    expect(clampStatusPanelWidth(359)).toBe(STATUS_PANEL_MIN_WIDTH)
    expect(clampStatusPanelWidth(0)).toBe(STATUS_PANEL_MIN_WIDTH)
    expect(clampStatusPanelWidth(-50)).toBe(STATUS_PANEL_MIN_WIDTH)
  })

  it("> 1200 clamp 到 1200 (v3.4 patch: 旧 720 升 1200)", () => {
    expect(clampStatusPanelWidth(1201)).toBe(STATUS_PANEL_MAX_WIDTH)
    expect(clampStatusPanelWidth(9999)).toBe(STATUS_PANEL_MAX_WIDTH)
    expect(clampStatusPanelWidth(STATUS_PANEL_MAX_WIDTH)).toBe(1200) // 显式 1200
  })

  it("NaN / Infinity → 默认值（防 corrupt localStorage）", () => {
    expect(clampStatusPanelWidth(Number.NaN)).toBe(STATUS_PANEL_DEFAULT_WIDTH)
    expect(clampStatusPanelWidth(Number.POSITIVE_INFINITY)).toBe(STATUS_PANEL_DEFAULT_WIDTH)
    expect(clampStatusPanelWidth(Number.NEGATIVE_INFINITY)).toBe(STATUS_PANEL_DEFAULT_WIDTH)
  })

  it("非整数 → 四舍五入（防 reload 误差 ≤ 1px AC）", () => {
    expect(clampStatusPanelWidth(400.4)).toBe(400)
    expect(clampStatusPanelWidth(400.6)).toBe(401)
    expect(clampStatusPanelWidth(400.5)).toBe(401) // round half-up
  })
})

describe("useLayoutStore.setStatusPanelWidth", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("范围内值直接设入", () => {
    useLayoutStore.getState().setStatusPanelWidth(500)
    expect(useLayoutStore.getState().statusPanelWidth).toBe(500)
  })

  it("越界值自动 clamp", () => {
    useLayoutStore.getState().setStatusPanelWidth(99999)
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MAX_WIDTH)
    useLayoutStore.getState().setStatusPanelWidth(50)
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MIN_WIDTH)
  })

  it("默认值 360 (AC 下限对齐，从 F021 旧 340 升级)", () => {
    resetStore()
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_DEFAULT_WIDTH)
    expect(STATUS_PANEL_DEFAULT_WIDTH).toBe(360)
  })
})

describe("layout-store persist (localStorage)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("setStatusPanelWidth 写入 localStorage", async () => {
    useLayoutStore.getState().setStatusPanelWidth(456)
    // zustand persist 是同步触发的（默认 storage = localStorage）
    const stored = localStorage.getItem(STORE_KEY)
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored ?? "{}")
    expect(parsed.state.statusPanelWidth).toBe(456)
  })

  it("rehydrate 时 corrupt 值被 clamp（merge fn 兜底）", () => {
    // 模拟 localStorage 被手动篡改成 99999 后 reload
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        state: {
          sidebarCollapsed: false,
          statusPanelCollapsed: false,
          statusPanelWidth: 99999, // corrupt
        },
        version: 0,
      }),
    )
    // 强 rehydrate
    void useLayoutStore.persist.rehydrate()
    expect(useLayoutStore.getState().statusPanelWidth).toBeLessThanOrEqual(STATUS_PANEL_MAX_WIDTH)
    expect(useLayoutStore.getState().statusPanelWidth).toBeGreaterThanOrEqual(
      STATUS_PANEL_MIN_WIDTH,
    )
  })

  it("collapsed state 也 persist（partialize 含 3 字段）", () => {
    useLayoutStore.getState().toggleStatusPanel()
    expect(useLayoutStore.getState().statusPanelCollapsed).toBe(true)
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}")
    expect(stored.state.statusPanelCollapsed).toBe(true)
  })
})
