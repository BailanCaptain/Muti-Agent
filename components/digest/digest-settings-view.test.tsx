import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DigestSettingsView } from "./digest-settings-view"

const effective = {
  primaryModel: "claude-opus-4-8",
  fallbackModel: "claude-opus-4-7",
  recipients: ["digest@example.com"],
  xHandles: [],
  xhsKeywords: [],
  disabledSources: [],
  sendTime: "07:30",
  restOverviewRows: 12,
}

const settingsResponse = {
  enabled: true,
  stored: null,
  effective,
  seedEffective: effective,
  emergencyFallback: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
  envSeeds: { recipients: ["digest@example.com"], xHandles: [], xhsKeywords: [] },
  secrets: {
    smtp: true,
    githubPat: false,
    xApiKey: false,
    rsshubBase: false,
    xhsBase: false,
  },
  sources: [],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("DigestSettingsView 固定终极兜底", () => {
  it("保留原两列输入、显示只读 GPT high，保存请求不携带只读字段", async () => {
    const putBodies: unknown[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/daily-digest/send-now")) {
        return new Response(
          JSON.stringify({ running: false, startedAt: null, lastOutcome: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.endsWith("/api/daily-digest/settings") && init?.method === "PUT") {
        putBodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ ok: true, effective }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.endsWith("/api/daily-digest/settings")) {
        return new Response(JSON.stringify(settingsResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    render(<DigestSettingsView />)

    expect(await screen.findByRole("note", { name: "模型最终兜底" })).toHaveTextContent(
      "最终兜底：GPT-5.6 Sol · Codex · high，仅前两层均失败时启用",
    )
    const primary = screen.getByLabelText("主力模型")
    expect(primary).toHaveValue("claude-opus-4-8")
    expect(screen.getByLabelText("兜底模型")).toHaveValue("claude-opus-4-7")

    fireEvent.change(primary, { target: { value: "claude-opus-4-9" } })
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))

    await waitFor(() => expect(putBodies).toHaveLength(1))
    expect(putBodies[0]).toEqual({ settings: { primaryModel: "claude-opus-4-9" } })
    expect(JSON.stringify(putBodies[0])).not.toContain("emergencyFallback")
  })
})
