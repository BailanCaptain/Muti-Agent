import type { Provider } from "@multi-agent/shared"

export const PROVIDER_ACCENT: Record<Provider, string> = {
  claude: "#7C3AED",
  codex: "#D97706",
  gemini: "#0D9488",
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
    badge: "bg-teal-50 text-teal-700 ring-teal-200/80",
    card: "border-teal-100/80 bg-teal-50/40",
    dot: "bg-teal-500",
    focus: "focus:border-teal-300 focus:ring-teal-100/80",
    button: "bg-teal-500 hover:bg-teal-600",
    progress: "bg-teal-500",
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
    container: "bg-teal-50/50 border-teal-100/80",
    button: "text-teal-600 hover:text-teal-700",
    content: "text-slate-600 [&_blockquote]:border-teal-200 [&_code]:bg-teal-100/50",
    icon: "text-teal-500/80",
  },
}

export const bubbleTheme: Record<Provider, string> = {
  codex: "border-amber-200/70 bg-amber-50/30",
  claude: "border-violet-200/70 bg-violet-50/30",
  gemini: "border-teal-200/70 bg-teal-50/30",
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
    folded: "border-teal-300 bg-teal-100 text-teal-800",
    open: "border-teal-200/70 bg-teal-50/40 text-teal-700 hover:bg-teal-50",
  },
}

export const mentionTheme: Record<Provider, string> = {
  codex: "border-amber-200/80 bg-amber-50 text-amber-700 hover:bg-amber-100",
  claude: "border-violet-200/80 bg-violet-50 text-violet-700 hover:bg-violet-100",
  gemini: "border-teal-200/80 bg-teal-50 text-teal-700 hover:bg-teal-100",
}

export const EVERYONE_THEME = "border-slate-200/80 bg-slate-50 text-slate-700 hover:bg-slate-100"
