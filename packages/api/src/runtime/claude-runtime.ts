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
