import http from "node:http"
import https from "node:https"
import { URL } from "node:url"
import type { FastifyInstance } from "fastify"

type JsonRpcId = string | number | null

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id?: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse =
  | {
      jsonrpc: "2.0"
      id: JsonRpcId
      result: unknown
    }
  | {
      jsonrpc: "2.0"
      id: JsonRpcId
      error: {
        code: number
        message: string
      }
    }

type CallbackIdentity = {
  apiUrl: string
  invocationId: string
  callbackToken: string
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

function getCallbackIdentity(): CallbackIdentity {
  const apiUrl = process.env.MULTI_AGENT_API_URL || process.env.API_URL || ""
  const invocationId = process.env.MULTI_AGENT_INVOCATION_ID || process.env.INVOCATION_ID || ""
  const callbackToken = process.env.MULTI_AGENT_CALLBACK_TOKEN || process.env.CALLBACK_TOKEN || ""

  if (!apiUrl || !invocationId || !callbackToken) {
    throw new Error("Missing MULTI_AGENT callback environment variables.")
  }

  return { apiUrl, invocationId, callbackToken }
}

function requestJson(
  targetUrl: string,
  options: { method: "GET" | "POST"; body?: Record<string, unknown> },
): Promise<{ statusCode: number; json: unknown }> {
  const url = new URL(targetUrl)
  const bodyText = options.body ? JSON.stringify(options.body) : null
  const client = url.protocol === "https:" ? https : http

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
              "content-length": Buffer.byteLength(bodyText),
            }
          : undefined,
      },
      (response) => {
        let raw = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          raw += chunk
        })
        response.on("end", () => {
          try {
            resolve({
              statusCode: response.statusCode ?? 0,
              json: raw ? JSON.parse(raw) : {},
            })
          } catch (error) {
            reject(error)
          }
        })
      },
    )

    request.on("error", reject)
    if (bodyText) {
      request.write(bodyText)
    }
    request.end()
  })
}

async function callPostMessage(content: string): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/post-message`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      content,
    },
  })

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `post_message failed: ${JSON.stringify(response.json)}` }],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

async function callGetRoomContext(limit?: number): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const url = new URL(`${identity.apiUrl}/api/callbacks/room-context`)
  url.searchParams.set("invocationId", identity.invocationId)
  url.searchParams.set("callbackToken", identity.callbackToken)
  if (typeof limit === "number") {
    url.searchParams.set("limit", String(limit))
  }

  const response = await requestJson(url.toString(), { method: "GET" })
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [
        { type: "text", text: `get_room_context failed: ${JSON.stringify(response.json)}` },
      ],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

// F027 #285 S3 · callGetRoomSummary / callSearchRoomMemories / callGetMemory 已退役删除：
// 旧 3 记忆工具（get_room_summary / search_room_memories / get_memory）B1-a 已从 getTools
// 摘牌，本轮后端真退役。职能 = rooms/<roomId>/session-summary.md（MemoryService 双写 +
// migrate-session-memories 存量导出），read_wiki / search_wiki 4 件套覆盖。
// session_memories 表数据原封不动（Iron Law；物理 DROP 留小孙手动）。

// F027 P14.b: query_messages MCP tool — BM25 全文召回（messages_fts trigram tokenizer），
// 走 HTTP backend。与 recall_similar_context 互补：semantic 召回靠 embedding cosine，
// BM25 召回靠字面 token / 短语命中。中文短串 (≥3 字) trigram 命中较稳。
async function callQueryMessages(params: {
  query: string
  topK?: number
  threadId?: string
  role?: string
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const url = new URL(`${identity.apiUrl}/api/callbacks/query-messages`)
  url.searchParams.set("invocationId", identity.invocationId)
  url.searchParams.set("callbackToken", identity.callbackToken)
  url.searchParams.set("query", params.query)
  if (typeof params.topK === "number") {
    url.searchParams.set("topK", String(params.topK))
  }
  if (params.threadId) {
    url.searchParams.set("threadId", params.threadId)
  }
  if (params.role) {
    url.searchParams.set("role", params.role)
  }

  const response = await requestJson(url.toString(), { method: "GET" })
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `query_messages failed: ${JSON.stringify(response.json)}` }],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

// F027 chap 12 Level 2: search_wiki MCP tool — BM25 over wiki entity index（已编译 wiki 知识实体），
// 走 HTTP backend。与 query_messages 互补：query_messages 搜 raw messages 字面，search_wiki 搜
// 沉淀后的结构化知识实体（concepts / rooms / people / feedback 桶）。
async function callSearchWiki(params: {
  query: string
  topK?: number
  scope?: string
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const url = new URL(`${identity.apiUrl}/api/callbacks/search-wiki`)
  url.searchParams.set("invocationId", identity.invocationId)
  url.searchParams.set("callbackToken", identity.callbackToken)
  url.searchParams.set("query", params.query)
  if (typeof params.topK === "number") {
    url.searchParams.set("topK", String(params.topK))
  }
  if (params.scope) {
    url.searchParams.set("scope", params.scope)
  }

  const response = await requestJson(url.toString(), { method: "GET" })
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `search_wiki failed: ${JSON.stringify(response.json)}` }],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

// F018 P5 AC6.3: recall_similar_context MCP tool — 语义召回，走 HTTP backend
async function callRecallSimilarContext(query: string, topK?: number): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const url = new URL(`${identity.apiUrl}/api/callbacks/recall-similar-context`)
  url.searchParams.set("invocationId", identity.invocationId)
  url.searchParams.set("callbackToken", identity.callbackToken)
  url.searchParams.set("query", query)
  if (typeof topK === "number") {
    url.searchParams.set("topK", String(topK))
  }

  const response = await requestJson(url.toString(), { method: "GET" })
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [
        { type: "text", text: `recall_similar_context failed: ${JSON.stringify(response.json)}` },
      ],
    }
  }

  // Return the reference-only 闭合段 formatted text directly (ready for agent context)
  const body = response.json as { text?: string }
  return {
    content: [{ type: "text", text: body.text ?? "(no relevant context found)" }],
  }
}

export function encodeMessage(message: JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`
}

