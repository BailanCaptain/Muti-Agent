import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

describe("F023 MCP dist build", () => {
  it("packages/api/dist/mcp/server.js must exist after build", () => {
    const distPath = path.resolve(__dirname, "..", "packages", "api", "dist", "mcp", "server.js");
    assert.ok(existsSync(distPath), `MCP server dist artifact missing: ${distPath}`);
    const stat = statSync(distPath);
    assert.ok(stat.size > 1024, `MCP server dist artifact suspiciously small: ${stat.size} bytes`);
  });
});
