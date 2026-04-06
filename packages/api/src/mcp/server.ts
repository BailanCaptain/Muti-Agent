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

async function callGetRoomContext(limit?: number): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const url = new URL(`${identity.apiUrl}/api/callbacks/room-context`);
  url.searchParams.set("invocationId", identity.invocationId);
  url.searchParams.set("callbackToken", identity.callbackToken);
  if (typeof limit === "number") {
    url.searchParams.set("limit", String(limit));
  }

  const response = await requestJson(url.toString(), { method: "GET" });
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `get_room_context failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callGetRoomSummary(): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const url = new URL(`${identity.apiUrl}/api/callbacks/room-summary`);
  url.searchParams.set("invocationId", identity.invocationId);
  url.searchParams.set("callbackToken", identity.callbackToken);

  const response = await requestJson(url.toString(), { method: "GET" });
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `get_room_summary failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callSearchRoomMemories(keyword: string): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const url = new URL(`${identity.apiUrl}/api/callbacks/search-memories`);
  url.searchParams.set("invocationId", identity.invocationId);
  url.searchParams.set("callbackToken", identity.callbackToken);
  url.searchParams.set("keyword", keyword);

  const response = await requestJson(url.toString(), { method: "GET" });
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `search_room_memories failed: ${JSON.stringify(response.json)}` }]
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

export function getTools() {
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
      name: "get_room_context",
      description: "获取当前协作房间的近期对话上下文（跨所有 agent 线程聚合）。",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "返回的最大消息数量，默认 20，最大 200。"
          }
        }
      }
    },
    {
      name: "get_room_summary",
      description: "获取当前协作房间的滚动摘要（压缩版上下文，适用于上下文窗口紧张时）。",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "search_room_memories",
      description: "按关键词搜索当前房间的历史记忆条目。",
      inputSchema: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "搜索关键词"
          }
        },
        required: ["keyword"]
      }
    },
    {
      name: "get_task_status",
      description: "查询当前协作房间中各 agent 的运行状态。",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "可选：指定查询的 agent 别名" }
        }
      }
    },
    {
      name: "create_task",
      description: "创建一个跟踪任务并分配给指定 agent。",
      inputSchema: {
        type: "object",
        properties: {
          assignee: { type: "string", description: "要分配任务的 agent 别名" },
          description: { type: "string", description: "任务描述" },
          priority: { type: "string", enum: ["low", "medium", "high"], description: "优先级" }
        },
        required: ["assignee", "description"]
      }
    },
    {
      name: "trigger_mention",
      description: "程序化触发 @mention，无需发送公开消息即可调度另一个 agent。",
      inputSchema: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "目标 agent 别名" },
          taskSnippet: { type: "string", description: "要求目标 agent 完成的任务" }
        },
        required: ["targetAgentId", "taskSnippet"]
      }
    },
    {
      name: "get_memory",
      description: "读取当前会话的记忆条目。",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "可选：用于筛选记忆的关键词" }
        }
      }
    },
    {
      name: "request_decision",
      description: "向用户��示一个选择卡片（多选题或 agent 选择器），等待用户选择后返回结��。用于 brainstorm 中的方案选择、架构选型投票等需要用��决策的场景。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "卡片标题" },
          description: { type: "string", description: "可选���说明文字" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "选项唯一标识" },
                label: { type: "string", description: "选项显示文字" },
                description: { type: "string", description: "选项说明" }
              },
              required: ["id", "label"]
            },
            description: "选项列表（2-6 个）"
          },
          multiSelect: { type: "boolean", description: "是否允许多选，默认 false" },
          anchorMessageId: {
            type: "string",
            description: "可选：将决策卡片嵌入到指定消息气泡中（inline card）。如果不提供，卡片作为独立系统卡片显示。"
          }
        },
        required: ["title", "options"]
      }
    },
    {
      name: "parallel_think",
      description: "并行调度多个 agent 独立思考同一问题，收集所有回复后返回综合结果。用于架构选型、方向性讨论等需要多视角的场景。调用前必须提供 searchEvidenceRefs（先搜后问）或 overrideReason。",
      inputSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: { type: "string" },
            description: '要并行调度的 agent 别名列表（最多 3 个）。例如: ["仁勋", "桂芬"]'
          },
          question: {
            type: "string",
            description: "向所有目标 agent 提出的问题或请求（最多 5000 字）"
          },
          callbackTo: {
            type: "string",
            description: "收集所有回复后通知的 agent 别名（通常是自己）"
          },
          context: {
            type: "string",
            description: "可选的额外上下文信息"
          },
          timeoutMinutes: {
            type: "number",
            description: "超时时间（分钟），默认 8，范围 3-20"
          },
          idempotencyKey: {
            type: "string",
            description: "幂等键，防止重复派发"
          },
          searchEvidenceRefs: {
            type: "array",
            items: { type: "string" },
            description: "调用前搜索的证据引用（先搜后问原则）"
          },
          overrideReason: {
            type: "string",
            description: "如果跳过搜索证据，必须说明原因"
          }
        },
        required: ["targets", "question", "callbackTo"]
      }
    },
    {
      name: "request_permission",
      description: "请求用户批准一个操作（如执行命令、修改文件）。调用会阻塞直到用户审批或超时。",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "操作类型，如 run_command、edit_file、delete_file" },
          reason: { type: "string", description: "为什么需要执行这个操作" },
          context: { type: "string", description: "操作详情（命令内容、文件路径等）" }
        },
        required: ["action", "reason"]
      }
    }
  ];
}

