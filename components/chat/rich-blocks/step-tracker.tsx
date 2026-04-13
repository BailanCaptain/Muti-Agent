"use client"

import { CheckCircle2, Loader2, Circle } from "lucide-react"
import type { Provider } from "@multi-agent/shared"

type ToolStep = {
  name: string
  args?: string
  status: "done" | "running" | "pending"
}

function parseThinkingToSteps(thinking: string): ToolStep[] {
  const steps: ToolStep[] = []
  // 匹配常见的 tool call 模式：
  // - "Tool: tool_name { args }"
  // - "Using tool_name(args)"
  // - 行首的 ✅ 或 ⏳ 标记
  const lines = thinking.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()

    // 匹配 "Read file", "Edit file", "Bash command" 等工具调用模式
    const toolMatch = trimmed.match(/^(?:(?:Tool|Using|Calling|Running|Executing)[:\s]+)?(\w[\w_-]*)\s*(?:\(([^)]*)\)|\{([^}]*)\}|:\s*(.+))?$/i)
    if (toolMatch) {
      const name = toolMatch[1]
      const args = toolMatch[2] || toolMatch[3] || toolMatch[4] || undefined
      // 如果是常见的工具名
      if (/^(Read|Edit|Write|Bash|Grep|Glob|Search|Fetch|WebSearch|WebFetch|Agent|TodoWrite)/i.test(name)) {
        steps.push({ name, args: args?.trim(), status: "done" })
      }
    }

    // 匹配 MCP 风格: "✅ tool_name { args }" or "⏳ tool_name { args }"
    const mcpMatch = trimmed.match(/^([✅⏳🔄]) (.+?)(?:\s*\{(.+)\})?$/)
    if (mcpMatch) {
      const status = mcpMatch[1] === '✅' ? 'done' as const : 'running' as const
      steps.push({ name: mcpMatch[2], args: mcpMatch[3]?.trim(), status })
    }
  }

  return steps
}

const providerStepTheme: Record<Provider, { icon: string; bar: string; text: string }> = {
  codex: { icon: "text-amber-500", bar: "bg-amber-100", text: "text-amber-700" },
  claude: { icon: "text-violet-500", bar: "bg-violet-100", text: "text-violet-700" },
  gemini: { icon: "text-sky-500", bar: "bg-sky-100", text: "text-sky-700" },
}

export function StepTracker({
  thinking,
  provider,
}: {
  thinking: string
  provider: Provider
}) {
  const steps = parseThinkingToSteps(thinking)
  const theme = providerStepTheme[provider]

  if (steps.length === 0) {
    return null
  }

  return (
    <div className="space-y-1.5">
      {steps.map((step, i) => (
        <div key={i} className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs ${theme.bar}`}>
          {step.status === "done" ? (
            <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${theme.icon}`} />
          ) : step.status === "running" ? (
            <Loader2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin ${theme.icon}`} />
          ) : (
            <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-300" />
          )}
          <div className="min-w-0 flex-1">
            <span className={`font-medium ${theme.text}`}>{step.name}</span>
            {step.args && (
              <span className="ml-1.5 font-mono text-[10px] text-slate-500 truncate">
                {step.args.length > 60 ? step.args.slice(0, 60) + '...' : step.args}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
