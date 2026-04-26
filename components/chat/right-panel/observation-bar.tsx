type Props = {
  messages: number
  evidence: number
  followUp: number
  sessionChainHref: string
}

export function ObservationBar({
  messages,
  evidence,
  followUp,
  sessionChainHref,
}: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        <span>观测</span>
        <a
          href={sessionChainHref}
          className="font-normal normal-case tracking-normal text-slate-400 no-underline hover:text-indigo-500"
        >
          会话链 →
        </a>
      </div>
      <div className="rounded-[16px] border border-slate-200/80 bg-gradient-to-br from-white to-slate-50/60 px-2 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="grid grid-cols-3 divide-x divide-slate-200/70">
          <Metric label="消息" value={messages} />
          <Metric label="证据" value={evidence} />
          <Metric label="跟进" value={followUp} />
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="font-mono text-[22px] font-semibold leading-none tabular-nums text-slate-900">
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400">{label}</div>
    </div>
  )
}
