"use client";

import { useEffect, useRef } from "react";
import { useThreadStore } from "@/components/stores/thread-store";
import { MessageBubble } from "./message-bubble";

export function TimelinePanel() {
  const timeline = useThreadStore((state) => state.timeline);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [timeline]);

  return (
    <div
      className="flex flex-1 flex-col overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.6),transparent_26%),linear-gradient(180deg,rgba(255,250,244,0.92),rgba(255,247,238,0.62))] px-6 py-8"
      ref={scrollRef}
    >
      <div className="mx-auto w-full max-w-[980px]">
        {timeline.length === 0 ? (
          <div className="flex min-h-[40vh] items-center justify-center text-slate-400">
            <div className="rounded-[28px] border border-dashed border-orange-100 bg-white/55 px-8 py-6 text-center shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
              <p className="text-sm italic">还没有更多消息了</p>
            </div>
          </div>
        ) : (
          timeline.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onCopy={(content) => navigator.clipboard.writeText(content)}
            />
          ))
        )}
      </div>
    </div>
  );
}
