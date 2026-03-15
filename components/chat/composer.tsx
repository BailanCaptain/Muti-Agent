"use client";

import { PROVIDERS } from "@multi-agent/shared";
import { useChatStore } from "@/components/stores/chat-store";
import { useThreadStore } from "@/components/stores/thread-store";
import { Send, Square } from "lucide-react";

export function Composer() {
  const value = useChatStore((state) => state.draft);
  const setDraft = useChatStore((state) => state.setDraft);
  const send = useChatStore((state) => state.sendMessage);
  const status = useChatStore((state) => state.status);
  const providers = useThreadStore((state) => state.providers);
  const stopThread = useThreadStore((state) => state.stopThread);

  const runningProviders = PROVIDERS.filter((p) => providers[p].running);
  const isRunning = runningProviders.length > 0;

  function handleStop() {
    for (const provider of runningProviders) {
      void stopThread(provider);
    }
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-[28px] border border-black/5 bg-white p-4 shadow-lg shadow-black/5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim() || isRunning) {
          return;
        }
        void send(value);
      }}
    >
      <div className="flex flex-wrap gap-2 px-2">
        {["@范德彪", "@黄仁勋", "@桂芬"].map((mention) => (
          <button
            key={mention}
            type="button"
            onClick={() => setDraft((current) => `${mention} ${current}`.trim())}
            className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-bold text-slate-500 transition-colors hover:bg-slate-200"
          >
            {mention}
          </button>
        ))}
      </div>

      <div className="relative flex items-end gap-2 px-2 pb-2">
        <textarea
          rows={1}
          value={value}
          onChange={(event) => {
            setDraft(event.target.value);
            event.target.style.height = 'auto';
            event.target.style.height = event.target.scrollHeight + 'px';
          }}
          placeholder="输入指令，@ 选择 Agent..."
          className="max-h-48 w-full resize-none bg-transparent py-2 text-sm text-slate-700 outline-none placeholder:text-slate-300"
        />

        {isRunning ? (
          <button
            type="button"
            onClick={handleStop}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-500/20 transition-all hover:bg-red-600 active:scale-95"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white shadow-lg shadow-orange-500/20 transition-all hover:bg-orange-600 active:scale-95 disabled:bg-slate-200 disabled:shadow-none"
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </form>
  );
}
