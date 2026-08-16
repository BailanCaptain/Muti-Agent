import { describe, expect, it } from "vitest"
import {
  getApiHttpBaseUrl,
  getApiWebSocketUrl,
  normalizeApiResourceUrlForStorage,
  resolveApiResourceUrl,
  resolveApiUrl,
} from "./api-endpoints"

describe("resolveApiUrl", () => {
  it("uses the page hostname instead of a build-time Tailscale hostname", () => {
    expect(resolveApiUrl("ws://100.120.213.33:8787/ws", "localhost")).toBe("ws://localhost:8787/ws")
  })

  it("keeps the configured preview port and path on a Tailscale page", () => {
    expect(resolveApiUrl("http://localhost:8801/api", "100.120.213.33")).toBe(
      "http://100.120.213.33:8801/api",
    )
  })

  it("keeps the configured URL during server rendering", () => {
    expect(resolveApiUrl("http://100.120.213.33:8787", undefined)).toBe(
      "http://100.120.213.33:8787",
    )
  })
})

describe("public API endpoint getters", () => {
  it("rebases the configured HTTP URL onto the browser hostname", () => {
    expect(getApiHttpBaseUrl("localhost", "http://100.120.213.33:8787")).toBe(
      "http://localhost:8787",
    )
  })

  it("rebases the configured WebSocket URL onto the browser hostname", () => {
    expect(getApiWebSocketUrl("localhost", "ws://100.120.213.33:8787/ws")).toBe(
      "ws://localhost:8787/ws",
    )
  })
})

describe("resolveApiResourceUrl", () => {
  it("rebases an internal upload URL onto the browser API hostname", () => {
    expect(
      resolveApiResourceUrl(
        "http://192.0.2.1:8787/uploads/screenshot.png?download=1#preview",
        "localhost",
        "http://192.0.2.1:8787",
      ),
    ).toBe("http://localhost:8787/uploads/screenshot.png?download=1#preview")
  })

  it("resolves a relative internal upload against the runtime API origin", () => {
    expect(
      resolveApiResourceUrl("/uploads/report.txt", "100.120.213.33", "http://localhost:8787"),
    ).toBe("http://100.120.213.33:8787/uploads/report.txt")
  })

  it("rebases a legacy localhost upload when the same API is opened over Tailscale", () => {
    expect(
      resolveApiResourceUrl(
        "http://localhost:8787/uploads/from-desktop.png",
        "100.120.213.33",
        "http://100.120.213.33:8787",
      ),
    ).toBe("http://100.120.213.33:8787/uploads/from-desktop.png")
  })

  it("keeps external media URLs unchanged", () => {
    expect(
      resolveApiResourceUrl(
        "https://cdn.example.com/uploads/reference.png",
        "localhost",
        "http://192.0.2.1:8787",
      ),
    ).toBe("https://cdn.example.com/uploads/reference.png")
  })
})

describe("normalizeApiResourceUrlForStorage", () => {
  it("stores same-API uploads as root-relative URLs", () => {
    expect(
      normalizeApiResourceUrlForStorage(
        "http://localhost:8787/uploads/from-desktop.png?download=1",
        "http://localhost:8787",
      ),
    ).toBe("/uploads/from-desktop.png?download=1")
  })

  it("keeps external media URLs absolute", () => {
    expect(
      normalizeApiResourceUrlForStorage(
        "https://cdn.example.com/uploads/reference.png",
        "http://localhost:8787",
      ),
    ).toBe("https://cdn.example.com/uploads/reference.png")
  })
})
