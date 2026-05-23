/**
 * F027 Phase 3 Week 4 Day 20 (AC-P3-5/4) · a2a-drawer-store 单元测试
 */

import { afterEach, describe, expect, it } from "vitest"
import { useA2ADrawerStore } from "./a2a-drawer-store"

describe("useA2ADrawerStore", () => {
  afterEach(() => {
    useA2ADrawerStore.setState({ callId: null, source: null })
  })

  it("默认 callId=null + source=null", () => {
    const s = useA2ADrawerStore.getState()
    expect(s.callId).toBeNull()
    expect(s.source).toBeNull()
  })

  it("openDrawer('call-1', 'viewfinder') → 写入 callId + source", () => {
    useA2ADrawerStore.getState().openDrawer("call-1", "viewfinder")
    const s = useA2ADrawerStore.getState()
    expect(s.callId).toBe("call-1")
    expect(s.source).toBe("viewfinder")
  })

  it("openDrawer 后 closeDrawer() → 清空", () => {
    useA2ADrawerStore.getState().openDrawer("call-2", "prompt-inspector")
    useA2ADrawerStore.getState().closeDrawer()
    const s = useA2ADrawerStore.getState()
    expect(s.callId).toBeNull()
    expect(s.source).toBeNull()
  })

  it("openDrawer 切换 callId → 新 callId 覆盖", () => {
    useA2ADrawerStore.getState().openDrawer("call-A", "viewfinder")
    useA2ADrawerStore.getState().openDrawer("call-B", "prompt-inspector")
    const s = useA2ADrawerStore.getState()
    expect(s.callId).toBe("call-B")
    expect(s.source).toBe("prompt-inspector")
  })
})
