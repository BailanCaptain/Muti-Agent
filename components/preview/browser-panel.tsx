"use client"

import { Camera, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Terminal, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { type ConsoleEntry, usePreviewBridge } from "./use-preview-bridge"

interface BrowserPanelProps {
  initialPort?: number
  initialPath?: string
  onClose?: () => void
}

export function BrowserPanel({ initialPort, initialPath, onClose }: BrowserPanelProps) {
  const [gatewayPort, setGatewayPort] = useState(0)
  const [targetPort, setTargetPort] = useState(initialPort ?? 0)
  const [urlInput, setUrlInput] = useState(
    initialPort
      ? `localhost:${initialPort}${initialPath && initialPath !== "/" ? initialPath : ""}`
      : "",
  )
  const [targetPath, setTargetPath] = useState(initialPath ?? "/")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const {
    consoleEntries,
    consoleOpen,
    setConsoleOpen,
    isCapturing,
    screenshotUrl,
    handleScreenshot,
    clearConsole,
  } = usePreviewBridge(iframeRef, gatewayPort)

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"
    fetch(`${apiBase}/api/preview/status`)
      .then((res) => res.json() as Promise<{ available: boolean; gatewayPort: number }>)
      .then((data) => {
        if (data.available) setGatewayPort(data.gatewayPort)
        else setError("Preview gateway not available")
      })
      .catch(() => setError("Cannot reach API server"))
  }, [])

  useEffect(() => {
    if (initialPort) {
      setTargetPort(initialPort)
      setTargetPath(initialPath ?? "/")
      setUrlInput(
        `localhost:${initialPort}${initialPath && initialPath !== "/" ? initialPath : ""}`,
      )
    }
  }, [initialPort, initialPath])

  const gatewayUrl = (() => {
    if (!targetPort || !gatewayPort) return ""
    const url = new URL(`http://localhost:${gatewayPort}`)
    const qIdx = targetPath.indexOf("?")
    if (qIdx >= 0) {
      url.pathname = targetPath.slice(0, qIdx)
      const existing = new URLSearchParams(targetPath.slice(qIdx + 1))
      for (const [k, v] of existing) url.searchParams.set(k, v)
    } else {
      url.pathname = targetPath
    }
    url.searchParams.set("__preview_port", String(targetPort))
    return url.toString()
  })()

  const handleNavigate = useCallback(() => {
    setError(null)
    const match = urlInput.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d+)(\/.*)?$/)
    if (!match) {
      setError("Enter a valid localhost URL (e.g. localhost:5173)")
      return
    }
    const port = Number.parseInt(match[1]!, 10)
    const path = match[2] ?? "/"
    setTargetPort(port)
    setTargetPath(path)
    setIsLoading(true)
  }, [urlInput])

  const handleRefresh = useCallback(() => {
    if (iframeRef.current && gatewayUrl) {
      setIsLoading(true)
      const src = iframeRef.current.src
      iframeRef.current.src = ""
      requestAnimationFrame(() => {
        if (iframeRef.current) iframeRef.current.src = src
      })
    }
  }, [gatewayUrl])

  return (
    <div className="flex flex-col h-full border-l border-slate-200 bg-white">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5">
        <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Back">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Forward">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={handleRefresh} title="Refresh">
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </button>

        <form
          className="flex flex-1 items-center gap-1"
          onSubmit={(e) => { e.preventDefault(); handleNavigate() }}
        >
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="localhost:5173"
            className="flex-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 outline-none focus:border-slate-300 focus:ring-1 focus:ring-slate-200"
          />
        </form>

        <button
          type="button"
          className={`rounded p-1 ${isCapturing ? "text-emerald-500" : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"}`}
          onClick={handleScreenshot}
          disabled={isCapturing || !gatewayUrl}
          title="Screenshot"
        >
          <Camera className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={`rounded p-1 ${consoleOpen ? "text-amber-500" : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"}`}
          onClick={() => setConsoleOpen((v) => !v)}
          title="Console"
        >
          <Terminal className="h-3.5 w-3.5" />
          {consoleEntries.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-400" />
          )}
        </button>
        {targetPort > 0 && (
          <a
            href={`http://localhost:${targetPort}${targetPath}`}
            target="_blank"
            rel="noreferrer"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            title="Open in new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {onClose && (
          <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={onClose} title="Close">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {error && (
        <div className="px-3 py-1.5 text-xs text-red-600 bg-red-50 border-b border-red-100">
          {error}
        </div>
      )}

      {screenshotUrl && (
        <div className="px-3 py-1.5 text-xs text-green-700 bg-green-50 border-b border-green-100">
          Screenshot saved: <a href={screenshotUrl} target="_blank" rel="noreferrer" className="underline">{screenshotUrl}</a>
        </div>
      )}

      {/* Iframe */}
      {gatewayUrl ? (
        <div className="relative flex-1">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
              <div className="text-xs text-slate-400">Loading preview...</div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={gatewayUrl}
            sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"
            referrerPolicy="no-referrer"
            className="w-full h-full border-0"
            title="Preview"
            onLoad={() => setIsLoading(false)}
            onError={() => { setIsLoading(false); setError("Failed to load preview") }}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
          <div className="text-center">
            <p className="text-2xl mb-2 opacity-30">🌐</p>
            <p>Enter a localhost URL to preview</p>
          </div>
        </div>
      )}

      {/* Console panel */}
      {consoleOpen && (
        <div className="border-t border-slate-200 bg-slate-900 max-h-48 overflow-y-auto">
          <div className="flex items-center justify-between px-2 py-1 border-b border-slate-700">
            <span className="text-[10px] font-medium text-slate-400">Console</span>
            <button type="button" className="text-[10px] text-slate-500 hover:text-slate-300" onClick={clearConsole}>
              Clear
            </button>
          </div>
          <div className="px-2 py-1 space-y-0.5 font-mono text-[11px]">
            {consoleEntries.map((entry, i) => (
              <div
                key={`${entry.timestamp}-${i}`}
                className={`${entry.level === "error" ? "text-red-400" : entry.level === "warn" ? "text-amber-400" : "text-slate-300"}`}
              >
                <span className="text-slate-500 mr-1">[{entry.level}]</span>
                {entry.args.join(" ")}
              </div>
            ))}
            {consoleEntries.length === 0 && (
              <div className="text-slate-600 italic">No console output</div>
            )}
          </div>
        </div>
      )}

      {/* Status bar */}
      <div className="flex items-center px-2 py-0.5 border-t border-slate-200 text-[10px] text-slate-400">
        {targetPort && gatewayPort ? (
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
            localhost:{targetPort} via gateway:{gatewayPort}
          </span>
        ) : (
          <span>No preview</span>
        )}
      </div>
    </div>
  )
}
