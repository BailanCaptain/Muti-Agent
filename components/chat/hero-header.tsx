type HeroHeaderProps = {
  status: string;
};

export function HeroHeader({ status }: HeroHeaderProps) {
  return (
    <header className="flex flex-col justify-between gap-4 rounded-[28px] border border-black/5 bg-white/75 p-6 shadow-soft backdrop-blur xl:flex-row xl:items-start">
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.28em] text-sand-500">
          Multi-Agent
        </p>
        <h1 className="font-serif text-4xl leading-tight text-sand-900 xl:text-5xl">
          Next.js + React + TypeScript
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-sand-700">
          前端使用 Next.js App Router，后端拆分为 Fastify API 和 CLI orchestrator，
          实时通信统一走 WebSocket，存储从 SQLite 起步，并为 Redis 预留扩展位置。
        </p>
      </div>
      <div className="rounded-full border border-emerald-700/15 bg-emerald-700/10 px-4 py-2 text-sm text-emerald-800">
        {status}
      </div>
    </header>
  );
}