export function parseFrame(buffer: string): { messages: unknown[]; remaining: string } {
  const messages: unknown[] = []
  let rest = buffer
  while (true) {
    const nl = rest.indexOf("\n")
    if (nl === -1) break
    const line = rest.slice(0, nl)
    rest = rest.slice(nl + 1)
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      messages.push(JSON.parse(trimmed))
    } catch {
      // Drop malformed line; real server will reply with parse error via write path.
    }
  }
  return { messages, remaining: rest }
}

function writeMessage(message: JsonRpcResponse) {
  process.stdout.write(encodeMessage(message))
}

function writeResult(id: JsonRpcId, result: unknown) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  })
}

function writeError(id: JsonRpcId, message: string, code = -32000) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  })
}

export function getTools() {
  return [
    {
      name: "post_message",
      description:
        "Post a public PROGRESS update to the current thread MID-TASK only. " +
        "Use ONLY while still working on a long task to share intermediate progress " +
        '(e.g. "running the test suite, will report back"). ' +
        "DO NOT use this tool to repeat or rephrase the answer you are about to give as your final reply " +
        "— your final assistant message is auto-persisted and dispatched, calling post_message after that " +
        "produces duplicate UI bubbles + duplicate @-triggers and will be hard-rejected by the server " +
        "(post-final lockout returns ok:true, locked:true, reason:final_already_emitted, no message persisted). " +
        "Each invocation can emit any number of progress posts before the final, but zero after.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The progress content to post. Must be NEW information (work-in-progress status, " +
              "intermediate findings) — never a copy or rephrasing of your eventual final answer.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "get_room_context",
      description:
        "⚠️[Legacy · F027 记忆收敛] A2A 派发（@/Call）路径已自动 adaptive recall 注入历史；直接对话需主动召回时优先 query_messages / search_wiki。需严格时序近期对话时才用本工具。获取当前协作房间的近期对话上下文（跨所有 agent 线程聚合）。",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "返回的最大消息数量，默认 20，最大 200。",
          },
        },
      },
    },
    {
      name: "query_messages",
      description:
        "F027 chap 21 P14: 按字面/关键词在当前 ROOM 的 messages 表做 BM25 全文召回（trigram tokenizer）。**重要：query 必须 ≥3 字符**（trigram 物理限制：<3 字会切不出完整 3-gram，通常返回 0 hit）。与 recall_similar_context 互补：那个走 embedding 语义相似，本工具走字面 token / 短语 / 实体 ID（如 F011 / B022 / R-205）的精确召回。query 含特殊字符会被 sanitize 包成 phrase 安全字面量；保留字 AND/OR/NEAR 自动转义。可选过滤：threadId 限单 thread / role 限消息角色（user/assistant/connector）。topK 默认 10，最大 100。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "搜索字符串（**必须 ≥3 字符** — trigram 物理限制，<3 字通常 0 hit）。英文 token / 中文短语 / 实体 ID 都支持；保留字 AND/OR/NEAR 自动转义。",
          },
          topK: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "返回 top-K 命中（默认 10，最大 100）。",
          },
          threadId: {
            type: "string",
            description: "可选：限定单个 thread 内召回（默认聚合当前 room 全部 thread）。",
          },
          role: {
            type: "string",
            description: "可选：限定消息角色（user / assistant / connector）。",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "search_wiki",
      description:
        "F027 chap 12 Level 2: 在已编译的 wiki 知识实体（concepts / rooms / people / feedback 桶）里做 BM25 加权全文召回（name 5x body）。与 query_messages 互补：query_messages 搜 raw 对话消息的字面 token，search_wiki 搜沉淀后的结构化知识实体（如 F011 概念页、某 room 的 viewfinder、某人 capability digest）。返回 path + score + excerpt。topK 默认 5，最大 50。scope 可选限定单桶（concepts / rooms / people / feedback），默认 all 全桶。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索字符串（自然语言 / 关键词 / 实体 ID 如 F011 / R-205）。",
          },
          topK: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "返回 top-K 命中（默认 5，最大 50）。",
          },
          scope: {
            type: "string",
            description:
              "可选：限定 wiki 桶（concepts / rooms / people / feedback）；默认 all 全桶。",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "recall_similar_context",
      description:
        "⚠️[Legacy · F027 记忆收敛] A2A 派发路径已自动语义召回；直接对话需主动召回时优先 search_wiki（wiki）/ query_messages（messages 字面）——本工具是 messages 语义召回的补充（4 件套不做 messages 语义）。按语义相似度在当前 ROOM（含本 ROOM 内所有协作 agent thread 的历史，不只是你自己）召回相关消息片段。适用于需要 ROOM 内历史细节但不确定在哪的情况 —— 宁可调一次也不要瞎编。返回 reference-only 闭合段格式，只作参考。与 get_room_context 区别：get_room_context 按时序拿近期对话，recall_similar_context 按语义相似度精准匹配（适合查旧话题、跨 thread 找细节）。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要搜索的问题或关键词（自然语言）",
          },
          topK: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "返回 Top-K 结果，默认 5",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_task_status",
      description: "查询当前协作房间中各 agent 的运行状态。",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "可选：指定查询的 agent 别名" },
        },
      },
    },
    {
      name: "create_task",
      description: "创建一个跟踪任务并分配给指定 agent。",
      inputSchema: {
        type: "object",
        properties: {
          assignee: { type: "string", description: "要分配任务的 agent 别名" },
          description: { type: "string", description: "任务描述" },
          priority: { type: "string", enum: ["low", "medium", "high"], description: "优先级" },
        },
        required: ["assignee", "description"],
      },
    },
    {
      name: "trigger_mention",
      description: "程序化触发 @mention，无需发送公开消息即可调度另一个 agent。",
      inputSchema: {
        type: "object",
        properties: {
          targetAgentId: { type: "string", description: "目标 agent 别名" },
          taskSnippet: { type: "string", description: "要求目标 agent 完成的任务" },
        },
        required: ["targetAgentId", "taskSnippet"],
      },
    },
    {
      name: "request_decision",
      description:
        "向用户��示一个选择卡片（多选题或 agent 选择器），等待用户选择后返回结��。用于 brainstorm 中的方案选择、架构选型投票等需要用��决策的场景。",
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
                description: { type: "string", description: "选项说明" },
              },
              required: ["id", "label"],
            },
            description: "选项列表（2-6 个）",
          },
          multiSelect: { type: "boolean", description: "是否允许多选，默认 false" },
          anchorMessageId: {
            type: "string",
            description:
              "可选：将决策卡片嵌入到指定消息气泡中（inline card）。如果不提供，卡片作为独立系统卡片显示。",
          },
        },
        required: ["title", "options"],
      },
    },
    {
      name: "request_permission",
      description: "请求用户批准一个操作（如执行命令、修改文件）。调用会阻塞直到用户审批或超时。",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型，如 run_command、edit_file、delete_file",
          },
          reason: { type: "string", description: "为什么需要执行这个操作" },
          context: { type: "string", description: "操作详情（命令内容、文件路径等）" },
        },
        required: ["action", "reason"],
      },
    },
    {
      name: "take_screenshot",
      description: "对指定 URL 截图并将图片嵌入当前消息，在前端即时展示。默认截 localhost:3000。",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "要截图的 URL，默认 http://localhost:3000" },
          alt: { type: "string", description: "图片描述（alt text）" },
        },
      },
    },
    {
      name: "update_workflow_sop",
      description:
        "F019 告示牌：推进当前 feature 的 WorkflowSop 状态机（stage / batonHolder / checks / resumeCapsule）。与 HTTP callback /api/callbacks/update-workflow-sop 行为等价。stage 枚举：kickoff|impl|quality_gate|review|merge|completion。乐观锁失配会报错；仅有 backlogItemId 必填。",
      inputSchema: {
        type: "object",
        properties: {
          backlogItemId: { type: "string", description: "feature 绑定 ID（如 F019）" },
          featureId: { type: "string", description: "feature 短 ID（默认等于 backlogItemId）" },
          stage: {
            type: "string",
            enum: ["kickoff", "impl", "quality_gate", "review", "merge", "completion"],
            description: "生命周期阶段枚举",
          },
          batonHolder: { type: "string", description: "接力棒持有者（当前该谁动）" },
          nextSkill: { type: "string", description: "下一步建议加载的 skill 名" },
          resumeCapsule: {
            type: "object",
            description: "恢复胶囊（goal/done/currentFocus）— 合并到现有，不覆盖",
            properties: {
              goal: { type: "string" },
              done: { type: "array", items: { type: "string" } },
              currentFocus: { type: "string" },
            },
          },
          checks: {
            type: "object",
            description: "四项 SOP gate 检查状态（attested|verified|unknown）",
            properties: {
              remoteMainSynced: { type: "string", enum: ["attested", "verified", "unknown"] },
              qualityGatePassed: { type: "string", enum: ["attested", "verified", "unknown"] },
              reviewApproved: { type: "string", enum: ["attested", "verified", "unknown"] },
              visionGuardDone: { type: "string", enum: ["attested", "verified", "unknown"] },
            },
          },
          expectedVersion: {
            type: "integer",
            description: "乐观锁：当前期望的 version；不匹配则 upsert 报错",
          },
        },
        required: ["backlogItemId"],
      },
    },
    {
      name: "acquire_wiki_lease",
      description:
        "F027 chap 6: 申请 wiki path 的写入互斥锁。返回 fencing_token + expires_at。lease 默认 TTL 30s，必须在过期前完成 update_wiki，否则 lease 被抢占（任何后续 update_wiki 用过期 token 都会拒）。同 path 已被他人持有时返 409 lease_held。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "wiki 相对路径（如 'wiki/concepts/foo.md'）" },
          ttlSeconds: { type: "number", description: "lease TTL 秒数，默认 30" },
        },
        required: ["path"],
      },
    },
    {
      name: "read_wiki",
      description:
        "F027 chap 6: 读 wiki 文件 + 当前 hash（CAS 用）。返回 content + hash 或 status='not_found'。update_wiki 之前必须先 read_wiki 拿 base_hash。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "wiki 相对路径" },
        },
        required: ["path"],
      },
    },
    {
      name: "update_wiki",
      description:
        "F027 chap 6: 写 wiki 文件，全套 ACL + CAS + lease + fencing 校验。流程：1) acquire_wiki_lease 拿 token；2) read_wiki 拿 base_hash；3) update_wiki 提交。status 枚举：ok / denied_acl / conflict（base_hash 不符）/ lease_expired（token 不持有）/ stale_token（写入临界区被抢占）/ schema_invalid / path_invalid（路径含 ../ 逃逸 / 非 wiki/ 前缀）/ internal（atomic-write IO 失败 / revert 失败，由服务端 5xx 兜）/ not_implemented。actions: write|append|delete 已支持；patch/promote/demote/ingest by design 不接 MCP 路径（防 agent 越权写 canonical wiki，V16.5 §6 ACL + §17）— promote/demote 走 HTTP POST /api/wiki/drafts/promote|demote + IngestModal UI（user-driven + 小孙审计 + ledger），见 F027-RESIDUAL-DEBT.md 类别 D1。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "wiki 相对路径" },
          action: {
            type: "string",
            enum: ["write", "append", "patch", "ingest", "promote", "demote", "delete"],
            description: "动作枚举",
          },
          base_hash: {
            type: ["string", "null"],
            description: "CAS 期望当前 hash，null = 创建新文件",
          },
          content: { type: "string", description: "新内容（write/append）或空（delete）" },
          fencing_token: { type: "string", description: "acquire_wiki_lease 返回的 token" },
          reason: { type: "string", description: "可选：写入原因（落 wiki_events.reason）" },
          source_message_ids: {
            type: "array",
            items: { type: "string" },
            description: "可选：触发本次写入的 message id 列表",
          },
        },
        required: ["path", "action", "content", "fencing_token"],
      },
    },
  ]
}

