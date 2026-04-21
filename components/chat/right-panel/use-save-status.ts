"use client"

import { useEffect, useRef, useState } from "react"

export type SaveStatus = "idle" | "saving" | "saved"

type Labels = {
  idle: string
  saving?: string
  saved?: string
}

const SAVED_HOLD_MS = 1800

export function useSaveStatus(labels: Labels) {
  const [status, setStatus] = useState<SaveStatus>("idle")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setStatus("saving")
    try {
      const result = await action()
      setStatus("saved")
      timerRef.current = setTimeout(() => {
        setStatus("idle")
        timerRef.current = null
      }, SAVED_HOLD_MS)
      return result
    } catch {
      setStatus("idle")
      return undefined
    }
  }

  const label =
    status === "saving"
      ? (labels.saving ?? "保存中…")
      : status === "saved"
        ? (labels.saved ?? "✓ 已保存")
        : labels.idle

  return { status, run, label, isBusy: status !== "idle" }
}
