"use client";

import type { Provider } from "@multi-agent/shared";

type AvatarIdentity = Provider | "user";
type AvatarSize = "xs" | "sm" | "md";

type ProviderAvatarProps = {
  identity: AvatarIdentity;
  size?: AvatarSize;
  className?: string;
};

const avatarTheme: Record<
  AvatarIdentity,
  {
    shell: string;
    ear: string;
    face: string;
    ring: string;
    badge: string;
    badgeText: string;
    accent: string;
  }
> = {
  user: {
    shell: "from-rose-100 via-orange-50 to-amber-50",
    ear: "from-orange-400 to-rose-400",
    face: "from-orange-500 via-orange-400 to-rose-400",
    ring: "ring-orange-200/80",
    badge: "bg-rose-500 text-white",
    badgeText: "U",
    accent: "bg-rose-200/80"
  },
  codex: {
    shell: "from-amber-100 via-orange-50 to-orange-100",
    ear: "from-amber-500 to-orange-500",
    face: "from-amber-500 via-orange-400 to-orange-500",
    ring: "ring-amber-200/80",
    badge: "bg-amber-500 text-white",
    badgeText: "C",
    accent: "bg-amber-200/80"
  },
  claude: {
    shell: "from-sky-100 via-cyan-50 to-blue-100",
    ear: "from-sky-500 to-cyan-500",
    face: "from-sky-500 via-cyan-400 to-blue-500",
    ring: "ring-sky-200/80",
    badge: "bg-sky-500 text-white",
    badgeText: "A",
    accent: "bg-sky-200/80"
  },
  gemini: {
    shell: "from-emerald-100 via-teal-50 to-lime-100",
    ear: "from-emerald-500 to-teal-500",
    face: "from-emerald-500 via-teal-400 to-lime-500",
    ring: "ring-emerald-200/80",
    badge: "bg-emerald-500 text-white",
    badgeText: "G",
    accent: "bg-emerald-200/80"
  }
};

const sizeMap: Record<
  AvatarSize,
  {
    shell: string;
    face: string;
    ear: string;
    badge: string;
    eye: string;
    muzzle: string;
    cheek: string;
    mouth: string;
    gap: string;
    badgeOffset: string;
    userText: string;
  }
> = {
  xs: {
    shell: "h-7 w-7",
    face: "h-5 w-5",
    ear: "h-2.5 w-2.5",
    badge: "h-3.5 w-3.5 text-[7px]",
    eye: "h-1 w-1",
    muzzle: "h-2.5 w-3.5",
    cheek: "h-1.5 w-1.5",
    mouth: "h-[2px] w-2",
    gap: "gap-1.5",
    badgeOffset: "-bottom-0.5 -right-0.5",
    userText: "text-[11px]"
  },
  sm: {
    shell: "h-9 w-9",
    face: "h-6.5 w-6.5",
    ear: "h-3.5 w-3.5",
    badge: "h-4 w-4 text-[8px]",
    eye: "h-1.5 w-1.5",
    muzzle: "h-3.5 w-4.5",
    cheek: "h-2 w-2",
    mouth: "h-[2px] w-2.5",
    gap: "gap-2",
    badgeOffset: "-bottom-0.5 -right-0.5",
    userText: "text-[13px]"
  },
  md: {
    shell: "h-11 w-11",
    face: "h-8 w-8",
    ear: "h-4 w-4",
    badge: "h-4.5 w-4.5 text-[9px]",
    eye: "h-1.5 w-1.5",
    muzzle: "h-4 w-5.5",
    cheek: "h-2 w-2",
    mouth: "h-[2px] w-3",
    gap: "gap-2.5",
    badgeOffset: "-bottom-1 -right-1",
    userText: "text-[15px]"
  }
};

function UserAvatar({ size = "md", className = "" }: { size?: AvatarSize; className?: string }) {
  const dimensions = sizeMap[size];

  return (
    <div
      className={`relative inline-flex ${dimensions.shell} items-center justify-center rounded-full bg-gradient-to-br from-orange-400 via-rose-400 to-orange-500 ring-1 ring-orange-200/80 shadow-[0_8px_20px_rgba(15,23,42,0.08)] ${className}`.trim()}
    >
      <span className={`font-semibold text-white ${dimensions.userText}`}>村</span>
    </div>
  );
}

export function ProviderAvatar({ identity, size = "md", className = "" }: ProviderAvatarProps) {
  if (identity === "user") {
    return <UserAvatar size={size} className={className} />;
  }

  const theme = avatarTheme[identity];
  const dimensions = sizeMap[size];

  return (
    <div
      className={`relative isolate inline-flex ${dimensions.shell} items-center justify-center rounded-full bg-gradient-to-br ${theme.shell} ring-1 ${theme.ring} shadow-[0_8px_20px_rgba(15,23,42,0.08)] ${className}`.trim()}
    >
      <span
        className={`absolute left-[18%] top-[10%] ${dimensions.ear} rounded-[35%] bg-gradient-to-br ${theme.ear} rotate-[-28deg] shadow-sm`}
      />
      <span
        className={`absolute right-[18%] top-[10%] ${dimensions.ear} rounded-[35%] bg-gradient-to-br ${theme.ear} rotate-[28deg] shadow-sm`}
      />

      <div className={`relative flex ${dimensions.face} items-center justify-center rounded-full bg-gradient-to-br ${theme.face}`}>
        <span className={`absolute left-[18%] top-[28%] ${dimensions.cheek} rounded-full ${theme.accent} blur-[1px]`} />
        <span className={`absolute right-[18%] top-[28%] ${dimensions.cheek} rounded-full ${theme.accent} blur-[1px]`} />

        <div className={`absolute top-[38%] flex ${dimensions.gap}`}>
          <span className={`${dimensions.eye} rounded-full bg-slate-900/90`} />
          <span className={`${dimensions.eye} rounded-full bg-slate-900/90`} />
        </div>

        <div
          className={`absolute top-[56%] ${dimensions.muzzle} rounded-full bg-white/85 shadow-[inset_0_1px_1px_rgba(255,255,255,0.75)]`}
        />
        <span
          className={`absolute top-[65%] ${dimensions.mouth} rounded-full border-b-2 border-slate-900/65`}
        />
      </div>

      <span
        className={`absolute ${dimensions.badgeOffset} flex ${dimensions.badge} items-center justify-center rounded-full border border-white/80 ${theme.badge} font-semibold shadow-sm`}
      >
        {theme.badgeText}
      </span>
    </div>
  );
}
