import { afterEach, describe, expect, it, vi } from "vitest"

const sockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly OPEN = 1
  readonly url: string
  readyState = 0

  constructor(url: string | URL) {
    this.url = String(url)
    sockets.push(this)
  }

  addEventListener() {}
  close() {}
  send() {}
}

describe("connectRealtime", () => {
  afterEach(() => {
    sockets.length = 0
    vi.unstubAllGlobals()
    vi.resetModules()
    delete process.env.NEXT_PUBLIC_API_WS_URL
  })

  it("connects to the page hostname instead of the build-time hostname", async () => {
    process.env.NEXT_PUBLIC_API_WS_URL = "ws://100.120.213.33:8787/ws"
    vi.stubGlobal("WebSocket", FakeWebSocket)

    const { connectRealtime } = await import("./client")
    const disconnect = connectRealtime({
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      onReconnect: vi.fn(),
      onMessage: vi.fn(),
    })

    expect(window.location.hostname).toBe("localhost")
    expect(sockets[0]?.url).toBe("ws://localhost:8787/ws")
    disconnect()
  })
})
