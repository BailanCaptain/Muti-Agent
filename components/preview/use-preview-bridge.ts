"use client"

import { useCallback, useEffect, useState } from "react"

export interface ConsoleEntry {
  level: string
  args: string[]
  timestamp: number
}

export function usePreviewBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  gatewayPort?: number,
) {
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [isCapturing, setIsCapturing] = useState(false)
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.source !== "multi-agent-bridge") return
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return
      if (gatewayPort) {
        const validOrigins = [
          `http://localhost:${gatewayPort}`,
          `http://127.0.0.1:${gatewayPort}`,
          window.location.origin,
        ]
        if (!validOrigins.includes(event.origin)) return
      }
      switch (event.data.type) {
        case "screenshot-result": {
          const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"
          fetch(`${apiBase}/api/preview/screenshot`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataUrl: event.data.dataUrl }),
          })
            .then((r) => r.json() as Promise<{ url: string }>)
            .then((data) => {
              setScreenshotUrl(data.url)
              setTimeout(() => setScreenshotUrl(null), 5000)
            })
            .catch(() => {})
            .finally(() => setIsCapturing(false))
          break
        }
        case "screenshot-error":
          setIsCapturing(false)
          break
        case "console":
          setConsoleEntries((prev) => {
            const next = [
              ...prev,
              { level: event.data.level, args: event.data.args, timestamp: event.data.timestamp },
            ]
            return next.length > 500 ? next.slice(-500) : next
          })
          if (event.data.level === "error") setConsoleOpen(true)
          break
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [iframeRef, gatewayPort])

  const handleScreenshot = useCallback(() => {
    if (!iframeRef.current?.contentWindow || isCapturing) return
    setIsCapturing(true)
    const targetOrigin = gatewayPort ? `http://localhost:${gatewayPort}` : "*"
    iframeRef.current.contentWindow.postMessage(
      { type: "screenshot-request", source: "multi-agent-preview" },
      targetOrigin,
    )
  }, [isCapturing, iframeRef, gatewayPort])

  const clearConsole = useCallback(() => setConsoleEntries([]), [])

  return {
    consoleEntries,
    consoleOpen,
    setConsoleOpen,
    isCapturing,
    screenshotUrl,
    handleScreenshot,
    clearConsole,
  }
}
