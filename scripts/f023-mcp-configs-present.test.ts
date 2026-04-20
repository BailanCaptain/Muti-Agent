import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const MCP_SERVER_NAME = "multi_agent_room";

describe("F023 三家 MCP 官方配置文件", () => {
  it(".mcp.json exists with multi_agent_room server pointing to dist/mcp/server.js", () => {
    const p = path.join(root, ".mcp.json");
    assert.ok(existsSync(p), ".mcp.json missing at project root");
    const cfg = JSON.parse(readFileSync(p, "utf-8")) as { mcpServers?: Record<string, { command: string; args: string[] }> };
    const entry = cfg.mcpServers?.[MCP_SERVER_NAME];
    assert.ok(entry, `.mcp.json must declare mcpServers.${MCP_SERVER_NAME}`);
    assert.equal(entry.command, "node");
    assert.ok(
      entry.args.some((a) => a.replace(/\\/g, "/").includes("packages/api/dist/mcp/server.js")),
      ".mcp.json args must point to packages/api/dist/mcp/server.js"
    );
    for (const a of entry.args) {
      assert.ok(
        !/^[A-Za-z]:[\\/]/.test(a) && !a.startsWith("/"),
        `.mcp.json args must NOT use absolute path (worktree-breaking): ${a}`
      );
    }
  });

  it(".codex/config.toml exists and declares multi_agent_room MCP server", () => {
    const p = path.join(root, ".codex/config.toml");
    assert.ok(existsSync(p), ".codex/config.toml missing at project root");
    const content = readFileSync(p, "utf-8");
    const normalized = content.replace(/\\\\/g, "/").replace(/\\/g, "/");
    assert.match(content, new RegExp(`\\[mcp_servers\\.${MCP_SERVER_NAME}\\]`));
    assert.match(normalized, /packages\/api\/dist\/mcp\/server\.js/);
    assert.match(content, /enabled\s*=\s*true/);
    assert.ok(
      !/[A-Za-z]:[\\/]/.test(content),
      ".codex/config.toml must NOT use absolute path (worktree-breaking)"
    );
    for (const name of [
      "MULTI_AGENT_API_URL",
      "MULTI_AGENT_INVOCATION_ID",
      "MULTI_AGENT_CALLBACK_TOKEN",
    ]) {
      assert.match(
        content,
        new RegExp(`env_vars[^\\]]*"${name}"`, "s"),
        `.codex/config.toml env_vars must whitelist ${name} (Codex strips parent env by default)`
      );
    }
  });

  it(".gemini/settings.json exists with multi_agent_room + env expansion", () => {
    const p = path.join(root, ".gemini/settings.json");
    assert.ok(existsSync(p), ".gemini/settings.json missing at project root");
    const cfg = JSON.parse(readFileSync(p, "utf-8")) as {
      mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
    };
    const entry = cfg.mcpServers?.[MCP_SERVER_NAME];
    assert.ok(entry, `.gemini/settings.json must declare mcpServers.${MCP_SERVER_NAME}`);
    assert.equal(entry.env?.MULTI_AGENT_API_URL, "${MULTI_AGENT_API_URL}");
    assert.equal(entry.env?.MULTI_AGENT_INVOCATION_ID, "${MULTI_AGENT_INVOCATION_ID}");
    assert.equal(entry.env?.MULTI_AGENT_CALLBACK_TOKEN, "${MULTI_AGENT_CALLBACK_TOKEN}");
    for (const a of entry.args) {
      assert.ok(
        !/^[A-Za-z]:[\\/]/.test(a) && !a.startsWith("/"),
        `.gemini/settings.json args must NOT use absolute path (worktree-breaking): ${a}`
      );
    }
  });
});