async function callGetTaskStatus(agentId?: string): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const url = new URL(`${identity.apiUrl}/api/callbacks/task-status`)
  url.searchParams.set("invocationId", identity.invocationId)
  url.searchParams.set("callbackToken", identity.callbackToken)
  if (agentId) {
    url.searchParams.set("agentId", agentId)
  }

  const response = await requestJson(url.toString(), { method: "GET" })
  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `get_task_status failed: ${JSON.stringify(response.json)}` }],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

async function callCreateTask(params: {
  assignee: string
  description: string
  priority?: string
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/create-task`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      assignee: params.assignee,
      description: params.description,
      priority: params.priority,
    },
  })

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `create_task failed: ${JSON.stringify(response.json)}` }],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

async function callTriggerMention(params: {
  targetAgentId: string
  taskSnippet: string
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/trigger-mention`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      targetAgentId: params.targetAgentId,
      taskSnippet: params.taskSnippet,
    },
  })

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `trigger_mention failed: ${JSON.stringify(response.json)}` }],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

async function callRequestDecision(params: {
  title: string
  description?: string
  options: Array<{ id: string; label: string; description?: string }>
  multiSelect?: boolean
  anchorMessageId?: string
}): Promise<ToolResult> {
  if (!params.options?.length || params.options.length < 2) {
    return {
      isError: true,
      content: [{ type: "text", text: "至少需要 2 个选项。" }],
    }
  }

  const identity = getCallbackIdentity()
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
    },
  })

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [
        { type: "text", text: `request_decision failed: ${JSON.stringify(response.json)}` },
      ],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

