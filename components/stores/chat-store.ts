"use client";

import { create } from "zustand";
import { socketClient } from "@/components/ws/client";
import { useThreadStore } from "./thread-store";

type ChatStore = {
  status: string;
  draft: string;
  setStatus: (status: string) => void;
  setDraft: (draft: string | ((current: string) => string)) => void;
  sendMessage: (input: string) => Promise<void>;
};

export const useChatStore = create<ChatStore>((set) => ({
  status: "正在连接实时层...",
  draft: "",
  setStatus: (status) => set({ status }),
  setDraft: (draft) =>
    set((state) => ({
      draft: typeof draft === "function" ? draft(state.draft) : draft
    })),
  sendMessage: async (input) => {
    const payload = useThreadStore.getState().buildSendPayload(input);
    if (!payload) {
      set({ status: "请先输入 @范德彪、@黄仁勋 或 @桂芬，再发送消息" });
      return;
    }

    socketClient.send({
      type: "send_message",
      payload
    });

    set({ draft: "" });
    set({ status: `已发送给 ${payload.alias}` });
  }
}));
