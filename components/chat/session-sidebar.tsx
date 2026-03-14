"use client";

import { useThreadStore } from "@/components/stores/thread-store";

const avatarTint = {
  codex: "from-amber-500 to-orange-600",
  claude: "from-sky-500 to-cyan-600",
  gemini: "from-emerald-500 to-teal-600"
} as const;

const avatarBadge = {
  codex: "范",
  claude: "黄",
  gemini: "桂"
} as const;

export function SessionSidebar() {
  const sessionGroups = useThreadStore((state) => state.sessionGroups);
  const activeGroupId = useThreadStore((state) => state.activeGroupId);
  const createGroup = useThreadStore((state) => state.createSessionGroup);
  const selectGroup = useThreadStore((state) => state.selectSessionGroup);

  return (
    <aside className="grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[28px] border border-black/5 bg-white/75 shadow-soft backdrop-blur">
      <div className="border-b border-black/5 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.28em] text-sand-500">历史会话</p>
            <h2 className="font-serif text-2xl">左侧保留全部记录</h2>
          </div>
          <button
            className="rounded-full border border-black/10 bg-white/80 px-4 py-2 text-sm font-semibold"
            onClick={() => void createGroup()}
            type="button"
          >
            新建
          </button>
        </div>
      </div>

      <div className="grid auto-rows-max content-start justify-items-stretch gap-3 overflow-auto p-3">
        {sessionGroups.map((group) => (
          <button
            className={`grid w-full justify-self-stretch gap-3 rounded-[22px] border p-4 text-left transition ${
              activeGroupId === group.id
                ? "border-sand-500/20 bg-white shadow-soft"
                : "border-black/5 bg-white/65 hover:bg-white/80"
            }`}
            key={group.id}
            onClick={() => void selectGroup(group.id)}
            type="button"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-semibold">{group.title}</div>
                <div className="mt-1 text-xs text-sand-700">{group.updatedAtLabel}</div>
              </div>
              <div className="flex -space-x-2">
                {group.previews.slice(0, 3).map((preview) => (
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br ${avatarTint[preview.provider]} text-xs font-bold text-white shadow-sm`}
                    key={`${group.id}-${preview.provider}`}
                    title={preview.alias}
                  >
                    {avatarBadge[preview.provider]}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-2">
              {group.previews.map((preview) => (
                <div className="flex items-start gap-2 text-xs text-sand-700" key={`${group.id}-${preview.provider}`}>
                  <span className="min-w-0 shrink-0 rounded-full bg-sand-100 px-2 py-1 font-semibold text-sand-900">
                    {preview.alias}
                  </span>
                  <span className="truncate">{preview.text || "还没有消息"}</span>
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
