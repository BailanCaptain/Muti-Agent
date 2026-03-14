"use client";

import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";

class SocketClient {
  private socket: WebSocket | null = null;

  connect(
    callbacks: {
      onOpen: () => void;
      onClose: () => void;
      onError: () => void;
      onMessage: (event: RealtimeServerEvent) => void;
    }
  ) {
    const url = process.env.NEXT_PUBLIC_API_WS_URL ?? "ws://localhost:8787/ws";
    this.socket = new WebSocket(url);

    this.socket.addEventListener("open", callbacks.onOpen);
    this.socket.addEventListener("close", callbacks.onClose);
    this.socket.addEventListener("error", callbacks.onError);
    this.socket.addEventListener("message", (event) => {
      callbacks.onMessage(JSON.parse(event.data) as RealtimeServerEvent);
    });

    return () => {
      this.socket?.close();
    };
  }

  send(event: RealtimeClientEvent) {
    this.socket?.send(JSON.stringify(event));
  }
}

export const socketClient = new SocketClient();

export function connectRealtime(callbacks: {
  onOpen: () => void;
  onClose: () => void;
  onError: () => void;
  onMessage: (event: RealtimeServerEvent) => void;
}) {
  return socketClient.connect(callbacks);
}
