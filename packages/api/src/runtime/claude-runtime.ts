import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BaseCliRuntime,
  resolveNodeScript,
  buildClaudeMcpPrompt,
  type AgentRunInput,
  type RuntimeCommand
} from "./base-runtime";

export class ClaudeRuntime extends BaseCliRuntime {
  readonly agentId = "claude";

  protected buildCommand(input: AgentRunInput): RuntimeCommand {
    const runtime = resolveNodeScript("@anthropic-ai/claude-code", ["cli.js"]);
    const model = input.env?.MULTI_AGENT_MODEL;
    const sessionId = input.env?.MULTI_AGENT_NATIVE_SESSION_ID;
    // 会话已恢复时不重复附加 system prompt，避免冗余 token。
    const args = ["--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--allowedTools", "mcp__multi_agent_room__*"];
    if (!sessionId) {
      const systemPrompt = [input.env?.MULTI_AGENT_SYSTEM_PROMPT ?? "", buildClaudeMcpPrompt()].filter(Boolean).join("\n\n");
      args.push("--append-system-prompt", systemPrompt);
    }
    args.unshift("-p", input.prompt);
    const workspaceRoot = input.cwd ?? process.cwd();
    const runtimeDir = path.join(workspaceRoot, ".multi-agent-runtime");
    const mcpConfigPath = path.join(runtimeDir, `${input.invocationId}.claude.mcp.json`);
    const mcpServerPath = path.join(__dirname, "..", "mcp", "server.js");

    mkdirSync(runtimeDir, { recursive: true });
    // 每次 invocation 生成一份临时 MCP 配置，把 callback 身份透传给本地 MCP server。
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
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
        },
        null,
        2
      ),
      "utf8"
    );
    args.push("--mcp-config", mcpConfigPath);

    if (model) {
      args.push("--model", model);
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    return {
      command: runtime.command,
      args: [...runtime.prefixArgs, ...args],
      shell: runtime.shell,
      cleanup() {
        // 配置文件只服务本次运行，退出后就清理，避免残留旧 token。
        try {
          rmSync(mcpConfigPath, { force: true });
        } catch {
          return;
        }
      }
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
