"use client"

import type { Provider } from "@multi-agent/shared"

type AvatarIdentity = Provider | "user"
type AvatarSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl"

type ProviderAvatarProps = {
  identity: AvatarIdentity
  size?: AvatarSize
  className?: string
}

const avatarTheme: Record<
  AvatarIdentity,
  {
    mainEmoji: string
    subEmoji: string
    subTransform: string
    shell: string
    ring: string
    shadow: string
  }
> = {
  user: {
    mainEmoji: "🤠",
    subEmoji: "🫓",
    subTransform: "rotate-12 translate-x-[10%] translate-y-[10%]",
    shell: "from-orange-100/80 via-rose-50/80 to-rose-100/80",
    ring: "ring-orange-200/80",
    shadow: "shadow-orange-500/20",
  },
  claude: {
    mainEmoji: "🐶",
    subEmoji: "🔧",
    subTransform: "-rotate-[30deg] translate-x-[20%] translate-y-[15%]",
    shell: "from-violet-100/80 via-indigo-50/80 to-purple-100/80",
    ring: "ring-violet-200/80",
    shadow: "shadow-violet-500/20",
  },
  codex: {
    mainEmoji: "🐮",
    subEmoji: "🧱",
    subTransform: "rotate-12 translate-x-[15%] translate-y-[15%]",
    shell: "from-amber-100/80 via-orange-50/80 to-yellow-100/80",
    ring: "ring-amber-200/80",
    shadow: "shadow-amber-500/20",
  },
  gemini: {
    mainEmoji: "🙀",
    subEmoji: "🔪",
    subTransform: "-rotate-[15deg] translate-x-[15%] translate-y-[10%]",
    shell: "from-sky-100/80 via-cyan-50/80 to-blue-100/80",
    ring: "ring-sky-200/80",
    shadow: "shadow-sky-500/20",
  },
}

const sizeMap: Record<
  AvatarSize,
  {
    shell: string
    mainSize: string
    subSize: string
    subPosition: string
  }
> = {
  "2xs": {
    shell: "h-5 w-5 rounded-lg",
    mainSize: "text-[12px]",
    subSize: "text-[8px]",
    subPosition: "-bottom-0 -right-0",
  },
  xs: {
    shell: "h-7 w-7 rounded-[10px]",
    mainSize: "text-[16px]",
    subSize: "text-[10px]",
    subPosition: "-bottom-0.5 -right-0.5",
  },
  sm: {
    shell: "h-9 w-9 rounded-xl",
    mainSize: "text-[22px]",
    subSize: "text-[14px]",
    subPosition: "-bottom-1 -right-1",
  },
  md: {
    shell: "h-11 w-11 rounded-2xl",
    mainSize: "text-[28px]",
    subSize: "text-[16px]",
    subPosition: "-bottom-1 -right-1",
  },
  lg: {
    shell: "h-16 w-16 rounded-[22px]",
    mainSize: "text-[42px]",
    subSize: "text-[24px]",
    subPosition: "-bottom-1.5 -right-1.5",
  },
  xl: {
    shell: "h-24 w-24 rounded-[32px]",
    mainSize: "text-[64px]",
    subSize: "text-[36px]",
    subPosition: "-bottom-2 -right-2",
  },
}

export function ProviderAvatar({ identity, size = "md", className = "" }: ProviderAvatarProps) {
  const theme = avatarTheme[identity]
  const dimensions = sizeMap[size]

  return (
    <div
      className={`relative inline-flex items-center justify-center bg-gradient-to-br bg-white/50 backdrop-blur-md ring-1 shadow-lg transition-transform hover:scale-105 ${dimensions.shell} ${theme.shell} ${theme.ring} ${theme.shadow} ${className}`.trim()}
    >
      <div className="absolute inset-0 z-0 mix-blend-overlay opacity-20 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.8)_0%,transparent_70%)]" />

      <span
        className={`relative z-10 flex items-center justify-center drop-shadow-md ${dimensions.mainSize}`}
        style={{ transform: "translateY(-5%)" }}
      >
        {theme.mainEmoji}
      </span>

      <span
        className={`absolute z-20 drop-shadow-lg ${dimensions.subPosition} ${dimensions.subSize} ${theme.subTransform}`}
      >
        {theme.subEmoji}
      </span>
    </div>
  )
}
