"use client"

import { useEffect, useRef } from "react"
import { useApprovalStore } from "../stores/approval-store"

export function useApprovalNotification() {
  const pending = useApprovalStore((s) => s.pending)
  const notifiedRef = useRef(new Set<string>())
  const originalTitleRef = useRef("")

  useEffect(() => {
    if (!originalTitleRef.current) {
      originalTitleRef.current = document.title
    }

    for (const req of pending) {
      if (notifiedRef.current.has(req.requestId)) continue
      notifiedRef.current.add(req.requestId)

      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(`${req.agentAlias} 需要权限`, {
          body: `${req.action}: ${req.reason}`,
          tag: `approval-${req.requestId}`,
          requireInteraction: true,
        })
      } else if (
        typeof Notification !== "undefined" &&
        Notification.permission !== "denied"
      ) {
        void Notification.requestPermission()
      }
    }

    if (pending.length > 0 && document.hidden) {
      document.title = `(${pending.length}) 待审批 — ${originalTitleRef.current}`
    } else {
      document.title = originalTitleRef.current
    }

    const currentIds = new Set(pending.map((r) => r.requestId))
    for (const id of notifiedRef.current) {
      if (!currentIds.has(id)) notifiedRef.current.delete(id)
    }
  }, [pending])

  useEffect(() => {
    const handler = () => {
      if (!document.hidden && originalTitleRef.current) {
        document.title = originalTitleRef.current
      }
    }
    document.addEventListener("visibilitychange", handler)
    return () => document.removeEventListener("visibilitychange", handler)
  }, [])
}
