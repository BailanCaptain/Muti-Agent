import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  type GithubRepoEvidence,
  assessGithubAiEligibility,
  isGithubPublishable,
} from "./github-eligibility"

function evidence(overrides: Partial<GithubRepoEvidence>): GithubRepoEvidence {
  return {
    repo: "example/repo",
    description: "",
    topics: [],
    readme: "",
    evidenceComplete: true,
    ...overrides,
  }
}

describe("GitHub AI eligibility（准入与排名彻底分离）", () => {
  it("Agent-Reach：AI Agent 全网检索是核心用途 → yes", async () => {
    const assessment = await assessGithubAiEligibility(
      evidence({
        repo: "Panniantong/Agent-Reach",
        description: "Give your AI agent eyes: search and read the web and social media",
        topics: ["ai-agent", "claude-code", "search"],
        readme:
          "Agent Reach installs tools that let Claude Code and other AI agents search X, Reddit, YouTube and the web.",
      }),
    )

    assert.equal(assessment.state, "yes")
    assert.equal(isGithubPublishable(assessment), true)
    assert.ok(assessment.reasons.length > 0)
  })

  it("IPTV：公开电视频道清单不是 AI → no", async () => {
    const assessment = await assessGithubAiEligibility(
      evidence({
        repo: "iptv-org/iptv",
        description: "Collection of publicly available IPTV channels from all over the world",
        topics: ["iptv", "television", "playlist"],
        readme: "This repository contains a playlist of publicly available television channels.",
      }),
    )

    assert.equal(assessment.state, "no")
    assert.equal(isGithubPublishable(assessment), false)
  })

  it("Wand-Enhancer：通用应用增强插件不是 AI → no", async () => {
    const assessment = await assessGithubAiEligibility(
      evidence({
        repo: "k1tbyte/Wand-Enhancer",
        description: "Enhancements and interoperability features for the Wand desktop app",
        topics: ["csharp", "desktop", "plugin"],
        readme: "Adds quality-of-life and interoperability features to Wand and WeMod.",
      }),
    )

    assert.equal(assessment.state, "no")
  })

  it("弱 agent 词：系统监控 daemon 的 agent 不是 AI Agent → no", async () => {
    const assessment = await assessGithubAiEligibility(
      evidence({
        repo: "infra/monitoring-agent",
        description: "A lightweight monitoring agent for Linux servers",
        topics: ["agent", "monitoring", "observability"],
        readme: "A background daemon that collects CPU, memory and disk metrics.",
      }),
    )

    assert.equal(assessment.state, "no")
  })

  it("mcp 缩写必须由正文消歧，不能把 Minecraft Coder Pack 当成 Model Context Protocol", async () => {
    const assessment = await assessGithubAiEligibility(
      evidence({
        repo: "legacy/minecraft-coder-pack",
        description: "Minecraft Coder Pack utilities for decompiling and modding legacy Minecraft",
        topics: ["mcp", "minecraft", "modding"],
        readme:
          "MCP stands for Minecraft Coder Pack. It provides Java scripts and mappings for decompiling, modifying, and recompiling the legacy Minecraft client.",
      }),
    )

    assert.equal(assessment.state, "no")
    assert.equal(isGithubPublishable(assessment), false)
  })

  it("仅 built with AI：AI 是制作方式而非仓库核心能力 → no", async () => {
    const assessment = await assessGithubAiEligibility(
      evidence({
        repo: "demo/portfolio",
        description: "A personal portfolio built with AI",
        topics: ["ai", "website"],
        readme:
          "This is a conventional static portfolio. The HTML and CSS were generated with ChatGPT; the site has no AI functionality.",
      }),
    )

    assert.equal(assessment.state, "no")
  })

  it("Codex/Claude Code 仅是开发手段或仓库同名时，不得冒充 AI 核心用途", async () => {
    const assessments = await Promise.all([
      assessGithubAiEligibility(
        evidence({
          repo: "demo/weather-cli",
          description: "A weather CLI developed with Codex",
          readme: "Fetches forecasts from a public weather API and prints them in the terminal.",
        }),
      ),
      assessGithubAiEligibility(
        evidence({
          repo: "demo/markdown-editor",
          description: "A Markdown editor built with Claude Code",
          readme: "A conventional local Markdown editor with preview and export.",
        }),
      ),
      assessGithubAiEligibility(
        evidence({
          repo: "acme/codex",
          description: "A catalog of ancient manuscripts",
          readme: "Metadata and transcriptions for a historical manuscript collection.",
        }),
      ),
    ])

    assert.deepEqual(
      assessments.map((assessment) => assessment.state),
      ["no", "no", "no"],
    )
    assert.ok(assessments.every((assessment) => !isGithubPublishable(assessment)))
  })

  it("面向 Claude Code/Codex 的插件、技能或集成仍属于 AI 核心用途", async () => {
    const assessments = await Promise.all([
      assessGithubAiEligibility(
        evidence({
          repo: "tools/claude-code-plugins",
          description: "Plugins and skills for Claude Code",
          readme: "Extends Claude Code with review workflows and reusable agent skills.",
        }),
      ),
      assessGithubAiEligibility(
        evidence({
          repo: "tools/codex-extension",
          description: "A Codex CLI extension and integration toolkit",
          readme: "Adds hooks and workflows to the Codex coding agent.",
        }),
      ),
    ])

    assert.deepEqual(
      assessments.map((assessment) => assessment.state),
      ["yes", "yes"],
    )
  })

  it("弱信号且 topics/README 证据读取失败 → unknown；发布端 fail-closed", async () => {
    const assessment = await assessGithubAiEligibility(
      evidence({
        repo: "ambiguous/agent-tool",
        description: "A flexible agent tool",
        topics: ["agent"],
        readme: null,
        evidenceComplete: false,
      }),
    )

    assert.equal(assessment.state, "unknown")
    assert.equal(isGithubPublishable(assessment), false)
    assert.ok(assessment.reasons.length > 0)
  })
})