// F019 P3: MCP tool → HTTP callback bridge. Shares auth + validation with
// /api/callbacks/update-workflow-sop. Stage enum / optimistic lock errors are
// returned as MCP isError responses so the caller can distinguish from success.
async function callUpdateWorkflowSop(params: {
  backlogItemId: string
  featureId?: string
  stage?: string
  batonHolder?: string | null
  nextSkill?: string | null
  resumeCapsule?: Record<string, unknown>
  checks?: Record<string, unknown>
  expectedVersion?: number
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/update-workflow-sop`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      backlogItemId: params.backlogItemId,
      ...(params.featureId !== undefined ? { featureId: params.featureId } : {}),
      ...(params.stage !== undefined ? { stage: params.stage } : {}),
      ...(params.batonHolder !== undefined ? { batonHolder: params.batonHolder } : {}),
      ...(params.nextSkill !== undefined ? { nextSkill: params.nextSkill } : {}),
      ...(params.resumeCapsule !== undefined ? { resumeCapsule: params.resumeCapsule } : {}),
      ...(params.checks !== undefined ? { checks: params.checks } : {}),
      ...(params.expectedVersion !== undefined ? { expectedVersion: params.expectedVersion } : {}),
    },
  })

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `update_workflow_sop failed (HTTP ${response.statusCode}): ${JSON.stringify(response.json)}`,
        },
      ],
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

async function callTakeScreenshot(params: { url?: string; alt?: string }): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/take-screenshot`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      url: params.url,
      alt: params.alt,
    },
  })

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [{ type: "text", text: `take_screenshot failed: ${JSON.stringify(response.json)}` }],
    }
  }

  const result = response.json as { ok: boolean; imageUrl: string }
  return {
    content: [
      {
        type: "text",
        text: `Screenshot captured and embedded in message. URL: ${result.imageUrl}`,
      },
    ],
  }
}

