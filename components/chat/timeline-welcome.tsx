"use client"

import { AGENT_PROFILES, PROVIDERS } from "@multi-agent/shared"
import { AtSign } from "lucide-react"
import { ProviderAvatar } from "./provider-avatar"

/**
 * F039 AC6 · 空房间欢迎空态（roadmap P0#6 复活，视觉版）。
 * 空房间不再是一行斜体「尚无消息。」，而是名册卡：三位智能体是谁、
 * 擅长什么、怎么 @ 派活 —— 新会话第一眼就学会派发，而不是发失败才学。
 * 纯展示组件（点击预填 composer 的交互版留给后续 feature）。
 */
export function TimelineWelcome() {
  return (
    <div className="mx-auto w-full max-w-lg" data-testid="timeline-welcome">
      <div className="rounded-floating border border-slate-200 bg-surface-canvas px-7 py-7 shadow-sm">
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-base font-semibold text-slate-900">三位智能体已就位</h2>
        </div>
        <p className="mb-5 text-compact text-slate-500">
          直接输入指令开始协作，或用 @ 点名派发给某一位。
        </p>
        <ul className="flex flex-col gap-3">
          {PROVIDERS.map((provider) => {
            const profile = AGENT_PROFILES[provider]
            return (
              <li key={provider} className="flex items-start gap-3">
                <ProviderAvatar identity={provider} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-slate-900">{profile.name}</span>
                    <span className="text-caption text-slate-500">{profile.role}</span>
                  </div>
                  <p className="mt-0.5 truncate text-caption text-slate-400" title={profile.strengths}>
                    {profile.strengths}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
        <div className="mt-5 flex items-center gap-1.5 border-t border-slate-200/70 pt-4 text-caption text-slate-500">
          <AtSign className="h-3.5 w-3.5 shrink-0 text-accent-500" aria-hidden="true" />
          <span>@所有人 可拉起三个 CLI 并行，支持粘贴图片与拖入 .md / .json / .txt</span>
        </div>
      </div>
    </div>
  )
}
