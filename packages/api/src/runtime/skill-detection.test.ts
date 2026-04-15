import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GeminiRuntime } from "./gemini-runtime";
import { CodexRuntime } from "./codex-runtime";

describe("GeminiRuntime — skill detection from tool parameters", () => {
  const runtime = new GeminiRuntime();

  it("classifies read_file on multi-agent-skills/ as skill", () => {
    const event = runtime.transformToolEvent({
      type: "tool_use",
      tool_name: "read_file",
      parameters: { file_path: "C:/Users/-/Desktop/Multi-Agent/multi-agent-skills/cross-role-handoff/SKILL.md" },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
  });

  it("classifies Bash with multi-agent-skills/ path as skill", () => {
    const event = runtime.transformToolEvent({
      type: "tool_use",
      tool_name: "Bash",
      parameters: { command: "cat multi-agent-skills/tdd/SKILL.md" },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
  });

  it("classifies regular read_file as tool", () => {
    const event = runtime.transformToolEvent({
      type: "tool_use",
      tool_name: "read_file",
      parameters: { file_path: "packages/api/src/runtime/base-runtime.ts" },
    });
    assert.ok(event);
    assert.equal(event.source, "tool");
  });

  it("classifies MCP tools correctly even with skill-like params", () => {
    const event = runtime.transformToolEvent({
      type: "tool_use",
      tool_name: "mcp__server/tool",
      parameters: { path: "multi-agent-skills/foo" },
    });
    assert.ok(event);
    assert.equal(event.source, "mcp");
  });

  it("classifies read_file with backslash path as skill", () => {
    const event = runtime.transformToolEvent({
      type: "tool_use",
      tool_name: "read_file",
      parameters: { file_path: "C:\\Users\\-\\Desktop\\Multi-Agent\\multi-agent-skills\\cross-role-handoff\\SKILL.md" },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
  });

  it("tool_result inherits skill source from preceding tool_use", () => {
    runtime.transformToolEvent({
      type: "tool_use",
      tool_name: "read_file",
      parameters: { file_path: "multi-agent-skills/debugging/SKILL.md" },
    });
    const result = runtime.transformToolEvent({
      type: "tool_result",
      status: "success",
      output: "file contents",
    });
    assert.ok(result);
    assert.equal(result.source, "skill");
  });
});

describe("CodexRuntime — skill detection from file_change path", () => {
  const runtime = new CodexRuntime();

  it("classifies file_change in multi-agent-skills/ as skill", () => {
    const event = runtime.transformToolEvent({
      type: "item.completed",
      item: {
        type: "file_change",
        path: "C:/Users/-/Desktop/Multi-Agent/multi-agent-skills/tdd/SKILL.md",
      },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
    assert.equal(event.toolName, "Skill");
  });

  it("classifies regular file_change as tool", () => {
    const event = runtime.transformToolEvent({
      type: "item.completed",
      item: {
        type: "file_change",
        path: "packages/api/src/index.ts",
      },
    });
    assert.ok(event);
    assert.equal(event.source, "tool");
    assert.equal(event.toolName, "Edit");
  });

  it("classifies command_execution with skill path as skill", () => {
    const event = runtime.transformToolEvent({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "cat multi-agent-skills/cross-role-handoff/SKILL.md",
      },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
    assert.equal(event.toolName, "Skill");
  });

  it("classifies regular command_execution as tool", () => {
    const event = runtime.transformToolEvent({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "ls -la packages/api/",
      },
    });
    assert.ok(event);
    assert.equal(event.source, "tool");
    assert.equal(event.toolName, "Bash");
  });

  it("classifies Get-Content with backslash skill path as skill", () => {
    const event = runtime.transformToolEvent({
      type: "item.started",
      item: {
        type: "command_execution",
        command: 'Get-Content -Path "C:\\Users\\-\\Desktop\\Multi-Agent\\multi-agent-skills\\cross-role-handoff\\SKILL.md"',
      },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
    assert.equal(event.toolName, "Skill");
    assert.equal(event.toolInput, "cross-role-handoff");
  });

  it("classifies command_execution.completed with backslash skill path as skill", () => {
    const event = runtime.transformToolEvent({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: 'Get-Content -Path "multi-agent-skills\\tdd\\SKILL.md"',
        aggregated_output: "---\nname: tdd\n---",
      },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
    assert.equal(event.toolName, "Skill");
  });

  it("classifies file_change with backslash path as skill", () => {
    const event = runtime.transformToolEvent({
      type: "item.completed",
      item: {
        type: "file_change",
        path: "C:\\Users\\-\\Desktop\\Multi-Agent\\multi-agent-skills\\debugging\\SKILL.md",
      },
    });
    assert.ok(event);
    assert.equal(event.source, "skill");
    assert.equal(event.toolName, "Skill");
  });
});
