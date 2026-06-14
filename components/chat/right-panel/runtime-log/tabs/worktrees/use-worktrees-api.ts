"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * F028 Task 9 · Worktree tab data hooks（契约镜像 packages/api/src/routes/worktrees.ts）
 * 懒加载门：enabled=false 不发任何请求（F027 always-render 防启动并发 fetch 同款防御）。
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

export type PreviewStatus = {
  apiPort: number
  webPort: number
  apiAlive: boolean
  webAlive: boolean
  ownership: "ui" | "foreign" | "none"
}

export type MergeStatus = {
  ahead: number | null
  behind: number | null
  mergedHint: boolean | null
}

export type WorktreeRow = {
  name: string
  branch: string
  head: string
  path: string
  isMain: boolean
  preview: PreviewStatus | null
  /** 续作 AC11：主仓/降级 = null；非主行 best-effort 合并状态 */
  mergeStatus?: MergeStatus | null
}

export type WorktreeSummary = {
  branch: string
  head: string
  commits: Array<{ hash: string; subject: string; date: string }>
  diffStat: { baseRef: string; files: number; insertions: number; deletions: number }
  working: { staged: number; unstaged: number; untracked: number }
}

export type PreviewAction = "compile-backend" | "restart" | "start"

export type ActionResult =
  | { ok: true; apiPort: number; webPort: number }
  | { ok: false; stage: string; message: string; httpStatus: number }

export function useWorktreesData({ enabled }: { enabled: boolean }) {
  const [worktrees, setWorktrees] = useState<WorktreeRow[]>([])
  const [control, setControl] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [listRes, capRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/worktrees`),
        fetch(`${API_BASE_URL}/api/worktrees/capabilities`),
      ])
      const list = (await listRes.json()) as { worktrees: WorktreeRow[] }
      const cap = (await capRes.json()) as { control: boolean }
      setWorktrees(list.worktrees ?? [])
      setControl(Boolean(cap.control))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) void refetch()
  }, [enabled, refetch])

  return { worktrees, control, isLoading, error, refetch }
}

export function useWorktreeSummary(name: string | null) {
  const [summary, setSummary] = useState<WorktreeSummary | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!name) {
      setSummary(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setSummary(null)
    fetch(`${API_BASE_URL}/api/worktrees/${encodeURIComponent(name)}/summary`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`summary ${res.status}`)
        return (await res.json()) as WorktreeSummary
      })
      .then((data) => {
        if (!cancelled) setSummary(data)
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [name])

  return { summary, isLoading }
}

export async function postPreviewAction(name: string, action: PreviewAction): Promise<ActionResult> {
  const res = await fetch(
    `${API_BASE_URL}/api/worktrees/${encodeURIComponent(name)}/preview/${action}`,
    { method: "POST" },
  )
  const body = (await res.json()) as
    | { ok: true; apiPort: number; webPort: number }
    | { ok: false; stage: string; message: string }
  if (body.ok) return body
  return { ...body, httpStatus: res.status }
}

export type CleanupStep = { name: string; ok: boolean; message?: string }
export type CleanupResult = { ok: boolean; steps: CleanupStep[] }

export async function postCleanup(name: string): Promise<CleanupResult> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/worktrees/${encodeURIComponent(name)}/cleanup`, {
      method: "POST",
    })
    const body = (await res.json()) as Partial<CleanupResult> & { error?: string; message?: string }
    // 德彪 code-r1 P2-2：后端异常（如 500）可能返回无 steps 的体；合成结构化失败，绝不让
    // 调用方拿到 steps=undefined 后 .map 崩。
    if (typeof body?.ok === "boolean" && Array.isArray(body.steps)) {
      return body as CleanupResult
    }
    return {
      ok: false,
      steps: [{ name: "request", ok: false, message: body?.error ?? body?.message ?? `清理响应异常（HTTP ${res.status}）` }],
    }
  } catch (err) {
    return { ok: false, steps: [{ name: "request", ok: false, message: err instanceof Error ? err.message : String(err) }] }
  }
}

export async function fetchLogTail(
  name: string,
  proc: "api" | "web",
  lines: number,
): Promise<string[]> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/worktrees/${encodeURIComponent(name)}/preview/log?proc=${proc}&lines=${lines}`,
    )
    const body = (await res.json()) as { lines: string[] }
    return body.lines ?? []
  } catch {
    return []
  }
}
