"use client"

import { CheckCircle2, Loader2, XCircle } from "lucide-react"
import type { Provider, ToolEvent } from "@multi-agent/shared"

const providerStepTheme: Record<Provider, { icon: string; bar: string; text: string; error: string }> = {
  codex: { icon: "text-amber-500", bar: "bg-amber-100", text: "text-amber-700", error: "text-red-500" },
  claude: { icon: "text-violet-500", bar: "bg-violet-100", text: "text-violet-700", error: "text-red-500" },
  gemini: { icon: "text-sky-500", bar: "bg-sky-100", text: "text-sky-700", error: "text-red-500" },
}

export function StepTracker({
  toolEvents,
  provider,
}: {
  toolEvents: ToolEvent[]
  provider: Provider
}) {
  const theme = providerStepTheme[provider]

  if (toolEvents.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5 mb-3">
      {toolEvents.map((event, i) => (
        <div key={i} className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs ${theme.bar}`}>
          {event.status === "error" ? (
            <XCircle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${theme.error}`} />
          ) : event.status === "completed" ? (
            <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${theme.icon}`} />
          ) : (
            <Loader2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin ${theme.icon}`} />
          )}
          <div className="min-w-0 flex-1">
            <span className={`font-medium ${theme.text}`}>
              {event.toolName || (event.type === "tool_result" ? "Result" : "Tool")}
            </span>
            {event.toolInput && (
              <span className="ml-1.5 font-mono text-[10px] text-slate-500 truncate">
                {event.toolInput.length > 60 ? `${event.toolInput.slice(0, 60)}...` : event.toolInput}
              </span>
            )}
            {event.type === "tool_result" && event.content && (
              <span className="ml-1.5 font-mono text-[10px] text-slate-400 truncate">
                → {event.content.length > 60 ? `${event.content.slice(0, 60)}...` : event.content}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
