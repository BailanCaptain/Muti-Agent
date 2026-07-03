"use client"

import { ChevronDown, ChevronRight } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"

/**
 * F028 Task 15 · ProjectTreeTab（AC1/AC2 前端面）
 * 根切换（主仓/任一 worktree）+ 懒加载目录树（子目录缓存）+ 只读内容视图
 * （mtime/truncated 提示/错误条）。读取走后端 containment 同源端点，前端零特权。
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

type TreeEntry = { name: string; type: "dir" | "file"; size: number | null }
type DirState = { entries: TreeEntry[]; truncated: boolean }

export function ProjectTreeTab() {
  const activeLvl1 = useRuntimeLogStore((s) => s.activeLvl1)
  const enabled = activeLvl1 === "project-tree"

  const [roots, setRoots] = useState<Array<{ id: string; label: string }>>([])
  const [rootId, setRootId] = useState("main")
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [file, setFile] = useState<{
    path: string
    content: string
    mtime: string
    truncated: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadDir = useCallback(
    async (dir: string, opts: { force?: boolean } = {}) => {
      if (!opts.force && dirs.has(dir)) return // 子目录缓存：再次展开不重 fetch
      try {
        const res = await fetch(
          `${API_BASE_URL}/api/project-tree/list?root=${encodeURIComponent(rootId)}&dir=${encodeURIComponent(dir)}`,
        )
        if (!res.ok) throw new Error(`list ${res.status}`)
        const body = (await res.json()) as DirState
        setDirs((prev) => new Map(prev).set(dir, body))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [dirs, rootId],
  )

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(`${API_BASE_URL}/api/project-tree/roots`)
      .then(async (res) => (await res.json()) as { roots: Array<{ id: string; label: string }> })
      .then((body) => {
        if (!cancelled) setRoots(body.roots ?? [])
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    void loadDir("")
    return () => {
      cancelled = true
    }
    // loadDir 依赖 dirs 缓存，仅在 enabled/root 变化时重置触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rootId])

  const switchRoot = (id: string) => {
    setRootId(id)
    setDirs(new Map())
    setExpanded(new Set())
    setFile(null)
    setError(null)
  }

  const toggleDir = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else {
        next.add(dir)
        void loadDir(dir)
      }
      return next
    })
  }

  const openFile = async (relPath: string) => {
    setError(null)
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/project-tree/content?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(relPath)}`,
      )
      const body = (await res.json()) as
        | { content: string; mtime: string; truncated: boolean }
        | { error: string }
      if (!res.ok || "error" in body) {
        setFile(null)
        setError("error" in body ? body.error : `content ${res.status}`)
        return
      }
      setFile({ path: relPath, ...body })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-3 text-xs" data-testid="project-tree-tab">
      <div className="flex items-center gap-1" data-testid="pt-root-switcher">
        <span className="text-slate-400">根:</span>
        {roots.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => switchRoot(r.id)}
            className={`rounded px-1.5 py-0.5 transition-colors ${
              r.id === rootId ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-2 text-red-700" data-testid="pt-error">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        <div className="w-1/2 overflow-auto rounded border border-slate-200 p-1.5">
          <DirNodes
            dir=""
            dirs={dirs}
            expanded={expanded}
            onToggleDir={toggleDir}
            onOpenFile={(p) => void openFile(p)}
          />
        </div>
        <div className="flex w-1/2 flex-col overflow-hidden rounded border border-slate-200">
          {file ? (
            <>
              <div className="border-b border-slate-100 px-2 py-1 text-slate-500" data-testid="pt-content-meta">
                {file.path} · {file.mtime}（只读）
              </div>
              {file.truncated && (
                <div className="bg-amber-50 px-2 py-1 text-amber-700" data-testid="pt-truncated-banner">
                  文件超 512KB，已截断显示
                </div>
              )}
              <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-caption leading-relaxed" data-testid="pt-content">
                {file.content}
              </pre>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-slate-300">点击左侧文件查看内容</div>
          )}
        </div>
      </div>
    </div>
  )
}

function DirNodes({
  dir,
  dirs,
  expanded,
  onToggleDir,
  onOpenFile,
}: {
  dir: string
  dirs: Map<string, DirState>
  expanded: Set<string>
  onToggleDir: (dir: string) => void
  onOpenFile: (path: string) => void
}) {
  const state = dirs.get(dir)
  if (!state) return <div className="px-1 text-slate-300">加载中…</div>
  return (
    <ul className="flex flex-col">
      {state.truncated && <li className="px-1 text-amber-600">（目录条目超 1000，已截断）</li>}
      {state.entries.map((entry) => {
        const childPath = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.type === "dir") {
          const open = expanded.has(childPath)
          return (
            <li key={childPath}>
              <button
                type="button"
                className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-slate-700 hover:bg-slate-100"
                data-testid={`pt-entry-${childPath}`}
                onClick={() => onToggleDir(childPath)}
              >
                <span className="text-slate-400">
                  {open ? (
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  )}
                </span>
                {entry.name}/
              </button>
              {open && (
                <div className="pl-4">
                  <DirNodes
                    dir={childPath}
                    dirs={dirs}
                    expanded={expanded}
                    onToggleDir={onToggleDir}
                    onOpenFile={onOpenFile}
                  />
                </div>
              )}
            </li>
          )
        }
        return (
          <li key={childPath}>
            <button
              type="button"
              className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-slate-600 hover:bg-slate-100"
              data-testid={`pt-entry-${childPath}`}
              onClick={() => onOpenFile(childPath)}
            >
              <span className="text-slate-300">·</span>
              {entry.name}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
