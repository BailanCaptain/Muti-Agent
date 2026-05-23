/**
 * F027 Phase 3 Week 4 Day 19c (AC-P3-6 入口 C) · composer-slash-menu 单元测试
 *
 * 覆盖:
 *   - SLASH_COMMANDS: 5 命令 (ingest enabled, 其他 4 disabled)
 *   - filterSlashCommands: 前缀过滤 (empty / 'in' / 'xyz')
 *   - findSlashContext: cursor 前 / 位置 + query (line start / 空格后 / path/url 排除)
 *   - nextHighlightOnKey: ArrowDown/Up 跳过 disabled
 *   - SlashCommandMenu 渲染: open / closed / commands 列表 / disabled UI / active 高亮
 *   - select: enabled click → onSelect 触发; disabled click → 不触发
 *   - outside click → onClose
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SLASH_COMMANDS,
  SlashCommandMenu,
  filterSlashCommands,
  findSlashContext,
  nextHighlightOnKey,
} from "./composer-slash-menu"

describe("SLASH_COMMANDS", () => {
  it("5 个命令, 顺序 ingest/promote/demote/series/rollback", () => {
    expect(SLASH_COMMANDS.length).toBe(5)
    expect(SLASH_COMMANDS.map((c) => c.key)).toEqual([
      "ingest",
      "promote",
      "demote",
      "series",
      "rollback",
    ])
  })

  it("只 ingest enabled (Phase 3 范围), 其他 4 disabled (Phase 4)", () => {
    const enabled = SLASH_COMMANDS.filter((c) => c.enabled)
    expect(enabled.map((c) => c.key)).toEqual(["ingest"])
  })
})

describe("filterSlashCommands", () => {
  it("query 空 → 全部 5", () => {
    expect(filterSlashCommands("").length).toBe(5)
  })
  it("query 'in' → only ingest", () => {
    const r = filterSlashCommands("in")
    expect(r.map((c) => c.key)).toEqual(["ingest"])
  })
  it("query 'P' → 多匹配 promote (case-insensitive)", () => {
    const r = filterSlashCommands("P")
    expect(r.map((c) => c.key)).toEqual(["promote"])
  })
  it("query 'xyz' → 空", () => {
    expect(filterSlashCommands("xyz").length).toBe(0)
  })
  it("query 'ROLL' → rollback", () => {
    expect(filterSlashCommands("ROLL").map((c) => c.key)).toEqual(["rollback"])
  })
})

describe("findSlashContext", () => {
  it("'/' at start cursor=1 → {start:0, query:''}", () => {
    expect(findSlashContext("/", 1)).toEqual({ start: 0, query: "" })
  })
  it("'/in' cursor=3 → {start:0, query:'in'}", () => {
    expect(findSlashContext("/in", 3)).toEqual({ start: 0, query: "in" })
  })
  it("'foo /in' cursor=7 → {start:4, query:'in'} (space 前的 /)", () => {
    expect(findSlashContext("foo /in", 7)).toEqual({ start: 4, query: "in" })
  })
  it("'foo/in' cursor=6 → null (path-like, 前面没空格)", () => {
    expect(findSlashContext("foo/in", 6)).toBeNull()
  })
  it("'/foo bar' cursor=8 → null (query 含空格)", () => {
    expect(findSlashContext("/foo bar", 8)).toBeNull()
  })
  it("cursor=0 → null (无 cursor 前内容)", () => {
    expect(findSlashContext("", 0)).toBeNull()
  })
  it("'@foo/bar' cursor=8 → null (/ 前是 mention)", () => {
    expect(findSlashContext("@foo/bar", 8)).toBeNull()
  })
})

describe("nextHighlightOnKey", () => {
  const cmds = SLASH_COMMANDS

  it("ArrowDown current=0 (ingest) → 0 (只 1 enabled, 转回自己)", () => {
    expect(nextHighlightOnKey("ArrowDown", cmds, 0)).toBe(0)
  })

  it("ArrowDown current=2 (disabled demote) → 0 (跳到第一个 enabled)", () => {
    expect(nextHighlightOnKey("ArrowDown", cmds, 2)).toBe(0)
  })

  it("ArrowUp current=0 → 0 (只 1 enabled wrap 回自己)", () => {
    expect(nextHighlightOnKey("ArrowUp", cmds, 0)).toBe(0)
  })

  it("Enter / 其他 key → null (不消费)", () => {
    expect(nextHighlightOnKey("Enter", cmds, 0)).toBeNull()
    expect(nextHighlightOnKey("Tab", cmds, 0)).toBeNull()
  })

  it("空 commands → null", () => {
    expect(nextHighlightOnKey("ArrowDown", [], 0)).toBeNull()
  })

  it("全 disabled → null", () => {
    const allDisabled = cmds.map((c) => ({ ...c, enabled: false }))
    expect(nextHighlightOnKey("ArrowDown", allDisabled, 0)).toBeNull()
  })

  it("ArrowDown 跨多 enabled: 假 2 enabled (0 + 2)", () => {
    const fake = [
      { ...cmds[0], enabled: true },
      { ...cmds[1], enabled: false },
      { ...cmds[2], enabled: true },
      { ...cmds[3], enabled: false },
      { ...cmds[4], enabled: false },
    ]
    // current=0 → next 2
    expect(nextHighlightOnKey("ArrowDown", fake, 0)).toBe(2)
    // current=2 → next wrap 0
    expect(nextHighlightOnKey("ArrowDown", fake, 2)).toBe(0)
    // ArrowUp current=0 → wrap 2
    expect(nextHighlightOnKey("ArrowUp", fake, 0)).toBe(2)
  })
})

describe("SlashCommandMenu 渲染", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("open=false → 不渲染", () => {
    render(
      <SlashCommandMenu
        open={false}
        commands={SLASH_COMMANDS}
        highlight={0}
        onSelect={vi.fn()}
        onHighlightChange={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("composer-slash-menu")).toBeNull()
  })

  it("open=true commands 空 → 不渲染", () => {
    render(
      <SlashCommandMenu
        open={true}
        commands={[]}
        highlight={0}
        onSelect={vi.fn()}
        onHighlightChange={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId("composer-slash-menu")).toBeNull()
  })

  it("open + 5 命令 → 渲染 5 button + ingest enabled + 其他 disabled", () => {
    render(
      <SlashCommandMenu
        open={true}
        commands={SLASH_COMMANDS}
        highlight={0}
        onSelect={vi.fn()}
        onHighlightChange={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId("composer-slash-menu")).toBeTruthy()
    expect(screen.getByTestId("slash-command-ingest")).toBeTruthy()
    const ingestBtn = screen.getByTestId("slash-command-ingest") as HTMLButtonElement
    expect(ingestBtn.disabled).toBe(false)
    const promoteBtn = screen.getByTestId("slash-command-promote") as HTMLButtonElement
    expect(promoteBtn.disabled).toBe(true)
    expect(promoteBtn.getAttribute("data-disabled")).toBe("true")
  })

  it("highlight=0 → ingest data-active=true", () => {
    render(
      <SlashCommandMenu
        open={true}
        commands={SLASH_COMMANDS}
        highlight={0}
        onSelect={vi.fn()}
        onHighlightChange={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId("slash-command-ingest").getAttribute("data-active")).toBe("true")
    expect(screen.getByTestId("slash-command-promote").getAttribute("data-active")).toBe("false")
  })

  it("click ingest → onSelect 触发 with cmd", () => {
    const onSelect = vi.fn()
    render(
      <SlashCommandMenu
        open={true}
        commands={SLASH_COMMANDS}
        highlight={0}
        onSelect={onSelect}
        onHighlightChange={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("slash-command-ingest"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ key: "ingest", enabled: true }))
  })

  it("click disabled promote → onSelect 不触发", () => {
    const onSelect = vi.fn()
    render(
      <SlashCommandMenu
        open={true}
        commands={SLASH_COMMANDS}
        highlight={0}
        onSelect={onSelect}
        onHighlightChange={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId("slash-command-promote"))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("mouseEnter (enabled cmd) → onHighlightChange triggered", () => {
    // React 在 disabled button 上不触发 onMouseEnter, 测 enabled ingest 即可。
    const onHighlightChange = vi.fn()
    render(
      <SlashCommandMenu
        open={true}
        commands={SLASH_COMMANDS}
        highlight={3}
        onSelect={vi.fn()}
        onHighlightChange={onHighlightChange}
        onClose={vi.fn()}
      />,
    )
    fireEvent.mouseEnter(screen.getByTestId("slash-command-ingest"))
    expect(onHighlightChange).toHaveBeenCalledWith(0) // ingest index=0
  })

  it("outside click → onClose 触发", () => {
    const onClose = vi.fn()
    render(
      <div>
        <button type="button" data-testid="outside">
          outside
        </button>
        <SlashCommandMenu
          open={true}
          commands={SLASH_COMMANDS}
          highlight={0}
          onSelect={vi.fn()}
          onHighlightChange={vi.fn()}
          onClose={onClose}
        />
      </div>,
    )
    fireEvent.mouseDown(screen.getByTestId("outside"))
    expect(onClose).toHaveBeenCalled()
  })

  it("inside click 不触发 onClose", () => {
    const onClose = vi.fn()
    render(
      <SlashCommandMenu
        open={true}
        commands={SLASH_COMMANDS}
        highlight={0}
        onSelect={vi.fn()}
        onHighlightChange={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.mouseDown(screen.getByTestId("slash-command-ingest"))
    expect(onClose).not.toHaveBeenCalled()
  })
})
