import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { A2ACallList, A2ATreeView } from "./a2a-tree-view"
import type { DebugA2ACallRow, DebugA2ASessionTree } from "./a2a-types"

function makeCall(overrides: Partial<DebugA2ACallRow> = {}): DebugA2ACallRow {
  const base: DebugA2ACallRow = {
    callId: "call-root",
    parentCallId: null,
    rootCallId: "call-root",
    issuerId: "黄仁勋",
    convenerId: "范德彪",
    onBehalfOf: null,
    replyTo: "thread-1",
    deadlineAt: "2026-04-29T11:00:00Z",
    joinSetId: null,
    status: "pending",
    envelopeVersion: "v1",
    sessionGroupId: "g1",
    createdAt: "2026-04-29T10:00:00Z",
    updatedAt: "2026-04-29T10:00:00Z",
  }
  return { ...base, ...overrides }
}

describe("F026 P5 F10 · A2ATreeView (递归 call tree)", () => {
  it("根节点 + 两层子节点全部渲染", () => {
    const tree: DebugA2ASessionTree = {
      rootCallId: "call-root",
      calls: [
        makeCall(),
        makeCall({
          callId: "call-c1",
          parentCallId: "call-root",
          issuerId: "范德彪",
          convenerId: "桂芬",
          status: "working",
        }),
        makeCall({
          callId: "call-c2",
          parentCallId: "call-c1",
          issuerId: "桂芬",
          convenerId: "黄仁勋",
          status: "done",
        }),
      ],
    }
    render(<A2ATreeView tree={tree} />)
    expect(screen.getByTestId("a2a-tree-call-root")).toBeTruthy()
    expect(screen.getByTestId("a2a-tree-node-call-root")).toBeTruthy()
    expect(screen.getByTestId("a2a-tree-node-call-c1")).toBeTruthy()
    expect(screen.getByTestId("a2a-tree-node-call-c2")).toBeTruthy()
  })

  it("root 不在 calls 中时降级为 amber 警告", () => {
    const tree: DebugA2ASessionTree = {
      rootCallId: "call-missing",
      calls: [makeCall({ callId: "call-other" })],
    }
    const { container } = render(<A2ATreeView tree={tree} />)
    expect(container.textContent).toMatch(/数据异常/)
  })

  it("循环引用兜底：visited Set 防止栈溢出", () => {
    const tree: DebugA2ASessionTree = {
      rootCallId: "call-root",
      calls: [
        makeCall(),
        // 故意造一条循环：call-x parent 自己（数据 corrupt 场景）
        makeCall({ callId: "call-x", parentCallId: "call-x" }),
      ],
    }
    // 应该正常渲染不抛错（visited Set 兜底）
    expect(() => render(<A2ATreeView tree={tree} />)).not.toThrow()
  })
})

describe("F026 P5 F10 · A2ACallList (扁平状态过滤列表)", () => {
  it("空列表时显示占位文案", () => {
    const { container } = render(<A2ACallList calls={[]} />)
    expect(container.textContent).toMatch(/当前没有匹配/)
    expect(screen.queryByTestId("a2a-call-list")).toBeNull()
  })

  it("非空时每行渲染 issuer→convener + status 标签", () => {
    render(
      <A2ACallList
        calls={[
          makeCall({ callId: "c1", status: "pending" }),
          makeCall({ callId: "c2", status: "timeout", issuerId: "桂芬", convenerId: "范德彪" }),
        ]}
      />,
    )
    expect(screen.getByTestId("a2a-call-list")).toBeTruthy()
    expect(screen.getByTestId("a2a-call-row-c1")).toBeTruthy()
    expect(screen.getByTestId("a2a-call-row-c2")).toBeTruthy()
    // 状态文案
    const list = screen.getByTestId("a2a-call-list")
    expect(list.textContent).toMatch(/待发/)
    expect(list.textContent).toMatch(/超时/)
  })
})
