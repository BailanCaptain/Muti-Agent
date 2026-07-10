"use client"

import { ConfirmDialog } from "@/components/chat/confirm-dialog"
import { MessageSquareWarning, Plus, Trash2, UserRoundCheck, UsersRound } from "lucide-react"
import { useState } from "react"
import {
  type AdminGroup,
  type AdminMember,
  type PendingAudit,
  useChannelAdminApi,
} from "./use-channel-admin-api"

/**
 * F040 Phase 2.5（AC-M4）：设置 → 渠道 —— 飞书授权自助管理。
 * 三节：待放行（拒绝审计一键放行，愿景核心）/ 成员 / 群（开关+绑定房间）。
 * 后端热生效（AC-M2）：这里改完，下一条飞书消息即按新配置判门，不用重启。
 */

const REASON_LABEL: Record<string, { text: string; tone: "amber" | "rose" | "slate" }> = {
  "member-not-allowed": { text: "成员未授权", tone: "amber" },
  allowlist: { text: "私聊未授权", tone: "rose" },
  "group-not-allowed": { text: "群未放行", tone: "rose" },
  unbound: { text: "群还没选房间", tone: "slate" },
}

const TONE_CLASS: Record<string, string> = {
  amber: "bg-amber-50 text-amber-700 ring-amber-200/80",
  rose: "bg-rose-50 text-rose-700 ring-rose-200/80",
  slate: "bg-slate-100 text-slate-600 ring-slate-200/80",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200/80",
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${TONE_CLASS[tone] ?? TONE_CLASS.slate}`}
    >
      {children}
    </span>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11px] text-slate-400">{children}</span>
}

function EmptyCard({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-400">
      <div className="mx-auto mb-2 flex justify-center text-slate-300">{icon}</div>
      {text}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
      {children}
    </div>
  )
}

// ---- 待放行 ----

function AuditRow({
  audit,
  onAllow,
  onAllowGroup,
  onDismiss,
}: {
  audit: PendingAudit
  onAllow: (name: string, role: "owner" | "participant") => Promise<boolean>
  onAllowGroup: () => Promise<boolean>
  onDismiss: () => Promise<boolean>
}) {
  const [name, setName] = useState("")
  const reason = REASON_LABEL[audit.reason] ?? { text: audit.reason, tone: "slate" as const }
  // 放行动作按 reason 分型：成员/私聊 = 起名放行（私聊过门要 owner 角色——D14 owner=∈p2p 白名单）；
  // 群未放行 = 把群加进白名单；群未绑房间 = 引导去下方群节选房间。
  const memberLike = audit.reason === "member-not-allowed" || audit.reason === "allowlist"
  const role: "owner" | "participant" = audit.reason === "allowlist" ? "owner" : "participant"
  return (
    <div
      className="rounded-2xl border border-amber-200/70 bg-amber-50/40 px-4 py-3"
      data-testid={`audit-row-${audit.openId}-${audit.reason}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={reason.tone}>{reason.text}</Chip>
        <Chip tone="slate">{audit.chatKind === "group" ? "群聊" : "私聊"}</Chip>
        <Mono>{audit.openId}</Mono>
        <span className="text-[11px] text-slate-400">被拒 {audit.count} 次</span>
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        会话 <Mono>{audit.chatId}</Mono> · 最近 {audit.lastAt.slice(0, 19).replace("T", " ")}
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        {memberLike ? (
          <>
            <input
              className="w-32 rounded-field border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-300 focus:border-amber-300 focus:outline-none"
              data-testid={`audit-name-${audit.openId}`}
              onChange={(e) => setName(e.target.value)}
              placeholder="给这个人起名"
              value={name}
            />
            <button
              className="rounded-field bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid={`audit-allow-${audit.openId}`}
              disabled={name.trim().length === 0}
              onClick={() => void onAllow(name.trim(), role)}
              type="button"
            >
              {audit.reason === "allowlist" ? "放行为 owner" : "放行"}
            </button>
          </>
        ) : audit.reason === "group-not-allowed" ? (
          <button
            className="rounded-field bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
            data-testid={`audit-allow-group-${audit.chatId}`}
            onClick={() => void onAllowGroup()}
            type="button"
          >
            把这个群加进白名单
          </button>
        ) : (
          <span className="text-xs text-slate-500">群已放行但还没选房间——在下方「群」节选一个即可。</span>
        )}
        <button
          className="rounded-field px-3 py-1.5 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          data-testid={`audit-dismiss-${audit.openId}`}
          onClick={() => void onDismiss()}
          type="button"
        >
          忽略
        </button>
      </div>
    </div>
  )
}

// ---- 成员行 ----

