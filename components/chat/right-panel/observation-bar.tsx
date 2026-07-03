type Props = {
  messages: number
  evidence: number
  followUp: number
}

export function ObservationBar({ messages, evidence, followUp }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="px-0.5 text-micro font-semibold uppercase tracking-[0.18em] text-slate-400">
        观测
      </div>
      <div className="rounded-card border border-slate-200 bg-surface-canvas px-2 py-3 shadow-sm">
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
      <div className="text-micro uppercase tracking-[0.16em] text-slate-400">{label}</div>
    </div>
  )
}
