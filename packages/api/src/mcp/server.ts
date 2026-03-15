import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { FastifyInstance } from "fastify";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId;
      error: {
        code: number;
        message: string;
      };
    };

type CallbackIdentity = {
  apiUrl: string;
  invocationId: string;
  callbackToken: string;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function getCallbackIdentity(): CallbackIdentity {
  const apiUrl = process.env.MULTI_AGENT_API_URL || process.env.API_URL || "";
  const invocationId = process.env.MULTI_AGENT_INVOCATION_ID || process.env.INVOCATION_ID || "";
  const callbackToken = process.env.MULTI_AGENT_CALLBACK_TOKEN || process.env.CALLBACK_TOKEN || "";

  if (!apiUrl || !invocationId || !callbackToken) {
    throw new Error("Missing MULTI_AGENT callback environment variables.");
  }

  return { apiUrl, invocationId, callbackToken };
}

function requestJson(
  targetUrl: string,
  options: { method: "GET" | "POST"; body?: Record<string, unknown> }
): Promise<{ statusCode: number; json: unknown }> {
  const url = new URL(targetUrl);
  const bodyText = options.body ? JSON.stringify(options.body) : null;
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        method: options.method,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        headers: bodyText
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(bodyText)
            }
          : undefined
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              json: raw ? JSON.parse(raw) : {}
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    if (bodyText) {
      request.write(bodyText);
    }
    request.end();
  });
}

async function callPostMessage(content: string): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/post-message`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      content
    }
  });

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `post_message failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callGetThreadContext(limit?: number): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const url = new URL(`${identity.apiUrl}/api/callbacks/thread-context`);
  url.searchParams.set("invocationId", identity.invocationId);
  url.searchParams.set("callbackToken", identity.callbackToken);
  if (typeof limit === "number") {
    url.searchParams.set("limit", String(limit));
  }

  const response = await requestJson(url.toString(), { method: "GET" });
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `get_thread_context failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

function writeMessage(message: JsonRpcResponse) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function writeResult(id: JsonRpcId, result: unknown) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result
  });
}

function writeError(id: JsonRpcId, message: string, code = -32000) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

function getTools() {
  return [
    {
      name: "post_message",
      description: "Post a public assistant message to the current thread via callback API.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The public message content to post."
          }
        },
        required: ["content"]
      }
    },
    {
      name: "get_thread_context",
      description: "Get recent thread context for the current invocation.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Optional max number of recent messages."
          }
        }
      }
    }
  ];
}

async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
  if (name === "post_message") {
    const content = typeof args?.content === "string" ? args.content : "";
    if (!content.trim()) {
      return {
        isError: true,
        content: [{ type: "text", text: "content is required" }]
      } satisfies ToolResult;
    }

    return callPostMessage(content.trim());
  }

  if (name === "get_thread_context") {
    const limit = typeof args?.limit === "number" ? args.limit : undefined;
    return callGetThreadContext(limit);
  }

  return {
    isError: true,
    content: [{ type: "text", text: `unknown tool: ${name}` }]
  } satisfies ToolResult;
}

async function handleRequest(request: JsonRpcRequest) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "multi-agent-mcp",
          version: "1.0.0"
        },
        capabilities: {
          tools: {}
        }
      };
    case "notifications/initialized":
      return null;
    case "tools/list":
      return {
        tools: getTools()
      };
    case "tools/call": {
      const toolName = typeof request.params?.name === "string" ? request.params.name : "";
      const args =
        request.params && typeof request.params.arguments === "object"
          ? (request.params.arguments as Record<string, unknown>)
          : undefined;
      return handleToolCall(toolName, args);
    }
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`);
  }
}

export function registerMcpServer(_app: FastifyInstance) {
  // HTTP API server does not host the MCP stdio process.
}

export function startMcpServer() {
  let buffer = "";
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", async (chunk) => {
    buffer += chunk;

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        break;
      }

      const headerText = buffer.slice(0, headerEnd);
      const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (buffer.length < bodyEnd) {
        break;
      }

      const body = buffer.slice(bodyStart, bodyEnd);
      buffer = buffer.slice(bodyEnd);

      try {
        const request = JSON.parse(body) as JsonRpcRequest;
        const result = await handleRequest(request);
        if (request.id !== undefined && result !== null) {
          writeResult(request.id, result);
        }
      } catch (error) {
        const requestId =
          typeof body === "string"
            ? (() => {
                try {
                  return (JSON.parse(body) as { id?: JsonRpcId }).id ?? null;
                } catch {
                  return null;
                }
              })()
            : null;
        writeError(requestId, error instanceof Error ? error.message : "Unknown MCP server error");
      }
    }
  });
}

if (require.main === module) {
  startMcpServer();
}