async function callGetTaskStatus(agentId?: string): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const url = new URL(`${identity.apiUrl}/api/callbacks/task-status`);
  url.searchParams.set("invocationId", identity.invocationId);
  url.searchParams.set("callbackToken", identity.callbackToken);
  if (agentId) {
    url.searchParams.set("agentId", agentId);
  }

  const response = await requestJson(url.toString(), { method: "GET" });
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `get_task_status failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callCreateTask(params: { assignee: string; description: string; priority?: string }): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/create-task`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      assignee: params.assignee,
      description: params.description,
      priority: params.priority
    }
  });

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `create_task failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callTriggerMention(params: { targetAgentId: string; taskSnippet: string }): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/trigger-mention`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      targetAgentId: params.targetAgentId,
      taskSnippet: params.taskSnippet
    }
  });

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `trigger_mention failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callRequestDecision(params: {
  title: string;
  description?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  multiSelect?: boolean;
  anchorMessageId?: string;
}): Promise<ToolResult> {
  if (!params.options?.length || params.options.length < 2) {
    return {
      isError: true,
      content: [{ type: "text", text: "至少需要 2 个选项。" }]
    };
  }

  const identity = getCallbackIdentity();
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/request-decision`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      title: params.title,
      description: params.description,
      options: params.options,
      multiSelect: params.multiSelect ?? false,
      anchorMessageId: params.anchorMessageId,
    }
  });

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `request_decision failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callParallelThink(params: {
  targets: string[];
  question: string;
  callbackTo: string;
  context?: string;
  timeoutMinutes?: number;
  idempotencyKey?: string;
  searchEvidenceRefs?: string[];
  overrideReason?: string;
}): Promise<ToolResult> {
  if (!params.searchEvidenceRefs?.length && !params.overrideReason) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: "parallel_think 要求 searchEvidenceRefs（先搜后问）或 overrideReason（说明跳过原因）。"
      }]
    };
  }

  if (!params.targets.length || params.targets.length > 3) {
    return {
      isError: true,
      content: [{ type: "text", text: "targets 必须是 1-3 个 agent。" }]
    };
  }

  const identity = getCallbackIdentity();
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/parallel-think`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      targets: params.targets,
      question: params.question,
      callbackTo: params.callbackTo,
      ...(params.context ? { context: params.context } : {}),
      ...(params.timeoutMinutes !== undefined ? { timeoutMinutes: params.timeoutMinutes } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.searchEvidenceRefs ? { searchEvidenceRefs: params.searchEvidenceRefs } : {}),
      ...(params.overrideReason ? { overrideReason: params.overrideReason } : {})
    }
  });

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `parallel_think failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

async function callRequestPermission(params: { action: string; reason: string; context?: string }): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/request-permission`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      action: params.action,
      reason: params.reason,
      ...(params.context ? { context: params.context } : {})
    }
  });

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `request_permission failed: ${JSON.stringify(response.json)}` }]
    };
  }

  const result = response.json as { status: string };
  if (result.status === "granted") {
    return { content: [{ type: "text", text: "Permission granted. Proceed with the operation." }] };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `Permission ${result.status}. Do not proceed with this operation.` }]
  };
}

async function callGetMemory(keyword?: string): Promise<ToolResult> {
  const identity = getCallbackIdentity();
  const url = new URL(`${identity.apiUrl}/api/callbacks/memory`);
  url.searchParams.set("invocationId", identity.invocationId);
  url.searchParams.set("callbackToken", identity.callbackToken);
  if (keyword) {
    url.searchParams.set("keyword", keyword);
  }

  const response = await requestJson(url.toString(), { method: "GET" });
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `get_memory failed: ${JSON.stringify(response.json)}` }]
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }]
  };
}

export async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
  switch (name) {
    case "post_message": {
      const content = typeof args?.content === "string" ? args.content : "";
      if (!content.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: "content is required" }]
        } satisfies ToolResult;
      }
      return callPostMessage(content.trim());
    }
    case "get_room_context": {
      const limit = typeof args?.limit === "number" ? args.limit : undefined;
      return callGetRoomContext(limit);
    }
    case "get_room_summary":
      return callGetRoomSummary();
    case "search_room_memories": {
      const keyword = typeof args?.keyword === "string" ? args.keyword : "";
      if (!keyword.trim()) {
        return { isError: true, content: [{ type: "text", text: "keyword is required" }] };
      }
      return callSearchRoomMemories(keyword.trim());
    }
    case "get_task_status":
      return callGetTaskStatus(args?.agentId as string | undefined);
    case "create_task":
      return callCreateTask(args as { assignee: string; description: string; priority?: string });
    case "trigger_mention":
      return callTriggerMention(args as { targetAgentId: string; taskSnippet: string });
    case "get_memory":
      return callGetMemory(args?.keyword as string | undefined);
    case "request_decision":
      return callRequestDecision(args as {
        title: string;
        description?: string;
        options: Array<{ id: string; label: string; description?: string }>;
        multiSelect?: boolean;
        anchorMessageId?: string;
      });
    case "parallel_think":
      return callParallelThink(args as {
        targets: string[];
        question: string;
        callbackTo: string;
        context?: string;
        timeoutMinutes?: number;
        idempotencyKey?: string;
        searchEvidenceRefs?: string[];
        overrideReason?: string;
      });
    case "request_permission":
      return callRequestPermission(args as { action: string; reason: string; context?: string });
    default:
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name}` }]
      } satisfies ToolResult;
  }
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
