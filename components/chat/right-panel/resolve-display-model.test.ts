import { describe, expect, it } from "vitest"
import { resolveDisplayModel } from "./resolve-display-model"

describe("resolveDisplayModel", () => {
  it("falls back to card.currentModel when no override", () => {
    expect(resolveDisplayModel("claude", {}, {}, "claude-opus-4-7")).toBe("claude-opus-4-7")
  })

  it("prefers global config over fallback", () => {
    expect(
      resolveDisplayModel("claude", {}, { claude: { model: "claude-sonnet-4-6" } }, "claude-opus-4-7"),
    ).toBe("claude-sonnet-4-6")
  })

  it("prefers session config over global config", () => {
    expect(
      resolveDisplayModel(
        "claude",
        { claude: { model: "claude-haiku-4-5-20251001" } },
        { claude: { model: "claude-sonnet-4-6" } },
        "claude-opus-4-7",
      ),
    ).toBe("claude-haiku-4-5-20251001")
  })

  it("returns null when nothing is set", () => {
    expect(resolveDisplayModel("codex", {}, {}, null)).toBeNull()
  })

  it("treats effort-only override as no model override (falls through)", () => {
    expect(
      resolveDisplayModel("codex", { codex: { effort: "high" } }, {}, "gpt-5-codex"),
    ).toBe("gpt-5-codex")
  })
})
