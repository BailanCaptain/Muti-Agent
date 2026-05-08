"use client"

import {
  type DebugA2ACallRow,
  type DebugA2ASessionTree,
  STATUS_TONE,
} from "./a2a-types"

/**
 * F026 P5 F10 · 递归 Tree 渲染（layout = parent_call_id 重建父子）
 *
 * 输入 trees = [{ rootCallId, calls: CallRow[] }]，calls 是当前 root 整棵树的所有节点
 * （含 root 自身）。本组件按 parentCallId 重建父子链 → 用嵌套 ul/li + 缩进可视化。
 *
 * 设计原则：
 * - 不订阅 WS，刷新交给上层 page 的 refetch 按钮（plan AC-P5-14 明示）。
 * - 死循环兜底：visited Set 防 corrupt 数据导致前端栈溢出。
 * - 节点节内显示：alias / status dot / callId 短截 / deadlineAt（最低限度对账信息）。
 */

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
}

function CallNode({
  call,
  childrenByParent,
  visited,
}: {
  call: DebugA2ACallRow
  childrenByParent: Map<string | null, DebugA2ACallRow[]>
  visited: Set<string>
}) {
  if (visited.has(call.callId)) return null
  visited.add(call.callId)
  const children = childrenByParent.get(call.callId) ?? []
  const tone = STATUS_TONE[call.status]

  return (
    <li className="my-1" data-testid={`a2a-tree-node-${call.callId}`}>
      <div className={`flex items-center gap-2 text-[12px] ${tone.text}`}>
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
        <span className="font-semibold">{call.issuerId}</span>
        <span className="opacity-60">→</span>
        <span className="font-semibold">{call.convenerId}</span>
        <span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] font-mono opacity-80">
          {shortId(call.callId)}
        </span>
        <span className="text-[10px] opacity-70">{tone.label}</span>
        <span className="text-[10px] opacity-50">deadline {call.deadlineAt}</span>
      </div>
      {children.length > 0 ? (
        <ul className="ml-4 border-l border-slate-200 pl-3">
          {children.map((child) => (
            <CallNode
              key={child.callId}
              call={child}
              childrenByParent={childrenByParent}
              visited={visited}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function A2ATreeView({ tree }: { tree: DebugA2ASessionTree }) {
  const root = tree.calls.find((c) => c.callId === tree.rootCallId)
  if (!root) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[12px] text-amber-700">
        Root call <code>{tree.rootCallId}</code> 不在 calls 列表中（数据异常）。
      </div>
    )
  }

  // 按 parentCallId 索引子节点
  const childrenByParent = new Map<string | null, DebugA2ACallRow[]>()
  for (const c of tree.calls) {
    const list = childrenByParent.get(c.parentCallId) ?? []
    list.push(c)
    childrenByParent.set(c.parentCallId, list)
  }

  const visited = new Set<string>()

  return (
    <div
      data-testid={`a2a-tree-${tree.rootCallId}`}
      className="rounded-lg border border-slate-200 bg-white/70 p-3"
    >
      <div className="mb-2 text-[11px] font-mono text-slate-500">
        root: {shortId(tree.rootCallId)}
      </div>
      <ul className="list-none">
        <CallNode call={root} childrenByParent={childrenByParent} visited={visited} />
      </ul>
    </div>
  )
}

export function A2ACallList({ calls }: { calls: DebugA2ACallRow[] }) {
  if (calls.length === 0) {
    return (
      <div className="rounded border border-dashed border-slate-200 bg-white/50 p-6 text-center text-[12px] text-slate-400">
        当前没有匹配的 call。
      </div>
    )
  }
  return (
    <ul
      data-testid="a2a-call-list"
      className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white/70 p-3"
    >
      {calls.map((c) => {
        const tone = STATUS_TONE[c.status]
        return (
          <li
            key={c.callId}
            data-testid={`a2a-call-row-${c.callId}`}
            className={`flex items-center gap-2 border-b border-slate-100 py-1 text-[12px] last:border-b-0 ${tone.text}`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`}
              aria-hidden="true"
            />
            <span className="font-semibold">{c.issuerId}</span>
            <span className="opacity-60">→</span>
            <span className="font-semibold">{c.convenerId}</span>
            <span className="rounded bg-white/80 px-1.5 py-0.5 text-[10px] font-mono opacity-80">
              {shortId(c.callId)}
            </span>
            <span className="text-[10px] opacity-70">{tone.label}</span>
            <span className="ml-auto text-[10px] opacity-50">{c.createdAt}</span>
          </li>
        )
      })}
    </ul>
  )
}