async function callRequestPermission(params: {
  action: string
  reason: string
  context?: string
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/request-permission`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      action: params.action,
      reason: params.reason,
      ...(params.context ? { context: params.context } : {}),
    },
  })

  if (response.statusCode >= 400) {
    return {
      isError: true,
      content: [
        { type: "text", text: `request_permission failed: ${JSON.stringify(response.json)}` },
      ],
    }
  }

  const result = response.json as { status: string }
  if (result.status === "granted") {
    return { content: [{ type: "text", text: "Permission granted. Proceed with the operation." }] }
  }
  return {
    isError: true,
    content: [
      { type: "text", text: `Permission ${result.status}. Do not proceed with this operation.` },
    ],
  }
}

async function callAcquireWikiLease(params: {
  path: string
  ttlSeconds?: number
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/acquire-wiki-lease`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      path: params.path,
      ...(params.ttlSeconds !== undefined ? { ttlSeconds: params.ttlSeconds } : {}),
    },
  })
  return {
    isError: response.statusCode >= 400,
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

async function callReadWiki(params: { path: string }): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const url = new URL(`${identity.apiUrl}/api/callbacks/read-wiki`)
  url.searchParams.set("invocationId", identity.invocationId)
  url.searchParams.set("callbackToken", identity.callbackToken)
  url.searchParams.set("path", params.path)
  const response = await requestJson(url.toString(), { method: "GET" })
  return {
    isError: response.statusCode >= 400,
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

async function callUpdateWiki(params: {
  path: string
  action: string
  base_hash?: string | null
  content: string
  fencing_token: string
  reason?: string
  source_message_ids?: string[]
}): Promise<ToolResult> {
  const identity = getCallbackIdentity()
  const response = await requestJson(`${identity.apiUrl}/api/callbacks/update-wiki`, {
    method: "POST",
    body: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      path: params.path,
      action: params.action,
      baseHash: params.base_hash ?? null,
      content: params.content,
      fencingToken: params.fencing_token,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.source_message_ids !== undefined
        ? { sourceMessageIds: params.source_message_ids }
        : {}),
    },
  })
  return {
    isError: response.statusCode >= 400,
    content: [{ type: "text", text: JSON.stringify(response.json) }],
  }
}

