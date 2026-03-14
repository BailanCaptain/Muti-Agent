"use client";

import { useEffect } from "react";
import { Composer } from "@/components/chat/composer";
import { HeroHeader } from "@/components/chat/hero-header";
import { ProviderStrip } from "@/components/chat/provider-strip";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import { TimelinePanel } from "@/components/chat/timeline-panel";
import { useChatStore } from "@/components/stores/chat-store";
import { useSettingsStore } from "@/components/stores/settings-store";
import { useThreadStore } from "@/components/stores/thread-store";
import { connectRealtime } from "@/components/ws/client";

export default function HomePage() {
  const bootstrap = useThreadStore((state) => state.bootstrap);
  const applyAssistantDelta = useThreadStore((state) => state.applyAssistantDelta);
  const replaceActiveGroup = useThreadStore((state) => state.replaceActiveGroup);
  const status = useChatStore((state) => state.status);
  const setStatus = useChatStore((state) => state.setStatus);
  const setSocketState = useSettingsStore((state) => state.setSocketState);

  useEffect(() => {
    void bootstrap().catch((error) => {
      setStatus(error instanceof Error ? error.message : "初始化失败");
    });

    const disconnect = connectRealtime({
      onOpen: () => {
        setSocketState("connected");
        setStatus("实时层已连接");
      },
      onClose: () => {
        setSocketState("disconnected");
        setStatus("实时层已断开");
      },
      onError: () => {
        setSocketState("error");
        setStatus("实时层连接失败");
      },
      onMessage: (event) => {
        if (event.type === "assistant_delta") {
          applyAssistantDelta(event.payload.messageId, event.payload.delta);
          return;
        }

        if (event.type === "thread_snapshot") {
          replaceActiveGroup(event.payload.activeGroup);
          return;
        }

        if (event.type === "status") {
          setStatus(event.payload.message);
        }
      }
    });

    return disconnect;
  }, [applyAssistantDelta, bootstrap, replaceActiveGroup, setSocketState, setStatus]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-4 p-4">
      <HeroHeader status={status} />
      <ProviderStrip />
      <section className="grid min-h-[70vh] gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        <SessionSidebar />
        <div className="grid overflow-hidden rounded-[28px] border border-black/5 bg-white/75 shadow-soft backdrop-blur xl:grid-rows-[auto_1fr_auto]">
          <TimelinePanel />
          <Composer />
        </div>
      </section>
    </main>
  );
}
