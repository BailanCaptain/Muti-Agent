"use client";

import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";

type ConnectCallbacks = {
  onOpen: () => void;
  onClose: () => void;
  onError: () => void;
  onMessage: (event: RealtimeServerEvent) => void;
  // Fired after a successful reconnect (NOT the initial open). Higher layers use this
  // to re-fetch snapshot state lost during the outage — see B001 for context.
  onReconnect?: () => void;
};

// Exponential backoff schedule (ms). Capped so a long outage still retries every 30s.
const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000];

class SocketClient {
  private socket: WebSocket | null = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hasOpenedOnce = false;

  connect(callbacks: ConnectCallbacks) {
    this.closedByUser = false;
    this.reconnectAttempt = 0;
    this.hasOpenedOnce = false;
    this.openSocket(callbacks);

    return () => {
      this.closedByUser = true;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.socket?.close();
    };
  }

  send(event: RealtimeClientEvent) {
    // Outgoing chat actions reuse the same event contract as the server-side ws route.
    this.socket?.send(JSON.stringify(event));
  }

  private openSocket(callbacks: ConnectCallbacks) {
    const url = process.env.NEXT_PUBLIC_API_WS_URL ?? "ws://localhost:8787/ws";
    // The browser keeps a single socket; higher layers subscribe through callbacks instead of re-opening per action.
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      const wasReconnect = this.hasOpenedOnce;
      this.hasOpenedOnce = true;
      this.reconnectAttempt = 0;
      callbacks.onOpen();
      if (wasReconnect) {
        // B001 Fix 2: after dropped frames during the outage, re-sync state from the server.
        callbacks.onReconnect?.();
      }
    });

    socket.addEventListener("close", () => {
      callbacks.onClose();
      if (this.closedByUser) {
        return;
      }
      this.scheduleReconnect(callbacks);
    });

    socket.addEventListener("error", () => {
      callbacks.onError();
      // error is followed by close on browsers; reconnect scheduling happens in the close handler.
    });

    socket.addEventListener("message", (event) => {
      callbacks.onMessage(JSON.parse(event.data) as RealtimeServerEvent);
    });
  }

  private scheduleReconnect(callbacks: ConnectCallbacks) {
    if (this.retryTimer) {
      return;
    }
    const delay = BACKOFF_SCHEDULE[Math.min(this.reconnectAttempt, BACKOFF_SCHEDULE.length - 1)];
    this.reconnectAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closedByUser) {
        return;
      }
      this.openSocket(callbacks);
    }, delay);
  }
}

export const socketClient = new SocketClient();

export function connectRealtime(callbacks: ConnectCallbacks) {
  return socketClient.connect(callbacks);
}