function MemberRow({
  member,
  onPatch,
  onDelete,
}: {
  member: AdminMember
  onPatch: (patch: {
    displayName?: string
    role?: "owner" | "participant"
    enabled?: boolean
  }) => Promise<boolean>
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(member.displayName)
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-2.5"
      data-testid={`member-row-${member.openId}`}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {editing ? (
          <input
            className="w-28 rounded-field border border-slate-200 bg-white px-2 py-1 text-xs text-slate-900 focus:border-amber-300 focus:outline-none"
            data-testid={`member-name-input-${member.openId}`}
            onChange={(e) => setDraftName(e.target.value)}
            value={draftName}
          />
        ) : (
          <span
            className={`text-sm font-medium ${member.enabled ? "text-slate-800" : "text-slate-400 line-through"}`}
          >
            {member.displayName}
          </span>
        )}
        <Chip tone={member.role === "owner" ? "emerald" : "slate"}>
          {member.role === "owner" ? "owner" : "成员"}
        </Chip>
        {!member.enabled && <Chip tone="rose">已禁用</Chip>}
        <Mono>{member.openId}</Mono>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <label
          className="relative mr-1 inline-block cursor-pointer"
          title="成员开关（关=按非白名单拒，随时可恢复）"
        >
          <input
            aria-label={`成员 ${member.displayName} 开关`}
            checked={member.enabled}
            className="peer sr-only"
            data-testid={`member-toggle-${member.openId}`}
            onChange={(e) => void onPatch({ enabled: e.target.checked })}
            type="checkbox"
          />
          <span className="block h-[18px] w-[34px] rounded-full bg-slate-200 transition peer-checked:bg-emerald-500" />
          <span className="pointer-events-none absolute left-0.5 top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition peer-checked:translate-x-4" />
        </label>
        {editing ? (
          <button
            className="rounded-field bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
            data-testid={`member-save-${member.openId}`}
            disabled={draftName.trim().length === 0}
            onClick={() => {
              void onPatch({ displayName: draftName.trim() }).then((ok) => {
                if (ok) setEditing(false)
              })
            }}
            type="button"
          >
            保存
          </button>
        ) : (
          <button
            className="rounded-field px-2.5 py-1 text-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            data-testid={`member-edit-${member.openId}`}
            onClick={() => {
              setDraftName(member.displayName)
              setEditing(true)
            }}
            type="button"
          >
            改名
          </button>
        )}
        <button
          className="rounded-full p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"
          data-testid={`member-delete-${member.openId}`}
          onClick={onDelete}
          title="移除成员"
          type="button"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

// ---- 群行 ----

/** AC-N5：默认应答人下拉的花名标签（与 /agent 命令同一词表） */
const RESPONDER_OPTIONS: Array<{ provider: string; label: string }> = [
  { provider: "claude", label: "黄仁勋（claude）" },
  { provider: "codex", label: "范德彪（codex）" },
  { provider: "gemini", label: "桂芬（gemini）" },
]

function GroupRow({
  group,
  roomOptions,
  onPatch,
  onDelete,
}: {
  group: AdminGroup
  roomOptions: Array<{ sessionGroupId: string; title: string }>
  onPatch: (patch: {
    sessionGroupId?: string
    enabled?: boolean
    defaultProvider?: string
  }) => Promise<boolean>
  onDelete: () => void
}) {
  const effectiveSg = group.boundSessionGroupId ?? group.sessionGroupId ?? ""
  return (
    <div
      className="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3"
      data-testid={`group-row-${group.chatId}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-800">
            {group.displayName || "未命名群"}
          </span>
          {!group.enabled && <Chip tone="rose">已停用</Chip>}
          <Mono>{group.chatId}</Mono>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="relative inline-block cursor-pointer" title="群开关（关=按陌生群拒）">
            <input
              aria-label={`群 ${group.displayName || group.chatId} 开关`}
              checked={group.enabled}
              className="peer sr-only"
              data-testid={`group-toggle-${group.chatId}`}
              onChange={(e) => void onPatch({ enabled: e.target.checked })}
              type="checkbox"
            />
            <span className="block h-[18px] w-[34px] rounded-full bg-slate-200 transition peer-checked:bg-emerald-500" />
            <span className="pointer-events-none absolute left-0.5 top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition peer-checked:translate-x-4" />
          </label>
          <button
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"
            data-testid={`group-delete-${group.chatId}`}
            onClick={onDelete}
            title="移除群"
            type="button"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-slate-400">当前房间</span>
        <select
          className="rounded-field border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-amber-300 focus:outline-none"
          data-testid={`group-room-select-${group.chatId}`}
          onChange={(e) => {
            if (e.target.value) void onPatch({ sessionGroupId: e.target.value })
          }}
          value={effectiveSg}
        >
          <option disabled value="">
            还没选——选一个房间
          </option>
          {roomOptions.map((r) => (
            <option key={r.sessionGroupId} value={r.sessionGroupId}>
              {r.title}
            </option>
          ))}
        </select>
        {group.roomTitle && <span className="text-[11px] text-slate-400">→ {group.roomTitle}</span>}
        <span className="ml-2 text-[11px] text-slate-400">默认应答人</span>
        <select
          className="rounded-field border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 focus:border-amber-300 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          data-testid={`group-responder-select-${group.chatId}`}
          disabled={!effectiveSg}
          onChange={(e) => {
            if (e.target.value) void onPatch({ defaultProvider: e.target.value })
          }}
          title={effectiveSg ? "群消息默认由谁应答（飞书 /agent 同一开关）" : "先选房间"}
          value={group.effectiveDefaultProvider}
        >
          {RESPONDER_OPTIONS.map((o) => (
            <option key={o.provider} value={o.provider}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ---- 主体 ----

export function ChannelAdminTab({ active }: { active: boolean }) {
  const api = useChannelAdminApi(active)
  const [confirm, setConfirm] = useState<{ title: string; run: () => Promise<boolean> } | null>(
    null,
  )
  const [newMember, setNewMember] = useState({ openId: "", name: "" })
  const [newGroup, setNewGroup] = useState({ chatId: "", name: "" })

  if (!api.overview && api.loading) {
    return <div className="py-8 text-center text-sm text-slate-400">加载中...</div>
  }
  const ov = api.overview ?? { members: [], groups: [], pendingAudits: [] }

  return (
    <div className="space-y-5" data-testid="channel-admin-tab">
      <div className="rounded-2xl bg-slate-50/80 px-4 py-2.5 text-[11px] leading-relaxed text-slate-400">
        飞书渠道授权自助管理。改动即时生效，不用重启；.env 里的白名单只在首次启动时导入一次，之后以这里为准。
      </div>
      {api.actionError && (
        <div
          className="rounded-2xl border border-rose-200/80 bg-rose-50/60 px-4 py-2.5 text-xs text-rose-600"
          data-testid="channel-admin-error"
        >
          {api.actionError}
        </div>
      )}

      {/* 待放行 */}
      <section className="space-y-2">
        <SectionTitle>待放行（有人 @ 了机器人但没权限）</SectionTitle>
        {ov.pendingAudits.length === 0 ? (
          <EmptyCard icon={<UserRoundCheck className="h-7 w-7" />} text="没有待处理的申请" />
        ) : (
          ov.pendingAudits.map((a) => (
            <AuditRow
              audit={a}
              key={a.id}
              onAllow={(name, role) => api.allowAudit(a.id, name, role)}
              onAllowGroup={async () => {
                const ok = await api.addGroup(a.chatId)
                if (ok) await api.dismissAudit(a.id)
                return ok
              }}
              onDismiss={() => api.dismissAudit(a.id)}
            />
          ))
        )}
      </section>

      {/* 成员 */}
      <section className="space-y-2">
        <SectionTitle>成员（群里谁能使唤机器人）</SectionTitle>
        {ov.members.length === 0 ? (
          <EmptyCard icon={<UsersRound className="h-7 w-7" />} text="还没有成员" />
        ) : (
          ov.members.map((m) => (
            <MemberRow
              key={m.openId}
              member={m}
              onDelete={() =>
                setConfirm({
                  title: `移除成员「${m.displayName}」？`,
                  run: () => api.deleteMember(m.openId),
                })
              }
              onPatch={(patch) => api.patchMember(m.openId, patch)}
            />
          ))
        )}
        <div className="flex items-center gap-2">
          <input
            className="w-44 rounded-field border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-[11px] text-slate-900 placeholder:font-sans placeholder:text-slate-300 focus:border-amber-300 focus:outline-none"
            data-testid="add-member-openid"
            onChange={(e) => setNewMember((s) => ({ ...s, openId: e.target.value }))}
            placeholder="open_id（ou_ 开头）"
            value={newMember.openId}
          />
          <input
            className="w-28 rounded-field border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-300 focus:border-amber-300 focus:outline-none"
            data-testid="add-member-name"
            onChange={(e) => setNewMember((s) => ({ ...s, name: e.target.value }))}
            placeholder="名字"
            value={newMember.name}
          />
          <button
            className="flex items-center gap-1 rounded-field border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-amber-300 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="add-member-submit"
            disabled={newMember.openId.trim().length === 0 || newMember.name.trim().length === 0}
            onClick={() => {
              void api
                .addMember(newMember.openId.trim(), newMember.name.trim(), "participant")
                .then((ok) => {
                  if (ok) setNewMember({ openId: "", name: "" })
                })
            }}
            type="button"
          >
            <Plus className="h-3.5 w-3.5" />
            添加
          </button>
        </div>
      </section>

      {/* 群 */}
      <section className="space-y-2">
        <SectionTitle>群（哪些飞书群可用 · 当前对着哪个房间）</SectionTitle>
        {ov.groups.length === 0 ? (
          <EmptyCard
            icon={<MessageSquareWarning className="h-7 w-7" />}
            text="还没有放行的群——群里 @ 一下机器人，上面「待放行」会出现它的申请"
          />
        ) : (
          ov.groups.map((g) => (
            <GroupRow
              group={g}
              key={g.chatId}
              onDelete={() =>
                setConfirm({
                  title: `移除群「${g.displayName || g.chatId}」？`,
                  run: () => api.deleteGroup(g.chatId),
                })
              }
              onPatch={(patch) => api.patchGroup(g.chatId, patch)}
              roomOptions={api.rooms}
            />
          ))
        )}
        <div className="flex items-center gap-2">
          <input
            className="w-44 rounded-field border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-[11px] text-slate-900 placeholder:font-sans placeholder:text-slate-300 focus:border-amber-300 focus:outline-none"
            data-testid="add-group-chatid"
            onChange={(e) => setNewGroup((s) => ({ ...s, chatId: e.target.value }))}
            placeholder="chat_id（oc_ 开头）"
            value={newGroup.chatId}
          />
          <input
            className="w-28 rounded-field border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-300 focus:border-amber-300 focus:outline-none"
            data-testid="add-group-name"
            onChange={(e) => setNewGroup((s) => ({ ...s, name: e.target.value }))}
            placeholder="群名（备注用）"
            value={newGroup.name}
          />
          <button
            className="flex items-center gap-1 rounded-field border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-amber-300 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="add-group-submit"
            disabled={newGroup.chatId.trim().length === 0}
            onClick={() => {
              void api
                .addGroup(newGroup.chatId.trim(), newGroup.name.trim() || undefined)
                .then((ok) => {
                  if (ok) setNewGroup({ chatId: "", name: "" })
                })
            }}
            type="button"
          >
            <Plus className="h-3.5 w-3.5" />
            添加
          </button>
        </div>
      </section>

      {/* 命令参考手册（AC-N5：飞书指挥面词表，owner 在飞书里直接输入） */}
      <section className="space-y-2" data-testid="command-manual">
        <SectionTitle>飞书命令（仅群主可用，私聊或群里 @ 机器人后输入）</SectionTitle>
        <div className="space-y-1.5 rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3">
          <p className="pb-1 text-[11px] leading-relaxed text-slate-500">
            格式：<code className="font-mono">/</code> 后面紧跟命令词（中间不加空格），
            命令和参数之间<strong>用空格隔开</strong>；多打几个空格没关系，大小写随意。
            左列就是能直接照抄的完整例子。
          </p>
          {[
            { cmd: "/rooms", desc: "列出所有房间（R-号 + 房间名，标出本对话当前所在房间）" },
            { cmd: "/newroom 周末计划", desc: "新建房间并把本对话立即切换过去（房名可带空格）" },
            {
              cmd: "/switch R-3",
              desc: "把本对话切到指定房间（R-号或完整房间名；R-号前面的 0 可省，R-3 = R-003）",
            },
            { cmd: "/agent 范德彪", desc: "改本对话的默认应答人（花名或 provider id）" },
            {
              cmd: "/model 范德彪 gpt-5.4 high",
              desc: "改当前房间某 agent 的模型（依次：花名 型号 强度，强度可省；最前面加 R-号可指定别的房间，如 /model R-2 …）",
            },
            { cmd: "/model 范德彪 default", desc: "清掉该 agent 的房间级覆盖，回到全局设置" },
            { cmd: "/model", desc: "看当前房间各 agent 生效的模型与来源（覆盖/全局/默认）" },
            { cmd: "/status", desc: "看本对话当前房间、默认应答人和各 agent 生效模型" },
            { cmd: "/help", desc: "在飞书里查看这份命令表" },
          ].map((r) => (
            <div className="flex items-baseline gap-3" key={r.cmd}>
              <code className="shrink-0 rounded bg-slate-200/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                {r.cmd}
              </code>
              <span className="text-[11px] leading-relaxed text-slate-500">{r.desc}</span>
            </div>
          ))}
          <p className="pt-1 text-[11px] leading-relaxed text-slate-400">
            命令不会进房间记录；非群主发命令会收到「仅群主可用」。改模型默认只影响当前房间，
            随时 <code className="font-mono">default</code> 一键还原。
          </p>
        </div>
      </section>

      <ConfirmDialog
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (confirm) await confirm.run()
          setConfirm(null)
        }}
        open={confirm !== null}
        title={confirm?.title ?? ""}
      />
    </div>
  )
}
