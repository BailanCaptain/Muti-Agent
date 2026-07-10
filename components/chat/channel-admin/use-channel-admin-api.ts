"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * F040 Phase 2.5（AC-M4）：渠道管理数据 hook —— typed 响应镜像
 * packages/api/src/routes/channel-admin.ts。写路径后端热生效（AC-M2），
 * 前端只需 refresh 拉最新快照。
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

export type AdminMember = {
  openId: string
  displayName: string
  role: "owner" | "participant"
  /** P2.6 AC-N3：false = 禁用（按非白名单拒，行保留可一键恢复） */
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export type AdminGroup = {
  chatId: string
  displayName: string
  sessionGroupId: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
  boundSessionGroupId: string | null
  roomTitle: string | null
  /** P2.6 AC-N5：默认应答人生效值（binding 单独设过 ?? 渠道默认） */
  effectiveDefaultProvider: string
}

export type PendingAudit = {
  id: string
  chatId: string
  chatKind: "p2p" | "group"
  openId: string
  reason: string
  count: number
  firstAt: string
  lastAt: string
  status: "pending" | "allowed" | "dismissed"
}

export type RoomOption = {
  sessionGroupId: string
  roomId: string | null
  title: string
}

export type ChannelAdminOverview = {
  members: AdminMember[]
  groups: AdminGroup[]
  pendingAudits: PendingAudit[]
}

async function requestJson(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      ...init,
    })
    if (res.ok) return { ok: true }
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    return { ok: false, error: data?.error ?? `请求失败（${res.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${String(err)}` }
  }
}

export function useChannelAdminApi(enabled: boolean) {
  const [overview, setOverview] = useState<ChannelAdminOverview | null>(null)
  const [rooms, setRooms] = useState<RoomOption[]>([])
  const [loading, setLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [ovRes, roomsRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/channel-admin/overview`),
        fetch(`${API_BASE_URL}/api/channel-admin/rooms`),
      ])
      if (ovRes.ok) setOverview((await ovRes.json()) as ChannelAdminOverview)
      if (roomsRes.ok) setRooms(((await roomsRes.json()) as { rooms: RoomOption[] }).rooms)
    } catch (err) {
      console.error("[channel-admin] refresh error", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (enabled) void refresh()
  }, [enabled, refresh])

  /** 写动作统一收口：成功刷新快照并清错，失败把后端 error 原样亮给小孙 */
  const act = useCallback(
    async (path: string, init?: RequestInit): Promise<boolean> => {
      const r = await requestJson(path, init)
      if (r.ok) {
        setActionError(null)
        await refresh()
        return true
      }
      setActionError(r.error)
      return false
    },
    [refresh],
  )

  return {
    overview,
    rooms,
    loading,
    actionError,
    refresh,
    addMember: (openId: string, displayName: string, role: "owner" | "participant") =>
      act("/api/channel-admin/members", {
        method: "POST",
        body: JSON.stringify({ openId, displayName, role }),
      }),
    patchMember: (
      openId: string,
      patch: { displayName?: string; role?: "owner" | "participant"; enabled?: boolean },
    ) =>
      act(`/api/channel-admin/members/${encodeURIComponent(openId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    deleteMember: (openId: string) =>
      act(`/api/channel-admin/members/${encodeURIComponent(openId)}`, { method: "DELETE" }),
    addGroup: (chatId: string, displayName?: string, sessionGroupId?: string) =>
      act("/api/channel-admin/groups", {
        method: "POST",
        body: JSON.stringify({ chatId, displayName, sessionGroupId }),
      }),
    patchGroup: (
      chatId: string,
      patch: {
        displayName?: string
        sessionGroupId?: string
        enabled?: boolean
        defaultProvider?: string
      },
    ) =>
      act(`/api/channel-admin/groups/${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    deleteGroup: (chatId: string) =>
      act(`/api/channel-admin/groups/${encodeURIComponent(chatId)}`, { method: "DELETE" }),
    allowAudit: (id: string, displayName: string, role: "owner" | "participant") =>
      act(`/api/channel-admin/audits/${encodeURIComponent(id)}/allow`, {
        method: "POST",
        body: JSON.stringify({ displayName, role }),
      }),
    dismissAudit: (id: string) =>
      act(`/api/channel-admin/audits/${encodeURIComponent(id)}/dismiss`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
  }
}
