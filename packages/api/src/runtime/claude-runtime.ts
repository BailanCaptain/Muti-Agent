import { existsSync } from "node:fs";
import path from "node:path";
import { BaseCliRuntime, resolveNpmRoot, type AgentRunInput, type RuntimeCommand } from "./base-runtime";
import { AGENT_SYSTEM_PROMPTS } from "./agent-prompts";

function resolveClaudeCommand() {
  // 1. npm 全局安装：cli.js 在 npm node_modules 里
  const npmRoot = resolveNpmRoot();
  const cliJs = npmRoot ? path.join(npmRoot, "node_modules", "@anthropic-ai", "claude-code", "cli.js") : "";
  if (cliJs && existsSync(cliJs)) {
    return { command: process.execPath, prefixArgs: [cliJs], shell: false };
  }

  // 2. PowerShell / standalone 安装：claude.exe 在 ~/.local/bin/
  const homeDir = process.env.USERPROFILE || process.env.HOME || "";
  const standaloneExe = path.join(homeDir, ".local", "bin", "claude.exe");
  if (existsSync(standaloneExe)) {
    return { command: standaloneExe, prefixArgs: [], shell: false };
  }

  // 3. 兜底：shell 模式（避免 --append-system-prompt 换行符被截断，不推荐）
  return { command: "claude", prefixArgs: [], shell: true };
}

function formatClaudeToolInput(name: string, input: Record<string, unknown>): string {
  try {
    if (name === "Bash") {
      const cmd = String(input.command ?? "").split("\n")[0].slice(0, 80);
      return `$ ${cmd}`;
    }

    if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) {
      const filePath = String(input.file_path ?? "");
      return filePath.split(/[/\\]/).slice(-2).join("/");
    }

    if (name === "Glob") {
      return String(input.pattern ?? "");
    }

    if (name === "Grep") {
      return String(input.pattern ?? "").slice(0, 40);
    }

    if (name === "Task" || name === "Agent") {
      return String(input.description ?? "").slice(0, 60);
    }

    // Default: first string value in input
    for (const value of Object.values(input)) {
      if (typeof value === "string") {
        return value.slice(0, 60);
      }
    }

    return "";
  } catch {
    return "";
  }
}

export class ClaudeRuntime extends BaseCliRuntime {
  readonly agentId = "claude";

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveClaudeCommand();
    const model = input.env?.MULTI_AGENT_MODEL;
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    // 会话已恢复时不重复附加 system prompt，避免冗余 token。
    const args = ["--output-format", "stream-json", "--verbose"];
    if (!sessionId) {
      args.push("--append-system-prompt", AGENT_SYSTEM_PROMPTS.claude);
    }
    args.unshift("-p", input.prompt);
    const mcpServerPath = path.join(__dirname, "..", "mcp", "server.js");

    // 直接把 MCP 配置作为 JSON 字符串内联传入，省去临时文件的创建与清理。
    const mcpConfig = JSON.stringify({
      mcpServers: {
        multi_agent_room: {
          command: process.execPath,
          args: [mcpServerPath],
          env: {
            MULTI_AGENT_API_URL: input.env?.MULTI_AGENT_API_URL ?? "",
            MULTI_AGENT_INVOCATION_ID: input.env?.MULTI_AGENT_INVOCATION_ID ?? "",
            MULTI_AGENT_CALLBACK_TOKEN: input.env?.MULTI_AGENT_CALLBACK_TOKEN ?? ""
          }
        }
      }
    });
    args.push("--mcp-config", mcpConfig);

    if (model) {
      args.push("--model", model);
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...args],
      shell: runtime.shell
    };
  }

  parseActivityLine(event: Record<string, unknown>): string | null {
    try {
      // Claude extended thinking
      if (event.type === "content_block_delta") {
        const delta = event.delta as { type?: string; thinking?: string } | undefined;
        if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          return delta.thinking;
        }
      }

      if (event.type === "assistant") {
        const message = event.message as { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> } | undefined;
        const toolUse = message?.content?.find((item) => item.type === "tool_use");
        if (toolUse && toolUse.name) {
          const summary = formatClaudeToolInput(toolUse.name, toolUse.input ?? {});
          return `⚡ ${toolUse.name} ${summary}`.trimEnd();
        }
        return null;
      }

      if (event.type === "user") {
        const message = event.message as { content?: Array<{ type?: string; content?: unknown }> } | undefined;
        const toolResult = message?.content?.find((item) => item.type === "tool_result");
        if (toolResult) {
          const content = toolResult.content;
          if (typeof content === "string" && content.trim()) {
            return `↩ ${content.split("\n")[0].slice(0, 100)}`;
          }
          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part === "object" && part && typeof (part as { text?: string }).text === "string") {
                const text = (part as { text: string }).text.trim();
                if (text) {
                  return `↩ ${text.split("\n")[0].slice(0, 100)}`;
                }
              }
            }
          }
          return "↩ done";
        }
        return null;
      }

      return null;
    } catch {
      return null;
    }
  }

  parseAssistantDelta(event: Record<string, unknown>) {
    if (event.type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return delta.text;
      }
    }

    if (event.type === "message_delta" && typeof event.delta === "string") {
      return event.delta;
    }

    if (event.type !== "assistant") {
      return "";
    }

    const message = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    return (
      message?.content
        ?.filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("") ?? ""
    );
  }
}

export const claudeRuntime = new ClaudeRuntime();
