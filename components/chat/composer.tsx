"use client";

import { useState } from "react";
import { useChatStore } from "@/components/stores/chat-store";

export function Composer() {
  const value = useChatStore((state) => state.draft);
  const setDraft = useChatStore((state) => state.setDraft);
  const send = useChatStore((state) => state.sendMessage);
  const status = useChatStore((state) => state.status);

  return (
    <form
      className="grid gap-3 border-t border-black/5 bg-white/70 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) {
          return;
        }
        void send(value);
      }}
    >
      <div className="flex flex-wrap gap-2">
        {["@范德彪", "@黄仁勋", "@桂芬"].map((mention) => (
          <button
            className="rounded-full border border-black/10 bg-white/80 px-3 py-1.5 text-xs font-semibold"
            key={mention}
            onClick={() => setDraft((current) => `${mention} ${current}`.trim())}
            type="button"
          >
            {mention}
          </button>
        ))}
      </div>
      <textarea
        className="min-h-28 rounded-[22px] border border-black/5 bg-white/85 px-4 py-4 text-sm outline-none"
        onChange={(event) => setDraft(event.target.value)}
        placeholder="例如：@黄仁勋 帮我分析这个报错"
        value={value}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-sand-700">{status}</p>
        <button className="rounded-full bg-sand-500 px-5 py-2.5 font-semibold text-white" type="submit">
          发送
        </button>
      </div>
    </form>
  );
}
