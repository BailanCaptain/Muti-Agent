"use client";

import { useThreadStore } from "@/components/stores/thread-store";

export function TimelinePanel() {
  const activeGroup = useThreadStore((state) => state.activeGroup);
  const messages = useThreadStore((state) => state.timeline);
  const providers = useThreadStore((state) => state.providers);

  return (
    <>
      <div className="border-b border-black/5 p-5">
        <p className="text-xs font-bold uppercase tracking-[0.28em] text-sand-500">当前会话</p>
        <h2 className="font-serif text-3xl">{activeGroup?.title ?? "会话加载中"}</h2>
        <p className="mt-2 text-sm text-sand-700">
          {activeGroup?.meta ?? "正在读取会话组、线程和消息数据。"}
        </p>
      </div>

      <div className="grid content-start gap-4 overflow-auto p-5">
        {messages.length === 0 ? (
          <div className="rounded-[22px] border border-dashed border-black/10 bg-white/50 p-5 text-sm text-sand-700">
            当前会话还没有消息，直接输入 <code>@范德彪</code>、<code>@黄仁勋</code> 或{" "}
            <code>@桂芬</code> 开始。
          </div>
        ) : null}

        {messages.map((message) => {
          const isThinking =
            message.role === "assistant" &&
            !message.content &&
            providers[message.provider]?.running;

          return (
            <article
              className={`grid gap-2 ${message.role === "user" ? "justify-items-end" : "justify-items-start"}`}
              key={message.id}
            >
              <div className="text-xs text-sand-700">
                {message.role === "assistant"
                  ? `${message.alias}${message.model ? ` · ${message.model}` : ""}`
                  : `你 -> ${message.alias}`}
              </div>
              <div
                className={`max-w-[92%] rounded-[18px] border border-black/5 px-4 py-3 text-sm leading-6 ${
                  message.role === "user" ? "bg-slate-900 text-white" : "bg-white/80 text-sand-900"
                }`}
              >
                {isThinking ? (
                  <span className="flex items-center gap-1 text-sand-400">
                    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                    <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
                  </span>
                ) : (
                  message.content
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
