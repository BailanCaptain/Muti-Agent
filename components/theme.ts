import type { Provider } from "@multi-agent/shared"

export const PROVIDER_ACCENT: Record<Provider, string> = {
  claude: "#7C3AED",
  codex: "#D97706",
  gemini: "#0EA5E9",
}

export const DEFAULT_ACCENT = "#64748B"

export const providerTheme: Record<
  Provider,
  {
    badge: string
    card: string
    dot: string
    focus: string
    button: string
    progress: string
  }
> = {
  codex: {
    badge: "bg-amber-50 text-amber-700 ring-amber-200/80",
    card: "border-amber-100/80 bg-amber-50/40",
    dot: "bg-amber-500",
    focus: "focus:border-amber-300 focus:ring-amber-100/80",
    button: "bg-amber-500 hover:bg-amber-600",
    progress: "bg-amber-500",
  },
  claude: {
    badge: "bg-violet-50 text-violet-700 ring-violet-200/80",
    card: "border-violet-100/80 bg-violet-50/40",
    dot: "bg-violet-500",
    focus: "focus:border-violet-300 focus:ring-violet-100/80",
    button: "bg-violet-500 hover:bg-violet-600",
    progress: "bg-violet-500",
  },
  gemini: {
    badge: "bg-sky-50 text-sky-700 ring-sky-200/80",
    card: "border-sky-100/80 bg-sky-50/40",
    dot: "bg-sky-500",
    focus: "focus:border-sky-300 focus:ring-sky-100/80",
    button: "bg-sky-500 hover:bg-sky-600",
    progress: "bg-sky-500",
  },
}

export const thinkingTheme: Record<
  Provider,
  {
    container: string
    button: string
    content: string
    icon: string
  }
> = {
  codex: {
    container: "bg-amber-50/50 border-amber-100/80",
    button: "text-amber-600 hover:text-amber-700",
    content: "text-slate-600 [&_blockquote]:border-amber-200 [&_code]:bg-amber-100/50",
    icon: "text-amber-500/80",
  },
  claude: {
    container: "bg-violet-50/50 border-violet-100/80",
    button: "text-violet-600 hover:text-violet-700",
    content: "text-slate-600 [&_blockquote]:border-violet-200 [&_code]:bg-violet-100/50",
    icon: "text-violet-500/80",
  },
  gemini: {
    container: "bg-sky-50/50 border-sky-100/80",
    button: "text-sky-600 hover:text-sky-700",
    content: "text-slate-600 [&_blockquote]:border-sky-200 [&_code]:bg-sky-100/50",
    icon: "text-sky-500/80",
  },
}

export const bubbleTheme: Record<Provider, string> = {
  codex: "border-amber-200/70 bg-amber-50/30",
  claude: "border-violet-200/70 bg-violet-50/30",
  gemini: "border-sky-200/70 bg-sky-50/30",
}

export const foldChipTheme: Record<Provider, { folded: string; open: string }> = {
  codex: {
    folded: "border-amber-300 bg-amber-100 text-amber-800",
    open: "border-amber-200/70 bg-amber-50/40 text-amber-700 hover:bg-amber-50",
  },
  claude: {
    folded: "border-violet-300 bg-violet-100 text-violet-800",
    open: "border-violet-200/70 bg-violet-50/40 text-violet-700 hover:bg-violet-50",
  },
  gemini: {
    folded: "border-sky-300 bg-sky-100 text-sky-800",
    open: "border-sky-200/70 bg-sky-50/40 text-sky-700 hover:bg-sky-50",
  },
}

export const mentionTheme: Record<Provider, string> = {
  codex: "border-amber-200/80 bg-amber-50 text-amber-700 hover:bg-amber-100",
  claude: "border-violet-200/80 bg-violet-50 text-violet-700 hover:bg-violet-100",
  gemini: "border-sky-200/80 bg-sky-50 text-sky-700 hover:bg-sky-100",
}

export const EVERYONE_THEME = "border-slate-200/80 bg-slate-50 text-slate-700 hover:bg-slate-100"
