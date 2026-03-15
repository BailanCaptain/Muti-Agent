"use client"

import { useThreadStore } from "@/components/stores/thread-store"
import { ChevronDown, Plus, Search, Star } from "lucide-react"
import { useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

export function SessionSidebar() {
  const sessionGroups = useThreadStore((state) => state.sessionGroups)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const createGroup = useThreadStore((state) => state.createSessionGroup)
  const selectGroup = useThreadStore((state) => state.selectSessionGroup)
  const [search, setSearch] = useState("")

  const filteredGroups = sessionGroups.filter(
    (group) =>
      group.title.toLowerCase().includes(search.toLowerCase()) ||
      group.previews.some((preview) => preview.text.toLowerCase().includes(search.toLowerCase())),
  )

  return (
    <aside className="flex h-screen w-[288px] shrink-0 flex-col border-r border-slate-200/70 bg-[linear-gradient(180deg,#fcf9f4_0%,#f7f8fb_100%)] px-4 py-5">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
            Rooms
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-[0.01em] text-slate-900">
            Conversations
          </h2>
        </div>
        <button
          className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white shadow-[0_12px_24px_rgba(245,158,11,0.22)] transition hover:bg-amber-600"
          onClick={() => void createGroup()}
          type="button"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </button>
      </div>

      <label className="relative mb-6 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="w-full rounded-2xl border border-slate-200/80 bg-white/80 py-2.5 pl-10 pr-4 text-sm text-slate-700 outline-none transition focus:border-amber-200 focus:bg-white focus:ring-4 focus:ring-amber-100/70"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search rooms or previews..."
          type="text"
          value={search}
        />
      </label>

      <div className="flex-1 overflow-y-auto">
        <div className="mb-3 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
          <span>Lobby</span>
          <span>Now</span>
        </div>

        <div className="mb-3 flex items-center justify-between px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          <div className="flex items-center gap-1.5">
            <ChevronDown className="h-3 w-3" />
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
            <span>Pinned</span>
          </div>
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-amber-600">
            {filteredGroups.length}
          </span>
        </div>

        <div className="space-y-1.5">
          {filteredGroups.map((group) => (
            <button
              className={`group w-full rounded-[24px] p-3 text-left transition ${
                activeGroupId === group.id
                  ? "bg-white shadow-[0_16px_35px_rgba(15,23,42,0.06)] ring-1 ring-amber-100/90"
                  : "hover:bg-white/70"
              }`}
              key={group.id}
              onClick={() => void selectGroup(group.id)}
              type="button"
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="flex -space-x-2">
                  {group.previews.map((preview) => (
                    <ProviderAvatar
                      className="ring-2 ring-white"
                      identity={preview.provider}
                      key={preview.provider}
                      size="xs"
                    />
                  ))}
                </div>
                <span className="shrink-0 text-[10px] text-slate-400">{group.updatedAtLabel}</span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-sm font-semibold text-slate-700">{group.title}</h3>
                <Star className="h-3.5 w-3.5 shrink-0 text-slate-300 transition group-hover:text-amber-300" />
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">
                {group.previews.find((preview) => preview.text)?.text || "No messages yet."}
              </p>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