export async function handleToolCall(name: string, args: Record<string, unknown> | undefined) {
  switch (name) {
    case "post_message": {
      const content = typeof args?.content === "string" ? args.content : ""
      if (!content.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: "content is required" }],
        } satisfies ToolResult
      }
      return callPostMessage(content.trim())
    }
    case "get_room_context": {
      const limit = typeof args?.limit === "number" ? args.limit : undefined
      return callGetRoomContext(limit)
    }
    // F027 #285 S3 · get_room_summary / search_room_memories / get_memory dispatch 支已删
    // → 落 default unknown tool（工具早已不广播，残余调用按未知处理）。
    case "recall_similar_context": {
      const query = typeof args?.query === "string" ? args.query : ""
      if (!query.trim()) {
        return { isError: true, content: [{ type: "text", text: "query is required" }] }
      }
      const topK = typeof args?.topK === "number" ? args.topK : undefined
      return callRecallSimilarContext(query.trim(), topK)
    }
    case "query_messages": {
      const query = typeof args?.query === "string" ? args.query : ""
      if (!query.trim()) {
        return { isError: true, content: [{ type: "text", text: "query is required" }] }
      }
      const topK = typeof args?.topK === "number" ? args.topK : undefined
      const threadId = typeof args?.threadId === "string" ? args.threadId : undefined
      const role = typeof args?.role === "string" ? args.role : undefined
      return callQueryMessages({ query: query.trim(), topK, threadId, role })
    }
    case "search_wiki": {
      const query = typeof args?.query === "string" ? args.query : ""
      if (!query.trim()) {
        return { isError: true, content: [{ type: "text", text: "query is required" }] }
      }
      const topK = typeof args?.topK === "number" ? args.topK : undefined
      const scope = typeof args?.scope === "string" ? args.scope : undefined
      return callSearchWiki({ query: query.trim(), topK, scope })
    }
    case "get_task_status":
      return callGetTaskStatus(args?.agentId as string | undefined)
    case "create_task":
      return callCreateTask(args as { assignee: string; description: string; priority?: string })
    case "trigger_mention":
      return callTriggerMention(args as { targetAgentId: string; taskSnippet: string })
    case "request_decision":
      return callRequestDecision(
        args as {
          title: string
          description?: string
          options: Array<{ id: string; label: string; description?: string }>
          multiSelect?: boolean
          anchorMessageId?: string
        },
      )
    case "request_permission":
      return callRequestPermission(args as { action: string; reason: string; context?: string })
    case "take_screenshot":
      return callTakeScreenshot(args as { url?: string; alt?: string })
    case "update_workflow_sop": {
      const backlogItemId = typeof args?.backlogItemId === "string" ? args.backlogItemId.trim() : ""
      if (!backlogItemId) {
        return {
          isError: true,
          content: [{ type: "text", text: "backlogItemId is required (non-empty string)" }],
        } satisfies ToolResult
      }
      return callUpdateWorkflowSop(args as Parameters<typeof callUpdateWorkflowSop>[0])
    }
    case "acquire_wiki_lease": {
      const path = typeof args?.path === "string" ? args.path : ""
      if (!path) {
        return {
          isError: true,
          content: [{ type: "text", text: "path is required (non-empty string)" }],
        } satisfies ToolResult
      }
      return callAcquireWikiLease({
        path,
        ttlSeconds: typeof args?.ttlSeconds === "number" ? args.ttlSeconds : undefined,
      })
    }
    case "read_wiki": {
      const path = typeof args?.path === "string" ? args.path : ""
      if (!path) {
        return {
          isError: true,
          content: [{ type: "text", text: "path is required (non-empty string)" }],
        } satisfies ToolResult
      }
      return callReadWiki({ path })
    }
    case "update_wiki": {
      const path = typeof args?.path === "string" ? args.path : ""
      const action = typeof args?.action === "string" ? args.action : ""
      const content = typeof args?.content === "string" ? args.content : ""
      const fencing_token = typeof args?.fencing_token === "string" ? args.fencing_token : ""
      if (!path || !action || !fencing_token) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "path, action, fencing_token are required (non-empty strings)",
            },
          ],
        } satisfies ToolResult
      }
      return callUpdateWiki({
        path,
        action,
        base_hash: typeof args?.base_hash === "string" ? args.base_hash : null,
        content,
        fencing_token,
        reason: typeof args?.reason === "string" ? args.reason : undefined,
        source_message_ids: Array.isArray(args?.source_message_ids)
          ? (args.source_message_ids as string[])
          : undefined,
      })
    }
    default:
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name}` }],
      } satisfies ToolResult
  }
}

async function handleRequest(request: JsonRpcRequest) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "multi-agent-mcp",
          version: "1.0.0",
        },
        capabilities: {
          tools: {},
        },
      }
    case "notifications/initialized":
      return null
    case "tools/list":
      return {
        tools: getTools(),
      }
    case "tools/call": {
      const toolName = typeof request.params?.name === "string" ? request.params.name : ""
      const args =
        request.params && typeof request.params.arguments === "object"
          ? (request.params.arguments as Record<string, unknown>)
          : undefined
      return handleToolCall(toolName, args)
    }
    default:
      throw new Error(`Unsupported MCP method: ${request.method}`)
  }
}

export function registerMcpServer(_app: FastifyInstance) {
  // HTTP API server does not host the MCP stdio process.
}

export function startMcpServer() {
  let buffer = ""
  process.stdin.setEncoding("utf8")

  process.stdin.on("data", async (chunk) => {
    buffer += chunk
    const { messages, remaining } = parseFrame(buffer)
    buffer = remaining

    for (const raw of messages) {
      const request = raw as JsonRpcRequest
      try {
        const result = await handleRequest(request)
        if (request.id !== undefined && result !== null) {
          writeResult(request.id, result)
        }
      } catch (error) {
        writeError(
          request?.id ?? null,
          error instanceof Error ? error.message : "Unknown MCP server error",
        )
      }
    }
  })
}

if (require.main === module) {
  startMcpServer()
}
